import { afterEach, expect, it } from 'vitest';
import { closeDb, initTestDb } from '../connection.js';
import { runMigrations } from './index.js';
import { createApproval } from '../approvals.js';

afterEach(closeDb);

it('bootstraps only approval interactions and refuses old question kinds', () => {
  const db = initTestDb();
  runMigrations(db);
  expect(
    createApproval({
      id: 'approval',
      request_id: 'request',
      created_at: 1767225600000,
      input: { action: 'install_packages', payload: {}, title: 'Confirm', options: [] },
    }),
  ).toBe(true);
  expect(() =>
    db
      .prepare(
        `INSERT INTO interactions
    (id,kind,request_id,input_json,response_json,created_at,updated_at)
    VALUES ('old','question','request','{}','{}',?,?)`,
      )
      .run(1767225600000, 1767225600000),
  ).toThrow('CHECK');
  expect(db.pragma('table_info(interactions)')).not.toEqual(
    expect.arrayContaining([
      expect.objectContaining({ name: 'message_out_id' }),
      expect.objectContaining({ name: 'in_reply_to' }),
    ]),
  );
  const rows = db.prepare('SELECT * FROM interactions').all();
  runMigrations(db);
  expect(db.prepare('SELECT * FROM interactions').all()).toEqual(rows);
  expect(db.pragma('foreign_key_check')).toEqual([]);
});
