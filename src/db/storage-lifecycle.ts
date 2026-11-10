import type Database from 'better-sqlite3';

export const STORAGE_VERSION = 3;
export const EPOCH_NOW_SQL =
  "(CAST(strftime('%s','now') AS INTEGER)*1000 + CAST(substr(strftime('%f','now'),4,3) AS INTEGER))";

export function assertStorageVersion(db: Database.Database, store: string, allowFresh = false): void {
  const version = db.pragma('user_version', { simple: true });
  if (version === STORAGE_VERSION) return;
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all();
  if (version === 0 && allowFresh && tables.length === 0) return;
  throw new Error(
    `Unsupported ${store} storage version ${version}; stop host AND runners and follow docs/usage-efficiency.md#offline-cutover`,
  );
}
