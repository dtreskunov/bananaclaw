import { randomUUID } from 'node:crypto';
import type { SyncFrame, GlobalSyncState, GlobalProjection, GlobalFrame, ProjectionCursor } from '../../shared/sync.js';
import { diffGlobal, SYNC_PROTOCOL_VERSION } from '../../shared/sync.js';
import { sameValue } from '../../shared/collection-patch.js';

export function sendSyncFrame(
  socket: {
    bufferedAmount: number;
    readyState: number;
    send: (data: string) => void;
    close: (code: number, reason: string) => void;
  },
  frame: SyncFrame,
): void {
  const encoded = JSON.stringify(frame);
  if (socket.bufferedAmount > 1024 * 1024 || Buffer.byteLength(encoded) > 16 * 1024 * 1024) {
    socket.close(1013, 'Synchronization buffer limit; reconnect for a snapshot');
    throw new Error('Synchronization transport buffer limit');
  }
  if (socket.readyState !== 1) throw new Error('Synchronization socket is not open');
  socket.send(encoded);
}

export interface SyncStreamOptions {
  read: (groupId: string | null) => Promise<GlobalSyncState>;
  authorize: () => void;
  canPublish: () => boolean;
  subscribe: (invalidate: (groupId?: string) => void) => () => void;
  send: (frame: SyncFrame) => void;
  fail: (error: unknown) => void;
  coalesceMs?: number;
}

/** Authoritative metadata patches; one in-flight build and one dirty bit, never a queue. */
export function startSyncStream(options: SyncStreamOptions) {
  let subscription: { id: number; groupId: string | null } | null = null;
  let previous: GlobalProjection | null = null;
  let acknowledgedId: number | null = null;
  let dirty = false;
  let running = false;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let unsubscribe = () => {};
  const stop = () => {
    if (stopped) return;
    stopped = true;
    clearTimeout(timer);
    unsubscribe();
  };
  const schedule = (groupId?: string) => {
    if (stopped || (groupId !== undefined && groupId !== subscription?.groupId)) return;
    dirty = true;
    if (running || timer || !subscription) return;
    timer = setTimeout(() => {
      void refresh();
    }, options.coalesceMs ?? 100);
    timer.unref?.();
  };
  const refresh = async () => {
    timer = undefined;
    if (stopped || running || !subscription) return;
    running = true;
    dirty = false;
    const current = subscription;
    try {
      options.authorize();
      const data = await options.read(current.groupId);
      if (stopped) return;
      options.authorize();
      if (current !== subscription) return;
      if (!options.canPublish()) {
        schedule();
        return;
      }
      if (
        !previous ||
        acknowledgedId !== current.id ||
        previous.groupId !== current.groupId ||
        !sameValue(previous.data, data)
      ) {
        const global: GlobalFrame = previous
          ? {
              kind: 'update',
              streamId: previous.streamId,
              baseRevision: previous.revision,
              revision: previous.revision + 1,
              changes: diffGlobal(previous, data, current.groupId),
            }
          : { kind: 'snapshot', streamId: randomUUID(), revision: 0, data };
        options.send({
          kind: 'sync',
          protocolVersion: SYNC_PROTOCOL_VERSION,
          subscriptionId: current.id,
          groupId: current.groupId,
          global,
        });
        previous = {
          kind: 'snapshot',
          streamId: global.streamId,
          revision: global.revision,
          groupId: current.groupId,
          data,
        };
        acknowledgedId = current.id;
      }
    } catch (error) {
      if (!stopped) {
        stop();
        options.fail(error);
      }
    } finally {
      running = false;
      if (dirty && !stopped) schedule();
    }
  };
  unsubscribe = options.subscribe(schedule);
  return {
    stop,
    subscribe(id: number, groupId: string | null, cursor: ProjectionCursor | null = null) {
      if (stopped || (subscription && id <= subscription.id)) return;
      subscription = { id, groupId };
      if (!previous || cursor?.streamId !== previous.streamId || cursor.revision !== previous.revision) previous = null;
      schedule();
    },
  };
}
