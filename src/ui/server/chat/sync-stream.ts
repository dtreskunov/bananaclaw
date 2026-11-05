import type { SyncFrame, GlobalSyncState } from '../../shared/sync.js';
import { SYNC_PROTOCOL_VERSION } from '../../shared/sync.js';

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
  read: (groupId: string | null, refreshThreads: boolean) => Promise<GlobalSyncState>;
  authorize: () => void;
  canPublish: () => boolean;
  subscribe: (invalidate: (groupId?: string, refreshThreads?: boolean) => void) => () => void;
  send: (frame: SyncFrame) => void;
  fail: (error: unknown) => void;
  coalesceMs?: number;
}

/** Full authoritative snapshots; one in-flight build and one dirty bit, never a queue. */
export function startSyncStream(options: SyncStreamOptions) {
  let subscription: { id: number; groupId: string | null } | null = null;
  let previous: string | null = null;
  let dirty = false;
  let threadsDirty = false;
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
  const schedule = (groupId?: string, refreshThreads = true) => {
    if (stopped || (groupId !== undefined && groupId !== subscription?.groupId)) return;
    dirty = true;
    threadsDirty ||= refreshThreads;
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
    const refreshThreads = threadsDirty;
    dirty = false;
    threadsDirty = false;
    const current = subscription;
    try {
      options.authorize();
      const data = await options.read(current.groupId, refreshThreads);
      if (stopped) return;
      options.authorize();
      if (current !== subscription) return;
      if (!options.canPublish()) {
        schedule();
        return;
      }
      const encoded = JSON.stringify(data);
      if (previous !== encoded) {
        options.send({
          kind: 'sync',
          protocolVersion: SYNC_PROTOCOL_VERSION,
          subscriptionId: current.id,
          groupId: current.groupId,
          global: data,
        });
        previous = encoded;
      }
    } catch (error) {
      if (!stopped) {
        stop();
        options.fail(error);
      }
    } finally {
      running = false;
      if (dirty && !stopped) schedule(undefined, false);
    }
  };
  unsubscribe = options.subscribe(schedule);
  return {
    stop,
    subscribe(id: number, groupId: string | null, refreshThreads = true) {
      if (stopped || (subscription && id <= subscription.id)) return;
      subscription = { id, groupId };
      previous = null;
      schedule(undefined, refreshThreads);
    },
  };
}
