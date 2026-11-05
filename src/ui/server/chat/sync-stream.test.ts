import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SyncFrame, GlobalSyncState } from '../../shared/sync.js';
import { sendSyncFrame, startSyncStream, type SyncStreamOptions } from './sync-stream.js';
import { SYNC_PROTOCOL_VERSION } from '../../shared/sync.js';
import { reduceGlobal, type GlobalProjection } from '../../shared/sync.js';
import { testGlobalSnapshot } from '../../shared/sync-test-fixtures.js';

afterEach(() => vi.useRealTimers());

function fixture(overrides: Partial<SyncStreamOptions> = {}) {
  vi.useFakeTimers();
  const frames: SyncFrame[] = [];
  let state: GlobalProjection | null = null;
  let invalidate: (groupId?: string, refreshThreads?: boolean) => void = () => {};
  const unsubscribe = vi.fn();
  const read = vi.fn(
    async (_groupId: string | null, _refreshThreads: boolean): Promise<GlobalSyncState> => ({
      approvals: [],
      attention: [],
      group: null,
    }),
  );
  const fail = vi.fn();
  const stream = startSyncStream({
    read,
    authorize: () => null,
    canPublish: () => true,
    subscribe: (fn) => {
      invalidate = fn;
      return unsubscribe;
    },
    send: (frame) => {
      frames.push(frame);
      if (frame.global) state = reduceGlobal(state, frame.global, frame.groupId);
    },
    fail,
    ...overrides,
  });
  return {
    stream,
    frames,
    invalidate: (gid?: string, refreshThreads?: boolean) => invalidate(gid, refreshThreads),
    unsubscribe,
    read,
    fail,
    state: () => state,
    cursor: () => (state ? { streamId: state.streamId, revision: state.revision } : null),
  };
}

describe('global synchronization stream', () => {
  it('closes a slow transport without adding another frame to its buffer', () => {
    const socket = { bufferedAmount: 1024 * 1024 + 1, readyState: 1, close: vi.fn(), send: vi.fn() };
    expect(() =>
      sendSyncFrame(socket, {
        kind: 'sync',
        protocolVersion: SYNC_PROTOCOL_VERSION,
        subscriptionId: 1,
        groupId: null,
        global: testGlobalSnapshot({ approvals: [], attention: [], group: null }),
      }),
    ).toThrow('buffer limit');
    expect(socket.close).toHaveBeenCalledWith(1013, expect.any(String));
    expect(socket.send).not.toHaveBeenCalled();
  });
  it('sends an initial snapshot and never polls idle projections', async () => {
    const f = fixture();
    f.stream.subscribe(1, null);
    await vi.advanceTimersByTimeAsync(100);
    expect(f.frames).toHaveLength(1);
    expect(f.frames[0]).toMatchObject({ subscriptionId: 1, groupId: null });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(f.read).toHaveBeenCalledOnce();
    f.stream.stop();
    f.stream.stop();
    expect(f.unsubscribe).toHaveBeenCalledOnce();
  });

  it('coalesces bursts, ignores other groups and acknowledges unchanged refreshes', async () => {
    const f = fixture();
    f.stream.subscribe(1, 'g');
    await vi.advanceTimersByTimeAsync(100);
    f.invalidate('other');
    await vi.advanceTimersByTimeAsync(100);
    expect(f.read).toHaveBeenCalledOnce();
    for (let i = 0; i < 1000; i++) f.invalidate('g');
    await vi.advanceTimersByTimeAsync(100);
    expect(f.read).toHaveBeenCalledTimes(2);
    expect(f.frames).toHaveLength(1);
    f.stream.subscribe(2, 'g', true, f.cursor());
    await vi.advanceTimersByTimeAsync(100);
    expect(f.frames).toHaveLength(2);
    expect(f.frames[1]).toMatchObject({
      subscriptionId: 2,
      global: { kind: 'update', baseRevision: 0, revision: 1, changes: {} },
    });
    expect(JSON.stringify(f.frames[1]).length).toBeLessThan(256);
    f.stream.stop();
  });

  it('reuses global state across group navigation and replaces only the group slice', async () => {
    const f = fixture();
    f.stream.subscribe(1, 'old');
    await vi.advanceTimersByTimeAsync(100);
    const cursor = f.cursor();
    f.stream.subscribe(2, 'new', true, cursor);
    await vi.advanceTimersByTimeAsync(100);
    expect(f.frames[1].global).toMatchObject({
      kind: 'update',
      streamId: cursor?.streamId,
      changes: { group: { kind: 'replace', value: null } },
    });
    if (f.frames[1].global?.kind !== 'update') throw new Error('Expected metadata update');
    expect(JSON.parse(JSON.stringify(f.frames[1].global.changes))).toEqual({ group: { kind: 'replace', value: null } });
    expect(f.state()?.groupId).toBe('new');
    f.stream.stop();
  });

  it('resnapshots when navigation reports a cursor that missed an already published patch', async () => {
    const f = fixture();
    f.stream.subscribe(1, 'old');
    await vi.advanceTimersByTimeAsync(100);
    const stale = f.cursor();
    f.read.mockResolvedValue({
      approvals: [],
      group: null,
      attention: [
        { id: 'q', origin: { agentGroupId: 'old', threadId: 't', channelType: 'web', messagingGroupId: 'mg' } },
      ],
    });
    f.invalidate();
    await vi.advanceTimersByTimeAsync(100);
    expect(f.frames[1].global?.kind).toBe('update');
    f.stream.subscribe(2, 'new', true, stale);
    await vi.advanceTimersByTimeAsync(100);
    expect(f.frames[2].global).toMatchObject({ kind: 'snapshot', revision: 0 });
    expect(f.frames[2].global?.streamId).not.toBe(stale?.streamId);
    f.stream.stop();
  });

  it('rescans threads only when requested, including every explicit refresh', async () => {
    const f = fixture();
    f.stream.subscribe(1, 'g');
    await vi.advanceTimersByTimeAsync(100);
    f.invalidate(undefined, false);
    await vi.advanceTimersByTimeAsync(100);
    expect(f.read.mock.calls[1][1]).toBe(false);
    f.invalidate('other');
    f.invalidate('g', false);
    await vi.advanceTimersByTimeAsync(100);
    expect(f.read.mock.calls[2][1]).toBe(false);
    f.stream.subscribe(2, 'g');
    await vi.advanceTimersByTimeAsync(100);
    expect(f.read.mock.calls[3][1]).toBe(true);
    f.stream.stop();
  });

  it('does not lose a thread refresh when metadata invalidations arrive during its read', async () => {
    let finish!: (data: GlobalSyncState) => void;
    const read = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<GlobalSyncState>((resolve) => {
            finish = resolve;
          }),
      )
      .mockResolvedValue({ approvals: [], attention: [], group: null });
    const f = fixture({ read });
    f.stream.subscribe(1, 'g');
    await vi.advanceTimersByTimeAsync(100);
    f.invalidate('g');
    f.invalidate(undefined, false);
    finish({ approvals: [], attention: [], group: null });
    await vi.advanceTimersByTimeAsync(100);
    expect(read).toHaveBeenLastCalledWith('g', true);
    f.invalidate(undefined, false);
    await vi.advanceTimersByTimeAsync(100);
    expect(read).toHaveBeenLastCalledWith('g', false);
    f.stream.stop();
  });

  it('re-reads instead of publishing when access changes after the asynchronous boundary', async () => {
    let current = false;
    const f = fixture({ canPublish: () => current });
    f.stream.subscribe(1, 'g');
    await vi.advanceTimersByTimeAsync(100);
    expect(f.frames).toEqual([]);
    current = true;
    await vi.advanceTimersByTimeAsync(100);
    expect(f.frames).toHaveLength(1);
    expect(f.fail).not.toHaveBeenCalled();
    expect(f.read.mock.calls[1][1]).toBe(true);
    f.stream.stop();
  });

  it('publishes a committed metadata change within the 250 ms local update budget', async () => {
    const f = fixture();
    f.stream.subscribe(1, null);
    await vi.advanceTimersByTimeAsync(100);
    f.read.mockResolvedValue({
      approvals: [],
      group: null,
      attention: [
        { id: 'q', origin: { agentGroupId: 'g', threadId: 't', channelType: 'web', messagingGroupId: 'mg' } },
      ],
    });
    const committedAt = Date.now();
    f.invalidate();
    await vi.advanceTimersByTimeAsync(99);
    expect(f.frames).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(f.frames).toHaveLength(2);
    expect(Date.now() - committedAt).toBeLessThanOrEqual(250);
    f.stream.stop();
  });

  it('does not publish an async scan after navigation', async () => {
    let finish!: (data: GlobalSyncState) => void;
    const read = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<GlobalSyncState>((resolve) => {
            finish = resolve;
          }),
      )
      .mockResolvedValue({ approvals: [], attention: [], group: null });
    const f = fixture({ read });
    f.stream.subscribe(1, 'old');
    await vi.advanceTimersByTimeAsync(100);
    f.stream.subscribe(2, 'new');
    for (let i = 0; i < 1000; i++) f.invalidate();
    expect(read).toHaveBeenCalledOnce();
    finish({ approvals: [], attention: [], group: null });
    await vi.advanceTimersByTimeAsync(100);
    expect(f.frames).toHaveLength(1);
    expect(f.frames[0]).toMatchObject({ subscriptionId: 2, groupId: 'new' });
    expect(read).toHaveBeenCalledTimes(2);
    f.stream.stop();
  });

  it('publishes within the update budget during sustained asynchronous invalidation', async () => {
    let revision = 0;
    const f = fixture({
      read: async () => {
        const id = String(++revision);
        await new Promise((resolve) => setTimeout(resolve, 20));
        return {
          approvals: [],
          group: null,
          attention: [{ id, origin: { agentGroupId: 'g', threadId: 't', channelType: 'web', messagingGroupId: 'mg' } }],
        };
      },
    });
    f.stream.subscribe(1, 'g');
    const mutations = setInterval(() => f.invalidate('g'), 5);
    try {
      await vi.advanceTimersByTimeAsync(250);
      expect(f.frames).toHaveLength(2);
      expect(f.state()?.data.attention[0].id).toBe('2');
    } finally {
      clearInterval(mutations);
      f.stream.stop();
    }
  });

  it('rechecks authorization after an async read and never sends its unauthorized result', async () => {
    let finish!: (data: GlobalSyncState) => void;
    let allowed = true;
    const f = fixture({
      read: () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
      authorize: () => {
        if (!allowed) throw new Error('revoked');
        return null;
      },
    });
    f.stream.subscribe(1, 'g');
    await vi.advanceTimersByTimeAsync(100);
    allowed = false;
    finish({ approvals: [], attention: [], group: null });
    await vi.advanceTimersByTimeAsync(0);
    expect(f.frames).toEqual([]);
    expect(f.fail).toHaveBeenCalledWith(expect.objectContaining({ message: 'revoked' }));
    expect(f.unsubscribe).toHaveBeenCalledOnce();
  });

  it('stops cleanly on transport failure and does not send an in-flight result after close', async () => {
    const f = fixture({
      send: () => {
        throw new Error('slow consumer');
      },
    });
    f.stream.subscribe(1, null);
    await vi.advanceTimersByTimeAsync(100);
    expect(f.fail).toHaveBeenCalledOnce();
    expect(f.unsubscribe).toHaveBeenCalledOnce();
    f.invalidate();
    await vi.advanceTimersByTimeAsync(1000);
    expect(f.read).toHaveBeenCalledOnce();
  });
});
