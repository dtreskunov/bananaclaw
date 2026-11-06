import type Database from 'better-sqlite3';
import { toEpoch, activityEpoch } from './time.js';

export const STORAGE_VERSION = 1;
export const EPOCH_NOW_SQL =
  "(CAST(strftime('%s','now') AS INTEGER)*1000 + CAST(substr(strftime('%f','now'),4,3) AS INTEGER))";
export const INSTANT_COLUMNS = new Set([
  'timestamp',
  'ts',
  'created_at',
  'updated_at',
  'expires_at',
  'last_active',
  'applied',
  'added_at',
  'resolved_at',
  'granted_at',
  'subscribed_at',
  'denied_at',
  'onboarded_at',
  'last_seen_at',
  'first_seen',
  'last_seen',
  'linked_at',
  'last_used_at',
  'last_used',
  'redeemed_at',
  'first_redeemed_at',
  'verified_at',
  'consumed_at',
  'responded_at',
  'delivered_at',
  'process_after',
  'deliver_after',
  'status_changed',
  'started_at',
  'ended_at',
  'completed_at',
  'tool_started_at',
  'parent_message_ts',
  'applied_at',
]);

/** Offline storage may already contain integers; the wire parser remains string-only. */
export function legacyEpoch(value: unknown): number | null {
  if (value === null) return null;
  if (typeof value === 'number' && Number.isSafeInteger(value)) {
    new Date(value).toISOString();
    return value;
  }
  if (typeof value !== 'string') throw new Error(`Invalid timestamp: ${String(value)}`);
  return toEpoch(value);
}

export function assertStorageVersion(db: Database.Database, store: string, allowFresh = false): void {
  const version = db.pragma('user_version', { simple: true });
  if (version === STORAGE_VERSION) return;
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all();
  if (version === 0 && allowFresh && tables.length === 0) return;
  throw new Error(
    `Unsupported ${store} storage version ${version}; stop host AND runners and follow docs/db-storage-cutover.md`,
  );
}

export function epochSchema(sql: string): string {
  return sql
    .replace(/\b([a-z_]+)\s+(?:TEXT|INTEGER)\b/g, (definition, column: string) =>
      INSTANT_COLUMNS.has(column)
        ? `${column} INTEGER${sql.includes(`typeof(${column})`) ? '' : ` CHECK (${column} IS NULL OR typeof(${column})='integer')`}`
        : definition,
    )
    .replaceAll("datetime('now')", EPOCH_NOW_SQL)
    .replace(/('[a-z_]+',\s*)NEW\.([a-z_]+)/g, (pair, key: string, column: string) =>
      column === 'ts'
        ? `${key}CAST(NEW.ts AS TEXT)`
        : INSTANT_COLUMNS.has(column)
          ? `${key}strftime('%Y-%m-%dT%H:%M:%fZ', NEW.${column}/1000.0, 'unixepoch')`
          : pair,
    );
}

const quote = (name: string): string => `"${name.replaceAll('"', '""')}"`;

function convertRowTimes(table: string, row: Record<string, unknown>, columns: string[]): void {
  for (const column of columns) {
    try {
      row[column] =
        column === 'ts' && typeof row[column] === 'string' && /^\d+$/.test(row[column] as string)
          ? activityEpoch(row[column] as string)
          : legacyEpoch(row[column]);
    } catch (error) {
      throw new Error(`${table}.${column}: ${String(error)}`, { cause: error });
    }
  }
}

function preflightJournal(table: string, payload: unknown): void {
  if (typeof payload !== 'string') throw new Error(`${table}: invalid journal payload`);
  const record: unknown = JSON.parse(payload);
  if (!record || typeof record !== 'object' || Array.isArray(record))
    throw new Error(`${table}: invalid journal payload`);
  for (const [column, value] of Object.entries(record))
    if (INSTANT_COLUMNS.has(column) && value !== null) {
      if (typeof value !== 'string') throw new Error(`${table}.${column}: journal instants must retain wire strings`);
      if (column === 'ts') activityEpoch(value);
      else toEpoch(value);
    }
}

/** Rebuild using the real sqlite_master DDL, retaining constraints, indexes and triggers. */
export function convertStoreTimes(db: Database.Database): void {
  if (db.inTransaction) throw new Error('Storage conversion must own its transaction');
  const tables = db
    .prepare("SELECT name,sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all() as Array<{ name: string; sql: string }>;
  const objects = db
    .prepare("SELECT sql FROM sqlite_master WHERE type IN ('index','trigger') AND sql IS NOT NULL")
    .all() as Array<{ sql: string }>;
  const sequences = db.prepare("SELECT 1 FROM sqlite_master WHERE name='sqlite_sequence'").get()
    ? (db.prepare('SELECT name, seq FROM sqlite_sequence').all() as Array<{ name: string; seq: number }>)
    : [];
  const plans = tables
    .map((table) => {
      const columns = db.prepare(`PRAGMA table_info(${quote(table.name)})`).all() as Array<{
        name: string;
        type: string;
        pk: number;
      }>;
      const instants = columns.filter((c) => INSTANT_COLUMNS.has(c.name)).map((c) => c.name);
      for (const column of columns) {
        if (INSTANT_COLUMNS.has(column.name) && !['TEXT', 'INTEGER'].includes(column.type.toUpperCase()))
          throw new Error(`Unsupported timestamp declaration: ${table.name}.${column.name} ${column.type}`);
      }
      let count = 0;
      for (const row of db.prepare(`SELECT * FROM ${quote(table.name)}`).iterate() as Iterable<
        Record<string, unknown>
      >) {
        convertRowTimes(table.name, row, instants);
        if (table.name === 'pending_host_events' || table.name === 'pending_runner_events')
          preflightJournal(table.name, row.payload);
        count++;
      }
      return { ...table, columns, instants, count };
    })
    .filter((plan) => plan.instants.length > 0);
  if ((db.pragma('foreign_key_check') as unknown[]).length) throw new Error('Preflight: foreign-key violations');
  if (db.pragma('quick_check', { simple: true }) !== 'ok')
    throw new Error('Preflight: database integrity check failed');
  const foreignKeys = db.pragma('foreign_keys', { simple: true });
  db.pragma('foreign_keys=OFF');
  try {
    db.transaction(() => {
      for (const { sql } of objects)
        if (/^CREATE TRIGGER/i.test(sql)) {
          const name = /^CREATE TRIGGER\s+(?:IF NOT EXISTS\s+)?(?:"([^"]+)"|(\w+))/i.exec(sql);
          if (!name) throw new Error('Unsupported trigger DDL');
          db.exec(`DROP TRIGGER ${quote(name[1] ?? name[2])}`);
        }
      for (const plan of plans) {
        const replacement = `__epoch_${plan.name}`;
        const ddl = epochSchema(plan.sql).replace(
          /^CREATE TABLE\s+(?:IF NOT EXISTS\s+)?(?:"[^"]+"|`[^`]+`|\[[^\]]+\]|\w+)/i,
          `CREATE TABLE ${quote(replacement)}`,
        );
        db.exec(ddl);
        const hiddenRowid =
          !/\bWITHOUT\s+ROWID\b/i.test(plan.sql) &&
          !(
            plan.columns.filter((column) => column.pk > 0).length === 1 &&
            plan.columns.some((column) => column.type.toUpperCase() === 'INTEGER' && column.pk === 1)
          );
        const names = plan.columns.map((c) => c.name);
        const insertNames = hiddenRowid ? ['rowid', ...names] : names;
        const insert = db.prepare(`INSERT INTO ${quote(replacement)} (${insertNames.map(quote)})
          VALUES (${insertNames.map(() => '?')})`);
        const rows = db
          .prepare(`SELECT ${hiddenRowid ? 'rowid AS __epoch_rowid,' : ''}* FROM ${quote(plan.name)}`)
          .all() as Record<string, unknown>[];
        for (const row of rows) {
          convertRowTimes(plan.name, row, plan.instants);
          insert.run(
            ...(hiddenRowid ? [row.__epoch_rowid, ...names.map((name) => row[name])] : names.map((name) => row[name])),
          );
        }
        db.exec(`DROP TABLE ${quote(plan.name)}; ALTER TABLE ${quote(replacement)} RENAME TO ${quote(plan.name)}`);
        const count = db.prepare(`SELECT count(*) AS n FROM ${quote(plan.name)}`).get() as { n: number };
        if (count.n !== plan.count) throw new Error(`Row count changed: ${plan.name}`);
      }
      for (const { sql } of objects)
        db.exec(
          epochSchema(
            sql
              .replace(/^CREATE INDEX /i, 'CREATE INDEX IF NOT EXISTS ')
              .replace(/^CREATE UNIQUE INDEX /i, 'CREATE UNIQUE INDEX IF NOT EXISTS '),
          ),
        );
      for (const { name, seq } of sequences) {
        const updated = db.prepare('UPDATE sqlite_sequence SET seq=MAX(seq,?) WHERE name=?').run(seq, name);
        if (!updated.changes) db.prepare('INSERT INTO sqlite_sequence(name,seq) VALUES (?,?)').run(name, seq);
      }
      if ((db.pragma('foreign_key_check') as unknown[]).length)
        throw new Error('Conversion left foreign-key violations');
      if (db.pragma('quick_check', { simple: true }) !== 'ok') throw new Error('Conversion integrity check failed');
      db.pragma(`user_version=${STORAGE_VERSION}`);
    })();
  } finally {
    db.pragma(`foreign_keys=${foreignKeys ? 'ON' : 'OFF'}`);
  }
}
