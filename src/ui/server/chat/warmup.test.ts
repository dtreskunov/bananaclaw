import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { Readable, Writable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const TEST_ROOT = path.join(os.tmpdir(), `nanoclaw-ui-warmup-${process.pid}`);
vi.mock('../../../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../config.js')>()),
  DATA_DIR: path.join(os.tmpdir(), `nanoclaw-ui-warmup-${process.pid}`),
}));
vi.mock('../../../container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(true),
  killContainer: vi.fn(),
}));

import { killContainer, wakeContainer } from '../../../container-runner.js';
import { closeDb, getDb, initTestDb, runMigrations } from '../../../db/index.js';
import { getSessionsByAgentGroup, deleteSession } from '../../../db/sessions.js';
import { createWebAdapter } from '../../../channels/web.js';
import { routeInbound } from '../../../router.js';
import { openInboundDb, openOutboundDb } from '../../../session-manager.js';
import { stopTypingRefresh } from '../../../modules/typing/index.js';
import type { ChannelAdapter } from '../../../channels/adapter.js';
import { handleChatRequest, listThreadsForViewer, matchChatPath } from './chat.js';
import { threadScanner } from './thread-scanner.js';

let adapter: ChannelAdapter;
const GROUP = 'agent';
const USER = 'web:member';
const THREAD = 'empty-thread';

async function call(
  suffix = `${THREAD}/warmup`,
  method = 'POST',
  userId = USER,
  body?: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const url = `/api/groups/${GROUP}/chat/${suffix}`;
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
  Object.assign(req, { method, url, headers: { 'content-type': 'application/json' } });
  const chunks: Buffer[] = [];
  const res = new Writable({
    write(chunk, _encoding, done) {
      chunks.push(Buffer.from(chunk));
      done();
    },
  });
  let status = 0;
  Object.assign(res, {
    writeHead(code: number) {
      status = code;
      return res;
    },
  });
  await handleChatRequest(req as http.IncomingMessage, res as http.ServerResponse, url.split('?')[0], userId);
  return { status, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) };
}

beforeEach(async () => {
  fs.mkdirSync(TEST_ROOT, { recursive: true });
  runMigrations(initTestDb());
  const db = getDb();
  for (const id of [USER, 'web:outsider']) {
    db.prepare("INSERT INTO users (id, kind, created_at) VALUES (?, 'web', ?)").run(id, new Date().toISOString());
  }
  db.prepare('INSERT INTO agent_groups (id, name, folder, created_at) VALUES (?, ?, ?, ?)').run(
    GROUP,
    GROUP,
    GROUP,
    new Date().toISOString(),
  );
  db.prepare('INSERT INTO agent_group_members (user_id, agent_group_id, added_by, added_at) VALUES (?, ?, ?, ?)').run(
    USER,
    GROUP,
    USER,
    new Date().toISOString(),
  );
  vi.mocked(wakeContainer).mockReset().mockResolvedValue(true);
  vi.mocked(killContainer).mockReset();
  adapter = createWebAdapter();
  await adapter.setup({
    onInbound: vi.fn(),
    onInboundEvent: routeInbound,
    onMetadata: vi.fn(),
    onAction: vi.fn(),
  });
});

afterEach(async () => {
  for (const session of getSessionsByAgentGroup(GROUP)) stopTypingRefresh(session.id);
  await adapter.teardown?.();
  await threadScanner.close();
  closeDb();
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
});

describe('web thread warmup', () => {
  it('keeps New thread lightweight and recognizes the warmup route', async () => {
    expect(matchChatPath('/api/groups/agent/chat/draft%20thread/warmup')).toEqual({
      kind: 'warmup',
      groupId: GROUP,
      threadId: 'draft thread',
    });
    expect((await call('start')).status).toBe(200);
    expect(getSessionsByAgentGroup(GROUP)).toEqual([]);
    expect(wakeContainer).not.toHaveBeenCalled();
  });

  it('warms an empty session without creating messages, turns, or title requests', async () => {
    const result = await call();
    expect(result.status).toBe(200);
    const [session] = getSessionsByAgentGroup(GROUP);
    expect(result.body.sessionId).toBe(session.id);
    expect(wakeContainer).toHaveBeenCalledWith(session);
    const inbound = openInboundDb(GROUP, session.id);
    const outbound = openOutboundDb(GROUP, session.id);
    try {
      expect(inbound.prepare('SELECT COUNT(*) AS n FROM messages_in').get()).toEqual({ n: 0 });
      expect(inbound.prepare('SELECT COUNT(*) AS n FROM thread_titles').get()).toEqual({ n: 0 });
      expect(outbound.prepare('SELECT COUNT(*) AS n FROM messages_out').get()).toEqual({ n: 0 });
      expect(outbound.prepare('SELECT COUNT(*) AS n FROM turns').get()).toEqual({ n: 0 });
    } finally {
      inbound.close();
      outbound.close();
    }
    expect(await listThreadsForViewer(USER, GROUP)).toEqual([
      expect.objectContaining({
        threadId: THREAD,
        sessionId: session.id,
        title: '(new thread)',
        messageCount: 0,
      }),
    ]);
    expect((await call()).body.sessionId).toBe(session.id);
    expect(getSessionsByAgentGroup(GROUP)).toHaveLength(1);
  });

  it('routes Send into the same session even while warmup is still starting', async () => {
    let complete!: (started: boolean) => void;
    vi.mocked(wakeContainer).mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          complete = resolve;
        }),
    );
    const warming = call();
    const [session] = getSessionsByAgentGroup(GROUP);
    const submitted = await call(`${THREAD}/send`, 'POST', USER, {
      text: 'Hello',
      clientMessageId: 'first-message',
    });
    expect(submitted).toMatchObject({ status: 200 });
    expect(getSessionsByAgentGroup(GROUP)).toHaveLength(1);
    expect(vi.mocked(wakeContainer).mock.calls.map(([s]) => s.id)).toEqual([session.id, session.id]);
    const inbound = openInboundDb(GROUP, session.id);
    try {
      expect(inbound.prepare('SELECT kind FROM messages_in').all()).toEqual([{ kind: 'chat' }]);
    } finally {
      inbound.close();
    }
    complete(true);
    expect((await warming).body.sessionId).toBe(session.id);
  });

  it('returns the reusable session on admission deferral and lets Send retry normally', async () => {
    vi.mocked(wakeContainer).mockResolvedValueOnce(false);
    const deferred = await call();
    expect(deferred.status).toBe(503);
    expect(deferred.body).toMatchObject({ error: 'warmup_deferred' });
    expect((await call(`${THREAD}/send`, 'POST', USER, { text: 'Hello' })).status).toBe(200);
    expect(getSessionsByAgentGroup(GROUP)).toHaveLength(1);
    expect(wakeContainer).toHaveBeenLastCalledWith(expect.objectContaining({ id: deferred.body.sessionId }));
  });

  it('keeps separate drafts in separate sessions with the default wiring', async () => {
    const first = await call();
    const second = await call('another-draft/warmup');
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.body.sessionId).not.toBe(first.body.sessionId);
    expect(getSessionsByAgentGroup(GROUP)).toHaveLength(2);
    expect((await call(`${THREAD}/send`, 'POST', USER, { text: 'Hello' })).status).toBe(200);
    expect(wakeContainer).toHaveBeenLastCalledWith(expect.objectContaining({ id: first.body.sessionId }));
  });

  it('preserves agent-shared wiring when warming and submitting across drafts', async () => {
    await call('start');
    getDb().prepare("UPDATE messaging_group_agents SET session_mode = 'agent-shared'").run();
    const first = await call();
    const second = await call('another-draft/warmup');
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.body.sessionId).toBe(first.body.sessionId);
    expect((await call('another-draft/send', 'POST', USER, { text: 'Hello' })).status).toBe(200);
    expect(getSessionsByAgentGroup(GROUP)).toHaveLength(1);
    expect(wakeContainer).toHaveBeenLastCalledWith(expect.objectContaining({ id: first.body.sessionId }));
  });

  it('stops a warmup that finishes after another tab has deleted its session', async () => {
    let complete!: (started: boolean) => void;
    vi.mocked(wakeContainer).mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          complete = resolve;
        }),
    );
    const warming = call();
    const [session] = getSessionsByAgentGroup(GROUP);
    deleteSession(session.id);
    complete(true);
    expect((await warming).status).toBe(409);
    expect(killContainer).toHaveBeenCalledWith(session.id, 'thread-deleted');
    expect(getSessionsByAgentGroup(GROUP)).toEqual([]);
  });

  it('denies a non-member before creating a messaging group or session', async () => {
    expect((await call(`${THREAD}/warmup`, 'POST', 'web:outsider')).status).toBe(403);
    expect(getDb().prepare('SELECT COUNT(*) AS n FROM messaging_groups').get()).toEqual({ n: 0 });
    expect(getSessionsByAgentGroup(GROUP)).toEqual([]);
    expect(wakeContainer).not.toHaveBeenCalled();
  });

  it.each([
    ['GET', `${THREAD}/warmup`, 405],
    ['POST', '__dm%3Aother/warmup', 400],
    ['POST', 'bad%2Fthread/warmup', 400],
    ['POST', 'bad%00thread/warmup', 400],
    ['POST', `${'a'.repeat(257)}/warmup`, 400],
    ['POST', `${THREAD}/warmup?channel=telegram&mg=foreign`, 400],
    ['POST', `${THREAD}/warmup?sessionId=foreign`, 400],
  ])('rejects %s %s without waking a container', async (method, suffix, status) => {
    expect((await call(suffix, method)).status).toBe(status);
    expect(getSessionsByAgentGroup(GROUP)).toEqual([]);
    expect(wakeContainer).not.toHaveBeenCalled();
  });
});
