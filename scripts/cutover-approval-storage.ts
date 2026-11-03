import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import Database from 'better-sqlite3';
import { migration049 } from '../src/db/migrations/049-approvals.js';
import { runMigrations } from '../src/db/migrations/index.js';

async function cutoverApprovalStorage(dbPath: string, backupPath: string): Promise<void> {
  if (fs.existsSync(backupPath)) throw new Error('Backup path already exists; choose a new file.');
  const db = new Database(dbPath, { fileMustExist: true, timeout: 0 });
  try {
    if (db.pragma('integrity_check', { simple: true }) !== 'ok') throw new Error('Database integrity check failed.');
    if (!db.prepare("SELECT 1 FROM schema_version WHERE name='agent-vault-only'").get())
      throw new Error('Complete the Agent Vault-only cutover before resetting approval storage.');
    if (
      !db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='pending_approvals'").get() ||
      db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='approvals'").get()
    )
      throw new Error('Expected legacy approval storage, not a fresh or already converted database.');
    const hasWorkflows = db
      .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='approval_workflows'")
      .get();
    if (hasWorkflows && db.prepare("SELECT 1 FROM approval_workflows WHERE stage='applying'").get())
      throw new Error('Review uncertain applying effects before cutover; explicitly finalize those workflows first.');
    fs.closeSync(fs.openSync(backupPath, 'wx', 0o600));
    await db.backup(backupPath);
    db.pragma('foreign_keys=ON');
    db.transaction(() => {
      db.exec(
        'DROP TABLE IF EXISTS approval_workflows; DROP TABLE IF EXISTS approval_history; DROP TABLE pending_approvals;',
      );
      runMigrations(db, [migration049]);
      if (db.prepare('PRAGMA foreign_key_check').all().length) throw new Error('Cutover left foreign-key violations.');
    }).exclusive();
    console.log(`Approval storage reset. Original database preserved at ${backupPath}`);
  } finally {
    db.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [dbPath, backupPath, ...flags] = process.argv.slice(2);
  if (
    !dbPath ||
    !backupPath ||
    flags.length !== 2 ||
    !flags.includes('--host-and-containers-stopped') ||
    !flags.includes('--discard-legacy-approvals')
  )
    throw new Error(
      'Usage: pnpm exec tsx scripts/cutover-approval-storage.ts <db> <new-backup-file> --host-and-containers-stopped --discard-legacy-approvals',
    );
  await cutoverApprovalStorage(dbPath, backupPath);
}
