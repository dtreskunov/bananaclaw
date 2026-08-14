/**
 * Endpoint-level tests for POST /api/groups/:id/chat/:threadId/fork.
 *
 * The primitive itself is covered in src/fork-session.test.ts; these pin the
 * route's guards — session-mode eligibility, anchor validation, and that a
 * fork is reachable by anyone who can read the thread rather than requiring
 * the admin privilege that deletion does.
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import http from 'http';
import path from 'path';
import { Readable, Writable } from 'stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const TEST_ROOT = '/tmp/nanoclaw-test-ui-fork-thread';

vi.mock('../../../config.js', async () => {
  const actual = await vi.importActual<typeof import('../../../config.js')>('../../../config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-ui-fork-thread/data' };
});

vi.mock('../../../container-runner.js', () => ({
  killContainer: vi.fn(),
  resolveProviderName: vi.fn().mockReturnValue('claude'),
}));

import { closeDb, getDb, initTestDb, runMigrations } from '../../../db/index.js';
import { getThreadFork } from '../../../db/thread-forks.js';
import { grantRole } from '../../../modules/permissions/db/user-roles.js';
import { closeSearchDb, indexMessage, initSearchDb } from '../../../search-index.js';
import { inboundDbPath, initSessionFolder, outboundDbPath } from '../../../session-manager.js';
import { handleChatRequest } from './chat.js';

const TEST_DATA_DIR = path.join(TEST_ROOT, 'data');
const NOW = new Date().toISOString();
const USER_ID = 'web:member';
const ADMIN_ID = 'web:admin';
const GROUP_ID = 'agent';
const WEB_MG = 'web-mg';
const WEB_PLATFORM_ID = `group:${GROUP_ID}`;
const THREAD = 'thread-1';
const SESSION = 'sess-1';

function makeRes(): { res: http.ServerResponse; done: Promise<void>; status: () => number; body: () => string } {
  let status = 0;
  const chunks: Buffer[] = [];
  let resolve!: () => void;
  const done = new Promise<void>((r) => {
    resolve = r;
  });
  const writable = new Writable({
    write(chunk, _enc, cb): void {
      chunks.push(Buffer.from(chunk));
      cb();
    },
  });
  const res = writable as unknown as http.ServerResponse;
  res.writeHead = ((next: number) => {
    status = next;
    return res;
  }) as http.ServerResponse['writeHead'];
  writable.on('finish', resolve);
  return { res, done, status: () => status, body: () => Buffer.concat(chunks).toString('utf8') };
}

async function postFork(
  body: unknown,
  opts: { threadId?: string; query?: string; userId?: string } = {},
): Promise<{ status: number; json: Record<string, unknown> }> {
  const threadId = opts.threadId ?? THREAD;
  const pathname = `/api/groups/${GROUP_ID}/chat/${encodeURIComponent(threadId)}/fork`;
  const req = Readable.from([Buffer.from(JSON.stringify(body))]) as unknown as http.IncomingMessage;
  req.method = 'POST';
  req.url = pathname + (opts.query ?? '');
  req.headers = { 'content-type': 'application/json' };
  const captured = makeRes();
  expect(await handleChatRequest(req, captured.res, pathname, opts.userId ?? USER_ID)).toBe(true);
  await captured.done;
  return { status: captured.status(), json: JSON.parse(captured.body() || '{}') };
}

async function call(
  method: string,
  pathname: string,
  opts: { query?: string; userId?: string } = {},
): Promise<{ status: number; json: Record<string, unknown> }> {
  const req = Readable.from([]) as unknown as http.IncomingMessage;
  req.method = method;
  req.url = pathname + (opts.query ?? '');
  req.headers = {};
  const captured = makeRes();
  expect(await handleChatRequest(req, captured.res, pathname, opts.userId ?? USER_ID)).toBe(true);
  await captured.done;
  return { status: captured.status(), json: JSON.parse(captured.body() || '{}') };
}

async function listThreads(userId = USER_ID): Promise<Record<string, ThreadJson>> {
  const { json } = await call('GET', `/api/groups/${GROUP_ID}/chat/threads`, { userId });
  const byId: Record<string, ThreadJson> = {};
  for (const t of json.threads as ThreadJson[]) byId[t.threadId] = t;
  return byId;
}

interface ThreadJson {
  threadId: string;
  forkedFrom?: { threadId: string; messageId: string; title: string | null; deleted: boolean; fidelity: string };
  forkChildCount?: number;
}

function seedMessagingGroup(id: string, channelType: string, platformId: string, sessionMode: string): void {
  getDb()
    .prepare(
      `INSERT INTO messaging_groups
         (id, channel_type, platform_id, instance, name, is_group, unknown_sender_policy, created_at)
       VALUES (?, ?, ?, ?, ?, 0, 'strict', ?)`,
    )
    .run(id, channelType, platformId, channelType, id, NOW);
  getDb()
    .prepare(
      `INSERT INTO messaging_group_agents
         (id, messaging_group_id, agent_group_id, session_mode, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(`wire-${id}`, id, GROUP_ID, sessionMode, NOW);
}

function seedThread(): void {
  getDb()
    .prepare(
      `INSERT INTO sessions
         (id, agent_group_id, messaging_group_id, thread_id, status, container_status, created_at)
       VALUES (?, ?, ?, ?, 'active', 'stopped', ?)`,
    )
    .run(SESSION, GROUP_ID, WEB_MG, THREAD, NOW);
  initSessionFolder(GROUP_ID, SESSION);

  const inDb = new Database(inboundDbPath(GROUP_ID, SESSION));
  inDb
    .prepare(
      `INSERT INTO messages_in (id, seq, kind, timestamp, status, trigger, platform_id, channel_type, thread_id, content)
       VALUES ('u1', 2, 'chat', '2026-01-01T00:01:00.000Z', 'processed', 1, ?, 'web', ?, '{"text":"hello"}')`,
    )
    .run(WEB_PLATFORM_ID, THREAD);
  inDb.close();

  const outDb = new Database(outboundDbPath(GROUP_ID, SESSION));
  outDb
    .prepare(
      `INSERT INTO messages_out (id, seq, in_reply_to, timestamp, kind, platform_id, channel_type, thread_id, content)
       VALUES ('a1', 1, 'u1', '2026-01-01T00:02:00.000Z', 'chat', ?, 'web', ?, '{"text":"hi back"}')`,
    )
    .run(WEB_PLATFORM_ID, THREAD);
  outDb
    .prepare(
      `INSERT INTO messages_out (id, seq, in_reply_to, timestamp, kind, platform_id, channel_type, thread_id, content)
       VALUES ('a2', 3, 'u1', '2026-01-01T00:03:00.000Z', 'chat', ?, 'web', ?, '{"text":"and more"}')`,
    )
    .run(WEB_PLATFORM_ID, THREAD);
  outDb.close();
}

/** The parent's messages as the host would have indexed them. */
const INDEXED = [
  { id: 'u1', direction: 'in' as const, timestamp: '2026-01-01T00:01:00.000Z', text: 'hello' },
  { id: 'a1', direction: 'out' as const, timestamp: '2026-01-01T00:02:00.000Z', text: 'hi back' },
  { id: 'a2', direction: 'out' as const, timestamp: '2026-01-01T00:03:00.000Z', text: 'and more' },
].map((m) => ({
  ...m,
  sessionId: SESSION,
  agentGroupId: GROUP_ID,
  messagingGroupId: WEB_MG,
  channelType: 'web',
  threadId: THREAD,
}));

function findSession(threadId: string): string {
  const row = getDb().prepare(`SELECT id FROM sessions WHERE thread_id = ?`).get(threadId) as { id: string };
  return row.id;
}

function indexedAt(messageId: string): { session_id: string; thread_id: string } | undefined {
  const search = new Database(path.join(TEST_DATA_DIR, 'search.db'), { readonly: true });
  try {
    return search.prepare(`SELECT session_id, thread_id FROM message_index WHERE id = ?`).get(messageId) as
      | { session_id: string; thread_id: string }
      | undefined;
  } finally {
    search.close();
  }
}

beforeEach(() => {
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
  const db = initTestDb();
  runMigrations(db);
  getDb()
    .prepare(`INSERT INTO users (id, kind, display_name, created_at) VALUES (?, 'web', 'Member', ?)`)
    .run(USER_ID, NOW);
  getDb()
    .prepare(`INSERT INTO users (id, kind, display_name, created_at) VALUES (?, 'web', 'Admin', ?)`)
    .run(ADMIN_ID, NOW);
  getDb()
    .prepare(
      `INSERT INTO agent_groups (id, name, folder, agent_provider, created_at) VALUES (?, 'Agent', 'agent', NULL, ?)`,
    )
    .run(GROUP_ID, NOW);
  getDb()
    .prepare(`INSERT INTO agent_group_members (user_id, agent_group_id, added_by, added_at) VALUES (?, ?, ?, ?)`)
    .run(USER_ID, GROUP_ID, USER_ID, NOW);
  grantRole({ user_id: ADMIN_ID, role: 'admin', agent_group_id: null, granted_by: ADMIN_ID, granted_at: NOW });
});

afterEach(() => {
  closeDb();
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
});

describe('POST chat thread fork', () => {
  it('forks for a plain member — reading a thread is enough to branch it', async () => {
    seedMessagingGroup(WEB_MG, 'web', WEB_PLATFORM_ID, 'per-thread');
    seedThread();

    const { status, json } = await postFork({ atMessageId: 'a1' });
    expect(status).toBe(200);
    expect(json.fidelity).toBe('transcript');
    expect(json.copied).toEqual({ in: 1, out: 1 });

    const newThreadId = json.threadId as string;
    expect(newThreadId).not.toBe(THREAD);
    expect(getThreadFork(GROUP_ID, WEB_MG, newThreadId)?.parent_thread_id).toBe(THREAD);

    const row = getDb()
      .prepare('SELECT thread_id FROM sessions WHERE id = ?')
      .get(json.sessionId as string);
    expect(row).toEqual({ thread_id: newThreadId });
  });

  it('rejects a missing anchor id', async () => {
    seedMessagingGroup(WEB_MG, 'web', WEB_PLATFORM_ID, 'per-thread');
    seedThread();
    const { status, json } = await postFork({});
    expect(status).toBe(400);
    expect(json.error).toBe('at_message_id_required');
  });

  it('404s an anchor that is not in the thread', async () => {
    seedMessagingGroup(WEB_MG, 'web', WEB_PLATFORM_ID, 'per-thread');
    seedThread();
    const { status, json } = await postFork({ atMessageId: 'nope' });
    expect(status).toBe(404);
    expect(json.error).toBe('anchor_not_found');
  });

  it('404s an unknown thread', async () => {
    seedMessagingGroup(WEB_MG, 'web', WEB_PLATFORM_ID, 'per-thread');
    const { status, json } = await postFork({ atMessageId: 'a1' }, { threadId: 'ghost' });
    expect(status).toBe(404);
    expect(json.error).toBe('thread_not_found');
  });

  it('refuses to fork a shared session, which cannot own a second session', async () => {
    seedMessagingGroup(WEB_MG, 'web', WEB_PLATFORM_ID, 'per-thread');
    seedMessagingGroup('shared-mg', 'resend', 'resend:agent@example.com', 'shared');
    seedThread();
    const { status, json } = await postFork(
      { atMessageId: 'a1' },
      { query: '?channel=resend&mg=shared-mg', userId: ADMIN_ID },
    );
    expect(status).toBe(400);
    expect(json.error).toBe('unsupported_session_mode');
  });

  it('rejects non-POST methods', async () => {
    seedMessagingGroup(WEB_MG, 'web', WEB_PLATFORM_ID, 'per-thread');
    seedThread();
    const pathname = `/api/groups/${GROUP_ID}/chat/${THREAD}/fork`;
    const req = Readable.from([]) as unknown as http.IncomingMessage;
    req.method = 'GET';
    req.url = pathname;
    req.headers = {};
    const captured = makeRes();
    expect(await handleChatRequest(req, captured.res, pathname, USER_ID)).toBe(true);
    await captured.done;
    expect(captured.status()).toBe(405);
  });
});

describe('fork lineage in the threads list', () => {
  beforeEach(() => {
    seedMessagingGroup(WEB_MG, 'web', WEB_PLATFORM_ID, 'per-thread');
    seedThread();
  });

  it('reports the origin on the branch and a child count on the parent', async () => {
    const { json } = await postFork({ atMessageId: 'a1' });
    const branchId = json.threadId as string;

    const threads = await listThreads();
    expect(threads[branchId].forkedFrom).toEqual({
      threadId: THREAD,
      messageId: 'a1',
      title: null,
      fidelity: 'transcript',
      deleted: false,
    });
    expect(threads[THREAD].forkChildCount).toBe(1);
    expect(threads[THREAD].forkedFrom).toBeUndefined();
  });

  it('marks the origin deleted once the parent is gone, and keeps the branch', async () => {
    const { json } = await postFork({ atMessageId: 'a1' });
    const branchId = json.threadId as string;

    const del = await call('DELETE', `/api/groups/${GROUP_ID}/chat/${THREAD}`, { userId: ADMIN_ID });
    expect(del.status).toBe(200);
    expect(del.json.removed).toBe(1);

    const threads = await listThreads(ADMIN_ID);
    expect(threads[THREAD]).toBeUndefined();
    expect(threads[branchId].forkedFrom?.deleted).toBe(true);
  });

  it('cascade delete takes the branches with it', async () => {
    const first = await postFork({ atMessageId: 'a1' });
    const branchId = first.json.threadId as string;
    const second = await postFork({ atMessageId: 'a1' }, { threadId: branchId });
    const grandchildId = second.json.threadId as string;

    const del = await call('DELETE', `/api/groups/${GROUP_ID}/chat/${THREAD}`, {
      query: '?cascade=1',
      userId: ADMIN_ID,
    });
    expect(del.status).toBe(200);
    expect(del.json.removed).toBe(3);

    const threads = await listThreads(ADMIN_ID);
    expect(threads[THREAD]).toBeUndefined();
    expect(threads[branchId]).toBeUndefined();
    expect(threads[grandchildId]).toBeUndefined();
  });
});

describe('search index handoff on delete', () => {
  beforeEach(() => {
    seedMessagingGroup(WEB_MG, 'web', WEB_PLATFORM_ID, 'per-thread');
    seedThread();
    initSearchDb();
    for (const m of INDEXED) indexMessage(m);
  });

  afterEach(() => {
    closeSearchDb();
  });

  it('hands messages the branch still shows over to the branch', async () => {
    const { json } = await postFork({ atMessageId: 'a1' });
    const branchId = json.threadId as string;
    const branchSession = findSession(branchId);

    const del = await call('DELETE', `/api/groups/${GROUP_ID}/chat/${THREAD}`, { userId: ADMIN_ID });
    expect(del.status).toBe(200);

    // u1/a1 are on screen in the branch, so they stay searchable there.
    expect(indexedAt('u1')).toEqual({ session_id: branchSession, thread_id: branchId });
    expect(indexedAt('a1')).toEqual({ session_id: branchSession, thread_id: branchId });
    // a2 came after the cut and exists nowhere now.
    expect(indexedAt('a2')).toBeUndefined();
  });

  it('hands them to the branch that cut deepest', async () => {
    const shallow = await postFork({ atMessageId: 'u1' });
    const deep = await postFork({ atMessageId: 'a1' });
    const deepId = deep.json.threadId as string;
    const deepSession = findSession(deepId);

    await call('DELETE', `/api/groups/${GROUP_ID}/chat/${THREAD}`, { userId: ADMIN_ID });

    // The shallow branch holds u1 too, but the deep one holds a superset and
    // the index has only one slot per message.
    expect(indexedAt('u1')).toEqual({ session_id: deepSession, thread_id: deepId });
    expect(indexedAt('a1')).toEqual({ session_id: deepSession, thread_id: deepId });
    expect(shallow.json.threadId).not.toBe(deepId);
  });

  it('purges outright when the cascade takes every branch too', async () => {
    await postFork({ atMessageId: 'a1' });

    await call('DELETE', `/api/groups/${GROUP_ID}/chat/${THREAD}`, { query: '?cascade=1', userId: ADMIN_ID });

    expect(indexedAt('u1')).toBeUndefined();
    expect(indexedAt('a1')).toBeUndefined();
    expect(indexedAt('a2')).toBeUndefined();
  });
});
