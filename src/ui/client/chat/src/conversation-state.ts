import { batch, signal } from '@preact/signals';
import type { Conversation, ConversationTrace } from '../../../shared/conversation';
import { conversationActivity } from '../../../shared/conversation-activity';
import {
  ConversationProtocolError,
  parseConversationFrame,
  reduceConversation,
  type ConversationSnapshot,
} from '../../../shared/conversation-protocol';
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
import { inheritActivityTrace, resetActivityTraceView } from './activity-trace-state';
import { completedResponseId } from './turn-completion';
import type { ChatMessage, TranscriptRow } from './types';

export const conversationState = signal<ConversationSnapshot | null>(null);
export const completedResponse = signal<string | null>(null);
export const chatTranscript = signal<TranscriptRow[]>([]);
export function resetConversation(): void {
  conversationState.value = null;
  completedResponse.value = null;
  resetActivityTraceView();
  chatTranscript.value = [];
}

export function conversationPresentation(view: Conversation): { messages: ChatMessage[]; transcript: TranscriptRow[] } {
  const turns = new Map(view.turns.map((turn) => [turn.id, turn]));
  const questions = new Map(view.questions.map((question) => [question.questionId, question]));
  const messages: ChatMessage[] = view.messages
    .filter((message) => message.inputState?.status !== 'cancelled')
    .map(({ timestamp, ...message }) => ({ ...message, files: message.files ?? null, ts: timestamp }));
  const byId = new Map(messages.map((message) => [message.id, message]));
  const answeredQuestions = new Set(
    messages.filter((message) => message.questionId).map((message) => message.questionId),
  );
  const traceLines = (trace: ConversationTrace) => {
    const turn = turns.get(trace.turnId);
    if (!turn) throw new ConversationProtocolError('invalid_frame');
    const ordinals = new Set(trace.ordinals);
    const activity = turn.activity.filter((line) => ordinals.has(line.ordinal));
    return trace.ownsTurn ? conversationActivity({ ...turn, activity }) : activity;
  };
  const transcript = view.timeline.flatMap((row): TranscriptRow[] => {
    const turn = row.trace ? turns.get(row.trace.turnId) : undefined;
    if (row.kind === 'message') {
      const message = byId.get(row.messageId);
      if (!message) throw new ConversationProtocolError('invalid_frame');
      if (row.statsTurnId) message.statsTurn = turns.get(row.statsTurnId);
      if (row.trace) {
        message.turnId = row.trace.turnId;
        message.activity = traceLines(row.trace);
        message.turnTraceOwner = row.trace.ownsTurn;
        message.turnTraceLive = row.trace.ownsTurn && turn?.phase !== 'settled';
      }
      if (message.questionId) {
        const question = questions.get(message.questionId);
        if (!question || message.direction !== 'in') throw new ConversationProtocolError('invalid_frame');
        return [{ kind: 'question', question, answer: message }];
      }
      return [{ kind: 'message', message }];
    }
    if (row.kind === 'question') {
      const question = questions.get(row.questionId);
      if (!question) throw new ConversationProtocolError('invalid_frame');
      return answeredQuestions.has(question.questionId) ? [] : [{ kind: 'question', question }];
    }
    if (!turn || turn.id !== row.turnId) throw new ConversationProtocolError('invalid_frame');
    return [
      {
        kind: 'turn',
        turn,
        afterId: row.afterId,
        activity: traceLines(row.trace),
        status: row.status,
        traceOwner: row.trace.ownsTurn ? `turn:${turn.id}` : `turn:${turn.id}:after:${row.afterId ?? 'start'}`,
      },
    ];
  });
  return {
    messages: transcript.flatMap((row) => (row.kind === 'message' ? [row.message] : [])),
    transcript,
  };
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
  const { messages, transcript } = conversationPresentation(view);
  batch(() => {
    conversationState.value = next;
    for (const message of view.messages) {
      if (message.inputState?.status === 'cancelled') confirmCancelledInput(message.id);
    }
    if (frame.kind === 'snapshot') resetActivityTraceView();
    else if (current && current.phase !== 'settled' && current.id !== previous?.conversation.connection.activeTurnId)
      inheritActivityTrace(`turn:${current.id}`);
    chatMessages.value = messages;
    chatTranscript.value = transcript;
    if (frame.kind === 'update') {
      const response = completedResponseId(previous?.conversation ?? null, messages);
      if (response) completedResponse.value = response;
    }
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
