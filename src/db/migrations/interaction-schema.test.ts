import { afterEach, expect, it } from 'vitest';
import { closeDb, initTestDb } from '../connection.js';
import { createApproval, getApproval } from '../approvals.js';
import { runMigrations } from './index.js';

afterEach(closeDb);

it('creates one public lifecycle and private progress without mirrored status or input fields', () => {
  const db = initTestDb();
  runMigrations(db);
  expect(
    db
      .prepare(
        "SELECT name FROM sqlite_master WHERE name IN ('questions','approvals','pending_approvals','approval_history')",
      )
      .all(),
  ).toEqual([]);
  expect((db.pragma('table_info(interaction_progress)') as { name: string }[]).map((row) => row.name)).toEqual([
    'id',
    'data_json',
    'submission_ids_json',
    'restart',
    'notified',
  ]);
  createApproval({
    id: 'c',
    request_id: 'c',
    created_at: 1767225600000,
    input: { action: 'install_packages', payload: {}, title: '', options: [] },
  });
  expect(() => db.exec("UPDATE interactions SET status='completed'")).toThrow('CHECK');
  db.exec("UPDATE interactions SET kind='access_grant'");
  expect(() => db.exec("UPDATE interactions SET status='approved'")).toThrow('CHECK');
  expect(getApproval('c')?.input.action).toBe('install_packages');
});
