import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrateQuestionSkips } from './migrate-question-skips.js';

let root: string;
let dbPath: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-question-skips-'));
  dbPath = path.join(root, 'v2.db');
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE sessions (id TEXT PRIMARY KEY);
    INSERT INTO sessions VALUES ('s');
    CREATE TABLE questions (
      question_id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id),
      message_out_id TEXT NOT NULL, in_reply_to TEXT, platform_id TEXT, channel_type TEXT, thread_id TEXT,
      title TEXT NOT NULL, question_text TEXT NOT NULL, response_mode TEXT NOT NULL,
      options_json TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
      answer_value TEXT, answer_type TEXT CHECK(answer_type IS NULL OR answer_type IN ('choice', 'text')),
      answered_by TEXT, answered_at TEXT, cancelled_at TEXT, created_at TEXT NOT NULL
    );
    CREATE INDEX idx_questions_session_status ON questions(session_id, status);
    CREATE TABLE changes (id TEXT);
    CREATE TRIGGER record_question_update AFTER UPDATE ON questions BEGIN
      INSERT INTO changes VALUES (NEW.question_id);
    END;
  `);
  for (const [rowid, status] of [
    [1, 'pending'],
    [3, 'answered'],
    [5, 'cancelled'],
  ] as const) {
    db.prepare(
      `INSERT INTO questions
      (rowid, question_id, session_id, message_out_id, title, question_text, response_mode, options_json,
       status, answer_type, answer_value, answered_by, answered_at, cancelled_at, created_at)
      VALUES (?, ?, 's', 'out', 'Title', 'Question?', 'text', '[]', ?, ?, ?, ?, ?, ?, 'created')`,
    ).run(
      rowid,
      status,
      status,
      status === 'answered' ? 'text' : null,
      status === 'answered' ? 'Yes' : null,
      status === 'answered' ? 'actor' : null,
      status === 'answered' ? 'answered' : null,
      status === 'cancelled' ? 'cancelled' : null,
    );
  }
  db.close();
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe('offline question skip migration', () => {
  it('backs up and preserves records, rowids, indexes, triggers and foreign keys', async () => {
    const original = new Database(dbPath);
    const before = original.prepare('SELECT rowid, * FROM questions ORDER BY rowid').all();
    original.close();
    const result = await migrateQuestionSkips(dbPath);
    expect(result.changed).toBe(true);
    expect(result.backup).not.toBeNull();
    const backup = new Database(result.backup!, { readonly: true });
    expect(backup.prepare('SELECT rowid, * FROM questions ORDER BY rowid').all()).toEqual(before);
    expect(fs.statSync(result.backup!).mode & 0o777).toBe(0o600);
    backup.close();
    const db = new Database(dbPath);
    try {
      db.pragma('foreign_keys = ON');
      expect(db.prepare('SELECT rowid, * FROM questions ORDER BY rowid').all()).toEqual(before);
      expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'questions_new'").get()).toBeUndefined();
      expect(db.pragma('foreign_key_check')).toEqual([]);
      expect(db.pragma('index_list(questions)')).toEqual(
        expect.arrayContaining([expect.objectContaining({ name: 'idx_questions_session_status' })]),
      );
      db.exec(
        "UPDATE questions SET status = 'answered', answer_type = 'skipped', answered_by = 'actor', answered_at = 'now' WHERE question_id = 'pending'",
      );
      expect(db.prepare('SELECT * FROM changes').all()).toEqual([{ id: 'pending' }]);
      expect(() => db.exec("UPDATE questions SET answer_value = 'fake' WHERE question_id = 'pending'")).toThrow(
        'CHECK',
      );
      expect(() => db.exec("DELETE FROM sessions WHERE id = 's'")).toThrow('FOREIGN KEY');
    } finally {
      db.close();
    }
    expect(await migrateQuestionSkips(dbPath)).toEqual({ changed: false, backup: null });
  });

  it('refuses an unexpected schema without changing data or creating a backup', async () => {
    const db = new Database(dbPath);
    db.exec('DROP TABLE questions; CREATE TABLE questions (question_id TEXT PRIMARY KEY)');
    db.close();
    await expect(migrateQuestionSkips(dbPath)).rejects.toThrow('Unexpected questions schema');
    expect(fs.readdirSync(root)).toEqual(['v2.db']);
  });
});
