import { parseTimestamp } from '../time.js';
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
import { describe, it, expect, afterEach, vi } from 'vitest';

import { countDueMessages, getNextInboundWorkAt, syncProcessingAcks } from './session-db.js';
import { transaction } from './transaction.js';
import { onHostChange } from '../host-changes.js';

const TEST_DIR = path.resolve('.test-session-db');
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
      timestamp      INTEGER NOT NULL,
      status         TEXT DEFAULT 'pending',
      process_after  INTEGER,
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
     VALUES (?, ?, ?, ?, ?, ?, ?, '{}')`,
  ).run(
    opts.id,
    opts.seq,
    opts.kind,
    Date.now(),
    opts.status ?? 'pending',
    opts.trigger ?? 1,
    parseTimestamp(opts.processAfter),
  );
}

afterEach(() => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
});

describe('countDueMessages', () => {
  it('caches only wake-eligible input and unfinished recurrence work', () => {
    const db = freshMessagesInDb();
    try {
      addRow(db, { id: 'context', seq: 2, kind: 'chat', trigger: 0 });
      addRow(db, { id: 'system', seq: 4, kind: 'system' });
      expect(getNextInboundWorkAt(db)).toBeNull();
      addRow(db, { id: 'future', seq: 6, kind: 'task', processAfter: '2999-01-01T00:00:00Z' });
      expect(getNextInboundWorkAt(db)).toBe(Date.parse('2999-01-01T00:00:00Z'));
      db.exec("UPDATE messages_in SET status='completed',recurrence='invalid-cron' WHERE id='future'");
      expect(getNextInboundWorkAt(db)).toBe(0);
    } finally {
      db.close();
    }
  });

  it('counts a pending trigger=1 chat message', () => {
    const db = freshMessagesInDb();
    addRow(db, { id: 'm1', seq: 2, kind: 'chat' });
    expect(countDueMessages(db)).toBe(1);
    db.close();
  });

  describe('syncProcessingAcks', () => {
    it('publishes actual transitions once and leaves completion history quiet', async () => {
      const input = freshMessagesInDb();
      const output = new Database(':memory:');
      const listener = vi.fn();
      const off = onHostChange(listener);
      try {
        addRow(input, { id: 'done', seq: 2, kind: 'chat', status: 'completed' });
        addRow(input, { id: 'new', seq: 4, kind: 'chat' });
        output.exec(`CREATE TABLE processing_ack(message_id TEXT, status TEXT);
          INSERT INTO processing_ack VALUES ('done','completed'), ('new','failed'), ('missing','completed');`);

        expect(syncProcessingAcks(input, output)).toEqual(['new']);
        expect(listener).not.toHaveBeenCalled();
        await Promise.resolve();
        expect(listener).toHaveBeenCalledTimes(1);
        listener.mockClear();

        expect(syncProcessingAcks(input, output)).toEqual([]);
        await Promise.resolve();
        expect(listener).not.toHaveBeenCalled();
      } finally {
        off();
        input.close();
        output.close();
      }
    });

    it('does not publish an acknowledgement transition rolled back by its caller', async () => {
      const input = freshMessagesInDb();
      const output = new Database(':memory:');
      const listener = vi.fn();
      const off = onHostChange(listener);
      try {
        addRow(input, { id: 'new', seq: 2, kind: 'chat' });
        output.exec(`CREATE TABLE processing_ack(message_id TEXT, status TEXT);
          INSERT INTO processing_ack VALUES ('new','completed');`);
        expect(() =>
          transaction(input, () => {
            syncProcessingAcks(input, output);
            throw new Error('rollback');
          })(),
        ).toThrow('rollback');
        await Promise.resolve();
        expect(listener).not.toHaveBeenCalled();
        expect(input.prepare("SELECT status FROM messages_in WHERE id='new'").pluck().get()).toBe('pending');
      } finally {
        off();
        input.close();
        output.close();
      }
    });
  });

  it('counts an interactive response as wake-eligible', () => {
    const db = freshMessagesInDb();
    addRow(db, { id: 'answer-1', seq: 2, kind: 'chat' });
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
