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
  outDb.close();
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
