import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, getDb, hasTable, initTestDb } from '../connection.js';
import { answerQuestion, getQuestion } from '../sessions.js';
import { migrations, runMigrations } from './index.js';

beforeEach(() => {
  runMigrations(initTestDb());
  getDb().exec(`
    INSERT INTO agent_groups (id, name, folder, created_at) VALUES ('g', 'Group', 'group', 'created');
    INSERT INTO sessions (id, agent_group_id, created_at) VALUES ('s', 'g', 'created');
    INSERT INTO questions
      (question_id, session_id, message_out_id, question_text, response_mode, options_json, created_at)
      VALUES ('q', 's', 'out', 'Choose?', 'choice', '[]', 'created');
  `);
});
afterEach(() => closeDb());

describe('current question schema bootstrap', () => {
  it('creates durable questions with skip support directly, without a legacy conversion', () => {
    const db = getDb();
    expect(hasTable(db, 'questions')).toBe(true);
    expect(hasTable(db, 'pending_questions')).toBe(false);
    expect(db.pragma('table_info(questions)')).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'title' })]),
    );
    expect(migrations.some((migration) => migration.name === 'durable-questions')).toBe(false);
    expect(answerQuestion('q', { type: 'skipped', value: null, userId: 'actor', answeredAt: 'skipped' })).toBe(true);
    expect(getQuestion('q')).toMatchObject({
      status: 'answered',
      answer_type: 'skipped',
      answer_value: null,
      answered_by: 'actor',
      answered_at: 'skipped',
    });
    expect(() => db.exec("UPDATE questions SET answer_value = 'fake' WHERE question_id = 'q'")).toThrow('CHECK');
    expect(db.pragma('foreign_key_check')).toEqual([]);
    expect(db.pragma('index_list(questions)')).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'idx_questions_session_status' })]),
    );
  });

  it('leaves upgraded data and historical applied-migration records unchanged on startup', () => {
    const db = getDb();
    answerQuestion('q', {
      type: 'skipped',
      value: null,
      userId: 'actor',
      answeredAt: 'skipped',
    });
    db.exec(`
      INSERT INTO schema_version (version, name, applied)
        SELECT MAX(version) + 1, 'durable-questions', 'historical' FROM schema_version;
      CREATE TABLE pending_questions (question_id TEXT PRIMARY KEY);
      INSERT INTO pending_questions VALUES ('legacy-record');
    `);
    const questions = db.prepare('SELECT * FROM questions').all();
    const versions = db.prepare('SELECT * FROM schema_version ORDER BY version').all();
    runMigrations(db);
    expect(db.prepare('SELECT * FROM questions').all()).toEqual(questions);
    expect(db.prepare('SELECT * FROM schema_version ORDER BY version').all()).toEqual(versions);
    expect(db.prepare('SELECT * FROM pending_questions').all()).toEqual([{ question_id: 'legacy-record' }]);
  });
});
