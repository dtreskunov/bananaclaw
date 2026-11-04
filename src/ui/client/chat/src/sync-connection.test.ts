import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SyncConnection } from './sync-connection';
import { SYNC_PROTOCOL_VERSION, SYNC_RELOAD_CLOSE_CODE } from '../../../shared/sync';

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
        data: {
          approvals: [],
          attention: [],
          group: groupId
            ? {
                threads: [],
                voiceInput: { backend: 'disabled', ready: false },
              }
            : null,
        },
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
    expect(f.apply).toHaveBeenCalledWith({ approvals: [], attention: [], group: null }, null);
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
    f.connection.setGroup('old');
    f.connection.setGroup('new');
    f.sockets[0].frame(1, 'old');
    f.sockets[0].frame(2, 'new');
    expect(f.apply).toHaveBeenCalledOnce();
    expect(f.apply.mock.calls[0][1]).toBe('new');
  });

  it('applies successive complete snapshots without requiring revision tracking', () => {
    const f = fixture();
    f.connection.start();
    f.sockets[0].open();
    f.sockets[0].frame(0, null);
    f.sockets[0].frame(0, null);
    expect(f.apply).toHaveBeenCalledTimes(2);
    expect(f.apply.mock.calls[0]).toEqual(f.apply.mock.calls[1]);
  });

  it('retains the selected group and takes a fresh snapshot after reconnect', async () => {
    const f = fixture();
    f.connection.setGroup('g');
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

  it('fails freshness barriers explicitly and never falls back to HTTP', async () => {
    const f = fixture();
    const refreshed = f.connection.refresh(null);
    const rejected = expect(refreshed).rejects.toThrow('timed out');
    f.sockets[0].open();
    await vi.advanceTimersByTimeAsync(15_000);
    await rejected;
    expect(f.unavailable).toHaveBeenCalled();
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
