import { afterEach, expect, it } from 'vitest';
import { closeDb, initTestDb } from '../connection.js';
import { migrations, runMigrations } from './index.js';
import { migration049 } from './049-approvals.js';

afterEach(closeDb);

it('creates one public lifecycle and private progress without mirrored status or request fields', () => {
  const db = initTestDb();
  runMigrations(db);
  expect(
    db.prepare("SELECT name FROM sqlite_master WHERE name IN ('pending_approvals','approval_history')").all(),
  ).toEqual([]);
  expect((db.pragma('table_info(approval_workflows)') as { name: string }[]).map((row) => row.name)).toEqual([
    'approval_id',
    'data_json',
    'submission_ids_json',
    'restart',
    'notified',
  ]);
  db.exec(`INSERT INTO approvals(approval_id,request_id,action,payload,created_at)
    VALUES('confirmation','confirmation','install_packages','{}','created')`);
  expect(() => db.exec("UPDATE approvals SET status='completed'")).toThrow('CHECK');
  db.exec("UPDATE approvals SET kind='access_grant'");
  expect(() => db.exec("UPDATE approvals SET status='approved'")).toThrow('CHECK');
});

it.each(['pending_approvals', 'approval_history', 'approval_workflows'])(
  'refuses unsupported %s storage without creating another lifecycle',
  (table) => {
    const db = initTestDb();
    runMigrations(
      db,
      migrations.filter((migration) => migration !== migration049),
    );
    db.exec(`CREATE TABLE ${table}(approval_id TEXT)`);
    expect(() => runMigrations(db)).toThrow('Legacy approval storage');
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name='approvals'").get()).toBeUndefined();
    expect(db.prepare('SELECT name FROM schema_version WHERE name=?').get(migration049.name)).toBeUndefined();
  },
);
