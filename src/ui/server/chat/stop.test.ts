import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { createHash } from 'node:crypto';
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
    supportsSteering?: boolean;
    supportsInputEditing?: boolean;
    supportsInputCancellation?: boolean;
  },
  connected: true,
  listeners: new Set<(sessionId: string, kind: 'turn.state' | 'disconnected' | 'heartbeat' | 'input.state') => void>(),
  stop: vi.fn(),
  submit: vi.fn(),
}));
vi.mock('../../../session-link.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../session-link.js')>()),
  getSessionActiveTurn: vi.fn(() => ({ turn: signal.turn, connected: signal.connected })),
  requestSessionTurnStop: signal.stop,
  onSessionSignal: (
    listener: (sessionId: string, kind: 'turn.state' | 'disconnected' | 'heartbeat' | 'input.state') => void,
  ) => {
    signal.listeners.add(listener);
    return () => signal.listeners.delete(listener);
  },
}));
vi.mock('../../../channels/web.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../channels/web.js')>()),
  submitWebInbound: signal.submit,
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
import { initSessionFolder, openInboundDb, openOutboundDbRw, writeSessionMessage } from '../../../session-manager.js';
import { applyDurableRunnerEvent } from '../../../session-link-durable.js';
import { createWebAdapter } from '../../../channels/web.js';
import { insertIdentity } from '../../../modules/permissions/db/identities.js';
import { COOKIE_NAME } from '../auth.js';
import { handleChatRequest, handleChatUpgrade, matchChatPath, readChatActiveTurn, readChatHistory } from './chat.js';
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
  signal.submit.mockReset().mockResolvedValue('web-client-123');
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
  options: {
    body?: unknown;
    group?: string;
    thread?: string;
    query?: string;
    user?: string;
    method?: string;
    kind?: 'send' | 'stop' | 'messages/pending';
    multipart?: string;
  } = {},
) {
  const pathname = `/api/groups/${options.group ?? 'agent'}/chat/${options.thread ?? 'thread-1'}/${options.kind ?? 'stop'}`;
  const req = Readable.from([
    Buffer.from(options.multipart ?? JSON.stringify(options.body === undefined ? { turnId: TURN.id } : options.body)),
  ]) as http.IncomingMessage;
  req.method = options.method ?? 'POST';
  req.url = pathname + (options.query ?? '');
  req.headers = options.multipart ? { 'content-type': 'multipart/form-data; boundary=test-boundary' } : {};
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

describe('native steering submissions', () => {
  const handling = { mode: 'steer', turnId: TURN.id };
  const send = (inputHandling: unknown = handling, options: Parameters<typeof stop>[0] = {}) =>
    stop({
      kind: 'send',
      body: { text: 'Change direction', clientMessageId: 'client-123', inputHandling },
      ...options,
    });

  it('binds JSON steering to the authorized web context and exposes only the advertised capability', async () => {
    signal.turn = { ...TURN, supportsSteering: true };
    expect(readChatActiveTurn('web:member', 'agent', 'thread-1', OVERRIDE).activeTurn).toEqual({
      id: TURN.id,
      status: 'running',
      supportsSteering: true,
    });
    expect((await send()).status).toBe(200);
    expect(signal.submit).toHaveBeenCalledWith(
      expect.objectContaining({
        platformId: 'group:agent',
        threadId: 'thread-1',
        userId: 'web:member',
        clientMessageId: 'client-123',
        inputHandling: handling,
      }),
    );
  });

  it('supports multipart intent and attachments, rejecting invalid metadata JSON', async () => {
    signal.turn = { ...TURN, supportsSteering: true };
    const multipart = (metadata: string) =>
      `--test-boundary\r\nContent-Disposition: form-data; name="text"\r\n\r\nChange\r\n` +
      `--test-boundary\r\nContent-Disposition: form-data; name="inputHandling"\r\n\r\n${metadata}\r\n` +
      '--test-boundary\r\nContent-Disposition: form-data; name="file"; filename="note.txt"\r\nContent-Type: text/plain\r\n\r\nNotes\r\n--test-boundary--\r\n';
    expect((await send(handling, { multipart: multipart(JSON.stringify(handling)) })).status).toBe(200);
    expect(signal.submit).toHaveBeenCalledWith(
      expect.objectContaining({
        inputHandling: handling,
        attachments: [{ filename: 'note.txt', contentType: 'text/plain', data: 'Tm90ZXM=', size: 5 }],
      }),
    );
    expect((await send(handling, { multipart: multipart('{') })).status).toBe(400);
    expect((await send(handling, { multipart: multipart('{"mode":"invalid"}') })).status).toBe(400);
  });

  it.each([
    null,
    [],
    'steer',
    {},
    { mode: 'steer' },
    { mode: 'queue', turnId: 'bad id' },
    { mode: 'steer', turnId: TURN.id, sessionId: 'forged' },
    { mode: 'invalid' },
  ])('rejects malformed inputHandling %j', async (value) => {
    expect((await send(value)).status).toBe(400);
    expect(signal.submit).not.toHaveBeenCalled();
  });

  it('does not infer support from provider settings and leaves normal and queued submissions unchanged', async () => {
    expect((await send()).body.error).toBe('unsupported');
    expect((await send({ mode: 'queue', turnId: TURN.id })).status).toBe(200);
    expect((await stop({ kind: 'send', body: { text: 'Ordinary send' } })).status).toBe(200);
    expect(signal.submit).toHaveBeenLastCalledWith(expect.objectContaining({ inputHandling: undefined }));
  });

  it('preserves stale targets as follow-ups rather than retargeting a new turn', async () => {
    for (const turn of [null, { ...TURN, id: 'new-turn', supportsSteering: true }]) {
      signal.turn = turn;
      expect((await send()).status).toBe(200);
      expect(signal.submit).toHaveBeenLastCalledWith(expect.objectContaining({ inputHandling: handling }));
    }
  });

  it('rejects live unsupported/disconnected/stopping targets and cross-conversation targets', async () => {
    signal.turn = { ...TURN, supportsSteering: true };
    expect((await send(handling, { thread: 'thread-2' })).body.error).toBe('different_conversation');
    signal.connected = false;
    expect((await send()).body.error).toBe('disconnected');
    signal.connected = true;
    signal.turn.status = 'stopping';
    expect((await send()).body.error).toBe('not_running');
    expect(signal.submit).not.toHaveBeenCalled();
  });

  it('requires group access, rejects forged context, and does not steer through external channel sends', async () => {
    signal.turn = { ...TURN, supportsSteering: true };
    expect((await send(handling, { group: 'other' })).status).toBe(403);
    expect((await send(handling, { query: '?channel=web&mg=mail-mg' })).status).toBe(403);
    expect((await send(handling, { query: '?channel=web' })).status).toBe(400);
    expect((await send(handling, { query: '?sessionId=forged' })).status).toBe(400);
    expect((await send(handling, { query: '?channel=resend&mg=mail-mg' })).status).toBe(400);
    expect(signal.submit).not.toHaveBeenCalled();
  });
});

function inputRow(
  id: string,
  options: { thread?: string; platform?: string; channel?: string; handling?: object; status?: string } = {},
) {
  const db = openInboundDb('agent', 'session-1');
  try {
    db.prepare(
      `INSERT INTO messages_in (id, seq, kind, timestamp, status, trigger, platform_id, channel_type, thread_id, content)
      VALUES (?, (SELECT COALESCE(MAX(seq), 0) + 2 FROM messages_in), 'chat', ?, ?, 1, ?, ?, ?, ?)`,
    ).run(
      `${id}:agent`,
      NOW,
      options.status ?? 'pending',
      options.platform ?? 'group:agent',
      options.channel ?? 'web',
      options.thread ?? 'thread-1',
      JSON.stringify({ text: id, ...(options.handling ? { inputHandling: options.handling } : {}) }),
    );
  } finally {
    db.close();
  }
}

function receipt(
  id: string,
  status: string,
  reason?: string,
  placement: { timelinePosition?: number; queuedForNextTurn?: boolean } = {},
) {
  const db = openOutboundDbRw('agent', 'session-1');
  const messageId = `${id}:agent`;
  try {
    db.prepare('INSERT OR REPLACE INTO session_state (key, value, updated_at) VALUES (?, ?, ?)').run(
      `input:${createHash('sha256').update(messageId).digest('hex')}`,
      JSON.stringify({ messageId, status, turnId: TURN.id, ...(reason ? { reason } : {}), ...placement }),
      NOW,
    );
  } finally {
    db.close();
  }
}

describe('durable input state history', () => {
  const history = () => readChatHistory('web:member', 'agent', 'thread-1', OVERRIDE);

  it('uses the same outbound placement in a live frame and reloaded history despite delivery latency', async () => {
    const timelinePosition = Date.parse(NOW) * 1000 + 1;
    const content = { text: 'Progress', timelinePosition };
    const db = openOutboundDbRw('agent', 'session-1');
    db.prepare(
      `INSERT INTO messages_out (id, seq, kind, timestamp, channel_type, platform_id, thread_id, content)
       VALUES ('out-test', 1, 'internal', ?, 'web', 'group:agent', 'thread-1', ?)`,
    ).run(NOW, JSON.stringify(content));
    db.close();
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
    try {
      expect((frames[0].messages as Array<{ timelinePosition: number }>)[0].timelinePosition).toBe(timelinePosition);
      await createWebAdapter().deliver('group:agent', 'thread-1', { id: 'out-test', kind: 'internal', content });
      const frame = frames.find((value) => value.kind === 'outbound');
      expect(frame).toMatchObject({ id: 'out-test', timelinePosition });
      expect(frame?.timestamp).not.toBe(NOW);
      expect(history()[0].timelinePosition).toBe(timelinePosition);
    } finally {
      ws.emit('close');
    }
  });

  it('keeps consumed follow-ups after the prior response on reload without altering sent timestamps', () => {
    const base = Date.parse(NOW) * 1000;
    inputRow('a', { status: 'completed' });
    inputRow('b', { status: 'completed', handling: { mode: 'queue' } });
    receipt('a', 'processing', undefined, { timelinePosition: base + 1 });
    receipt('b', 'processing', undefined, { timelinePosition: base + 3, queuedForNextTurn: true });
    const outDb = openOutboundDbRw('agent', 'session-1');
    const insert = outDb.prepare(
      `INSERT INTO messages_out (id, seq, kind, timestamp, platform_id, channel_type, thread_id, content)
       VALUES (?, ?, 'chat', ?, 'group:agent', 'web', 'thread-1', ?)`,
    );
    insert.run('out-a', 1, NOW, JSON.stringify({ text: 'answer A', timelinePosition: base + 2 }));
    insert.run('out-b', 3, NOW, JSON.stringify({ text: 'answer B', timelinePosition: base + 4 }));
    outDb.close();
    for (let reload = 0; reload < 2; reload++) {
      const messages = history();
      expect(messages.map((message) => message.id)).toEqual(['a', 'out-a', 'b', 'out-b']);
      expect(messages.find((message) => message.id === 'b')).toMatchObject({
        timestamp: NOW,
        timelinePosition: base + 3,
        canEditPending: false,
      });
      expect(messages.find((message) => message.id === 'b')?.inputState).toBeUndefined();
    }
  });

  it('distinguishes genuine queued follow-ups from the first message awaiting runner startup', () => {
    inputRow('initial');
    inputRow('explicit', { handling: { mode: 'queue' } });
    inputRow('fallback', { handling: { mode: 'steer', turnId: TURN.id } });
    receipt('fallback', 'queued', 'turn_finished', { queuedForNextTurn: true });
    const messages = history();
    expect(messages.find((message) => message.id === 'initial')?.inputState?.queuedForNextTurn).toBeUndefined();
    for (const id of ['explicit', 'fallback']) {
      expect(messages.find((message) => message.id === id)?.inputState?.queuedForNextTurn).toBe(true);
      expect(messages.find((message) => message.id === id)?.timelinePosition).toBeUndefined();
    }
  });

  it('preserves applied steering placement and ignores another conversation placement', () => {
    const base = Date.parse(NOW) * 1000;
    inputRow('steer', { status: 'completed' });
    inputRow('hidden', { thread: 'thread-2' });
    receipt('steer', 'applied', undefined, { timelinePosition: base + 3 });
    receipt('hidden', 'processing', undefined, { timelinePosition: base + 2 });
    expect(history()).toEqual([
      expect.objectContaining({
        id: 'steer',
        timelinePosition: base + 3,
        inputState: expect.objectContaining({ status: 'applied', timelinePosition: base + 3 }),
      }),
    ]);
  });

  it('retains the queue flag during the claim-before-placement acknowledgement gap', () => {
    inputRow('waiting', { handling: { mode: 'queue' } });
    receipt('waiting', 'queued', undefined, { queuedForNextTurn: true });
    const db = openOutboundDbRw('agent', 'session-1');
    db.prepare("INSERT INTO processing_ack VALUES (?, 'processing', ?)").run('waiting:agent', NOW);
    db.close();
    expect(history()[0]).toMatchObject({
      canEditPending: false,
      inputState: { status: 'processing', queuedForNextTurn: true },
    });
    expect(history()[0].timelinePosition).toBeUndefined();
    const timelinePosition = Date.parse(NOW) * 1000 + 1;
    receipt('waiting', 'processing', undefined, { queuedForNextTurn: true, timelinePosition });
    expect(history()[0].timelinePosition).toBe(timelinePosition);
  });

  it('normalizes namespaced IDs, restores state, and isolates other conversations', () => {
    inputRow('visible');
    inputRow('other-thread', { thread: 'thread-2' });
    inputRow('other-room', { platform: 'group:other' });
    inputRow('other-channel', { channel: 'resend' });
    for (const id of ['visible', 'other-thread', 'other-room', 'other-channel']) receipt(id, 'queued');
    expect(history()).toEqual([
      expect.objectContaining({
        id: 'visible',
        inputState: { messageId: 'visible', status: 'queued', turnId: TURN.id },
      }),
    ]);
    receipt('visible', 'applied');
    expect(history()[0].inputState?.status).toBe('applied');
  });

  it('uses intent only as pending status, clears claims immediately, and retains applied provenance', () => {
    inputRow('pending', { handling: { mode: 'steer', turnId: TURN.id } });
    expect(history()[0].inputState?.status).toBe('queued');
    receipt('pending', 'queued');
    const db = openOutboundDbRw('agent', 'session-1');
    db.prepare(
      "INSERT INTO processing_ack (message_id, status, status_changed) VALUES ('pending:agent', 'processing', ?)",
    ).run(NOW);
    db.close();
    expect(history()[0].inputState?.status).toBe('processing');
    receipt('pending', 'applied');
    expect(history()[0].inputState?.status).toBe('applied');
  });

  it('retains stale follow-up outcomes after completion, without a queued caption', () => {
    inputRow('stale', { status: 'completed' });
    receipt('stale', 'queued', 'turn_finished');
    expect(history()[0].inputState).toEqual({
      messageId: 'stale',
      status: 'processing',
      turnId: TURN.id,
      reason: 'turn_finished',
    });
  });

  it('restores native external-channel receipts but ignores external submission metadata', () => {
    inputRow('external', {
      channel: 'resend',
      platform: 'bot@example.com',
      handling: { mode: 'steer', turnId: TURN.id },
    });
    const read = () =>
      readChatHistory('web:owner', 'agent', 'thread-1', { channelType: 'resend', messagingGroupId: 'mail-mg' });
    expect(read()[0].inputState).toBeUndefined();
    receipt('external', 'steering');
    expect(read()[0].inputState?.status).toBe('steering');
  });

  it('ignores malformed and mismatched receipt keys', () => {
    inputRow('visible');
    const db = openOutboundDbRw('agent', 'session-1');
    db.prepare('INSERT INTO session_state (key, value, updated_at) VALUES (?, ?, ?)').run(
      'input:forged',
      JSON.stringify({ messageId: 'visible:agent', status: 'applied' }),
      NOW,
    );
    db.prepare('INSERT INTO session_state (key, value, updated_at) VALUES (?, ?, ?)').run('input:broken', '{', NOW);
    db.close();
    expect(history()[0].inputState?.status).toBe('queued');
  });

  it('pushes only visible message receipts on input.state and clears claimed queue status', () => {
    inputRow('visible');
    inputRow('hidden', { thread: 'thread-2' });
    receipt('visible', 'queued');
    receipt('hidden', 'applied');
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
    expect((frames[0].messages as Array<{ inputState: { status: string } }>)[0].inputState.status).toBe('queued');
    const count = frames.length;
    for (const listener of signal.listeners) listener('unrelated-session', 'input.state');
    expect(frames).toHaveLength(count);
    const db = openOutboundDbRw('agent', 'session-1');
    db.prepare(
      "INSERT INTO processing_ack (message_id, status, status_changed) VALUES ('visible:agent', 'processing', ?)",
    ).run(NOW);
    db.close();
    for (const listener of signal.listeners) listener('session-1', 'input.state');
    expect(frames.at(-1)).toMatchObject({
      kind: 'input-state',
      states: [{ messageId: 'visible', inputState: { status: 'processing' }, canEditPending: false }],
    });
    receipt('visible', 'applied');
    for (const listener of signal.listeners) listener('session-1', 'input.state');
    expect(frames.at(-1)).toMatchObject({
      kind: 'input-state',
      states: [{ messageId: 'visible', inputState: { messageId: 'visible', status: 'applied', turnId: TURN.id } }],
    });
    const position = Date.parse(NOW) * 1000 + 1;
    receipt('visible', 'processing', undefined, { timelinePosition: position });
    for (const listener of signal.listeners) listener('session-1', 'input.state');
    expect(frames.at(-1)).toMatchObject({
      kind: 'input-state',
      states: [{ messageId: 'visible', timelinePosition: position }],
    });

    ws.emit('close');
    expect(signal.listeners.size).toBe(0);
  });
});

describe('pending web input editing', () => {
  const userId = 'b6f435da-4cd5-4e64-8ad8-1da9b3b244b0';
  const requestId = 'f965e0be-d447-4795-bfd4-1a4bd2b2807b';
  const body = { requestId, expectedText: 'original', text: 'revised' };
  const edit = (options: Parameters<typeof stop>[0] = {}) =>
    stop({ kind: 'messages/pending', method: 'PATCH', user: userId, body, ...options });
  const target = () => {
    const db = openInboundDb('agent', 'session-1');
    try {
      return db.prepare('SELECT id, seq, timestamp, content FROM messages_in WHERE id = ?').get('pending:agent') as {
        id: string;
        seq: number;
        timestamp: string;
        content: string;
      };
    } finally {
      db.close();
    }
  };
  const acknowledge = (status: 'accepted' | 'conflict', reason?: string) => {
    applyDurableRunnerEvent('agent', 'session-1', {
      eventId: 'edit-result',
      sequence: 1,
      event: {
        type: 'state.upsert',
        payload: {
          key: `input-edit:${requestId}`,
          value: JSON.stringify({ requestId, messageId: 'pending:agent', status, ...(reason ? { reason } : {}) }),
          updated_at: NOW,
        },
      },
    });
    for (const listener of signal.listeners) listener('session-1', 'input.state');
  };
  beforeEach(() => {
    const db = getDb();
    db.prepare("INSERT INTO users (id, kind, created_at) VALUES (?, 'web', ?)").run(userId, NOW);
    db.prepare('INSERT INTO agent_group_members (user_id, agent_group_id, added_by, added_at) VALUES (?, ?, ?, ?)').run(
      userId,
      'agent',
      userId,
      NOW,
    );
    signal.turn = { ...TURN, supportsSteering: true, supportsInputEditing: true, supportsInputCancellation: true };
    writeSessionMessage('agent', 'session-1', {
      id: 'pending:agent',
      kind: 'chat',
      timestamp: NOW,
      channelType: 'web',
      platformId: 'group:agent',
      threadId: 'thread-1',
      senderUserId: userId,
      content: JSON.stringify({
        text: 'original',
        inputHandling: { mode: 'queue' },
        attachments: [{ name: 'keep.txt', localPath: 'inbox/keep.txt', mimeType: 'text/plain' }],
      }),
    });
  });

  it('waits for durable runner acceptance before changing text and preserves identity, metadata and ordering', async () => {
    const before = target();
    let done = false;
    const pending = edit().then((result) => {
      done = true;
      return result;
    });
    await vi.waitFor(() => expect(signal.listeners.size).toBe(1));
    expect(done).toBe(false);
    expect(target()).toEqual(before);
    const visible = readChatHistory(userId, 'agent', 'thread-1', OVERRIDE);
    expect(visible).toHaveLength(1);
    expect(visible[0].canEditPending).toBe(true);
    acknowledge('accepted');
    expect(await pending).toEqual({ status: 200, body: { ok: true, id: 'pending', text: 'revised' } });
    const after = target();
    expect({ ...after, content: before.content }).toEqual(before);
    expect(JSON.parse(after.content)).toEqual({ ...JSON.parse(before.content), text: 'revised' });
    expect(signal.listeners.size).toBe(0);
    signal.connected = false;
    signal.turn = null;
    expect((await edit()).status).toBe(200);
    expect((await edit({ body: { ...body, text: 'different' } })).body.error).toBe('request_id_conflict');
  });

  const cancel = (options: Parameters<typeof stop>[0] = {}) =>
    stop({ kind: 'messages/pending', method: 'DELETE', user: userId, body: { requestId }, ...options });
  const acknowledgeCancel = (status: 'accepted' | 'conflict', reason?: string) => {
    applyDurableRunnerEvent('agent', 'session-1', {
      eventId: 'cancel-result',
      sequence: 1,
      event: {
        type: 'state.upsert',
        payload: {
          key: `input-cancel:${requestId}`,
          value: JSON.stringify({ requestId, messageId: 'pending:agent', status, ...(reason ? { reason } : {}) }),
          updated_at: NOW,
        },
      },
    });
    for (const listener of signal.listeners) listener('session-1', 'input.state');
  };

  it('removes a cancelled input only after durable confirmation and returns idempotent success after disconnect', async () => {
    const pending = cancel();
    await vi.waitFor(() => expect(signal.listeners.size).toBe(1));
    expect(readChatHistory(userId, 'agent', 'thread-1', OVERRIDE)).toHaveLength(1);
    acknowledgeCancel('accepted');
    expect(await pending).toEqual({ status: 200, body: { ok: true, id: 'pending' } });
    expect(readChatHistory(userId, 'agent', 'thread-1', OVERRIDE)).toEqual([]);
    expect(readChatHistory(userId, 'agent', 'thread-1', OVERRIDE, { includeCancelled: true })).toEqual([
      expect.objectContaining({
        id: 'pending',
        text: '',
        inputState: { messageId: 'pending', status: 'cancelled' },
      }),
    ]);
    const db = openInboundDb('agent', 'session-1');
    expect(db.prepare('SELECT status FROM messages_in WHERE id = ?').pluck().get('pending:agent')).toBe('completed');
    db.close();
    expect(signal.stop).not.toHaveBeenCalled();
    signal.connected = false;
    signal.turn = null;
    expect(await cancel()).toEqual({ status: 200, body: { ok: true, id: 'pending' } });
  });

  it('authorizes cancellation against the message author and exact conversation, with strict body validation', async () => {
    expect((await cancel({ user: 'web:other' })).status).toBe(404);
    expect((await cancel({ user: 'web:owner' })).status).toBe(404);
    expect((await cancel({ thread: 'thread-2' })).status).toBe(404);
    expect((await cancel({ group: 'other' })).status).toBe(403);
    expect((await cancel({ query: '?channel=web' })).status).toBe(400);
    expect((await cancel({ body: { requestId, text: 'unexpected' } })).status).toBe(400);
    expect((await cancel({ body: { requestId: 'invalid' } })).status).toBe(400);
    signal.turn = { ...TURN, supportsInputEditing: true };
    expect((await cancel()).body.error).toBe('cancellation_unsupported');
    signal.connected = false;
    expect((await cancel()).body.error).toBe('runner_disconnected');
  });

  it('keeps the input visible when authoritative consumption wins cancellation', async () => {
    const pending = cancel();
    await vi.waitFor(() => expect(signal.listeners.size).toBe(1));
    acknowledgeCancel('conflict', 'steering_consumed');
    expect(await pending).toEqual({ status: 409, body: { error: 'steering_consumed' } });
    expect(readChatHistory(userId, 'agent', 'thread-1', OVERRIDE)).toHaveLength(1);
  });

  it('broadcasts only scoped empty cancellation tombstones to other connected tabs', async () => {
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
    try {
      const pending = cancel();
      await vi.waitFor(() => expect(signal.listeners.size).toBe(2));
      acknowledgeCancel('accepted');
      expect((await pending).status).toBe(200);
      const tombstone = [...frames].reverse().find((frame) => frame.kind === 'input-state');
      expect(tombstone?.states).toEqual([
        {
          messageId: 'pending',
          inputState: { messageId: 'pending', status: 'cancelled' },
          text: '',
          canEditPending: false,
        },
      ]);
      ws.emit('close');
      frames.length = 0;
      handleChatUpgrade(req, new PassThrough(), Buffer.alloc(0));
      expect(frames.find((frame) => frame.kind === 'history')?.messages).toEqual([
        expect.objectContaining({ id: 'pending', text: '', inputState: { messageId: 'pending', status: 'cancelled' } }),
      ]);
    } finally {
      ws.emit('close');
    }
  });

  it('serializes cancellation with edits and keeps cancellation timeout retries idempotent', async () => {
    vi.useFakeTimers();
    try {
      const pending = cancel();
      await vi.advanceTimersByTimeAsync(1);
      expect((await edit()).body.error).toBe('cancel_in_progress');
      await vi.advanceTimersByTimeAsync(5_000);
      expect(await pending).toEqual({ status: 503, body: { error: 'cancel_pending' } });
      acknowledgeCancel('accepted');
      expect((await cancel()).status).toBe(200);
      const db = openInboundDb('agent', 'session-1');
      expect(db.prepare('SELECT COUNT(*) FROM messages_in WHERE id = ?').pluck().get(`cancel-${requestId}`)).toBe(1);
      db.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects stale text, other authors, other conversations, external channels and invalid requests', async () => {
    expect((await edit({ body: { ...body, expectedText: 'stale' } })).body.error).toBe('text_changed');
    expect((await edit({ user: 'web:other' })).status).toBe(404);
    expect((await edit({ user: 'web:owner' })).status).toBe(404);
    expect((await edit({ thread: 'thread-2' })).status).toBe(404);
    expect((await edit({ group: 'other' })).status).toBe(403);
    expect((await edit({ user: 'web:owner', query: '?channel=resend&mg=mail-mg' })).status).toBe(403);
    expect((await edit({ query: '?channel=web' })).status).toBe(400);
    expect((await edit({ method: 'POST' })).status).toBe(405);
    expect((await edit({ body: { ...body, text: ' ' } })).status).toBe(400);
    expect((await edit({ body: { ...body, requestId: 'not-a-uuid' } })).status).toBe(400);
    expect((await edit({ body: { ...body, attachments: [] } })).status).toBe(400);
    expect(readChatHistory('web:other', 'agent', 'thread-1', OVERRIDE)[0].canEditPending).toBe(false);
  });

  it('requires a connected editing-capable runner and blocks known processing inputs', async () => {
    signal.connected = false;
    expect((await edit()).body.error).toBe('runner_disconnected');
    signal.connected = true;
    signal.turn = { ...TURN, supportsSteering: true };
    expect((await edit()).body.error).toBe('editing_unsupported');
    signal.turn = { ...TURN, supportsInputEditing: true, status: 'stopping' };
    expect((await edit()).status).toBe(409);
    signal.turn = { ...TURN, supportsInputEditing: true };
    const db = openOutboundDbRw('agent', 'session-1');
    db.prepare("INSERT INTO processing_ack VALUES (?, 'processing', ?)").run('pending:agent', NOW);
    db.close();
    expect((await edit()).body.error).toBe('input_not_pending');
    const message = readChatHistory(userId, 'agent', 'thread-1', OVERRIDE)[0];
    expect(message.canEditPending).toBe(false);
    expect(message.inputState?.status).toBe('processing');
  });

  it('returns conflict when consumption wins despite lagging host status', async () => {
    const pending = edit();
    await vi.waitFor(() => expect(signal.listeners.size).toBe(1));
    acknowledge('conflict', 'steering_consumed');
    expect(await pending).toEqual({ status: 409, body: { error: 'steering_consumed' } });
    expect(JSON.parse(target().content).text).toBe('original');
  });

  it('serializes concurrent edits and allows an ambiguous timeout to be retried with the same request ID', async () => {
    vi.useFakeTimers();
    try {
      const pending = edit();
      await vi.advanceTimersByTimeAsync(1);
      const second = edit({ body: { ...body, requestId: 'f965e0be-d447-4795-bfd4-1a4bd2b2807c' } });
      await vi.advanceTimersByTimeAsync(1);
      expect((await second).body.error).toBe('edit_in_progress');
      await vi.advanceTimersByTimeAsync(5_000);
      expect(await pending).toEqual({ status: 503, body: { error: 'edit_pending' } });
      expect(signal.listeners.size).toBe(0);
      acknowledge('accepted');
      const retry = edit();
      await vi.advanceTimersByTimeAsync(1);
      expect((await retry).status).toBe(200);
    } finally {
      vi.useRealTimers();
    }
  });
});

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
