import { log } from './log.js';

export type HostChange =
  | { kind: 'activity'; sessionId: string }
  | { kind: 'interactions'; sessionId?: string | null }
  | { kind: 'sessions'; sessionId?: string | null; groupId?: string | null }
  | { kind: 'configuration'; groupId?: string | null }
  | { kind: 'access'; groupId?: string };

const listeners = new Set<(change: HostChange) => void>();
let pending = new Map<string, HostChange>();
let accessRevision = 0;

export function hostAccessRevision(): number {
  return accessRevision;
}

export function onHostChange(listener: (change: HostChange) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Identifiers only. Consumers authorize and read their own committed projection. */
export function publishHostChange(change: HostChange): void {
  if (change.kind === 'access') ++accessRevision;
  if (!listeners.size) return;
  const scheduled = pending.size > 0;
  if (change.kind === 'access' || pending.size >= 1024) {
    pending.clear();
    pending.set('access', { kind: 'access' });
  } else if (!pending.has('access')) pending.set(JSON.stringify(change), change);
  if (scheduled) return;
  queueMicrotask(() => {
    const changes = pending;
    pending = new Map();
    for (const entry of changes.values())
      for (const listener of listeners) {
        try {
          listener(entry);
        } catch (err) {
          log.error('Host change listener failed', { change: entry, err });
        }
      }
  });
}
