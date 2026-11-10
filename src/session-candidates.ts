import { getActiveSessions, getSession, getSessionsByAgentGroup } from './db/sessions.js';
import { onHostChange } from './host-changes.js';
import type { Session } from './types.js';

export class SessionCandidates {
  private readonly entries = new Map<string, { at: number }>();
  private unsubscribe?: () => void;

  start(): void {
    this.stop();
    this.unsubscribe = onHostChange((change) => {
      if (
        change.kind !== 'sessions' &&
        change.kind !== 'runtime' &&
        change.kind !== 'configuration' &&
        change.kind !== 'access'
      )
        return;
      if ('sessionId' in change && change.sessionId) {
        this.invalidate(change.sessionId);
      } else {
        const sessions = change.groupId ? getSessionsByAgentGroup(change.groupId) : getActiveSessions();
        for (const session of sessions) this.invalidate(session.id);
      }
    });
    for (const session of getActiveSessions()) this.invalidate(session.id);
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.entries.clear();
  }

  private invalidate(sessionId: string): void {
    this.entries.set(sessionId, { at: 0 });
  }

  token(sessionId: string): object | undefined {
    return this.entries.get(sessionId);
  }

  inspected(sessionId: string, token: object | undefined, at: number | null): void {
    const entry = this.entries.get(sessionId);
    // A commit during inspection must survive the older inspection's result.
    if (!entry || entry !== token) return;
    if (at === null) this.entries.delete(sessionId);
    else entry.at = at;
  }

  *due(): Iterable<Session> {
    const now = Date.now();
    for (const [id, entry] of [...this.entries]) {
      if (entry.at > now) continue;
      const session = getSession(id);
      if (session?.status === 'active') yield session;
      else this.entries.delete(id);
    }
  }
}
