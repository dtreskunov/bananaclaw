import { log } from './log.js';

export type UiChange = { kind: 'interactions' } | { kind: 'group'; groupId: string } | { kind: 'access' };

const listeners = new Set<(change: UiChange) => void>();
let pending = new Map<string, UiChange>();

export function onUiChange(listener: (change: UiChange) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Re-read committed state after synchronous outer transactions have unwound. */
export function invalidateUi(change: UiChange): void {
  if (!listeners.size) return;
  const scheduled = pending.size > 0;
  if (change.kind === 'access' || pending.size >= 1024) {
    pending.clear();
    pending.set('access', { kind: 'access' });
  } else if (!pending.has('access')) {
    pending.set(JSON.stringify(change), change);
  }
  if (scheduled) return;
  queueMicrotask(() => {
    const changes = pending;
    pending = new Map();
    for (const entry of changes.values()) {
      for (const listener of listeners) {
        try {
          listener(entry);
        } catch (error) {
          log.error('UI invalidation listener failed', { change: entry, err: error });
        }
      }
    }
  });
}
