import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migration001 } from '../src/db/migrations/001-initial.js';
import { migrateQuestionTitles } from './migrate-question-titles.js';

let dir: string;
let dbPath: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'question-title-migration-'));
  dbPath = path.join(dir, 'central.db');
  const db = new Database(dbPath);
  try {
    migration001.up(db);
    db.exec(`
      ALTER TABLE questions ADD COLUMN title TEXT NOT NULL DEFAULT 'Title';
      CREATE TABLE schema_version (version INTEGER PRIMARY KEY, name TEXT NOT NULL);
      INSERT INTO schema_version VALUES (1, 'initial');
      INSERT INTO agent_groups (id, name, folder, created_at) VALUES ('g', 'Group', 'group', 'now');
      INSERT INTO sessions (id, agent_group_id, created_at) VALUES ('s', 'g', 'now');
      INSERT INTO questions
        (rowid, question_id, session_id, message_out_id, question_text, response_mode, options_json,
         status, answer_value, answer_type, answered_by, answered_at, cancelled_at, created_at)
        VALUES (3, 'pending', 's', 'out1', 'Choose?', 'text', '[]', 'pending', NULL, NULL, NULL, NULL, NULL, 'now'),
               (11, 'answer', 's', 'out2', 'Choose?', 'text', '[]', 'answered', 'yes', 'text', 'u', 'later', NULL, 'now'),
               (27, 'skip', 's', 'out3', 'Choose?', 'text', '[]', 'answered', NULL, 'skipped', 'u', 'later', NULL, 'now'),
               (42, 'choice', 's', 'out4', 'Choose?', 'choice', '[{"label":"Yes","selectedLabel":"Yes","value":"yes"}]',
                'answered', 'yes', 'choice', 'u', 'later', NULL, 'now'),
               (81, 'cancelled', 's', 'out5', 'Choose?', 'text', '[]', 'cancelled', NULL, NULL, NULL, NULL, 'later', 'now');
      CREATE TRIGGER question_status_change AFTER UPDATE OF status ON questions BEGIN SELECT 1; END;
    `);
  } finally {
    db.close();
  }
});

afterEach(() => {
  for (const file of fs.readdirSync(dir)) fs.unlinkSync(path.join(dir, file));
  fs.rmdirSync(dir);
});

function read<T>(query: (db: Database.Database) => T): T {
  const db = new Database(dbPath, { readonly: true });
  try {
    return query(db);
  } finally {
    db.close();
  }
}

describe('offline question title migration', () => {
  it('defaults to read-only inspection without creating a backup', async () => {
    expect(await migrateQuestionTitles(dbPath)).toEqual({
      hasTitle: true,
      count: 5,
      changed: false,
      backup: null,
    });
    expect(fs.readdirSync(dir)).toEqual(['central.db']);
    expect(read((db) => db.prepare('SELECT title FROM questions').all())).toHaveLength(5);
  });

  it('preserves all other data, rowids, constraints, indexes, triggers and migration records', async () => {
    const before = read((db) => db.prepare('SELECT rowid, * FROM questions ORDER BY question_id').all());
    const objects = read((db) =>
      db
        .prepare(
          "SELECT type, name, sql FROM sqlite_schema WHERE tbl_name = 'questions' AND type != 'table' ORDER BY type, name",
        )
        .all(),
    );
    const versions = read((db) => db.prepare('SELECT * FROM schema_version ORDER BY version').all());
    const result = await migrateQuestionTitles(dbPath, { apply: true, hostStopped: true });
    expect(result).toMatchObject({ hasTitle: false, count: 5, changed: true });
    assert.ok(result.backup);
    expect(fs.statSync(result.backup).mode & 0o777).toBe(0o600);
    const backup = new Database(result.backup, { readonly: true });
    try {
      expect(backup.prepare('SELECT rowid, * FROM questions ORDER BY question_id').all()).toEqual(before);
    } finally {
      backup.close();
    }
    const expected = (before as Record<string, unknown>[]).map(({ title: _title, ...row }) => row);
    expect(read((db) => db.prepare('SELECT rowid, * FROM questions ORDER BY question_id').all())).toEqual(expected);
    expect(
      read((db) =>
        db
          .prepare(
            "SELECT type, name, sql FROM sqlite_schema WHERE tbl_name = 'questions' AND type != 'table' ORDER BY type, name",
          )
          .all(),
      ),
    ).toEqual(objects);
    expect(read((db) => db.prepare('SELECT * FROM schema_version ORDER BY version').all())).toEqual(versions);
    const db = new Database(dbPath);
    try {
      expect(() => db.exec("UPDATE questions SET answer_value = 'fake' WHERE question_id = 'skip'")).toThrow('CHECK');
      expect(db.pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }]);
      expect(db.pragma('foreign_key_check')).toEqual([]);
    } finally {
      db.close();
    }
  });

  it('does not create another backup when applied again', async () => {
    await migrateQuestionTitles(dbPath, { apply: true, hostStopped: true });
    const files = fs.readdirSync(dir);
    expect(await migrateQuestionTitles(dbPath, { apply: true, hostStopped: true })).toEqual({
      hasTitle: false,
      count: 5,
      changed: false,
      backup: null,
    });
    expect(fs.readdirSync(dir)).toEqual(files);
  });

  it('refuses to apply without stopped-host acknowledgement', async () => {
    await expect(migrateQuestionTitles(dbPath, { apply: true })).rejects.toThrow('Stop the host');
    expect(fs.readdirSync(dir)).toEqual(['central.db']);
    expect(read((db) => db.prepare('SELECT title FROM questions').all())).toHaveLength(5);
  });

  it('rolls back if a title-dependent index prevents removal', async () => {
    const db = new Database(dbPath);
    db.exec('CREATE INDEX title_index ON questions(title)');
    db.close();
    await expect(migrateQuestionTitles(dbPath, { apply: true, hostStopped: true })).rejects.toThrow('title');
    expect(read((db) => db.prepare('SELECT title FROM questions').all())).toHaveLength(5);
    expect(read((db) => db.pragma('integrity_check'))).toEqual([{ integrity_check: 'ok' }]);
  });

  it('rejects an unexpected schema before writing or backing up', async () => {
    const db = new Database(dbPath);
    db.exec('ALTER TABLE questions ADD COLUMN unexpected TEXT');
    db.close();
    await expect(migrateQuestionTitles(dbPath, { apply: true, hostStopped: true })).rejects.toThrow(
      'Unexpected questions schema',
    );
    expect(fs.readdirSync(dir)).toEqual(['central.db']);
  });
});
