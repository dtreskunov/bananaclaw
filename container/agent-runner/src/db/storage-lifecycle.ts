import type { Database } from 'bun:sqlite';

export const STORAGE_VERSION = 1;
export const EPOCH_NOW_SQL =
  "(CAST(strftime('%s','now') AS INTEGER)*1000 + CAST(substr(strftime('%f','now'),4,3) AS INTEGER))";
const instants = new Set([
  'timestamp',
  'ts',
  'created_at',
  'updated_at',
  'delivered_at',
  'process_after',
  'deliver_after',
  'status_changed',
  'started_at',
  'ended_at',
  'completed_at',
  'tool_started_at',
  'applied_at',
]);

export function assertStorageVersion(db: Database, store: string): void {
  const version = (db.query('PRAGMA user_version').get() as { user_version: number }).user_version;
  if (version === STORAGE_VERSION) return;
  const existing = db
    .query("SELECT 1 FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' LIMIT 1")
    .get();
  if (version === 0 && !existing) return;
  throw new Error(
    `Unsupported ${store} storage version ${version}; stop host AND runners and follow docs/db-storage-cutover.md`,
  );
}

export function epochSchema(sql: string): string {
  return sql
    .replace(/\b([a-z_]+)\s+(?:TEXT|INTEGER)\b/g, (definition, column: string) =>
      instants.has(column)
        ? `${column} INTEGER${sql.includes(`typeof(${column})`) ? '' : ` CHECK (${column} IS NULL OR typeof(${column})='integer')`}`
        : definition,
    )
    .replaceAll("datetime('now')", EPOCH_NOW_SQL)
    .replace(/('[a-z_]+',\s*)NEW\.([a-z_]+)/g, (pair, key: string, column: string) =>
      column === 'ts'
        ? `${key}CAST(NEW.ts AS TEXT)`
        : instants.has(column)
          ? `${key}strftime('%Y-%m-%dT%H:%M:%fZ', NEW.${column}/1000.0, 'unixepoch')`
          : pair,
    );
}
