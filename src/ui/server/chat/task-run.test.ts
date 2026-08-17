import Database from 'better-sqlite3';
import fs from 'fs';
import http from 'http';
import path from 'path';
import { Readable, Writable } from 'stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const TEST_ROOT = '/tmp/nanoclaw-test-ui-task-run';
const TEST_DATA_DIR = path.join(TEST_ROOT, 'data');

vi.mock('../../../config.js', async () => {
  const actual = await vi.importActual<typeof import('../../../config.js')>('../../../config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-ui-task-run/data' };
});

vi.mock('../../../container-runner.js', () => ({
  killContainer: vi.fn(),
  resolveProviderName: vi.fn().mockReturnValue('claude'),
}));

import { closeDb, getDb, initTestDb, runMigrations } from '../../../db/index.js';
import { inboundDbPath, initSessionFolder } from '../../../session-manager.js';
import { handleChatRequest } from './chat.js';

const NOW = '2026-08-16T12:00:00.000Z';
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
       VALUES (?, 2, 'task', ?, 'pending', '2026-08-17T12:00:00.000Z',
               '0 9 * * *', ?, 1, ?, 'web', ?, ?)`,
    )
    .run(SERIES_ID, NOW, SERIES_ID, PLATFORM_ID, THREAD_ID, JSON.stringify({ prompt: 'Find deals' }));
  inDb.close();
});

afterEach(() => {
  closeDb();
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
});

describe('POST chat task run', () => {
  it('creates a distinct manual occurrence and leaves the schedule unchanged', async () => {
    const pathname = `/api/groups/${GROUP_ID}/chat/${THREAD_ID}/tasks/${SERIES_ID}/run`;
    const req = Readable.from([]) as unknown as http.IncomingMessage;
    req.method = 'POST';
    req.url = pathname;
    req.headers = {};
    const captured = makeRes();

    expect(await handleChatRequest(req, captured.res, pathname, USER_ID)).toBe(true);
    await captured.done;

    expect(captured.status()).toBe(200);
    const response = JSON.parse(captured.body()) as { occurrenceId: string };
    expect(response.occurrenceId).not.toBe(SERIES_ID);

    const inDb = new Database(inboundDbPath(GROUP_ID, SESSION_ID));
    const scheduled = inDb
      .prepare('SELECT process_after, recurrence, content FROM messages_in WHERE id = ?')
      .get(SERIES_ID) as { process_after: string; recurrence: string; content: string };
    const manual = inDb
      .prepare('SELECT series_id, process_after, recurrence, content FROM messages_in WHERE id = ?')
      .get(response.occurrenceId) as {
      series_id: string;
      process_after: string;
      recurrence: string | null;
      content: string;
    };
    inDb.close();

    expect(scheduled.process_after).toBe('2026-08-17T12:00:00.000Z');
    expect(scheduled.recurrence).toBe('0 9 * * *');
    expect(JSON.parse(scheduled.content).triggerSource).toBeUndefined();
    expect(manual.series_id).toBe(SERIES_ID);
    expect(manual.recurrence).toBeNull();
    expect(JSON.parse(manual.content).triggerSource).toBe('manual');
  });
});
