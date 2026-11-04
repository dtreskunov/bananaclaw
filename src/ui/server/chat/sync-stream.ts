import type { SyncFrame, GlobalSyncState } from '../../shared/sync.js';
import { SYNC_PROTOCOL_VERSION } from '../../shared/sync.js';

export interface SyncStreamOptions {
  read: (groupId: string | null, refreshThreads: boolean) => Promise<GlobalSyncState>;
  authorize: () => number | null;
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
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  let unsubscribe = () => {};
  const stop = () => {
    if (stopped) return;
    stopped = true;
    clearTimeout(timer);
    clearTimeout(deadlineTimer);
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
      const deadline = options.authorize();
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
          data,
        });
        previous = encoded;
      }
      clearTimeout(deadlineTimer);
      if (deadline !== null) {
        deadlineTimer = setTimeout(() => schedule(), Math.min(2_147_483_647, Math.max(1, deadline - Date.now())));
        deadlineTimer.unref?.();
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
    subscribe(id: number, groupId: string | null) {
      if (stopped || (subscription && id <= subscription.id)) return;
      subscription = { id, groupId };
      previous = null;
      schedule();
    },
  };
}
