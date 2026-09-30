import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';

// Mirrored in the Bun runner's db/turns.ts; neither runtime imports the other.
export type TurnPhase = 'running' | 'stopping' | 'settling' | 'settled';
export type TurnOutcome =
  | 'pending'
  | 'replied'
  | 'warning'
  | 'silent'
  | 'stopped'
  | 'failed'
  | 'unknown'
  | 'interrupted';
export interface TurnRow {
  id: string;
  origin_channel_type: string | null;
  origin_platform_id: string | null;
  origin_thread_id: string | null;
  origin_source_session_id: string | null;
  started_at: string | null;
  ended_at: string | null;
  phase: TurnPhase;
  outcome: TurnOutcome;
  provenance: 'native' | 'backfill' | 'fork';
  imported_from_session_id: string | null;
  imported_from_turn_id: string | null;
}

export interface TurnInputRow {
  turn_id: string;
  message_in_id: string;
  association: 'consumed' | 'applied' | 'reply';
}

/** Host passes a read-only inbound snapshot; runner reads its local projection. */
export interface TurnInputEvidence {
  id: string;
  channel_type: string | null;
  platform_id: string | null;
  thread_id: string | null;
  source_session_id: string | null;
}

export const TURN_SCHEMA = `
CREATE TABLE IF NOT EXISTS conversation_sync_migrations (
  step TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS turns (
  id TEXT PRIMARY KEY NOT NULL CHECK (length(id) > 0),
  origin_channel_type TEXT,
  origin_platform_id TEXT,
  origin_thread_id TEXT,
  origin_source_session_id TEXT,
  started_at TEXT,
  ended_at TEXT,
  phase TEXT NOT NULL CHECK (phase IN ('running', 'stopping', 'settling', 'settled')),
  outcome TEXT NOT NULL CHECK (outcome IN ('pending', 'replied', 'warning', 'silent', 'stopped', 'failed', 'unknown', 'interrupted')),
  provenance TEXT NOT NULL CHECK (provenance IN ('native', 'backfill', 'fork')),
  imported_from_session_id TEXT,
  imported_from_turn_id TEXT
);
CREATE INDEX IF NOT EXISTS idx_turns_origin ON turns(origin_channel_type, origin_platform_id, origin_thread_id);
CREATE TABLE IF NOT EXISTS turn_inputs (
  turn_id TEXT NOT NULL REFERENCES turns(id),
  message_in_id TEXT NOT NULL,
  association TEXT NOT NULL CHECK (association IN ('consumed', 'applied', 'reply')),
  PRIMARY KEY (turn_id, message_in_id)
);
CREATE INDEX IF NOT EXISTS idx_turn_inputs_message ON turn_inputs(message_in_id);
`;

export const TURN_ACTIVITY_SCHEMA = `
CREATE TABLE IF NOT EXISTS turn_activity (
  message_out_id TEXT,
  ordinal INTEGER NOT NULL,
  ts TEXT NOT NULL,
  text TEXT NOT NULL,
  turn_id TEXT REFERENCES turns(id),
  PRIMARY KEY (message_out_id, ordinal),
  CHECK (message_out_id IS NOT NULL OR turn_id IS NOT NULL)
);
`;

export const TURN_INDEX_SCHEMA = `
CREATE INDEX IF NOT EXISTS idx_messages_out_turn ON messages_out(turn_id);
CREATE INDEX IF NOT EXISTS idx_turn_usage_turn ON turn_usage(turn_id);
CREATE INDEX IF NOT EXISTS idx_turn_activity_turn ON turn_activity(turn_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_turn_activity_unanchored
  ON turn_activity(turn_id, ordinal) WHERE message_out_id IS NULL;
INSERT OR IGNORE INTO conversation_sync_migrations(step) VALUES ('schema:1');
`;

export function hasTurnSchema(db: Database.Database): boolean {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'turns'").get();
}

export function getTurn(db: Database.Database, id: string): TurnRow | undefined {
  return db.prepare('SELECT * FROM turns WHERE id = ?').get(id) as TurnRow | undefined;
}

/** Storage-only helper. Lifecycle transitions and journaling are deliberately not wired yet. */
export function putTurn(db: Database.Database, turn: TurnRow): void {
  db.prepare(
    `
    INSERT INTO turns (id, origin_channel_type, origin_platform_id, origin_thread_id,
      origin_source_session_id, started_at, ended_at, phase, outcome, provenance,
      imported_from_session_id, imported_from_turn_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      origin_channel_type=excluded.origin_channel_type, origin_platform_id=excluded.origin_platform_id,
      origin_thread_id=excluded.origin_thread_id, origin_source_session_id=excluded.origin_source_session_id,
      started_at=excluded.started_at, ended_at=excluded.ended_at, phase=excluded.phase,
      outcome=excluded.outcome, provenance=excluded.provenance,
      imported_from_session_id=excluded.imported_from_session_id,
      imported_from_turn_id=excluded.imported_from_turn_id
  `,
  ).run(
    turn.id,
    turn.origin_channel_type,
    turn.origin_platform_id,
    turn.origin_thread_id,
    turn.origin_source_session_id,
    turn.started_at,
    turn.ended_at,
    turn.phase,
    turn.outcome,
    turn.provenance,
    turn.imported_from_session_id,
    turn.imported_from_turn_id,
  );
}

export function getTurnInputs(db: Database.Database, turnId: string): TurnInputRow[] {
  return db.prepare('SELECT * FROM turn_inputs WHERE turn_id = ? ORDER BY message_in_id').all(turnId) as TurnInputRow[];
}

export function linkTurnInput(db: Database.Database, input: TurnInputRow): void {
  if (!getTurn(db, input.turn_id)) throw new Error(`Unknown turn: ${input.turn_id}`);
  db.prepare(
    `INSERT INTO turn_inputs (turn_id, message_in_id, association) VALUES (?, ?, ?)
    ON CONFLICT(turn_id, message_in_id) DO NOTHING`,
  ).run(input.turn_id, input.message_in_id, input.association);
}

export interface TurnAssociations {
  inputs: TurnInputRow[];
  outputIds: string[];
  usageIds: string[];
  activity: Array<{ message_out_id: string | null; ordinal: number }>;
}

export function getTurnAssociations(db: Database.Database, turnId: string): TurnAssociations {
  return {
    inputs: getTurnInputs(db, turnId),
    outputIds: (
      db.prepare('SELECT id FROM messages_out WHERE turn_id = ? ORDER BY id').all(turnId) as Array<{ id: string }>
    ).map((r) => r.id),
    usageIds: (
      db.prepare('SELECT id FROM turn_usage WHERE turn_id = ? ORDER BY id').all(turnId) as Array<{ id: string }>
    ).map((r) => r.id),
    activity: db
      .prepare('SELECT message_out_id, ordinal FROM turn_activity WHERE turn_id = ? ORDER BY message_out_id, ordinal')
      .all(turnId) as TurnAssociations['activity'],
  };
}

export type TurnAssociationTarget =
  | { table: 'messages_out' | 'turn_usage'; id: string }
  | { table: 'turn_activity'; message_out_id: string; ordinal: number };

/** Link an existing record without permitting accidental reassignment. Storage-only. */
export function linkTurnRecord(db: Database.Database, turnId: string, target: TurnAssociationTarget): void {
  db.transaction(() => {
    if (!getTurn(db, turnId)) throw new Error(`Unknown turn: ${turnId}`);
    const where = target.table === 'turn_activity' ? 'message_out_id = ? AND ordinal = ?' : 'id = ?';
    const values = target.table === 'turn_activity' ? [target.message_out_id, target.ordinal] : [target.id];
    const row = db.prepare(`SELECT turn_id FROM ${target.table} WHERE ${where}`).get(...values) as
      | { turn_id: string | null }
      | undefined;
    if (!row) throw new Error('Unknown turn association target');
    if (row.turn_id !== null && row.turn_id !== turnId) throw new Error('Record already belongs to another turn');
    if (row.turn_id === null)
      db.prepare(`UPDATE ${target.table} SET turn_id = ? WHERE ${where}`).run(turnId, ...values);
  })();
}

/** Explicit, versioned schema migration. Never called by a production DB opener. */
export function migrateTurnSchema(db: Database.Database): void {
  db.transaction(() => {
    db.exec(TURN_SCHEMA);
    if (db.prepare("SELECT 1 FROM conversation_sync_migrations WHERE step = 'schema:1'").get()) return;
    for (const table of ['messages_out', 'turn_usage', 'turn_activity']) {
      const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
      if (!columns.some((c) => c.name === 'turn_id')) {
        db.exec(`ALTER TABLE ${table} ADD COLUMN turn_id TEXT REFERENCES turns(id)`);
      }
    }
    const activityColumns = db.prepare('PRAGMA table_info(turn_activity)').all() as Array<{
      name: string;
      notnull: number;
    }>;
    if (activityColumns.some((c) => c.name === 'message_out_id' && c.notnull)) {
      // Keep legacy keys, ordinals, and trigger SQL byte-for-byte. The new nullable
      // output anchor permits activity on silent turns without a synthetic reply.
      const objects = db
        .prepare(
          "SELECT sql FROM sqlite_master WHERE tbl_name = 'turn_activity' AND type IN ('index', 'trigger') AND sql IS NOT NULL",
        )
        .all() as Array<{ sql: string }>;
      db.exec(`ALTER TABLE turn_activity RENAME TO turn_activity_before_sync;
        ${TURN_ACTIVITY_SCHEMA}
        INSERT INTO turn_activity SELECT message_out_id, ordinal, ts, text, turn_id FROM turn_activity_before_sync;
        DROP TABLE turn_activity_before_sync;`);
      for (const { sql } of objects) db.exec(sql);
    }
    db.exec(TURN_INDEX_SCHEMA);
  })();
}

function parseObject(text: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(text);
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  } catch (err) {
    if (err instanceof SyntaxError) return {};
    throw err;
  }
}

function explicitId(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

export function historicalTurnId(messageOutId: string): string {
  return `legacy:out:${createHash('sha256').update(messageOutId).digest('hex')}`;
}

/** Conservative one-time import; no clock-based grouping or lifecycle reconstruction. */
export function backfillTurns(db: Database.Database, inputs: TurnInputEvidence[] = []): void {
  db.transaction(() => {
    migrateTurnSchema(db);
    if (db.prepare("SELECT 1 FROM conversation_sync_migrations WHERE step = 'backfill:1'").get()) return;
    // Association-only updates must not enqueue old protocol payloads (or replay
    // existing usage). Restore the same triggers before committing.
    const triggers = db
      .prepare(
        "SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND tbl_name IN ('messages_out', 'turn_usage', 'turn_activity')",
      )
      .all() as Array<{ name: string; sql: string }>;
    for (const { name } of triggers) db.exec(`DROP TRIGGER "${name.replaceAll('"', '""')}"`);

    const inputById = new Map(inputs.map((row) => [row.id, row]));
    const outputs = db
      .prepare('SELECT id, in_reply_to, content, turn_id FROM messages_out ORDER BY id')
      .all() as Array<{ id: string; in_reply_to: string | null; content: string; turn_id: string | null }>;
    const applied: Array<{ messageId: string; turnId: string }> = [];
    const states = db.prepare("SELECT key, value FROM session_state WHERE key LIKE 'input:%'").all() as Array<{
      key: string;
      value: string;
    }>;
    for (const state of states) {
      const value = parseObject(state.value);
      const turnId = explicitId(value.turnId);
      if (
        value.status !== 'applied' ||
        !turnId ||
        typeof value.messageId !== 'string' ||
        !inputById.has(value.messageId)
      )
        continue;
      if (state.key !== `input:${createHash('sha256').update(value.messageId).digest('hex')}`) continue;
      applied.push({ messageId: value.messageId, turnId });
    }
    const reserved = new Set([
      ...(db.prepare('SELECT id FROM turns').all() as Array<{ id: string }>).map((r) => r.id),
      ...outputs.map((r) => r.turn_id ?? explicitId(parseObject(r.content).turn_id)).filter((id): id is string => !!id),
      ...applied.map((r) => r.turnId),
    ]);
    const imported = new Set<string>();
    const ensureTurn = (id: string) => {
      if (getTurn(db, id)) return;
      putTurn(db, {
        id,
        origin_channel_type: null,
        origin_platform_id: null,
        origin_thread_id: null,
        origin_source_session_id: null,
        started_at: null,
        ended_at: null,
        phase: 'settled',
        outcome: 'unknown',
        provenance: 'backfill',
        imported_from_session_id: null,
        imported_from_turn_id: null,
      });
      imported.add(id);
    };
    for (const input of applied) {
      ensureTurn(input.turnId);
      linkTurnInput(db, { turn_id: input.turnId, message_in_id: input.messageId, association: 'applied' });
    }
    for (const output of outputs) {
      let id = output.turn_id ?? explicitId(parseObject(output.content).turn_id);
      if (!id) {
        const base = historicalTurnId(output.id);
        id = base;
        for (let suffix = 1; reserved.has(id); suffix++) id = `${base}:${suffix}`;
        reserved.add(id);
      }
      ensureTurn(id);
      db.prepare('UPDATE messages_out SET turn_id = ? WHERE id = ? AND turn_id IS NULL').run(id, output.id);
      if (output.in_reply_to && inputById.has(output.in_reply_to)) {
        linkTurnInput(db, { turn_id: id, message_in_id: output.in_reply_to, association: 'reply' });
      }
    }
    for (const id of imported) {
      const origins = getTurnInputs(db, id)
        .map((r) => inputById.get(r.message_in_id))
        .filter((r) => r !== undefined);
      const routes = new Map(
        origins.map((r) => [JSON.stringify([r.channel_type, r.platform_id, r.thread_id, r.source_session_id]), r]),
      );
      // A destination is not proof of origin. Conflicting/missing inputs remain unknown.
      if (routes.size === 1) {
        const route = origins[0];
        putTurn(db, {
          ...getTurn(db, id)!,
          origin_channel_type: route.channel_type,
          origin_platform_id: route.platform_id,
          origin_thread_id: route.thread_id,
          origin_source_session_id: route.source_session_id,
        });
      }
    }
    for (const table of ['turn_usage', 'turn_activity']) {
      db.exec(`UPDATE ${table} SET turn_id = (SELECT turn_id FROM messages_out WHERE id = ${table}.message_out_id)
        WHERE turn_id IS NULL AND EXISTS (SELECT 1 FROM messages_out WHERE id = ${table}.message_out_id)`);
    }
    for (const { sql } of triggers) db.exec(sql);
    db.prepare("INSERT INTO conversation_sync_migrations(step) VALUES ('backfill:1')").run();
  })();
}
