import type Database from 'better-sqlite3';
import { reduceConversationActivity } from '../../../activity.js';
import type { Question } from '../../../types.js';
import type { ConversationApproval } from '../../shared/approval.js';
import { queryInteractions, legacyInteractionExpired } from '../../../db/interactions.js';
import { outboundTimelinePosition } from '../../../input-timeline.js';
import { conversationTimeline } from './conversation-timeline.js';
import { approvalTranscript } from './approval-transcript.js';
import type { TurnInputRow, TurnRow } from '../../../db/turns.js';
import { readTurnMetadataForTurns } from '../../../session-link-durable.js';
import { getSessionTurnSignals } from '../../../session-link.js';
import { openOutboundDb } from '../../../session-manager.js';
import type {
  Conversation,
  ConversationMessage,
  ConversationQuestion,
  ConversationTurn,
  ConversationUsage,
} from '../../shared/conversation.js';
import { publicInboundMessageId, readChatHistory } from './history.js';
import { resolveTurnContext, routeMatches, type TurnContext } from './conversation-context.js';
import { renderedReadCursor } from './read-state.js';

type Signals = ReturnType<typeof getSessionTurnSignals>;

function append<K, V>(groups: Map<K, V[]>, key: K, value: V): void {
  const group = groups.get(key);
  if (group) group.push(value);
  else groups.set(key, [value]);
}

function rowsByTurn<T extends { turn_id: string | null }>(
  db: Database.Database | null,
  table: 'turn_activity' | 'turn_usage' | 'turn_inputs',
  scope: { turns: string; owned: string; outputs: string },
): (turnId: string) => T[] {
  const groups = new Map<string | null, T[]>();
  const order = { turn_activity: 'ordinal', turn_usage: 'id', turn_inputs: 'message_in_id' };
  const anchored =
    table === 'turn_inputs'
      ? ''
      : 'AND (record.turn_id IN (SELECT value FROM json_each(@owned)) OR record.message_out_id IN (SELECT value FROM json_each(@outputs)))';
  const rows = db
    ? (db
        .prepare(
          `SELECT record.* FROM json_each(@turns) visible JOIN ${table} record ON record.turn_id=visible.value
       ${anchored} ORDER BY record.turn_id, record.${order[table]}`,
        )
        .all(scope) as T[])
    : [];
  for (const row of rows) {
    append(groups, row.turn_id, row);
  }
  return (turnId) => groups.get(turnId) ?? [];
}

function usageValue(row: Record<string, unknown>): Partial<ConversationUsage> {
  const value: Record<string, unknown> = {};
  for (const key of [
    'cost_usd',
    'input_tokens',
    'output_tokens',
    'cache_read_tokens',
    'cache_write_tokens',
    'model',
    'reasoning_tokens',
    'num_turns',
    'context_window',
    'max_output_tokens',
    'context_tokens',
    'duration_ms',
    'duration_api_ms',
  ])
    if (row[key] !== null && row[key] !== undefined) value[key] = row[key];
  return value as Partial<ConversationUsage>;
}

/** When the earliest submission answered by the turn arrived, never before the previous turn ended. */
function turnRequestedAt(
  turn: TurnRow,
  previous: TurnRow | undefined,
  inputIds: string[],
  inputTimes: ReadonlyMap<string, number>,
): number | null {
  const submitted = inputIds.reduce((earliest, id) => Math.min(earliest, inputTimes.get(id)!), Infinity);
  if (turn.started_at === null || submitted === Infinity) return null;
  const previousEnd = previous?.ended_at;
  const floor = previousEnd != null && previousEnd <= turn.started_at ? previousEnd : -Infinity;
  return Math.min(turn.started_at, Math.max(floor, submitted));
}

/** Pure synchronous read of host-owned state. The host is the only writer and cannot
 * interleave commits with this read. A settled turn is the rendering barrier. */
export function projectConversation(
  outDb: Database.Database | null,
  context: TurnContext,
  threadId: string,
  groupId: string,
  history: ConversationMessage[],
  questions: Question[],
  signals: Signals,
  approvals: ConversationApproval[] = [],
): Conversation {
  const records = outDb ? (outDb.prepare('SELECT * FROM turns ORDER BY started_at, id').all() as TurnRow[]) : [];
  const byId = new Map(records.map((turn) => [turn.id, turn]));
  for (const message of history) {
    if (message.turnId && !byId.has(message.turnId)) throw new Error('Missing conversation turn association');
  }
  const owns = (turn: TurnRow) =>
    routeMatches(context, turn.origin_channel_type, turn.origin_platform_id, turn.origin_thread_id);
  const unknown = (turn: TurnRow) =>
    turn.provenance !== 'native' && turn.origin_channel_type === null && turn.origin_platform_id === null;
  const visibleQuestions = questions.filter((q) => routeMatches(context, q.channel_type, q.platform_id, q.thread_id));
  const visibleQuestionIds = new Set(visibleQuestions.map((q) => q.id));
  const anchors = outDb
    ? (outDb
        .prepare(
          'SELECT message.* FROM json_each(?) visible JOIN messages_out message ON message.id=visible.value ORDER BY visible.key',
        )
        .all(JSON.stringify(visibleQuestions.map((q) => q.message_out_id))) as Array<{
        id: string;
        turn_id: string | null;
        content: string;
        timestamp: number;
      }>)
    : [];
  const questionAnchors = new Map(anchors.map((anchor) => [anchor.id, anchor]));
  const messages: ConversationMessage[] = history
    .filter((message) => {
      if (message.questionId && !visibleQuestionIds.has(message.questionId)) return false;
      const turn = message.turnId ? byId.get(message.turnId) : undefined;
      return !(turn && turn.phase !== 'settled' && message.deliveryOrigin === 'response');
    })
    .map((message) => {
      const turn = message.turnId ? byId.get(message.turnId) : undefined;
      if (turn && !owns(turn) && !unknown(turn)) {
        // Off-route sends expose the message, never the source conversation's turn.
        const { turnId: _turn, ...visible } = message;
        return visible;
      }
      return message;
    });
  const visibleOutputIds = new Set(messages.filter((m) => m.direction === 'out').map((m) => m.id));
  const outputsByTurn = new Map<string, string[]>();
  const inputTimes = new Map<string, number>();
  for (const message of messages) {
    if (message.direction === 'in') {
      inputTimes.set(message.id, Math.min(inputTimes.get(message.id) ?? Infinity, message.timestamp));
    } else if (message.turnId) {
      append(outputsByTurn, message.turnId, message.id);
    }
  }
  for (const question of visibleQuestions) visibleOutputIds.add(question.message_out_id);
  for (const [id, anchor] of questionAnchors) {
    if (anchor.turn_id) {
      append(outputsByTurn, anchor.turn_id, id);
    }
  }
  const visibleTurns = records
    .map((turn, index) => ({ turn, index, owned: owns(turn) }))
    .filter(({ turn, owned }) => owned || (unknown(turn) && outputsByTurn.has(turn.id)));
  const turnIdsJson = JSON.stringify(visibleTurns.map(({ turn }) => turn.id));
  const ownedTurnIds = visibleTurns.filter(({ owned }) => owned).map(({ turn }) => turn.id);
  const scope = {
    turns: turnIdsJson,
    owned: JSON.stringify(ownedTurnIds),
    outputs: JSON.stringify([...visibleOutputIds]),
  };
  const activityByTurn = rowsByTurn<{
    turn_id: string;
    message_out_id: string | null;
    ordinal: number;
    ts: number;
    text: string;
    timeline_position: number;
  }>(outDb, 'turn_activity', scope);
  const usageByTurn = rowsByTurn<Record<string, unknown> & { turn_id: string }>(outDb, 'turn_usage', scope);
  const inputsByTurn = rowsByTurn<TurnInputRow>(outDb, 'turn_inputs', scope);
  const metadataByTurn = readTurnMetadataForTurns(outDb, ownedTurnIds);
  const liveActivityByTurn = new Map<string, Signals['activity']>();
  for (const line of signals.activity) append(liveActivityByTurn, line.turnId, line);
  const turns: ConversationTurn[] = [];
  for (const { turn, index, owned } of visibleTurns) {
    const outputs = outputsByTurn.get(turn.id) ?? [];
    const activity = activityByTurn(turn.id);
    const trace = new Map<number, ConversationTurn['activity'][number]>();
    for (const line of activity) {
      trace.set(line.ordinal, {
        ordinal: line.ordinal,
        ts: line.ts,
        text: line.text,
        timelinePosition: line.timeline_position,
      });
    }
    if (owned && turn.phase !== 'settled') {
      for (const line of liveActivityByTurn.get(turn.id) ?? []) {
        if (!trace.has(line.ordinal))
          trace.set(line.ordinal, {
            ordinal: line.ordinal,
            ts: line.ts,
            text: line.text,
            timelinePosition: line.timelinePosition,
          });
      }
    }
    const usage = usageByTurn(turn.id).map((row) => ({ id: String(row.id), value: usageValue(row) }));
    const metadata = metadataByTurn.get(turn.id);
    const inputIds = inputsByTurn(turn.id)
      .map((r) => publicInboundMessageId(r.message_in_id, groupId))
      .filter((id) => inputTimes.has(id));
    let status: ConversationTurn['metadata']['status'] = 'provisional';
    let durationMs: number | null = null;
    if (turn.phase === 'settled') {
      if (metadata?.final) {
        status = metadata.status;
        durationMs = metadata.durationMs;
      } else {
        status = usage.length ? 'partial' : 'unavailable';
        // Native terminal timestamps take precedence over stale checkpoint durations.
        if (turn.provenance !== 'native') durationMs = usage.at(-1)?.value.duration_ms ?? null;
      }
    }
    turns.push({
      id: turn.id,
      phase: turn.phase,
      outcome: turn.outcome,
      startedAt: turn.started_at,
      requestedAt: turnRequestedAt(turn, records[index - 1], inputIds, inputTimes),
      endedAt: turn.ended_at,
      inputIds,
      outputIds: outputs,
      activity: reduceConversationActivity([...trace.values()].sort((a, b) => a.ordinal - b.ordinal)),
      usage,
      metadata: {
        status,
        model: metadata?.model ?? usage.at(-1)?.value.model ?? null,
        durationMs,
      },
    });
  }
  const turnIds = new Set(turns.map((turn) => turn.id));
  const scopedQuestions: ConversationQuestion[] = visibleQuestions.map((q) => {
    const anchor = questionAnchors.get(q.message_out_id);
    if (!anchor?.turn_id || !byId.has(anchor.turn_id))
      throw new Error('Missing conversation question turn association');
    const timelinePosition = outboundTimelinePosition(anchor.content);
    return {
      kind: 'question',
      id: q.id,
      ...q.input,
      status: legacyInteractionExpired(q) ? 'cancelled' : q.status,
      response: q.response,
      answeredAt: q.responded_at,
      threadId: q.thread_id,
      agentGroupId: groupId,
      createdAt: anchor.timestamp,
      messageId: q.message_out_id,
      ...(timelinePosition !== undefined ? { timelinePosition } : {}),
      ...(turnIds.has(anchor.turn_id) ? { turnId: anchor.turn_id } : {}),
    };
  });
  const live = signals.active.turn;
  const active =
    live &&
    turnIds.has(live.id) &&
    byId.get(live.id)?.phase !== 'settled' &&
    routeMatches(context, live.channelType, live.platformId, live.threadId)
      ? live
      : null;
  const connected = signals.active.connected;
  const actionable = context.canSend && connected && !!active;
  const view = {
    threadId,
    messages,
    turns,
    interactions: [...scopedQuestions, ...approvals],
    connection: { connected, activeTurnId: active?.id ?? null },
    capabilities: {
      canSend: context.canSend,
      stop: actionable,
      stopTool: actionable && active?.status === 'running' && active.supportsToolCancellation === true,
      steer: actionable && active?.supportsSteering === true,
      editInput: actionable && active?.supportsInputEditing === true,
      cancelInput: actionable && active?.supportsInputCancellation === true,
    },
  };
  return { ...view, timeline: conversationTimeline(view) };
}

export function readConversation(
  userId: string,
  groupId: string,
  threadId: string,
  override?: { channelType: string; messagingGroupId: string },
): Conversation {
  const context = resolveTurnContext(userId, groupId, threadId, override);
  if (!context) throw new Error('Conversation is not accessible');
  const history = readChatHistory(userId, groupId, threadId, override, {
    includeCancelled: true,
    hideApprovalOutcomes: true,
  });
  const outDb = context.sessionId ? openOutboundDb(groupId, context.sessionId) : null;
  try {
    const questions = context.sessionId
      ? queryInteractions<Question>(
          "SELECT * FROM interactions WHERE session_id = ? AND kind='question' ORDER BY created_at, id",
          context.sessionId,
        )
      : [];
    const view = projectConversation(
      outDb,
      context,
      threadId,
      groupId,
      history,
      questions,
      getSessionTurnSignals(context.sessionId ?? ''),
      approvalTranscript(userId, groupId, context),
    );
    return { ...view, readCursor: renderedReadCursor(userId, groupId, context, view) };
  } finally {
    outDb?.close();
  }
}
