import { onHostChange } from '../../../host-changes.js';
import { getSession } from '../../../db/sessions.js';
import type { SyncFrame } from '../../shared/sync.js';
import { lookupSessionByHash } from '../db.js';
import { createGlobalProjection } from './sync-state.js';
import { startSyncStream } from './sync-stream.js';

export class SyncAuthenticationError extends Error {}

export function startGlobalSubscription(options: {
  userId: string;
  sessionHash: string;
  send: (frame: SyncFrame) => void;
  fail: (error: unknown) => void;
}) {
  const projection = createGlobalProjection(options.userId);
  return startSyncStream({
    read: projection.read,
    canPublish: projection.canPublish,
    authorize: () => {
      const session = lookupSessionByHash(options.sessionHash, { touch: false });
      if (!session || session.userId !== options.userId)
        throw new SyncAuthenticationError('Global sync authentication expired');
      const deadline = Date.parse(session.expiresAt);
      if (!Number.isFinite(deadline)) throw new SyncAuthenticationError('Invalid synchronization expiry deadline');
      return deadline;
    },
    subscribe: (invalidate) =>
      onHostChange((change) => {
        if (change.kind === 'configuration') {
          invalidate(change.groupId ?? undefined, false);
        } else if (change.kind === 'sessions') {
          const groupId =
            change.groupId ?? (change.sessionId ? getSession(change.sessionId)?.agent_group_id : undefined);
          invalidate(undefined, false);
          invalidate(groupId ?? undefined);
        } else {
          invalidate(undefined, change.kind === 'access');
        }
      }),
    send: options.send,
    fail: options.fail,
  });
}
