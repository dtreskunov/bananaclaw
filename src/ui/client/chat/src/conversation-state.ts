import { batch, signal } from '@preact/signals';
import type { Conversation, ConversationTurn } from '../../../shared/conversation';
import {
  ConversationProtocolError,
  parseConversationFrame,
  reduceConversation,
  type ConversationSnapshot,
} from '../../../shared/conversation-protocol';
import { timelineSortKey } from '../../../shared/timeline';
import { turnRowView } from './turn-row';
import {
  activeTurn,
  canSend,
  chatLoading,
  chatMessages,
  chatReady,
  chatStatus,
  pendingQuestions,
  pendingWebSends,
  refs,
} from './state';
import { applyTurnState } from './stop-turn';
import { confirmCancelledInput } from './pending-cancel';
import { playCompletionChime, playProgressTick } from './sound';
import { maybeNotify } from './notify';
import type { ChatMessage } from './types';

export const conversationState = signal<ConversationSnapshot | null>(null);
export function resetConversation(): void {
  conversationState.value = null;
}

/** Activity `ts` is epoch milliseconds; imported history may carry ISO text or nothing usable. */
function activityKey(ts: string): number | null {
  const ms = /^\d+$/.test(ts) ? Number(ts) : Date.parse(ts);
  return Number.isFinite(ms) ? ms * 1000 : null;
}

/**
 * A turn renders as system rows of activity between its own messages: each steering input or
 * mid-turn output starts a new row, so work done before and after it reads in order. Settled
 * accounting belongs on the turn's last reply; only a turn without one keeps a status row.
 */
export function conversationMessages(view: Conversation): ChatMessage[] {
  const turns = new Map(view.turns.map((turn) => [turn.id, turn]));
  const key = (m: Conversation['messages'][number]) => timelineSortKey(m.timestamp, m.timelinePosition);
  const statsHosts = new Map<string, ConversationTurn>();
  for (const turn of view.turns) {
    if (turn.phase !== 'settled') continue;
    const replies = view.messages.filter((m) => turn.outputIds.includes(m.id) && m.direction === 'out');
    const last = replies.sort((a, b) => key(a) - key(b)).at(-1);
    if (last) statsHosts.set(last.id, turn);
  }
  const messages: ChatMessage[] = view.messages
    .filter((m) => m.inputState?.status !== 'cancelled')
    .map(({ timestamp, ...m }) => {
      const turn = m.turnId ? turns.get(m.turnId) : undefined;
      const statsTurn = statsHosts.get(m.id);
      return {
        ...m,
        files: m.files ?? null,
        ts: timestamp,
        ...(turn?.activity.length ? { activity: undefined } : {}),
        ...(turn?.usage.length ? { usage: undefined } : {}),
        ...(turn?.metadata.durationMs !== null && turn?.metadata.durationMs !== undefined
          ? { turnStats: undefined, stoppedStats: undefined }
          : {}),
        ...(statsTurn ? { statsTurn } : {}),
      };
    });
  for (const turn of view.turns) {
    const anchor = view.messages.find((m) => turn.outputIds.includes(m.id) || turn.inputIds.includes(m.id));
    const inputs = view.messages.filter((m) => turn.inputIds.includes(m.id));
    const outputs = view.messages.filter((m) => turn.outputIds.includes(m.id));
    const firstInput = inputs.length ? Math.min(...inputs.map(key)) : null;
    const firstOutput = outputs.length ? Math.min(...outputs.map(key)) : null;
    const ts =
      turn.startedAt ??
      anchor?.timestamp ??
      view.questions.find((q) => q.turnId === turn.id)?.createdAt ??
      turn.endedAt ??
      '';
    // Imported history has no start time; its trace belongs directly above its own reply.
    const start =
      !turn.startedAt && firstOutput !== null
        ? Math.max(firstOutput - 1, firstInput !== null ? firstInput + 1 : 0)
        : firstInput !== null
          ? Math.max(timelineSortKey(ts), firstInput + 1)
          : null;
    // Only live-recorded turns have step times comparable with message positions. Inputs still
    // waiting to be applied sit in the composer tray, not in the transcript.
    const boundaries = turn.startedAt
      ? [...inputs, ...outputs]
          .filter((m) => m.inputState?.status !== 'steering' && m.inputState?.status !== 'cancelled')
          .map(key)
          .filter((position) => firstInput === null || position > firstInput)
          .sort((a, b) => a - b)
      : [];
    const segmentOf = (ts: string): number => {
      const at = activityKey(ts);
      return at === null ? 0 : boundaries.filter((boundary) => boundary <= at).length;
    };
    const segments = new Map<number, ConversationTurn['activity']>();
    for (const line of turn.activity) {
      const index = segmentOf(line.ts);
      segments.set(index, [...(segments.get(index) ?? []), line]);
    }
    const settled = turn.phase === 'settled';
    // Live status follows the newest turn message; settled status needs a row only without a reply.
    const statusSegment = !settled
      ? boundaries.length
      : [...statsHosts.values()].includes(turn) || turnRowView(turn, 0).hidden
        ? null
        : Math.max(-1, ...segments.keys()) >= 0
          ? Math.max(...segments.keys())
          : 0;
    if (statusSegment !== null && !segments.has(statusSegment)) segments.set(statusSegment, []);
    for (const [index, lines] of segments) {
      const position = index === 0 ? start : boundaries[index - 1] + 1;
      messages.push({
        id: index === 0 ? `turn:${turn.id}` : `turn:${turn.id}:${index}`,
        direction: 'turn',
        turn,
        activity: lines,
        ...(index === statusSegment ? { turnStatus: true } : {}),
        text: turn.outcome,
        files: null,
        ts,
        ...(position !== null ? { timelinePosition: position } : {}),
      });
    }
  }
  return messages.sort((a, b) => timelineSortKey(a.ts, a.timelinePosition) - timelineSortKey(b.ts, b.timelinePosition));
}

export function applyConversationFrame(raw: unknown, expectedThreadId: string): void {
  const frame = parseConversationFrame(raw);
  const previous = conversationState.value;
  const next = reduceConversation(previous, frame);
  if (next.conversation.threadId !== expectedThreadId) throw new ConversationProtocolError('invalid_frame');
  if (next === previous) return;
  const view = next.conversation;
  const current = view.turns.find((turn) => turn.id === view.connection.activeTurnId);
  const caps = view.capabilities;
  batch(() => {
    conversationState.value = next;
    for (const message of view.messages) {
      if (message.inputState?.status === 'cancelled') confirmCancelledInput(message.id);
    }
    chatMessages.value = conversationMessages(view);
    pendingQuestions.value = view.questions;
    const inputs = new Set(view.messages.filter((m) => m.direction === 'in').map((m) => m.id));
    pendingWebSends.value = pendingWebSends.value.filter(
      (send) => send.threadId !== expectedThreadId || !inputs.has(send.messageId),
    );
    refs.seenIds = new Set(view.messages.map((m) => `${m.direction}:${m.id}`));
    canSend.value = caps.canSend;
    applyTurnState(
      current
        ? {
            id: current.id,
            status: current.phase === 'stopping' ? 'stopping' : 'running',
            supportsSteering: caps.steer,
            supportsInputEditing: caps.editInput,
            supportsInputCancellation: caps.cancelInput,
          }
        : null,
      view.connection.connected,
    );
    chatLoading.value = false;
    chatReady.value = true;
    chatStatus.value = 'connected';
  });
  // A snapshot (including reconnect) is not evidence of a newly completed turn.
  if (frame.kind !== 'update' || !previous) return;
  const oldTurns = new Map(previous.conversation.turns.map((turn) => [turn.id, turn]));
  for (const turn of view.turns) {
    if (turn.phase === 'settled' && oldTurns.get(turn.id)?.phase !== 'settled') playCompletionChime();
    else if (
      turn.id === activeTurn.value?.id &&
      JSON.stringify(turn.activity) !== JSON.stringify(oldTurns.get(turn.id)?.activity)
    )
      playProgressTick();
  }
  const oldOutputs = new Set(previous.conversation.messages.filter((m) => m.direction === 'out').map((m) => m.id));
  for (const message of view.messages) {
    if (message.direction === 'out' && !oldOutputs.has(message.id)) maybeNotify(message.text, message.files ?? []);
  }
}
