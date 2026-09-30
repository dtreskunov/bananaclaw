import { randomUUID } from 'node:crypto';
import type { Conversation } from '../../shared/conversation.js';
import {
  CONVERSATION_PROTOCOL_VERSION,
  diffConversation,
  type ConversationFrame,
  type ConversationSnapshot,
} from '../../shared/conversation-protocol.js';

export function conversationSnapshot(conversation: Conversation): ConversationSnapshot {
  return {
    kind: 'snapshot',
    protocolVersion: CONVERSATION_PROTOCOL_VERSION,
    streamId: randomUUID(),
    revision: 0,
    conversation,
  };
}

export interface ConversationStreamOptions {
  read: () => Conversation;
  subscribe: (invalidate: () => void) => () => void;
  send: (frame: ConversationFrame) => void;
  fail: (error: unknown) => void;
  coalesceMs?: number;
}

export function sendConversationFrame(
  socket: {
    bufferedAmount: number;
    readyState: number;
    send: (data: string) => void;
    close: (code: number, reason: string) => void;
  },
  frame: ConversationFrame,
): void {
  const encoded = JSON.stringify(frame);
  if (socket.bufferedAmount > 1024 * 1024 || Buffer.byteLength(encoded) > 16 * 1024 * 1024) {
    socket.close(1013, 'Conversation buffer limit; reconnect for a snapshot');
    throw new Error('Conversation transport buffer limit');
  }
  if (socket.readyState !== 1) throw new Error('Conversation socket is not open');
  socket.send(encoded);
}

/** One bounded dirty bit, not a frame queue. Subscribe before the first read and
 * re-read after its boundary when invalidated during initialization. */
export function startConversationStream(options: ConversationStreamOptions): () => void {
  let state: ConversationSnapshot | null = null;
  let stopped = false;
  let dirty = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let unsubscribe = () => {};
  const stop = () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    unsubscribe();
  };
  const refresh = () => {
    timer = undefined;
    if (stopped) return;
    dirty = false;
    try {
      const next = options.read();
      if (state && JSON.stringify(state.conversation) === JSON.stringify(next)) return;
      const frame: ConversationFrame = state
        ? {
            kind: 'update',
            protocolVersion: CONVERSATION_PROTOCOL_VERSION,
            streamId: state.streamId,
            baseRevision: state.revision,
            revision: state.revision + 1,
            changes: diffConversation(state.conversation, next),
          }
        : conversationSnapshot(next);
      options.send(frame);
      state = {
        kind: 'snapshot',
        protocolVersion: CONVERSATION_PROTOCOL_VERSION,
        streamId: frame.streamId,
        revision: frame.revision,
        conversation: next,
      };
    } catch (error) {
      stop();
      options.fail(error);
    } finally {
      if (dirty && !stopped) schedule();
    }
  };
  const schedule = () => {
    if (stopped) return;
    dirty = true;
    if (!state || timer) return;
    timer = setTimeout(refresh, options.coalesceMs ?? 40);
    timer.unref?.();
  };
  unsubscribe = options.subscribe(schedule);
  refresh();
  return stop;
}
