import type { Database } from 'bun:sqlite';

export const STORAGE_VERSION = 2;
export const EPOCH_NOW_SQL =
  "(CAST(strftime('%s','now') AS INTEGER)*1000 + CAST(substr(strftime('%f','now'),4,3) AS INTEGER))";

export function assertStorageVersion(db: Database, store: string, expectedVersion = STORAGE_VERSION): void {
  const version = (db.query('PRAGMA user_version').get() as { user_version: number }).user_version;
  if (version === expectedVersion) return;
  const existing = db
    .query("SELECT 1 FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' LIMIT 1")
    .get();
  if (version === 0 && !existing) return;
  throw new Error(
    `Unsupported ${store} storage version ${version}; stop host AND runners and follow docs/reply-suggestions-cutover.md`,
  );
}
