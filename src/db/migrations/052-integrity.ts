import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

const checks: Record<string, string[]> = {
  user_roles: ["role IN ('owner','admin')", "role != 'owner' OR agent_group_id IS NULL"],
  identities: ['primary_for_channel IN (0,1)'],
  users: ['unread_baseline >= 0'],
  thread_summary_meta: ['unread_ready IN (0,1)'],
  interaction_progress: [
    "json_valid(data_json) AND json_type(data_json)='object'",
    "json_valid(submission_ids_json) AND json_type(submission_ids_json)='array'",
    'restart IN (0,1)',
    'notified IN (0,1)',
  ],
};

function quote(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

export const migration052: Migration = {
  version: 52,
  name: 'central-integrity',
  disableForeignKeys: true,
  up(db) {
    const tables = db
      .prepare("SELECT name,sql FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'")
      .all() as Array<{ name: string; sql: string }>;
    const legacy = db.pragma('legacy_alter_table', { simple: true });
    db.pragma('legacy_alter_table = ON');
    try {
      for (const table of tables) hardenTable(db, table);
      db.exec(`
        CREATE UNIQUE INDEX user_roles_global_unique ON user_roles(user_id,role)
          WHERE agent_group_id IS NULL;
        CREATE UNIQUE INDEX identities_primary_unique ON identities(user_id,channel)
          WHERE primary_for_channel=1;
        CREATE UNIQUE INDEX sessions_active_thread_unique
          ON sessions(agent_group_id,messaging_group_id,thread_id)
          WHERE status='active' AND messaging_group_id IS NOT NULL AND thread_id IS NOT NULL;
        CREATE UNIQUE INDEX sessions_active_shared_unique
          ON sessions(agent_group_id,messaging_group_id)
          WHERE status='active' AND messaging_group_id IS NOT NULL AND thread_id IS NULL;
      `);
    } finally {
      db.pragma(`legacy_alter_table = ${legacy ? 'ON' : 'OFF'}`);
    }
  },
};

function hardenTable(db: Database.Database, table: { name: string; sql: string }): void {
  const columns = db.prepare(`PRAGMA table_info(${quote(table.name)})`).all() as Array<{
    name: string;
    type: string;
    pk: number;
    notnull: number;
  }>;
  const keys = columns.filter((column) => column.pk > 0);
  const nullableKey = keys.length === 1 && keys[0].type === 'TEXT' && !keys[0].notnull;
  const constraints = checks[table.name] ?? [];
  if (!nullableKey && constraints.length === 0) return;
  const objects = db
    .prepare("SELECT sql FROM sqlite_schema WHERE tbl_name=? AND type IN ('index','trigger') AND sql IS NOT NULL")
    .all(table.name) as Array<{ sql: string }>;
  const temporary = `${table.name}__integrity`;
  let sql = table.sql.replace(
    /^CREATE TABLE (?:IF NOT EXISTS )?(?:"[^"]+"|`[^`]+`|\[[^\]]+\]|\w+)/i,
    `CREATE TABLE ${quote(temporary)}`,
  );
  if (nullableKey) sql = sql.replace(/\bTEXT PRIMARY KEY\b(?! NOT NULL)/i, 'TEXT PRIMARY KEY NOT NULL');
  const end = sql.lastIndexOf(')');
  if (constraints.length) {
    sql = `${sql.slice(0, end)}, ${constraints.map((check) => `CHECK(${check})`).join(',')}${sql.slice(end)}`;
  }
  const names = ['rowid', ...columns.map((column) => column.name)].map(quote).join(',');
  db.exec(sql);
  db.exec(`INSERT INTO ${quote(temporary)} (${names}) SELECT ${names} FROM ${quote(table.name)}`);
  db.exec(`DROP TABLE ${quote(table.name)}; ALTER TABLE ${quote(temporary)} RENAME TO ${quote(table.name)}`);
  for (const object of objects) db.exec(object.sql);
}
