import { createHash } from 'node:crypto';
import { getInboundDb, getOutboundDb } from './db/connection.js';
import { getMessageIn, getPendingInputEdits, markCompleted, markProcessing, type MessageInRow } from './db/messages-in.js';
import { allocateTimelinePosition } from './db/timeline.js';
import { extractFileAttachments, formatMessages, isRunnerCommand, type RoutingContext } from './formatter.js';
import type { AgentProvider, AgentQuery } from './providers/types.js';

export interface InputEditReceipt {
  requestId: string;
  messageId: string;
  status: 'accepted' | 'conflict';
  reason?: 'not_pending' | 'text_changed' | 'steering_consumed' | 'unsupported';
}

export function readInputEditReceipt(requestId: string, operation: 'edit' | 'cancel' = 'edit'): InputEditReceipt | undefined {
  const row = getOutboundDb().prepare('SELECT value FROM session_state WHERE key = ?')
    .get(`input-${operation}:${requestId}`) as { value: string } | null;
  return row ? JSON.parse(row.value) as InputEditReceipt : undefined;
}

/** No awaits: pending mutations, provider buffer changes and commit share one JS turn. */
export function processPendingInputEdits(
  provider: AgentProvider,
  continuation?: string,
  active?: { query: AgentQuery; steeringInputs: Map<string, MessageInRow> },
): void {
  for (const request of getPendingInputEdits()) {
    const input = JSON.parse(request.content) as {
      action?: unknown; requestId?: unknown; messageId?: unknown; expectedText?: unknown; replacementText?: unknown;
    };
    // A malformed control row must fail visibly rather than enter the model prompt.
    if (typeof input.requestId !== 'string' || typeof input.messageId !== 'string') {
      throw new Error(`Malformed input mutation request ${request.id}`);
    }
    const requestId = input.requestId;
    const messageId = input.messageId;
    const cancelling = input.action === 'cancel_input';
    const operation = cancelling ? 'cancel' : 'edit';
    const db = getOutboundDb();
    let replaced = false;
    let updated: MessageInRow | undefined;
    try {
      db.transaction(() => {
        if (readInputEditReceipt(requestId, operation)) {
          markCompleted([request.id]);
          return;
        }
        const receipt: InputEditReceipt = { requestId, messageId, status: 'conflict' };
        const target = getMessageIn(messageId);
        const inputState = readInputState(messageId);
        const sameAuthor = target &&
          (target.sender_user_id || target.sender_identity) &&
          (target.sender_user_id ?? null) === (request.sender_user_id ?? null) &&
          (target.sender_identity ?? null) === (request.sender_identity ?? null);
        if ((cancelling ? provider.supportsInputCancellation : provider.supportsInputEditing) !== true ||
          request.id !== `${operation}-${requestId}` ||
          (!cancelling && (typeof input.expectedText !== 'string' || typeof input.replacementText !== 'string'))) {
          receipt.reason = 'unsupported';
        } else if (!target || !['chat', 'chat-sdk'].includes(target.kind) || target.channel_type !== 'web' ||
          request.channel_type !== target.channel_type || request.platform_id !== target.platform_id ||
          request.thread_id !== target.thread_id || !sameAuthor || target.source_session_id != null ||
          target.status !== 'pending' || target.trigger !== 1 ||
          inputState?.status === 'processing' || inputState?.status === 'applied' || inputState?.status === 'cancelled' ||
          db.prepare('SELECT 1 FROM claimed_inputs WHERE message_id = ?').get(messageId) ||
          db.prepare('SELECT 1 FROM processing_ack WHERE message_id = ?').get(messageId) ||
          (continuation && provider.appliedSteering?.(continuation, [messageId]).includes(messageId))) {
          receipt.reason = 'not_pending';
        } else {
          const content = JSON.parse(target.content) as Record<string, unknown>;
          if (!cancelling && content.text !== input.expectedText) {
            receipt.reason = 'text_changed';
          } else {
            const candidate = {
              ...target,
              ...(cancelling ? { status: 'completed' } : {}),
              content: JSON.stringify({ ...content, ...(cancelling ? { cancelled: true } : { text: input.replacementText }) }),
            };
            if (active?.steeringInputs.has(messageId)) {
              const files = extractFileAttachments([candidate]);
              replaced = cancelling ? active.query.cancelSteering?.(messageId) === true : active.query.replaceSteering?.({
                id: messageId, prompt: formatMessages([candidate]), ...(files.length ? { files } : {}),
              }) === true;
              if (!replaced) receipt.reason = 'steering_consumed';
            }
            if (!receipt.reason) {
              getInboundDb().prepare('UPDATE messages_in SET content = ?, status = ? WHERE id = ?')
                .run(candidate.content, candidate.status, messageId);
              receipt.status = 'accepted';
              updated = candidate;
            }
          }
        }
        db.prepare('INSERT INTO session_state (key, value, updated_at) VALUES (?, ?, ?)')
          .run(`input-${operation}:${requestId}`, JSON.stringify(receipt), new Date().toISOString());
        if (cancelling && receipt.status === 'accepted') {
          writeInputState({ messageId, status: 'cancelled' });
          markCompleted([messageId]);
        }
        markCompleted([request.id]);
      })();
    } catch (error) {
      // A failed commit cannot leave the provider using an uncommitted buffer change.
      if (replaced) active?.query.abort();
      throw error;
    }
    if (updated && active?.steeringInputs.has(messageId)) {
      if (cancelling) active.steeringInputs.delete(messageId);
      else active.steeringInputs.set(messageId, updated);
    }
  }
}

export interface InputState {
  messageId: string;
  status: 'queued' | 'steering' | 'applied' | 'processing' | 'cancelled';
  turnId?: string;
  reason?: 'turn_finished' | 'different_conversation' | 'unsupported';
  timelinePosition?: number;
  queuedForNextTurn?: boolean;
}

export function inputHandling(message: MessageInRow): { mode: 'queue' | 'steer'; turnId?: string } | undefined {
  if (message.channel_type !== 'web') return undefined;
  let content: unknown;
  try {
    content = JSON.parse(message.content);
  } catch (error) {
    if (error instanceof SyntaxError) return undefined;
    throw error;
  }
  if (!content || typeof content !== 'object' || !('inputHandling' in content)) return undefined;
  const value = content.inputHandling;
  if (!value || typeof value !== 'object' || !('mode' in value) ||
    (value.mode !== 'queue' && value.mode !== 'steer')) return undefined;
  return {
    mode: value.mode,
    ...('turnId' in value && typeof value.turnId === 'string' ? { turnId: value.turnId } : {}),
  };
}

export function steeringDisposition(
  message: MessageInRow,
  routing: RoutingContext,
  turnId: string,
  supported: boolean,
): InputState {
  const state: InputState = { messageId: message.id, status: 'queued', turnId };
  const intent = inputHandling(message);
  if (!supported) return intent?.mode === 'steer' ? { ...state, reason: 'unsupported' } : state;
  if (!['chat', 'chat-sdk'].includes(message.kind) || message.trigger !== 1 ||
    message.source_session_id || isRunnerCommand(message) || intent?.mode === 'queue') return state;
  if (message.channel_type !== routing.channelType || message.platform_id !== routing.platformId ||
    (message.thread_id || null) !== (routing.threadId || null)) {
    return { ...state, reason: 'different_conversation' };
  }
  if (message.channel_type === 'web' && intent?.mode !== 'steer') return state;
  if (intent?.turnId && intent.turnId !== turnId) return { ...state, reason: 'turn_finished' };
  if (!message.channel_type || message.channel_type === 'cli') return state;
  return { ...state, status: 'steering' };
}

function inputKey(id: string): string {
  return `input:${createHash('sha256').update(id).digest('hex')}`;
}

export function readInputState(messageId: string): InputState | undefined {
  const row = getOutboundDb().prepare('SELECT value FROM session_state WHERE key = ?')
    .get(inputKey(messageId)) as { value: string } | undefined;
  return row ? JSON.parse(row.value) as InputState : undefined;
}

export function writeInputState(state: InputState): void {
  const key = inputKey(state.messageId);
  const db = getOutboundDb();
  db.transaction(() => {
    const previous = readInputState(state.messageId);
    if (previous?.status === 'cancelled' && state.status !== 'cancelled') {
      throw new Error(`Cannot revive cancelled input ${state.messageId}`);
    }
    const consuming = state.status === 'processing' || state.status === 'applied';
    const timelinePosition = previous?.timelinePosition ?? (consuming ? allocateTimelinePosition(db) : undefined);
    const { timelinePosition: _position, queuedForNextTurn: _queued, ...disposition } = state;
    const value = JSON.stringify({
      ...disposition,
      ...(timelinePosition !== undefined ? { timelinePosition } : {}),
      ...(state.status === 'queued' && timelinePosition === undefined &&
        (state.queuedForNextTurn || previous?.queuedForNextTurn)
        ? { queuedForNextTurn: true } : {}),
    });
    db.prepare(
      `INSERT INTO session_state (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at
       WHERE session_state.value != excluded.value`,
    ).run(key, value, new Date().toISOString());
  }).immediate();
}

export function startInputProcessing(messages: MessageInRow[]): void {
  getOutboundDb().transaction(() => {
    for (const message of messages) {
      if (!['chat', 'chat-sdk'].includes(message.kind)) continue;
      const previous = readInputState(message.id);
      if (previous?.status === 'applied') {
        writeInputState(previous);
        continue;
      }
      const intent = inputHandling(message);
      writeInputState({
        messageId: message.id,
        status: 'processing',
        ...(intent?.mode === 'steer' || previous?.status === 'steering'
          ? { reason: 'turn_finished' as const }
          : previous?.reason ? { reason: previous.reason } : {}),
      });
    }
    markProcessing(messages.map((message) => message.id));
  }).immediate();
}
