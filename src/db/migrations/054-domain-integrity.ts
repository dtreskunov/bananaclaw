import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

const boolean = '$value IN (0,1)';
const counter = "typeof($value)='integer' AND $value>=0 AND $value<=9007199254740991";
const array = "json_valid($value) AND json_type($value)='array'";
const object = "json_valid($value) AND json_type($value)='object'";

const domains: Record<string, Record<string, string>> = {
  container_configs: {
    cli_scope: "$value IN ('disabled','group','global')",
    skills: `$value='"all"' OR (${array})`,
    mcp_servers: object,
    model_params: object,
    packages_apt: array,
    packages_npm: array,
    packages_pip: array,
    disabled_skills: array,
    additional_mounts: array,
    max_messages_per_prompt: "$value IS NULL OR (typeof($value)='integer' AND $value>0)",
  },
  messaging_groups: {
    is_group: boolean,
    unknown_sender_policy: "$value IN ('strict','request_approval','public')",
  },
  messaging_group_agents: {
    session_mode: "$value IN ('shared','per-thread','agent-shared')",
    engage_mode: "$value IN ('pattern','mention','mention-sticky')",
    engage_pattern: "NEW.engage_mode!='pattern' OR ($value IS NOT NULL AND length(trim($value))>0)",
    sender_scope: "$value IN ('all','known')",
    ignored_message_policy: "$value IN ('drop','accumulate')",
  },
  sessions: {
    status: "$value IN ('active','closed')",
    container_status: "$value IN ('running','idle','stopped')",
  },
  identities: {
    metadata_json: `$value IS NULL OR (${object})`,
  },
  users: { unread_baseline: counter },
  conversation_reads: { position: counter },
  credential_gateway_sync: {
    revision: "typeof($value)='integer' AND $value>=1 AND $value<=9007199254740991",
  },
  push_subscriptions: { fail_count: counter },
  identity_link_challenges: { attempts: counter },
  unregistered_senders: {
    message_count: "typeof($value)='integer' AND $value>=1 AND $value<=9007199254740991",
  },
  chat_sdk_lists: { idx: counter },
};

export const migration054: Migration = {
  version: 54,
  name: 'domain-integrity',
  disableForeignKeys: true,
  up(db) {
    for (const [table, columns] of Object.entries(domains)) {
      const conditions = Object.entries(columns).map(
        ([column, rule]) => `(${rule.replaceAll('$value', `NEW.${column}`)})`,
      );
      const invalid = `NOT COALESCE(${conditions.join(' AND ')},0)`;
      const existing = db
        .prepare(`SELECT count(*) AS count FROM ${table} WHERE ${invalid.replaceAll('NEW.', '')}`)
        .get() as { count: number };
      if (existing.count)
        throw new Error(
          `Domain integrity: ${table} has ${existing.count} incompatible rows; repair them offline before upgrading`,
        );
      if (table === 'messaging_group_agents') addRoutingDefaults(db);
      for (const operation of ['INSERT', 'UPDATE']) {
        db.exec(`
          CREATE TRIGGER domain_${table}_${operation.toLowerCase()}
          BEFORE ${operation} ON ${table} WHEN ${invalid} BEGIN
            SELECT RAISE(ABORT,'invalid ${table} domain values');
          END;
        `);
      }
    }
  },
};

function addRoutingDefaults(db: Database.Database): void {
  const { sql } = db
    .prepare("SELECT sql FROM sqlite_schema WHERE type='table' AND name='messaging_group_agents'")
    .get() as { sql: string };
  const objects = db
    .prepare(
      "SELECT sql FROM sqlite_schema WHERE tbl_name='messaging_group_agents' AND type IN ('index','trigger') AND sql IS NOT NULL",
    )
    .all() as Array<{ sql: string }>;
  const columns = db.prepare('PRAGMA table_info(messaging_group_agents)').all() as Array<{ name: string }>;
  const names = ['rowid', ...columns.map(({ name }) => name)]
    .map((name) => `"${name.replaceAll('"', '""')}"`)
    .join(',');
  let replacement = sql.replace(
    /^CREATE TABLE (?:"messaging_group_agents"|messaging_group_agents)/,
    'CREATE TABLE messaging_group_agents__domains',
  );
  for (const [column, value] of [
    ['engage_mode', 'mention'],
    ['sender_scope', 'all'],
    ['ignored_message_policy', 'drop'],
  ]) {
    replacement = replacement.replace(
      new RegExp(`\\b${column}\\s+TEXT\\b`),
      `${column} TEXT NOT NULL DEFAULT '${value}'`,
    );
  }
  db.exec(replacement);
  db.exec(`
    INSERT INTO messaging_group_agents__domains (${names})
      SELECT ${names} FROM messaging_group_agents;
    DROP TABLE messaging_group_agents;
    ALTER TABLE messaging_group_agents__domains RENAME TO messaging_group_agents;
  `);
  for (const object of objects) db.exec(object.sql);
}
