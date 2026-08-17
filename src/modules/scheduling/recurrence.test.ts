/**
 * Tests for `handleRecurrence` — specifically the timezone-aware cron
 * interpretation ported from v1 (src/v1/task-scheduler.ts).
 *
 * Core invariant: cron expressions are interpreted in the user's TIMEZONE,
 * not UTC. Without this, `"0 9 * * *"` fires at 09:00 UTC instead of 09:00
 * user-local — a recurring scheduling bug users can't diagnose.
 */
import fs from 'fs';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import { ensureSchema, openInboundDb, openOutboundDbRw } from '../../db/session-db.js';
import { insertTask } from './db.js';
import { handleRecurrence } from './recurrence.js';
import type { Session } from '../../types.js';

const TEST_DIR = '/tmp/nanoclaw-recurrence-test';
const DB_PATH = path.join(TEST_DIR, 'inbound.db');
const OUT_DB_PATH = path.join(TEST_DIR, 'outbound.db');

function freshDb() {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  ensureSchema(DB_PATH, 'inbound');
  return openInboundDb(DB_PATH);
}

function freshOutboundDb() {
  ensureSchema(OUT_DB_PATH, 'outbound');
  return openOutboundDbRw(OUT_DB_PATH);
}

function fakeSession(): Session {
  return {
    id: 'sess-test',
    agent_group_id: 'ag-test',
    messaging_group_id: 'mg-test',
    thread_id: null,
    status: 'active',
    created_at: new Date().toISOString(),
    last_active: new Date().toISOString(),
    container_status: 'stopped',
  } as Session;
}

afterEach(() => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
});

describe('handleRecurrence', () => {
  it('clones a completed recurring task with a next-run in the future', async () => {
    const db = freshDb();
    insertTask(db, {
      id: 'task-1',
      processAfter: '2020-01-01T00:00:00.000Z',
      recurrence: '0 9 * * *', // every day at 09:00 (user TZ)
      platformId: null,
      channelType: null,
      threadId: null,
      content: JSON.stringify({ prompt: 'daily digest' }),
    });
    db.prepare(`UPDATE messages_in SET status='completed' WHERE id='task-1'`).run();

    await handleRecurrence(db, fakeSession());

    const rows = db
      .prepare(`SELECT id, status, process_after, recurrence, series_id FROM messages_in ORDER BY seq`)
      .all() as Array<{
      id: string;
      status: string;
      process_after: string;
      recurrence: string | null;
      series_id: string;
    }>;
    expect(rows).toHaveLength(2);
    const original = rows.find((r) => r.id === 'task-1')!;
    const follow = rows.find((r) => r.id !== 'task-1')!;
    expect(original.recurrence).toBeNull();
    expect(follow.status).toBe('pending');
    expect(follow.recurrence).toBe('0 9 * * *');
    expect(follow.series_id).toBe('task-1');
    expect(new Date(follow.process_after).getTime()).toBeGreaterThan(Date.now());
  });

  it('does not clone rows whose recurrence is already cleared', async () => {
    const db = freshDb();
    insertTask(db, {
      id: 'task-1',
      processAfter: '2020-01-01T00:00:00.000Z',
      recurrence: null,
      platformId: null,
      channelType: null,
      threadId: null,
      content: JSON.stringify({ prompt: 'one-off' }),
    });
    db.prepare(`UPDATE messages_in SET status='completed' WHERE id='task-1'`).run();

    await handleRecurrence(db, fakeSession());

    const count = (db.prepare(`SELECT COUNT(*) AS c FROM messages_in`).get() as { c: number }).c;
    expect(count).toBe(1);
  });

  it('pauses the next occurrence after three consecutive scheduled failures', async () => {
    const db = freshDb();
    const outDb = freshOutboundDb();
    insertTask(db, {
      id: 'task-1',
      processAfter: '2020-01-01T00:00:00.000Z',
      recurrence: '0 9 * * *',
      platformId: null,
      channelType: null,
      threadId: null,
      content: JSON.stringify({ prompt: 'daily digest' }),
    });
    db.prepare("UPDATE messages_in SET status = 'completed' WHERE id = 'task-1'").run();
    const insertAttempt = outDb.prepare(
      `INSERT INTO task_attempts
        (task_message_id, series_id, trigger_source, status, started_at)
       VALUES (?, 'task-1', 'scheduled', 'failed', ?)`,
    );
    insertAttempt.run('attempt-1', '2026-08-16T10:00:00Z');
    insertAttempt.run('attempt-2', '2026-08-16T11:00:00Z');
    insertAttempt.run('attempt-3', '2026-08-16T12:00:00Z');

    await handleRecurrence(db, fakeSession(), outDb);

    const follow = db.prepare("SELECT status, content FROM messages_in WHERE id != 'task-1'").get() as {
      status: string;
      content: string;
    };
    const completed = db.prepare("SELECT content FROM messages_in WHERE id = 'task-1'").get() as { content: string };
    expect(follow.status).toBe('paused');
    expect(JSON.parse(follow.content)).toMatchObject({ consecutiveFailures: 3, autoPaused: true });
    expect(JSON.parse(completed.content)).toMatchObject({ consecutiveFailures: 3, autoPaused: true });
    outDb.close();
    db.close();
  });

  it('clears a carried failure count after a successful attempt', async () => {
    const db = freshDb();
    const outDb = freshOutboundDb();
    insertTask(db, {
      id: 'task-1',
      processAfter: '2020-01-01T00:00:00.000Z',
      recurrence: '0 9 * * *',
      platformId: null,
      channelType: null,
      threadId: null,
      content: JSON.stringify({ prompt: 'daily digest', consecutiveFailures: 2 }),
    });
    db.prepare("UPDATE messages_in SET status = 'completed' WHERE id = 'task-1'").run();
    outDb
      .prepare(
        `INSERT INTO task_attempts
        (task_message_id, series_id, trigger_source, status, started_at)
       VALUES ('attempt-ok', 'task-1', 'scheduled', 'completed', '2026-08-16T12:00:00Z')`,
      )
      .run();

    await handleRecurrence(db, fakeSession(), outDb);

    const follow = db.prepare("SELECT content FROM messages_in WHERE id != 'task-1'").get() as { content: string };
    expect(JSON.parse(follow.content)).toMatchObject({ consecutiveFailures: 0, autoPaused: false });
    outDb.close();
    db.close();
  });
});
