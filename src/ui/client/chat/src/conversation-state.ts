import { batch, signal } from '@preact/signals';
import type { Conversation } from '../../../shared/conversation';
import {
  ConversationProtocolError,
  parseConversationFrame,
  reduceConversation,
  type ConversationSnapshot,
} from '../../../shared/conversation-protocol';
import { timelineSortKey } from '../../../shared/timeline';
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

/** Rendering has its own stable turn row, independent of zero/one/many output messages. */
export function conversationMessages(view: Conversation): ChatMessage[] {
  const turns = new Map(view.turns.map((turn) => [turn.id, turn]));
  const messages: ChatMessage[] = view.messages
    .filter((m) => m.inputState?.status !== 'cancelled')
    .map(({ timestamp, ...m }) => {
      const turn = m.turnId ? turns.get(m.turnId) : undefined;
      return {
        ...m,
        files: m.files ?? null,
        ts: timestamp,
        ...(turn?.activity.length ? { activity: undefined } : {}),
        ...(turn?.usage.length ? { usage: undefined } : {}),
        ...(turn?.metadata.durationMs !== null && turn?.metadata.durationMs !== undefined
          ? { turnStats: undefined, stoppedStats: undefined }
          : {}),
      };
    });
  for (const turn of view.turns) {
    const anchor = view.messages.find((m) => turn.outputIds.includes(m.id) || turn.inputIds.includes(m.id));
    const key = (m: Conversation['messages'][number]) => timelineSortKey(m.timestamp, m.timelinePosition);
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
    const position =
      !turn.startedAt && firstOutput !== null
        ? Math.max(firstOutput - 1, firstInput !== null ? firstInput + 1 : 0)
        : firstInput !== null
          ? Math.max(timelineSortKey(ts), firstInput + 1)
          : null;
    messages.push({
      id: `turn:${turn.id}`,
      direction: 'turn',
      turn,
      text: turn.outcome,
      files: null,
      ts,
      ...(position !== null ? { timelinePosition: position } : {}),
    });
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
