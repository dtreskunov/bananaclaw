import { randomUUID } from 'node:crypto';
import type { SyncFrame, SyncResponse } from '../../shared/sync.js';
import { SYNC_PROTOCOL_VERSION } from '../../shared/sync.js';

export interface SyncStreamOptions {
  read: (groupId: string | null) => Promise<Omit<SyncResponse, 'conversation'>>;
  authorize: () => void;
  subscribe: (invalidate: (groupId?: string) => void) => () => void;
  deadline: () => number | null;
  send: (frame: SyncFrame) => void;
  fail: (error: unknown) => void;
  coalesceMs?: number;
}

/** Full authoritative snapshots; one in-flight build and one dirty bit, never a queue. */
export function startSyncStream(options: SyncStreamOptions) {
  const streamId = randomUUID();
  let subscription: { id: number; groupId: string | null } | null = null;
  let revision = 0;
  let previous: string | null = null;
  let dirty = false;
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
      if (current !== subscription || dirty) {
        dirty = true;
        return;
      }
      const encoded = JSON.stringify(data);
      if (previous !== encoded) {
        options.send({
          kind: 'sync',
          protocolVersion: SYNC_PROTOCOL_VERSION,
          streamId,
          subscriptionId: current.id,
          groupId: current.groupId,
          revision: revision++,
          data,
        });
        previous = encoded;
      }
      clearTimeout(deadlineTimer);
      const deadline = options.deadline();
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
      if (dirty && !stopped) schedule();
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
