/**
 * Tests for the thread-fork primitive.
 *
 * The dangerous parts of forking are not the copy itself but the two replay
 * hazards it creates: inherited outbound rows look undelivered to the delivery
 * poller, and inherited inbound rows look unprocessed to the container. Both
 * would fire on the fork's first wake and blast the whole history at the user.
 * These tests pin the guards (`delivered`, `processing_ack`, `trigger = 0`)
 * along with the ordering invariant that the session row is written last.
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./config.js', async () => {
  const actual = await vi.importActual('./config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-fork' };
});

vi.mock('./container-runner.js', () => ({
  resolveProviderName: vi.fn().mockReturnValue('claude'),
}));

vi.mock('./env.js', () => ({
  readEnvFile: vi.fn().mockReturnValue({}),
}));

import { closeDb, createAgentGroup, createMessagingGroup, initTestDb, runMigrations } from './db/index.js';
import { createSession, getSession } from './db/sessions.js';
import { getThreadFork } from './db/thread-forks.js';
import { ForkError, forkThread } from './fork-session.js';
import { resolveProviderName } from './container-runner.js';
import { readEnvFile } from './env.js';
import { inboundDbPath, initSessionFolder, outboundDbPath, sessionDir } from './session-manager.js';
import type { Session } from './types.js';

const TEST_DIR = '/tmp/nanoclaw-test-fork';
const AG = 'ag-1';
const MG = 'mg-1';
const PARENT_SESSION = 'sess-parent';
const PARENT_THREAD = 'thread-parent';
const NEW_THREAD = 'thread-fork';

function ts(n: number): string {
  return new Date(Date.UTC(2026, 0, 1, 0, n)).toISOString();
}

function parentSession(): Session {
  return {
    id: PARENT_SESSION,
    agent_group_id: AG,
    messaging_group_id: MG,
    thread_id: PARENT_THREAD,
    agent_provider: null,
    status: 'active',
    container_status: 'stopped',
    last_active: null,
    created_at: ts(0),
  };
}

/**
 * Parent transcript: u1 / a1 / u2 / a2, plus a scheduled task and a message in
 * an unrelated thread. Forking at `a1` must take u1+a1 and nothing else.
 */
function seedParent(): void {
  initSessionFolder(AG, PARENT_SESSION);

  const inDb = new Database(inboundDbPath(AG, PARENT_SESSION));
  inDb
    .prepare(
      `INSERT INTO messages_in (id, seq, kind, timestamp, status, trigger, platform_id, channel_type, thread_id, content)
       VALUES (@id, @seq, @kind, @timestamp, 'processed', 1, 'chan-1', 'discord', @thread_id, @content)`,
    )
    .run({ id: 'u1', seq: 2, kind: 'chat', timestamp: ts(1), thread_id: PARENT_THREAD, content: '{"text":"first"}' });
  inDb
    .prepare(
      `INSERT INTO messages_in (id, seq, kind, timestamp, status, trigger, platform_id, channel_type, thread_id, content)
       VALUES (@id, @seq, @kind, @timestamp, 'processed', 1, 'chan-1', 'discord', @thread_id, @content)`,
    )
    .run({ id: 'u2', seq: 4, kind: 'chat', timestamp: ts(3), thread_id: PARENT_THREAD, content: '{"text":"second"}' });
  inDb
    .prepare(
      `INSERT INTO messages_in (id, seq, kind, timestamp, status, trigger, platform_id, channel_type, thread_id, content)
       VALUES (@id, @seq, @kind, @timestamp, 'pending', 1, 'chan-1', 'discord', @thread_id, @content)`,
    )
    .run({
      id: 'task-1',
      seq: 6,
      kind: 'task',
      timestamp: ts(1),
      thread_id: PARENT_THREAD,
      content: '{"text":"cron"}',
    });
  inDb
    .prepare(
      `INSERT INTO messages_in (id, seq, kind, timestamp, status, trigger, platform_id, channel_type, thread_id, content)
       VALUES (@id, @seq, @kind, @timestamp, 'processed', 1, 'chan-1', 'discord', @thread_id, @content)`,
    )
    .run({
      id: 'other',
      seq: 8,
      kind: 'chat',
      timestamp: ts(1),
      thread_id: 'thread-other',
      content: '{"text":"nope"}',
    });
  inDb
    .prepare(
      `INSERT INTO thread_titles (channel_type, platform_id, thread_id, title, source, request_message_id, published, updated_at)
       VALUES ('discord', 'chan-1', @thread_id, 'Parent topic', 'model', 'u1', 1, @updated_at)`,
    )
    .run({ thread_id: PARENT_THREAD, updated_at: ts(1) });
  inDb.close();

  const outDb = new Database(outboundDbPath(AG, PARENT_SESSION));
  outDb
    .prepare(
      `INSERT INTO messages_out (id, seq, in_reply_to, timestamp, kind, platform_id, channel_type, thread_id, content)
       VALUES (@id, @seq, @in_reply_to, @timestamp, 'chat', 'chan-1', 'discord', @thread_id, @content)`,
    )
    .run({
      id: 'a1',
      seq: 1,
      in_reply_to: 'u1',
      timestamp: ts(2),
      thread_id: PARENT_THREAD,
      content: '{"text":"answer one"}',
    });
  outDb
    .prepare(
      `INSERT INTO messages_out (id, seq, in_reply_to, timestamp, kind, platform_id, channel_type, thread_id, content)
       VALUES (@id, @seq, @in_reply_to, @timestamp, 'chat', 'chan-1', 'discord', @thread_id, @content)`,
    )
    .run({
      id: 'a2',
      seq: 3,
      in_reply_to: 'u2',
      timestamp: ts(4),
      thread_id: PARENT_THREAD,
      content: '{"text":"answer two"}',
    });
  outDb
    .prepare(`INSERT INTO session_state (key, value, updated_at) VALUES ('continuation:claude', 'sdk-abc', @now)`)
    .run({ now: ts(4) });
  outDb.close();
}

function fork(anchor = 'a1') {
  return forkThread({
    agentGroupId: AG,
    messagingGroupId: MG,
    channelType: 'discord',
    parentSession: parentSession(),
    parentThreadId: PARENT_THREAD,
    anchorMessageId: anchor,
    newThreadId: NEW_THREAD,
    parentTitle: 'Parent topic',
  });
}

beforeEach(() => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  const db = initTestDb();
  runMigrations(db);
  createAgentGroup({ id: AG, name: 'Test Agent', folder: 'test-agent', agent_provider: null, created_at: ts(0) });
  createMessagingGroup({
    id: MG,
    channel_type: 'discord',
    platform_id: 'chan-1',
    name: 'General',
    is_group: 1,
    unknown_sender_policy: 'strict',
    created_at: ts(0),
  });
  createSession(parentSession());
  seedParent();
});

afterEach(() => {
  closeDb();
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
});

describe('forkThread', () => {
  it('copies history up to the anchor and stops there', () => {
    const result = fork('a1');

    const inDb = new Database(inboundDbPath(AG, result.sessionId), { readonly: true });
    const outDb = new Database(outboundDbPath(AG, result.sessionId), { readonly: true });
    try {
      const inIds = inDb.prepare('SELECT id FROM messages_in ORDER BY seq').all() as { id: string }[];
      const outIds = outDb.prepare('SELECT id FROM messages_out ORDER BY seq').all() as { id: string }[];
      // 'u2' is after the anchor, 'task-1' is a scheduled task, 'other' is a
      // different thread; 'a2' is after the anchor.
      expect(inIds.map((r) => r.id)).toEqual(['u1']);
      expect(outIds.map((r) => r.id)).toEqual(['a1']);
    } finally {
      inDb.close();
      outDb.close();
    }
    expect(result.copiedIn).toBe(1);
    expect(result.copiedOut).toBe(1);
  });

  it('rethreads inherited rows onto the new thread id', () => {
    const result = fork('a2');
    const inDb = new Database(inboundDbPath(AG, result.sessionId), { readonly: true });
    try {
      const threads = inDb.prepare('SELECT DISTINCT thread_id FROM messages_in').all() as { thread_id: string }[];
      expect(threads).toEqual([{ thread_id: NEW_THREAD }]);
    } finally {
      inDb.close();
    }
  });

  it('marks inherited outbound rows delivered so the poller never re-sends them', () => {
    const result = fork('a2');
    const inDb = new Database(inboundDbPath(AG, result.sessionId), { readonly: true });
    try {
      const rows = inDb.prepare('SELECT message_out_id, status FROM delivered ORDER BY message_out_id').all();
      expect(rows).toEqual([
        { message_out_id: 'a1', status: 'inherited' },
        { message_out_id: 'a2', status: 'inherited' },
      ]);
    } finally {
      inDb.close();
    }
  });

  it('acks inherited inbound rows and clears their trigger so the fork does not replay them', () => {
    const result = fork('a2');
    const inDb = new Database(inboundDbPath(AG, result.sessionId), { readonly: true });
    const outDb = new Database(outboundDbPath(AG, result.sessionId), { readonly: true });
    try {
      const triggers = inDb.prepare('SELECT DISTINCT trigger AS t FROM messages_in').all();
      expect(triggers).toEqual([{ t: 0 }]);
      const acks = outDb.prepare('SELECT message_id, status FROM processing_ack ORDER BY message_id').all();
      expect(acks).toEqual([
        { message_id: 'u1', status: 'completed' },
        { message_id: 'u2', status: 'completed' },
      ]);
    } finally {
      inDb.close();
      outDb.close();
    }
  });

  it('records fork_origin with a digest and the parent continuation', () => {
    const result = fork('a1');
    const inDb = new Database(inboundDbPath(AG, result.sessionId), { readonly: true });
    try {
      const row = inDb.prepare('SELECT * FROM fork_origin').get() as {
        parent_session_id: string;
        parent_continuation: string | null;
        provider: string;
        anchor_ref: string | null;
        digest: string;
      };
      expect(row.parent_session_id).toBe(PARENT_SESSION);
      expect(row.parent_continuation).toBe('sdk-abc');
      expect(row.provider).toBe('claude');
      // No turn_checkpoints table on this session, so no native anchor.
      expect(row.anchor_ref).toBeNull();
      expect(row.digest).toContain('first');
      expect(row.digest).toContain('answer one');
      expect(row.digest).not.toContain('answer two');
    } finally {
      inDb.close();
    }
    // Without a per-turn anchor the fork can only be reconstructed from the
    // digest, no matter what the provider supports.
    expect(result.fidelity).toBe('transcript');
  });

  it('carries the parent title so the branch is not left untitled', () => {
    const result = fork('a1');
    const inDb = new Database(inboundDbPath(AG, result.sessionId), { readonly: true });
    try {
      const row = inDb
        .prepare('SELECT title, source, published FROM thread_titles WHERE thread_id = ?')
        .get(NEW_THREAD);
      expect(row).toEqual({ title: 'Parent topic', source: 'fork', published: 1 });
    } finally {
      inDb.close();
    }
  });

  it('creates the session row and lineage record, and leaves the parent untouched', () => {
    const result = fork('a1');

    const session = getSession(result.sessionId);
    expect(session?.thread_id).toBe(NEW_THREAD);
    expect(session?.agent_group_id).toBe(AG);

    const lineage = getThreadFork(AG, MG, NEW_THREAD);
    expect(lineage?.parent_thread_id).toBe(PARENT_THREAD);
    expect(lineage?.parent_message_id).toBe('a1');
    expect(lineage?.fidelity).toBe('transcript');

    const parentIn = new Database(inboundDbPath(AG, PARENT_SESSION), { readonly: true });
    try {
      const count = parentIn.prepare('SELECT COUNT(*) AS c FROM messages_in').get() as { c: number };
      expect(count.c).toBe(4);
    } finally {
      parentIn.close();
    }
  });

  it('copies attachment directories for inherited messages only', () => {
    const parentDir = sessionDir(AG, PARENT_SESSION);
    fs.mkdirSync(path.join(parentDir, 'inbox', 'u1'), { recursive: true });
    fs.writeFileSync(path.join(parentDir, 'inbox', 'u1', 'a.txt'), 'kept');
    fs.mkdirSync(path.join(parentDir, 'inbox', 'u2'), { recursive: true });
    fs.writeFileSync(path.join(parentDir, 'inbox', 'u2', 'b.txt'), 'dropped');

    const result = fork('a1');
    const dir = sessionDir(AG, result.sessionId);
    expect(fs.readFileSync(path.join(dir, 'inbox', 'u1', 'a.txt'), 'utf8')).toBe('kept');
    expect(fs.existsSync(path.join(dir, 'inbox', 'u2'))).toBe(false);
  });

  it('rejects an unknown anchor without leaving a session behind', () => {
    expect(() => fork('nope')).toThrow(ForkError);
    const sessions = fs.readdirSync(path.join(TEST_DIR, 'v2-sessions', AG));
    expect(sessions).toEqual([PARENT_SESSION]);
  });

  it('takes the provider default from .env, which the service unit never loads', () => {
    const prior = process.env.DEFAULT_PROVIDER;
    delete process.env.DEFAULT_PROVIDER;
    vi.mocked(readEnvFile).mockReturnValue({ DEFAULT_PROVIDER: 'opencode' });
    try {
      fork('a1');
      expect(vi.mocked(resolveProviderName).mock.calls.at(-1)?.[2]).toBe('opencode');
    } finally {
      vi.mocked(readEnvFile).mockReturnValue({});
      if (prior !== undefined) process.env.DEFAULT_PROVIDER = prior;
    }
  });
});

/**
 * The two session DBs are written by different processes in different formats:
 * the host stores ISO in inbound.db, the container stores SQLite's
 * `datetime('now')` in outbound.db. Restate the seeded transcript the way it is
 * actually stored on disk — comparing those as strings cuts the fork in the
 * wrong place, in both directions.
 */
describe('forkThread — mixed timestamp formats', () => {
  const sqliteTs = (n: number): string => ts(n).replace('T', ' ').slice(0, 19);

  function setOutTs(id: string, timestamp: string): void {
    const outDb = new Database(outboundDbPath(AG, PARENT_SESSION));
    outDb.prepare('UPDATE messages_out SET timestamp = ? WHERE id = ?').run(timestamp, id);
    outDb.close();
  }

  beforeEach(() => {
    setOutTs('a1', sqliteTs(2));
    setOutTs('a2', sqliteTs(4));
  });

  it('keeps the user turns when branching at an assistant message', () => {
    const result = fork('a1');

    const inDb = new Database(inboundDbPath(AG, result.sessionId), { readonly: true });
    const outDb = new Database(outboundDbPath(AG, result.sessionId), { readonly: true });
    try {
      expect(
        (inDb.prepare('SELECT id FROM messages_in ORDER BY seq').all() as { id: string }[]).map((r) => r.id),
      ).toEqual(['u1']);
      expect(
        (outDb.prepare('SELECT id FROM messages_out ORDER BY seq').all() as { id: string }[]).map((r) => r.id),
      ).toEqual(['a1']);
      const origin = inDb.prepare('SELECT digest FROM fork_origin').get() as { digest: string };
      expect(origin.digest).toContain('**User:** first');
    } finally {
      inDb.close();
      outDb.close();
    }
  });

  it('leaves the later replies behind when branching at a user message', () => {
    const result = fork('u2');

    const outDb = new Database(outboundDbPath(AG, result.sessionId), { readonly: true });
    try {
      expect(
        (outDb.prepare('SELECT id FROM messages_out ORDER BY seq').all() as { id: string }[]).map((r) => r.id),
      ).toEqual(['a1']);
    } finally {
      outDb.close();
    }
  });

  it('treats a reply stamped in the same second as the anchor as after it', () => {
    // Outbound timestamps have whole-second resolution, so a fast reply can
    // land on the same second as the message it answers.
    setOutTs('a1', sqliteTs(1));
    const result = fork('u1');

    const outDb = new Database(outboundDbPath(AG, result.sessionId), { readonly: true });
    try {
      expect(outDb.prepare('SELECT COUNT(*) AS c FROM messages_out').get()).toEqual({ c: 0 });
    } finally {
      outDb.close();
    }
  });
});
