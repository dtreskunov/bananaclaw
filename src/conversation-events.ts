import { log } from './log.js';
import path from 'node:path';

type Listener = (sessionId: string | null) => void;
const listeners = new Set<Listener>();

/** Invalidation only: subscribers must re-authorize and read the committed projection. */
export function onConversationChange(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function invalidateConversation(sessionId: string | null): void {
  for (const listener of listeners) {
    try {
      listener(sessionId);
    } catch (err) {
      log.error('Conversation invalidation listener failed', { sessionId, err });
    }
  }
}

/** DB helpers can run inside a synchronous outer transaction: read only after it unwinds.
 * A rollback may invalidate, but cannot publish a mutation or advance a stream revision. */
export function invalidateSessionDatabase(filename: string): void {
  if (filename === ':memory:') return;
  const sessionId = path.basename(path.dirname(filename));
  queueMicrotask(() => invalidateConversation(sessionId));
}
