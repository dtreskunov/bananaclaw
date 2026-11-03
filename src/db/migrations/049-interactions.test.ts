import { afterEach, expect, it } from 'vitest';
import { closeDb, initTestDb } from '../connection.js';
import { createApproval, getApproval } from '../approvals.js';
import { migrations, runMigrations } from './index.js';
import { migration049 } from './049-interactions.js';

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
    created_at: 'created',
    input: { action: 'install_packages', payload: {}, title: '', options: [] },
  });
  expect(() => db.exec("UPDATE interactions SET status='completed'")).toThrow('CHECK');
  db.exec("UPDATE interactions SET kind='access_grant'");
  expect(() => db.exec("UPDATE interactions SET status='approved'")).toThrow('CHECK');
  expect(getApproval('c')?.input.action).toBe('install_packages');
});

it.each(['questions', 'pending_questions', 'approvals', 'pending_approvals', 'approval_history', 'approval_workflows'])(
  'refuses existing %s storage without runtime conversion or record loss',
  (table) => {
    const db = initTestDb();
    runMigrations(
      db,
      migrations.filter((migration) => migration !== migration049),
    );
    db.exec(`CREATE TABLE ${table}(id TEXT); INSERT INTO ${table} VALUES('preserved')`);
    expect(() => runMigrations(db)).toThrow('explicit offline cutover');
    expect(db.prepare(`SELECT id FROM ${table}`).all()).toEqual([{ id: 'preserved' }]);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name='interactions'").get()).toBeUndefined();
    expect(db.prepare('SELECT name FROM schema_version WHERE name=?').get(migration049.name)).toBeUndefined();
  },
);
