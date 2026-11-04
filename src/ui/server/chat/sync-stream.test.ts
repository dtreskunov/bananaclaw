import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SyncFrame, SyncResponse } from '../../shared/sync.js';
import { startSyncStream, type SyncStreamOptions } from './sync-stream.js';

afterEach(() => vi.useRealTimers());

function fixture(overrides: Partial<SyncStreamOptions> = {}) {
  vi.useFakeTimers();
  const frames: SyncFrame[] = [];
  let invalidate: (groupId?: string) => void = () => {};
  const unsubscribe = vi.fn();
  const read = vi.fn(async (): Promise<SyncResponse> => ({ approvals: [], attention: [] }));
  const fail = vi.fn();
  const stream = startSyncStream({
    read,
    authorize: () => {},
    subscribe: (fn) => {
      invalidate = fn;
      return unsubscribe;
    },
    deadline: () => null,
    send: (frame) => {
      frames.push(frame);
    },
    fail,
    ...overrides,
  });
  return { stream, frames, invalidate: (gid?: string) => invalidate(gid), unsubscribe, read, fail };
}

describe('global synchronization stream', () => {
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
    f.stream.subscribe(2, 'g');
    await vi.advanceTimersByTimeAsync(100);
    expect(f.frames).toHaveLength(2);
    expect(f.frames[1]).toMatchObject({ subscriptionId: 2 });
    f.stream.stop();
  });

  it('publishes a committed metadata change within the 250 ms local update budget', async () => {
    const f = fixture();
    f.stream.subscribe(1, null);
    await vi.advanceTimersByTimeAsync(100);
    f.read.mockResolvedValue({
      approvals: [],
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
    let finish!: (data: SyncResponse) => void;
    const read = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<SyncResponse>((resolve) => {
            finish = resolve;
          }),
      )
      .mockResolvedValue({ approvals: [], attention: [] });
    const f = fixture({ read });
    f.stream.subscribe(1, 'old');
    await vi.advanceTimersByTimeAsync(100);
    f.stream.subscribe(2, 'new');
    for (let i = 0; i < 1000; i++) f.invalidate();
    expect(read).toHaveBeenCalledOnce();
    finish({ approvals: [], attention: [] });
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
          attention: [{ id, origin: { agentGroupId: 'g', threadId: 't', channelType: 'web', messagingGroupId: 'mg' } }],
        };
      },
    });
    f.stream.subscribe(1, 'g');
    const mutations = setInterval(() => f.invalidate('g'), 5);
    try {
      await vi.advanceTimersByTimeAsync(250);
      expect(f.frames).toHaveLength(2);
      expect(f.frames[1].data.attention[0].id).toBe('2');
    } finally {
      clearInterval(mutations);
      f.stream.stop();
    }
  });

  it('rechecks authorization after an async read and never sends its unauthorized result', async () => {
    let finish!: (data: SyncResponse) => void;
    let allowed = true;
    const f = fixture({
      read: () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
      authorize: () => {
        if (!allowed) throw new Error('revoked');
      },
    });
    f.stream.subscribe(1, 'g');
    await vi.advanceTimersByTimeAsync(100);
    allowed = false;
    finish({ approvals: [], attention: [] });
    await vi.advanceTimersByTimeAsync(0);
    expect(f.frames).toEqual([]);
    expect(f.fail).toHaveBeenCalledWith(expect.objectContaining({ message: 'revoked' }));
    expect(f.unsubscribe).toHaveBeenCalledOnce();
  });

  it('refreshes at an expiry deadline without recurring database scans', async () => {
    const f = fixture({ deadline: () => (Date.now() < 1000 ? 1000 : null) });
    vi.setSystemTime(0);
    f.stream.subscribe(1, null);
    await vi.advanceTimersByTimeAsync(100);
    await vi.advanceTimersByTimeAsync(999);
    expect(f.read).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    expect(f.read).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(f.read).toHaveBeenCalledTimes(2);
    f.stream.stop();
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
