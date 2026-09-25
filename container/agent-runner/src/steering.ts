import { createHash } from 'node:crypto';
import { getOutboundDb } from './db/connection.js';
import type { MessageInRow } from './db/messages-in.js';
import { isRunnerCommand, type RoutingContext } from './formatter.js';

export interface InputState {
  messageId: string;
  status: 'queued' | 'steering' | 'applied' | 'processing';
  turnId?: string;
  reason?: 'turn_finished' | 'different_conversation' | 'unsupported';
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
  const value = JSON.stringify(state);
  getOutboundDb().prepare(
    `INSERT INTO session_state (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at
     WHERE session_state.value != excluded.value`,
  ).run(key, value, new Date().toISOString());
}

export function startInputProcessing(messages: MessageInRow[]): void {
  for (const message of messages) {
    if (!['chat', 'chat-sdk'].includes(message.kind)) continue;
    const previous = readInputState(message.id);
    if (previous?.status === 'applied') continue;
    const intent = inputHandling(message);
    writeInputState({
      messageId: message.id,
      status: 'processing',
      ...(intent?.mode === 'steer' || previous?.status === 'steering'
        ? { reason: 'turn_finished' as const }
        : previous?.reason ? { reason: previous.reason } : {}),
    });
  }
}
