import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SyncConnection } from './sync-connection';
import { SYNC_PROTOCOL_VERSION, SYNC_RELOAD_CLOSE_CODE } from '../../../shared/sync';
import { testGlobalSnapshot } from '../../../shared/sync-test-fixtures';

class Socket {
  readyState = 0;
  onopen: (() => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  send = vi.fn((_data: string) => {});
  close = vi.fn(() => {
    this.readyState = 3;
    this.onclose?.({ code: 1000 });
  });
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  frame(subscriptionId: number, groupId: string | null) {
    this.onmessage?.({
      data: JSON.stringify({
        kind: 'sync',
        protocolVersion: SYNC_PROTOCOL_VERSION,
        subscriptionId,
        groupId,
        global: testGlobalSnapshot({
          approvals: [],
          attention: [],
          group: groupId
            ? {
                threads: [],
                voiceInput: { backend: 'disabled', ready: false },
              }
            : null,
        }),
      }),
    });
  }
}

const connections: SyncConnection[] = [];
beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  for (const connection of connections.splice(0)) connection.stop();
  vi.useRealTimers();
});
function fixture() {
  const sockets: Socket[] = [];
  const options = {
    socket: () => {
      const socket = new Socket();
      sockets.push(socket);
      return socket as unknown as WebSocket;
    },
    apply: vi.fn(),
    connecting: vi.fn(),
    unavailable: vi.fn(),
    reload: vi.fn(),
    unauthorized: vi.fn(),
  };
  const connection = new SyncConnection(options);
  connections.push(connection);
  return { connection, sockets, ...options };
}

describe('global sync browser connection', () => {
  it('subscribes without a selected group and does not poll after a snapshot', async () => {
    const f = fixture();
    f.connection.start();
    const socket = f.sockets[0];
    socket.open();
    expect(JSON.parse(socket.send.mock.calls[0][0])).toMatchObject({ groupId: null, subscriptionId: 0 });
    socket.frame(0, null);
    expect(f.apply).toHaveBeenCalledWith(
      expect.objectContaining({ global: { approvals: [], attention: [], group: null } }),
    );
    await vi.advanceTimersByTimeAsync(60_000);
    expect(socket.send).toHaveBeenCalledOnce();
    expect(f.sockets).toHaveLength(1);
  });

  it('waits for the matching fresh snapshot and applies it before resolving', async () => {
    const f = fixture();
    const refreshed = f.connection.refresh('g');
    f.sockets[0].open();
    f.sockets[0].frame(1, 'g');
    expect(f.apply).not.toHaveBeenCalled();
    f.sockets[0].frame(2, 'g');
    expect((await refreshed).group?.threads).toEqual([]);
    expect(f.apply).toHaveBeenCalledOnce();
  });

  it('ignores obsolete subscriptions after rapid navigation', () => {
    const f = fixture();
    f.connection.start();
    f.sockets[0].open();
    f.connection.select('old', null);
    f.connection.select('new', null);
    f.sockets[0].frame(1, 'old');
    f.sockets[0].frame(2, 'new');
    expect(f.apply).toHaveBeenCalledOnce();
    expect(f.apply.mock.calls[0][0].groupId).toBe('new');
  });

  it('ignores duplicate metadata snapshots but applies empty revisioned acknowledgements', () => {
    const f = fixture();
    f.connection.start();
    f.sockets[0].open();
    f.sockets[0].frame(0, null);
    f.sockets[0].frame(0, null);
    expect(f.apply).toHaveBeenCalledOnce();
    f.sockets[0].onmessage?.({
      data: JSON.stringify({
        kind: 'sync',
        protocolVersion: SYNC_PROTOCOL_VERSION,
        subscriptionId: 0,
        groupId: null,
        global: { kind: 'update', streamId: 'test-global', baseRevision: 0, revision: 1, changes: {} },
      }),
    });
    expect(f.apply).toHaveBeenCalledTimes(2);
  });

  it('retains the selected group and takes a fresh snapshot after reconnect', async () => {
    const f = fixture();
    f.connection.select('g', null);
    f.connection.start();
    f.sockets[0].open();
    f.sockets[0].frame(1, 'g');
    f.sockets[0].close();
    await vi.advanceTimersByTimeAsync(1000);
    expect(f.sockets).toHaveLength(2);
    f.sockets[1].open();
    f.sockets[0].frame(1, 'g');
    f.sockets[1].frame(1, 'g');
    expect(f.apply).toHaveBeenCalledTimes(2);
  });

  it('requests a fresh snapshot on visibility catch-up without opening a second socket', () => {
    const f = fixture();
    f.connection.start();
    f.sockets[0].open();
    f.connection.catchUp();
    expect(f.sockets).toHaveLength(1);
    expect(JSON.parse(f.sockets[0].send.mock.calls.at(-1)![0])).toMatchObject({ subscriptionId: 1 });
  });

  it('resubscribes conversation contexts on one socket and preserves them across reconnect', async () => {
    const f = fixture();
    f.connection.start();
    f.sockets[0].open();
    const conversation = { threadId: 'first', channelType: 'telegram', messagingGroupId: 'mg' };
    f.connection.select('g', conversation);
    f.connection.select('g', { ...conversation, threadId: 'second' });
    expect(f.sockets).toHaveLength(1);
    expect(JSON.parse(f.sockets[0].send.mock.calls.at(-1)![0])).toMatchObject({
      subscriptionId: 2,
      groupId: 'g',
      conversation: { ...conversation, threadId: 'second' },
    });
    f.sockets[0].close();
    f.connection.reconnectNow();
    f.sockets[1].open();
    expect(JSON.parse(f.sockets[1].send.mock.calls[0][0])).toMatchObject({
      subscriptionId: 2,
      conversation: { ...conversation, threadId: 'second' },
    });
    await vi.advanceTimersByTimeAsync(1000);
    expect(f.sockets).toHaveLength(2);
  });

  it('does not resolve metadata refreshes from conversation-only frames', async () => {
    const f = fixture();
    let resolved = false;
    const pending = f.connection.refresh('g').then(() => {
      resolved = true;
    });
    f.sockets[0].open();
    const subscriptionId = JSON.parse(f.sockets[0].send.mock.calls.at(-1)![0]).subscriptionId;
    f.sockets[0].onmessage?.({
      data: JSON.stringify({
        kind: 'sync',
        protocolVersion: SYNC_PROTOCOL_VERSION,
        groupId: 'g',
        subscriptionId,
        conversation: null,
      }),
    });
    await Promise.resolve();
    expect(resolved).toBe(false);
    f.sockets[0].frame(subscriptionId, 'g');
    await pending;
    expect(resolved).toBe(true);
  });

  it('fails freshness barriers explicitly and never falls back to HTTP', async () => {
    const f = fixture();
    const refreshed = f.connection.refresh(null);
    const rejected = expect(refreshed).rejects.toThrow('timed out');
    f.sockets[0].open();
    await vi.advanceTimersByTimeAsync(15_000);
    await rejected;
    expect(f.unavailable).toHaveBeenCalled();
  });

  it('reports metadata revisions on navigation and clears the cursor after reconnect', () => {
    const f = fixture();
    f.connection.start();
    f.sockets[0].open();
    f.sockets[0].frame(0, null);
    f.connection.select('g', null);
    expect(JSON.parse(f.sockets[0].send.mock.calls.at(-1)![0]).globalCursor).toEqual({
      streamId: 'test-global',
      revision: 0,
    });
    f.sockets[0].close();
    f.connection.reconnectNow();
    f.sockets[1].open();
    expect(JSON.parse(f.sockets[1].send.mock.calls[0][0]).globalCursor).toBeNull();
  });

  it('recovers a metadata revision gap with a new baseline, never a success-shaped refresh', async () => {
    const f = fixture();
    f.connection.start();
    f.sockets[0].open();
    f.sockets[0].frame(0, null);
    const fresh = f.connection.refresh(null);
    const rejected = expect(fresh).rejects.toThrow('disconnected');
    f.sockets[0].onmessage?.({
      data: JSON.stringify({
        kind: 'sync',
        protocolVersion: SYNC_PROTOCOL_VERSION,
        groupId: null,
        subscriptionId: 1,
        global: { kind: 'update', streamId: 'test-global', baseRevision: 2, revision: 3, changes: {} },
      }),
    });
    await rejected;
    expect(f.apply).toHaveBeenCalledOnce();
    expect(f.unavailable).toHaveBeenCalledWith(expect.stringContaining('revision_gap'));
    await vi.advanceTimersByTimeAsync(1000);
    f.sockets[1].open();
    f.sockets[1].frame(1, null);
    expect(f.apply).toHaveBeenCalledTimes(2);
  });

  it('requires a reload on protocol mismatch rather than reconnecting indefinitely', async () => {
    const f = fixture();
    f.connection.start();
    f.sockets[0].open();
    f.sockets[0].onmessage?.({ data: '{"protocolVersion":999}' });
    expect(f.reload).toHaveBeenCalledOnce();
    expect(f.apply).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(f.sockets).toHaveLength(1);
  });

  it('returns to login after session revocation instead of retrying an unauthorized socket', async () => {
    const f = fixture();
    f.connection.start();
    f.sockets[0].open();
    f.sockets[0].onclose?.({ code: 4401 });
    expect(f.unauthorized).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(f.sockets).toHaveLength(1);
  });

  it('requires a reload when the server rejects an outdated subscription protocol', async () => {
    const f = fixture();
    f.connection.start();
    f.sockets[0].open();
    f.sockets[0].onclose?.({ code: SYNC_RELOAD_CLOSE_CODE });
    expect(f.reload).toHaveBeenCalledOnce();
    expect(f.unavailable).toHaveBeenCalledWith(expect.stringContaining('protocol changed'));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(f.sockets).toHaveLength(1);
  });
});
