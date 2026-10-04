import type Database from 'better-sqlite3';
import { reduceActivityLines } from '../../../activity.js';
import type { Question } from '../../../types.js';
import { getDb } from '../../../db/connection.js';
import { outboundTimelinePosition } from '../../../input-timeline.js';
import { conversationTimeline } from './conversation-timeline.js';
import { getTurnInputs, type TurnRow } from '../../../db/turns.js';
import { readTurnMetadata } from '../../../session-link-durable.js';
import { getSessionTurnSignals } from '../../../session-link.js';
import { openOutboundDb } from '../../../session-manager.js';
import type {
  Conversation,
  ConversationMessage,
  ConversationQuestion,
  ConversationTurn,
  ConversationUsage,
} from '../../shared/conversation.js';
import { publicInboundMessageId, readChatHistory, resolveTurnContext, type TurnContext } from './chat.js';

export function routeMatches(
  context: TurnContext,
  channel: string | null,
  platform: string | null,
  thread: string | null,
): boolean {
  return (
    channel === context.channelType &&
    platform !== null &&
    context.platformIds.includes(platform) &&
    thread === context.threadId
  );
}

type Signals = ReturnType<typeof getSessionTurnSignals>;
type QuestionRow = Omit<Question, 'options'> & { options_json: string };

function displayActivity(lines: ConversationTurn['activity']): ConversationTurn['activity'] {
  const groups = new Map<string, ConversationTurn['activity']>();
  for (const line of lines) {
    let key = `ordinal:${line.ordinal}`;
    try {
      const step: unknown = JSON.parse(line.text);
      if (
        step &&
        typeof step === 'object' &&
        'kind' in step &&
        'id' in step &&
        typeof step.kind === 'string' &&
        typeof step.id === 'string'
      )
        key = JSON.stringify([step.kind, step.id]);
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
    }
    const group = groups.get(key) ?? [];
    group.push(line);
    groups.set(key, group);
  }
  return [...groups.values()].flatMap((group) => {
    const reduced = reduceActivityLines(group);
    return reduced.length ? reduced.map((line) => ({ ...group[0], ...line })) : group;
  });
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
  ])
    if (row[key] !== null && row[key] !== undefined) value[key] = row[key];
  return value as Partial<ConversationUsage>;
}

/** Pure synchronous read of host-owned state. The host is the only writer and cannot
 * interleave commits with this read. A settled turn is the rendering barrier. */
export function projectConversation(
  outDb: Database.Database | null,
  context: TurnContext,
  threadId: string,
  groupId: string,
  history: ConversationMessage[],
  questions: QuestionRow[],
  signals: Signals,
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
  const questionAnchors = new Map(
    visibleQuestions.map((q) => [
      q.message_out_id,
      outDb?.prepare('SELECT turn_id, content FROM messages_out WHERE id = ?').get(q.message_out_id) as
        | { turn_id: string | null; content: string }
        | undefined,
    ]),
  );
  const messages: ConversationMessage[] = history
    .filter((message) => {
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
      return { ...message };
    });
  const visibleOutputIds = new Set(messages.filter((m) => m.direction === 'out').map((m) => m.id));
  for (const id of questionAnchors.keys()) visibleOutputIds.add(id);
  const visibleInputIds = new Set(messages.filter((m) => m.direction === 'in').map((m) => m.id));
  const turns: ConversationTurn[] = [];
  for (const turn of records) {
    const owned = owns(turn);
    const outputs = [
      ...messages.filter((m) => m.turnId === turn.id && m.direction === 'out').map((m) => m.id),
      ...[...questionAnchors].filter(([, anchor]) => anchor?.turn_id === turn.id).map(([id]) => id),
    ];
    if (!owned && !(unknown(turn) && outputs.length)) continue;
    const activity = outDb!
      .prepare(
        'SELECT message_out_id, ordinal, ts, text, timeline_position FROM turn_activity WHERE turn_id = ? ORDER BY ordinal',
      )
      .all(turn.id) as Array<{
      message_out_id: string | null;
      ordinal: number;
      ts: string;
      text: string;
      timeline_position: number;
    }>;
    const trace = new Map<number, ConversationTurn['activity'][number]>();
    for (const line of activity) {
      if (owned || (line.message_out_id !== null && visibleOutputIds.has(line.message_out_id)))
        trace.set(line.ordinal, {
          ordinal: line.ordinal,
          ts: line.ts,
          text: line.text,
          timelinePosition: line.timeline_position,
        });
    }
    if (owned && turn.phase !== 'settled') {
      for (const line of signals.activity) {
        if (line.turnId === turn.id && !trace.has(line.ordinal))
          trace.set(line.ordinal, {
            ordinal: line.ordinal,
            ts: line.ts,
            text: line.text,
            timelinePosition: line.timelinePosition,
          });
      }
    }
    const usage = (
      outDb!.prepare('SELECT * FROM turn_usage WHERE turn_id = ? ORDER BY id').all(turn.id) as Array<
        Record<string, unknown>
      >
    )
      .filter((row) => owned || visibleOutputIds.has(String(row.message_out_id)))
      .map((row) => ({ id: String(row.id), value: usageValue(row) }));
    const metadata = owned ? readTurnMetadata(outDb!, turn.id) : undefined;
    const liveUsage =
      owned && turn.phase !== 'settled' && signals.usage?.turnId === turn.id ? signals.usage.value : null;
    turns.push({
      id: turn.id,
      phase: turn.phase,
      outcome: turn.outcome,
      startedAt: turn.started_at,
      endedAt: turn.ended_at,
      inputIds: getTurnInputs(outDb!, turn.id)
        .map((r) => publicInboundMessageId(r.message_in_id, groupId))
        .filter((id) => visibleInputIds.has(id)),
      outputIds: outputs,
      activity: displayActivity([...trace.values()].sort((a, b) => a.ordinal - b.ordinal)),
      usage,
      metadata: {
        status:
          turn.phase !== 'settled' ? 'provisional' : (metadata?.status ?? (usage.length ? 'partial' : 'unavailable')),
        model: metadata?.model ?? usage.at(-1)?.value.model ?? liveUsage?.model ?? null,
        // A running turn's stored duration is a stale checkpoint, not its elapsed time.
        durationMs: turn.phase === 'settled' ? (metadata?.durationMs ?? usage.at(-1)?.value.duration_ms ?? null) : null,
      },
      liveUsage,
    });
  }
  const turnIds = new Set(turns.map((turn) => turn.id));
  const scopedQuestions: ConversationQuestion[] = visibleQuestions.map((q) => {
    const anchor = questionAnchors.get(q.message_out_id);
    if (!anchor?.turn_id || !byId.has(anchor.turn_id))
      throw new Error('Missing conversation question turn association');
    return {
      questionId: q.question_id,
      title: q.title,
      question: q.question_text,
      responseMode: q.response_mode,
      options: JSON.parse(q.options_json),
      status: q.status,
      answerValue: q.answer_value,
      answerType: q.answer_type,
      answeredAt: q.answered_at,
      threadId: q.thread_id,
      agentGroupId: groupId,
      createdAt: q.created_at,
      messageId: q.message_out_id,
      ...(anchor?.content && outboundTimelinePosition(anchor.content) !== undefined
        ? { timelinePosition: outboundTimelinePosition(anchor.content) }
        : {}),
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
    questions: scopedQuestions,
    connection: { connected, activeTurnId: active?.id ?? null },
    capabilities: {
      canSend: context.canSend,
      stop: actionable,
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
  const history = readChatHistory(userId, groupId, threadId, override, { includeCancelled: true });
  const outDb = context.sessionId ? openOutboundDb(groupId, context.sessionId) : null;
  try {
    const questions = context.sessionId
      ? (getDb()
          .prepare('SELECT * FROM questions WHERE session_id = ? ORDER BY created_at, question_id')
          .all(context.sessionId) as QuestionRow[])
      : [];
    return projectConversation(
      outDb,
      context,
      threadId,
      groupId,
      history,
      questions,
      getSessionTurnSignals(context.sessionId ?? ''),
    );
  } finally {
    outDb?.close();
  }
}
