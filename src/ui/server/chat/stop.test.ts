import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { PassThrough, Readable, Writable } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const signal = vi.hoisted(() => ({
  turn: null as null | {
    id: string;
    status: 'running' | 'stopping';
    channelType: string;
    platformId: string;
    threadId: string | null;
  },
  connected: true,
  listeners: new Set<(sessionId: string, kind: 'turn.state' | 'disconnected' | 'heartbeat') => void>(),
  stop: vi.fn(),
}));
vi.mock('../../../session-link.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../session-link.js')>()),
  getSessionActiveTurn: vi.fn(() => ({ turn: signal.turn, connected: signal.connected })),
  requestSessionTurnStop: signal.stop,
  onSessionSignal: (listener: (sessionId: string, kind: 'turn.state' | 'disconnected' | 'heartbeat') => void) => {
    signal.listeners.add(listener);
    return () => signal.listeners.delete(listener);
  },
}));
vi.mock('../../../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../config.js')>()),
  DATA_DIR: path.resolve('.test-stop'),
}));
vi.mock('../auth.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../auth.js')>()),
  authenticate: () => ({ userId: 'web:member', sessionHash: 'test' }),
}));
vi.mock('../../../channels/channel-registry.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../channels/channel-registry.js')>()),
  getChannelAdapter: () => ({ isConnected: () => true }),
}));
vi.mock('../../../container-runner.js', () => ({
  killContainer: vi.fn(),
  resolveProviderName: vi.fn(() => 'claude'),
}));

import { closeDb, getDb, initTestDb, runMigrations } from '../../../db/index.js';
import { initSessionFolder } from '../../../session-manager.js';
import { insertIdentity } from '../../../modules/permissions/db/identities.js';
import { COOKIE_NAME } from '../auth.js';
import { handleChatRequest, handleChatUpgrade, matchChatPath, readChatActiveTurn } from './chat.js';
import { handle } from './routes.js';

const TURN = {
  id: 'turn-1',
  status: 'running' as const,
  channelType: 'web',
  platformId: 'group:agent',
  threadId: 'thread-1',
};
const OVERRIDE = { channelType: 'web', messagingGroupId: 'web-mg' };
const NOW = '2026-09-25T00:00:00.000Z';

beforeEach(() => {
  runMigrations(initTestDb());
  const db = getDb();
  for (const id of ['web:member', 'web:other', 'web:owner']) {
    db.prepare("INSERT INTO users (id, kind, created_at) VALUES (?, 'web', ?)").run(id, NOW);
  }
  for (const id of ['agent', 'other']) {
    db.prepare('INSERT INTO agent_groups (id, name, folder, created_at) VALUES (?, ?, ?, ?)').run(id, id, id, NOW);
  }
  for (const id of ['web:member', 'web:other']) {
    db.prepare('INSERT INTO agent_group_members (user_id, agent_group_id, added_by, added_at) VALUES (?, ?, ?, ?)').run(
      id,
      'agent',
      id,
      NOW,
    );
  }
  db.prepare(
    "INSERT INTO user_roles (user_id, role, agent_group_id, granted_by, granted_at) VALUES ('web:owner', 'owner', NULL, 'web:owner', ?)",
  ).run(NOW);
  for (const [id, channel, platform] of [
    ['web-mg', 'web', 'group:agent'],
    ['mail-mg', 'resend', 'bot@example.com'],
  ]) {
    db.prepare(
      "INSERT INTO messaging_groups (id, channel_type, platform_id, instance, is_group, unknown_sender_policy, created_at) VALUES (?, ?, ?, ?, 1, 'strict', ?)",
    ).run(id, channel, platform, channel, NOW);
    db.prepare(
      "INSERT INTO messaging_group_agents (id, messaging_group_id, agent_group_id, session_mode, created_at) VALUES (?, ?, 'agent', 'agent-shared', ?)",
    ).run(`wire-${id}`, id, NOW);
  }
  db.prepare(
    "INSERT INTO sessions (id, agent_group_id, messaging_group_id, thread_id, status, container_status, created_at) VALUES ('session-1', 'agent', NULL, NULL, 'active', 'stopped', ?)",
  ).run(NOW);
  initSessionFolder('agent', 'session-1');
  signal.turn = { ...TURN };
  signal.connected = true;
  signal.listeners.clear();
  signal.stop.mockReset().mockImplementation(async (_sessionId: string, turnId: string) => {
    if (!signal.connected) return { accepted: false, error: 'disconnected' };
    if (signal.turn?.id !== turnId) return { accepted: false, error: 'not_active' };
    return { accepted: true, turn: { ...signal.turn, status: 'stopping' } };
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  closeDb();
  fs.rmSync(path.resolve('.test-stop'), { recursive: true, force: true });
});

async function stop(
  options: { body?: unknown; group?: string; thread?: string; query?: string; user?: string; method?: string } = {},
) {
  const pathname = `/api/groups/${options.group ?? 'agent'}/chat/${options.thread ?? 'thread-1'}/stop`;
  const req = Readable.from([
    Buffer.from(JSON.stringify(options.body === undefined ? { turnId: TURN.id } : options.body)),
  ]) as http.IncomingMessage;
  req.method = options.method ?? 'POST';
  req.url = pathname + (options.query ?? '');
  req.headers = {};
  const chunks: Buffer[] = [];
  let status = 0;
  const res = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(Buffer.from(chunk));
      callback();
    },
  }) as unknown as http.ServerResponse;
  res.writeHead = ((code: number) => {
    status = code;
    return res;
  }) as typeof res.writeHead;
  await handleChatRequest(req, res, pathname, options.user ?? 'web:member');
  return { status, body: JSON.parse(Buffer.concat(chunks).toString()) };
}

describe('chat stop authorization', () => {
  it('accepts the explicit current turn and preserves shared web membership semantics', async () => {
    expect(matchChatPath('/api/groups/agent/chat/thread-1/stop')).toEqual({
      kind: 'stop',
      groupId: 'agent',
      threadId: 'thread-1',
    });
    expect(await stop({ user: 'web:other' })).toEqual({
      status: 202,
      body: { activeTurn: { id: TURN.id, status: 'stopping' }, connected: true },
    });
    expect(signal.stop).toHaveBeenCalledWith('session-1', TURN.id);
  });

  it.each([
    null,
    {},
    { turnId: '' },
    { turnId: 'bad id' },
    { turnId: 'x'.repeat(129) },
    { turnId: TURN.id, sessionId: 'forged' },
  ])('rejects malformed body %j', async (body) => {
    expect((await stop({ body })).status).toBe(400);
    expect(signal.stop).not.toHaveBeenCalled();
  });

  it('requires POST, group access, and an authorized send context, even for spectators', async () => {
    expect((await stop({ method: 'GET' })).status).toBe(405);
    expect((await stop({ group: 'other' })).status).toBe(403);
    expect((await stop({ query: '?channel=resend&mg=mail-mg' })).status).toBe(403);
    expect((await stop({ query: '?channel=resend&mg=mail-mg', user: 'web:owner' })).status).toBe(403);
    expect((await stop({ query: '?channel=resend&mg=web-mg', user: 'web:owner' })).status).toBe(403);
    expect(signal.stop).not.toHaveBeenCalled();
  });

  it.each(['?channel=web', '?mg=web-mg', '?channel=&mg=', '?sessionId=forged'])(
    'rejects forged or partial query %s',
    async (query) => {
      expect((await stop({ query })).status).toBe(400);
      expect(signal.stop).not.toHaveBeenCalled();
    },
  );

  it('rejects another thread, channel, or platform in an agent-shared session', async () => {
    expect((await stop({ thread: 'thread-2' })).status).toBe(409);
    signal.turn = { ...TURN, channelType: 'resend' };
    expect((await stop()).status).toBe(409);
    signal.turn = { ...TURN, platformId: 'group:other' };
    expect((await stop()).status).toBe(409);
    expect(signal.stop).not.toHaveBeenCalled();
  });

  it('isolates threadless shared DMs by the authenticated recipient identity', async () => {
    insertIdentity({ userId: 'web:member', channel: 'resend', handle: 'member@example.com' });
    signal.turn = { ...TURN, channelType: 'resend', platformId: 'resend:other@example.com', threadId: null };
    const context = { thread: '__dm:mail-mg', query: '?channel=resend&mg=mail-mg' };
    expect((await stop(context)).status).toBe(409);
    expect(
      readChatActiveTurn('web:member', 'agent', context.thread, {
        channelType: 'resend',
        messagingGroupId: 'mail-mg',
      }).activeTurn,
    ).toBeNull();
    signal.turn.platformId = 'resend:member@example.com';
    expect((await stop(context)).status).toBe(202);
    expect((await stop({ ...context, thread: '__dm:forged' })).status).toBe(403);
  });

  it('reports stale, completed, disconnected, and concurrent completion failures', async () => {
    expect((await stop({ body: { turnId: 'old-turn' } })).status).toBe(409);
    signal.turn = null;
    expect((await stop()).status).toBe(409);
    signal.turn = { ...TURN };
    signal.connected = false;
    expect((await stop()).status).toBe(503);
    signal.connected = true;
    signal.stop.mockResolvedValueOnce({ accepted: false, error: 'not_active' });
    expect((await stop()).status).toBe(409);
  });
});

describe('chat turn snapshots and events', () => {
  it('includes the authenticated active turn in polling snapshots', async () => {
    const req = Readable.from([]) as unknown as http.IncomingMessage;
    req.method = 'GET';
    req.url = '/ui/chat/api/sync?gid=agent&tid=thread-1&channel=web&mg=web-mg';
    req.headers = { cookie: `${COOKIE_NAME}=test` };
    const chunks: Buffer[] = [];
    const res = new Writable({
      write(chunk, _encoding, callback) {
        chunks.push(Buffer.from(chunk));
        callback();
      },
    }) as unknown as http.ServerResponse;
    res.writeHead = (() => res) as typeof res.writeHead;
    await handle(req, res);
    expect(JSON.parse(Buffer.concat(chunks).toString())).toMatchObject({
      activeTurn: { id: TURN.id, status: 'running' },
      connected: true,
    });
  });

  it('publishes only public fields to the authorized matching conversation', () => {
    expect(readChatActiveTurn('web:member', 'agent', 'thread-1', OVERRIDE)).toEqual({
      activeTurn: { id: TURN.id, status: 'running' },
      connected: true,
    });
    expect(readChatActiveTurn('web:member', 'agent', 'thread-2', OVERRIDE).activeTurn).toBeNull();
    expect(readChatActiveTurn('web:member', 'other', 'thread-1', OVERRIDE)).toEqual({
      activeTurn: null,
      connected: false,
    });
    signal.turn = { ...TURN, channelType: 'resend' };
    expect(readChatActiveTurn('web:member', 'agent', 'thread-1', OVERRIDE).activeTurn).toBeNull();
  });

  it('bootstraps history/ready, clears the old context on turn switch, and reports disconnects', () => {
    const frames: Record<string, unknown>[] = [];
    const ws = Object.assign(new EventEmitter(), {
      send: (frame: string) => frames.push(JSON.parse(frame)),
      close: vi.fn(),
    });
    vi.spyOn(WebSocketServer.prototype, 'handleUpgrade').mockImplementation((_req, _socket, _head, callback) => {
      callback(ws as unknown as WebSocket, _req);
    });
    const req = Readable.from([]) as unknown as http.IncomingMessage;
    req.url = '/ui/chat/api/groups/agent/chat/thread-1/ws';
    req.headers = { cookie: `${COOKIE_NAME}=test` };
    handleChatUpgrade(req, new PassThrough(), Buffer.alloc(0));
    expect(frames.filter((frame) => frame.kind === 'history' || frame.kind === 'ready')).toEqual([
      expect.objectContaining({ kind: 'history', activeTurn: { id: TURN.id, status: 'running' }, connected: true }),
      expect.objectContaining({ kind: 'ready', activeTurn: { id: TURN.id, status: 'running' }, connected: true }),
    ]);
    signal.turn = { ...TURN, status: 'stopping' };
    for (const listener of signal.listeners) listener('session-1', 'turn.state');
    expect(frames.at(-1)).toEqual({ kind: 'turn', turn: { id: TURN.id, status: 'stopping' }, connected: true });
    const count = frames.length;
    for (const listener of signal.listeners) listener('session-1', 'heartbeat');
    expect(frames).toHaveLength(count);
    signal.turn = { ...TURN, id: 'turn-2', threadId: 'thread-2' };
    for (const listener of signal.listeners) listener('session-1', 'turn.state');
    expect(frames.at(-1)).toEqual({ kind: 'turn', turn: null, connected: true });
    const beforeUnrelatedTurn = frames.length;
    signal.turn = { ...TURN, id: 'turn-3', threadId: 'thread-3' };
    for (const listener of signal.listeners) listener('session-1', 'turn.state');
    expect(frames).toHaveLength(beforeUnrelatedTurn);
    signal.connected = false;
    for (const listener of signal.listeners) listener('session-1', 'disconnected');
    expect(frames.at(-1)).toEqual({ kind: 'turn', turn: null, connected: false });
    ws.emit('close');
    expect(signal.listeners.size).toBe(0);
  });
});
