/**
 * Tests for core per-session messages_in schema maintenance.
 *
 * Task-specific DB tests (insertTask, cancel/pause/resume, updateTask,
 * insertRecurrence) live in `src/modules/scheduling/db.test.ts` with the
 * rest of the scheduling module.
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { describe, it, expect, afterEach } from 'vitest';

import { countDueMessages } from './session-db.js';

const TEST_DIR = '/tmp/nanoclaw-session-db-test';
const DB_PATH = path.join(TEST_DIR, 'inbound.db');

function freshMessagesInDb(): Database.Database {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  const db = new Database(DB_PATH);
  db.exec(`
    CREATE TABLE messages_in (
      id             TEXT PRIMARY KEY,
      seq            INTEGER UNIQUE,
      kind           TEXT NOT NULL,
      timestamp      TEXT NOT NULL,
      status         TEXT DEFAULT 'pending',
      process_after  TEXT,
      recurrence     TEXT,
      tries          INTEGER DEFAULT 0,
      trigger        INTEGER NOT NULL DEFAULT 1,
      platform_id    TEXT,
      channel_type   TEXT,
      thread_id      TEXT,
      content        TEXT NOT NULL
    );
  `);
  return db;
}

function addRow(
  db: Database.Database,
  opts: { id: string; seq: number; kind: string; status?: string; trigger?: number; processAfter?: string | null },
): void {
  db.prepare(
    `INSERT INTO messages_in (id, seq, kind, timestamp, status, trigger, process_after, content)
     VALUES (?, ?, ?, datetime('now'), ?, ?, ?, '{}')`,
  ).run(opts.id, opts.seq, opts.kind, opts.status ?? 'pending', opts.trigger ?? 1, opts.processAfter ?? null);
}

afterEach(() => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
});

describe('countDueMessages', () => {
  it('counts a pending trigger=1 chat message', () => {
    const db = freshMessagesInDb();
    addRow(db, { id: 'm1', seq: 2, kind: 'chat' });
    expect(countDueMessages(db)).toBe(1);
    db.close();
  });

  it('counts an interactive response as wake-eligible', () => {
    const db = freshMessagesInDb();
    addRow(db, { id: 'answer-1', seq: 2, kind: 'interactive_response' });
    expect(countDueMessages(db)).toBe(1);
    db.close();
  });

  it('excludes kind=system rows so orphaned system messages never pin a slot', () => {
    const db = freshMessagesInDb();
    // A stale question_response / delivery_failed the container never acked.
    addRow(db, { id: 'sys1', seq: 2, kind: 'system' });
    addRow(db, { id: 'sys2', seq: 4, kind: 'system' });
    expect(countDueMessages(db)).toBe(0);
    // A real chat message alongside orphaned system rows still counts (once).
    addRow(db, { id: 'chat1', seq: 6, kind: 'chat' });
    expect(countDueMessages(db)).toBe(1);
    db.close();
  });

  it('excludes trigger=0 (context-only) and non-pending and future rows', () => {
    const db = freshMessagesInDb();
    addRow(db, { id: 'ctx', seq: 2, kind: 'chat', trigger: 0 });
    addRow(db, { id: 'done', seq: 4, kind: 'chat', status: 'completed' });
    addRow(db, { id: 'future', seq: 6, kind: 'chat', processAfter: '2999-01-01T00:00:00Z' });
    expect(countDueMessages(db)).toBe(0);
    db.close();
  });
});
