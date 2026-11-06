import Database from 'better-sqlite3';
import fs from 'fs';
import http from 'http';
import path from 'path';
import { Readable, Writable } from 'stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const TEST_ROOT = `${process.cwd()}/.test-state/nanoclaw-test-ui-task-run`;
const TEST_DATA_DIR = path.join(TEST_ROOT, 'data');

vi.mock('../../../config.js', async () => {
  const actual = await vi.importActual<typeof import('../../../config.js')>('../../../config.js');
  return { ...actual, DATA_DIR: `${process.cwd()}/.test-state/nanoclaw-test-ui-task-run/data` };
});

vi.mock('../../../container-runner.js', () => ({
  killContainer: vi.fn(),
  resolveProviderName: vi.fn().mockReturnValue('claude'),
}));

import { closeDb, getDb, initTestDb, runMigrations } from '../../../db/index.js';
import { inboundDbPath, outboundDbPath, initSessionFolder } from '../../../session-manager.js';
import * as sessionManager from '../../../session-manager.js';
import { handleChatRequest } from './chat.js';

const NOW = 1786881600000;
const USER_ID = 'web:member';
const GROUP_ID = 'agent';
const MESSAGING_GROUP_ID = 'web-mg';
const PLATFORM_ID = `group:${GROUP_ID}`;
const THREAD_ID = 'thread-1';
const SESSION_ID = 'session-1';
const SERIES_ID = 'series-1';

function makeRes(): { res: http.ServerResponse; done: Promise<void>; status: () => number; body: () => string } {
  let status = 0;
  const chunks: Buffer[] = [];
  let resolve!: () => void;
  const done = new Promise<void>((doneResolve) => {
    resolve = doneResolve;
  });
  const writable = new Writable({
    write(chunk, _encoding, callback): void {
      chunks.push(Buffer.from(chunk));
      callback();
    },
  });
  const res = writable as unknown as http.ServerResponse;
  res.setHeader = vi.fn(() => res);
  res.writeHead = ((nextStatus: number) => {
    status = nextStatus;
    return res;
  }) as http.ServerResponse['writeHead'];
  writable.on('finish', resolve);
  return { res, done, status: () => status, body: () => Buffer.concat(chunks).toString('utf8') };
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
    .prepare(
      `INSERT INTO agent_groups (id, name, folder, agent_provider, created_at) VALUES (?, 'Agent', 'agent', NULL, ?)`,
    )
    .run(GROUP_ID, NOW);
  getDb()
    .prepare(`INSERT INTO agent_group_members (user_id, agent_group_id, added_by, added_at) VALUES (?, ?, ?, ?)`)
    .run(USER_ID, GROUP_ID, USER_ID, NOW);
  getDb()
    .prepare(
      `INSERT INTO messaging_groups
         (id, channel_type, platform_id, instance, name, is_group, unknown_sender_policy, created_at)
       VALUES (?, 'web', ?, 'web', 'Web', 0, 'strict', ?)`,
    )
    .run(MESSAGING_GROUP_ID, PLATFORM_ID, NOW);
  getDb()
    .prepare(
      `INSERT INTO messaging_group_agents
         (id, messaging_group_id, agent_group_id, session_mode, created_at)
       VALUES ('wire-1', ?, ?, 'per-thread', ?)`,
    )
    .run(MESSAGING_GROUP_ID, GROUP_ID, NOW);
  getDb()
    .prepare(
      `INSERT INTO sessions
         (id, agent_group_id, messaging_group_id, thread_id, status, container_status, created_at)
       VALUES (?, ?, ?, ?, 'active', 'stopped', ?)`,
    )
    .run(SESSION_ID, GROUP_ID, MESSAGING_GROUP_ID, THREAD_ID, NOW);
  initSessionFolder(GROUP_ID, SESSION_ID);

  const inDb = new Database(inboundDbPath(GROUP_ID, SESSION_ID));
  inDb
    .prepare(
      `INSERT INTO messages_in
         (id, seq, kind, timestamp, status, process_after, recurrence, series_id,
          trigger, platform_id, channel_type, thread_id, content)
       VALUES (?, 2, 'task', ?, 'pending', 1786968000000,
               '0 9 * * *', ?, 1, ?, 'web', ?, ?)`,
    )
    .run(SERIES_ID, NOW, SERIES_ID, PLATFORM_ID, THREAD_ID, JSON.stringify({ prompt: 'Find deals' }));
  inDb.prepare('UPDATE host_sequence SET last_even = 2 WHERE id = 1').run();
  inDb.close();
});

afterEach(() => {
  closeDb();
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
});

describe('POST chat task run', () => {
  it('batches exactly ten newest attempts per visible series using the series index', async () => {
    const inbound = new Database(inboundDbPath(GROUP_ID, SESSION_ID));
    inbound
      .prepare(
        `INSERT INTO messages_in(id,seq,kind,timestamp,status,process_after,series_id,channel_type,platform_id,thread_id,content)
      VALUES('series-2',4,'task',?,'paused',0,'series-2','web',?,?,'{"prompt":"Second"}')`,
      )
      .run(NOW, PLATFORM_ID, THREAD_ID);
    inbound.close();
    const outbound = new Database(outboundDbPath(GROUP_ID, SESSION_ID));
    for (const series of [SERIES_ID, 'series-2', 'hidden-series']) {
      for (let index = 0; index < 12; index++) {
        outbound
          .prepare(
            `INSERT INTO task_attempts(task_message_id,series_id,trigger_source,status,started_at)
          VALUES(?,?,'scheduled','completed',?)`,
          )
          .run(`${series}-${index}`, series, index);
      }
    }
    const all = vi.spyOn(Object.getPrototypeOf(outbound.prepare('SELECT 1')), 'all');
    const open = vi.spyOn(sessionManager, 'openOutboundDb');
    try {
      const pathname = `/api/groups/${GROUP_ID}/chat/${THREAD_ID}/tasks`;
      const req = Readable.from([]) as http.IncomingMessage;
      req.method = 'GET';
      req.url = pathname;
      const captured = makeRes();
      await handleChatRequest(req, captured.res, pathname, USER_ID);
      await captured.done;
      expect(captured.status()).toBe(200);
      const tasks = JSON.parse(captured.body()).tasks as { seriesId: string; attempts: { startedAt: number }[] }[];
      expect(tasks).toHaveLength(2);
      expect(tasks.map((task) => task.seriesId).sort()).toEqual([SERIES_ID, 'series-2']);
      for (const task of tasks)
        expect(task.attempts.map((attempt) => attempt.startedAt)).toEqual([11, 10, 9, 8, 7, 6, 5, 4, 3, 2]);
      expect(open).toHaveBeenCalledTimes(1);
      const index = all.mock.contexts.findIndex((statement) => statement.source.includes('JOIN task_attempts'));
      expect(all.mock.results[index].value).toHaveLength(20);
      const query = all.mock.contexts[index].source as string;
      const plan = outbound.prepare(`EXPLAIN QUERY PLAN ${query}`).all(JSON.stringify([SERIES_ID, 'series-2']));
      expect(JSON.stringify(plan)).toContain('idx_task_attempts_series_started');
      expect(JSON.stringify(plan)).not.toContain('SCAN attempt');
    } finally {
      all.mockRestore();
      open.mockRestore();
      outbound.close();
    }
  });

  it('surfaces missing task-attempt storage instead of returning empty success', async () => {
    const db = new Database(outboundDbPath(GROUP_ID, SESSION_ID));
    db.exec('DROP TABLE task_attempts');
    db.close();
    const pathname = `/api/groups/${GROUP_ID}/chat/${THREAD_ID}/tasks`;
    const req = Readable.from([]) as http.IncomingMessage;
    req.method = 'GET';
    req.url = pathname;
    const captured = makeRes();
    await handleChatRequest(req, captured.res, pathname, USER_ID);
    await captured.done;
    expect(captured.status()).toBe(500);
    expect(JSON.parse(captured.body())).toEqual({ error: 'task_list_failed' });
  });

  it.each([0, 1793934000123])('updates scheduled instants using exact epoch milliseconds %s', async (processAfter) => {
    const pathname = `/api/groups/${GROUP_ID}/chat/${THREAD_ID}/tasks/${SERIES_ID}`;
    const req = Readable.from([Buffer.from(JSON.stringify({ processAfter }))]) as http.IncomingMessage;
    req.method = 'PATCH';
    req.url = pathname;
    req.headers = { 'x-nanoclaw-ui-protocol': '16' };
    const captured = makeRes();
    expect(await handleChatRequest(req, captured.res, pathname, USER_ID)).toBe(true);
    await captured.done;
    expect(captured.status()).toBe(200);
    const db = new Database(inboundDbPath(GROUP_ID, SESSION_ID), { readonly: true });
    try {
      expect(db.prepare('SELECT process_after FROM messages_in WHERE id=?').get(SERIES_ID)).toEqual({
        process_after: processAfter,
      });
    } finally {
      db.close();
    }
  });

  it.each(['2026-11-06T03:00:00Z', 0.5, null, 8640000000000001])(
    'rejects invalid scheduled timestamp %s without changing the task',
    async (processAfter) => {
      const pathname = `/api/groups/${GROUP_ID}/chat/${THREAD_ID}/tasks/${SERIES_ID}`;
      const req = Readable.from([Buffer.from(JSON.stringify({ processAfter }))]) as http.IncomingMessage;
      req.method = 'PATCH';
      req.url = pathname;
      req.headers = { 'x-nanoclaw-ui-protocol': '16' };
      const captured = makeRes();
      expect(await handleChatRequest(req, captured.res, pathname, USER_ID)).toBe(true);
      await captured.done;
      expect(captured.status()).toBe(400);
      const db = new Database(inboundDbPath(GROUP_ID, SESSION_ID), { readonly: true });
      try {
        expect(db.prepare('SELECT process_after FROM messages_in WHERE id=?').get(SERIES_ID)).toEqual({
          process_after: 1786968000000,
        });
      } finally {
        db.close();
      }
    },
  );

  it('creates a distinct manual occurrence and leaves the schedule unchanged', async () => {
    const pathname = `/api/groups/${GROUP_ID}/chat/${THREAD_ID}/tasks/${SERIES_ID}/run`;
    const req = Readable.from([]) as unknown as http.IncomingMessage;
    req.method = 'POST';
    req.url = pathname;
    req.headers = { 'x-nanoclaw-ui-protocol': '16' };
    const captured = makeRes();

    expect(await handleChatRequest(req, captured.res, pathname, USER_ID)).toBe(true);
    await captured.done;

    expect(captured.status()).toBe(200);
    const response = JSON.parse(captured.body()) as { occurrenceId: string };
    expect(response.occurrenceId).not.toBe(SERIES_ID);

    const inDb = new Database(inboundDbPath(GROUP_ID, SESSION_ID));
    const scheduled = inDb
      .prepare('SELECT process_after, recurrence, content FROM messages_in WHERE id = ?')
      .get(SERIES_ID) as { process_after: number; recurrence: string; content: string };
    const manual = inDb
      .prepare('SELECT series_id, process_after, recurrence, content FROM messages_in WHERE id = ?')
      .get(response.occurrenceId) as {
      series_id: string;
      process_after: number;
      recurrence: string | null;
      content: string;
    };
    inDb.close();

    expect(scheduled.process_after).toBe(1786968000000);
    expect(scheduled.recurrence).toBe('0 9 * * *');
    expect(JSON.parse(scheduled.content).triggerSource).toBeUndefined();
    expect(manual.series_id).toBe(SERIES_ID);
    expect(manual.recurrence).toBeNull();
    expect(JSON.parse(manual.content).triggerSource).toBe('manual');
  });
});
