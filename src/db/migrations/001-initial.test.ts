import { afterEach, expect, it } from 'vitest';
import { closeDb, initTestDb } from '../connection.js';
import { answerQuestion, createQuestion, getQuestion } from '../sessions.js';
import { runMigrations } from './index.js';
import { createApproval } from '../approvals.js';

afterEach(closeDb);

it('bootstraps canonical questions with typed responses, idempotence and retained pending queues', () => {
  const db = initTestDb();
  runMigrations(db);
  db.exec(`
    INSERT INTO agent_groups (id, name, folder, created_at) VALUES ('g', 'Group', 'group', 1767225600000);
    INSERT INTO sessions (id, agent_group_id, created_at) VALUES ('s', 'g', 1767225600000);
  `);
  const question = {
    id: 'q',
    session_id: 's',
    message_out_id: 'out',
    in_reply_to: null,
    platform_id: null,
    channel_type: null,
    thread_id: null,
    created_at: '2026-01-01T00:00:00.000Z',
    input: { question: 'Choose?', responseMode: 'choice' as const, options: [] },
  };
  expect(createQuestion(question)).toBe(true);
  expect(createQuestion(question)).toBe(false);
  expect(() =>
    createApproval({
      id: 'q',
      request_id: 'q',
      created_at: '2026-01-01T00:00:00.000Z',
      input: {
        action: 'install_packages',
        payload: {},
        title: 'Confirm',
        options: [],
      },
    }),
  ).toThrow('Global interaction ID collision');
  const queued = { ...question, id: 'other', message_out_id: 'out-other' };
  expect(createQuestion(queued)).toBe(true);
  expect(createQuestion(queued)).toBe(false);
  expect(getQuestion('other')).toMatchObject({ status: 'pending', input: question.input });
  expect(answerQuestion('q', { responseType: 'skipped', userId: 'actor', answeredAt: '2026-01-01T00:00:01.000Z' })).toBe(true);
  expect(getQuestion('q')).toMatchObject({
    status: 'answered',
    response: { responseType: 'skipped' },
    responded_by: 'actor',
    responded_at: '2026-01-01T00:00:01.000Z',
  });
  expect(createQuestion({ ...question, id: 'literal' })).toBe(true);
  const answer = {
    responseType: 'text' as const,
    value: 'yes',
    userId: 'actor',
    answeredAt: '2026-01-01T00:00:02.000Z',
    questionId: 'route-only',
    message: 'not response data',
  };
  expect(answerQuestion('literal', answer)).toBe(true);
  expect(getQuestion('literal')?.response).toEqual({ responseType: 'text', value: 'yes' });
  expect(getQuestion('other')?.status).toBe('pending');
  expect(() => db.exec(`UPDATE interactions SET response_json='{"responseType":"skipped","value":"fake"}'`)).toThrow(
    'CHECK',
  );
  const rows = db.prepare('SELECT * FROM interactions').all();
  const versions = db.prepare('SELECT * FROM schema_version ORDER BY version').all();
  runMigrations(db);
  expect(db.prepare('SELECT * FROM interactions').all()).toEqual(rows);
  expect(db.prepare('SELECT * FROM schema_version ORDER BY version').all()).toEqual(versions);
  expect(db.pragma('foreign_key_check')).toEqual([]);
});
