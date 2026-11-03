import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { execFileSync } from 'node:child_process';
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

it('refuses legacy storage; the explicit offline reset backs it up and leaves unrelated records intact', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'approval-cutover-'));
  const dbPath = path.join(directory, 'central.db');
  const backupPath = path.join(directory, 'before.db');
  const cutover = () =>
    execFileSync(
      process.execPath,
      [
        '--import',
        'tsx',
        'scripts/cutover-approval-storage.ts',
        dbPath,
        backupPath,
        '--host-and-containers-stopped',
        '--discard-legacy-approvals',
      ],
      { stdio: 'pipe' },
    );
  const db = new Database(dbPath);
  try {
    runMigrations(
      db,
      migrations.filter((m) => m !== migration049),
    );
    db.exec(`CREATE TABLE pending_approvals(approval_id TEXT PRIMARY KEY);
      CREATE TABLE approval_workflows(approval_id TEXT,stage TEXT);
      CREATE TABLE approval_history(approval_id TEXT);
      INSERT INTO pending_approvals VALUES('old');
      INSERT INTO approval_workflows VALUES('old','applying');
      INSERT INTO agent_groups(id,name,folder,created_at) VALUES('keep','Keep','keep','created');`);
    expect(() => runMigrations(db)).toThrow('offline cutover');
    expect(cutover).toThrow('uncertain applying effects');
    expect(fs.existsSync(backupPath)).toBe(false);
    db.exec("UPDATE approval_workflows SET stage='failed'");
    cutover();
    expect(db.prepare('SELECT id FROM agent_groups').pluck().all()).toEqual(['keep']);
    expect(db.prepare('SELECT * FROM approvals').all()).toEqual([]);
    expect(db.pragma('foreign_key_check')).toEqual([]);
    const backup = new Database(backupPath, { readonly: true });
    try {
      expect(backup.prepare('SELECT approval_id FROM pending_approvals').pluck().all()).toEqual(['old']);
      expect(backup.pragma('integrity_check', { simple: true })).toBe('ok');
    } finally {
      backup.close();
    }
    expect(cutover).toThrow('already exists');
  } finally {
    db.close();
    fs.rmSync(directory, { recursive: true });
  }
});
