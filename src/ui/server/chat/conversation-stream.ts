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
  read: () => Conversation | null;
  subscribe: (invalidate: () => void) => () => void;
  send: (frame: ConversationFrame | null) => void;
  fail: (error: unknown) => void;
  canSend?: () => boolean;
  coalesceMs?: number;
}

/** One bounded dirty bit, not a frame queue. Subscribe before the first read and
 * re-read after its boundary when invalidated during initialization. */
export function startConversationStream(options: ConversationStreamOptions): () => void {
  let state: ConversationSnapshot | null | undefined;
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
      if (options.canSend && !options.canSend()) {
        timer = setTimeout(refresh, options.coalesceMs ?? 40);
        timer.unref?.();
        return;
      }
      const next = options.read();
      if (state !== undefined && JSON.stringify(state?.conversation ?? null) === JSON.stringify(next)) return;
      const frame: ConversationFrame | null =
        next === null
          ? null
          : state
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
      state =
        frame && next
          ? {
              kind: 'snapshot',
              protocolVersion: CONVERSATION_PROTOCOL_VERSION,
              streamId: frame.streamId,
              revision: frame.revision,
              conversation: next,
            }
          : null;
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
    if (state === undefined || timer) return;
    timer = setTimeout(refresh, options.coalesceMs ?? 40);
    timer.unref?.();
  };
  unsubscribe = options.subscribe(schedule);
  refresh();
  return stop;
}
