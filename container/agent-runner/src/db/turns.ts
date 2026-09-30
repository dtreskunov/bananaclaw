import type { Database } from 'bun:sqlite';

// Mirrored in the host's src/db/turns.ts; neither runtime imports the other.
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

export const TURN_SCHEMA = `
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
`;

export function getTurn(db: Database, id: string): TurnRow | undefined {
  return (db.query('SELECT * FROM turns WHERE id = ?').get(id) as TurnRow | null) ?? undefined;
}

/** Storage upsert; callers own lifecycle validation and runner journal triggers. */
export function putTurn(db: Database, turn: TurnRow): void {
  db.query(
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

export function getTurnInputs(db: Database, turnId: string): TurnInputRow[] {
  return db.query('SELECT * FROM turn_inputs WHERE turn_id = ? ORDER BY message_in_id').all(turnId) as TurnInputRow[];
}

export function linkTurnInput(db: Database, input: TurnInputRow): void {
  if (!getTurn(db, input.turn_id)) throw new Error(`Unknown turn: ${input.turn_id}`);
  db.query(
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

export function getTurnAssociations(db: Database, turnId: string): TurnAssociations {
  return {
    inputs: getTurnInputs(db, turnId),
    outputIds: (
      db.query('SELECT id FROM messages_out WHERE turn_id = ? ORDER BY id').all(turnId) as Array<{ id: string }>
    ).map((r) => r.id),
    usageIds: (
      db.query('SELECT id FROM turn_usage WHERE turn_id = ? ORDER BY id').all(turnId) as Array<{ id: string }>
    ).map((r) => r.id),
    activity: db
      .query('SELECT message_out_id, ordinal FROM turn_activity WHERE turn_id = ? ORDER BY message_out_id, ordinal')
      .all(turnId) as TurnAssociations['activity'],
  };
}

export type TurnAssociationTarget =
  | { table: 'messages_out' | 'turn_usage'; id: string }
  | { table: 'turn_activity'; message_out_id: string; ordinal: number };

/** Link an existing record without permitting accidental reassignment. Storage-only. */
export function linkTurnRecord(db: Database, turnId: string, target: TurnAssociationTarget): void {
  db.transaction(() => {
    if (!getTurn(db, turnId)) throw new Error(`Unknown turn: ${turnId}`);
    const where = target.table === 'turn_activity' ? 'message_out_id = ? AND ordinal = ?' : 'id = ?';
    const values = target.table === 'turn_activity' ? [target.message_out_id, target.ordinal] : [target.id];
    const row = db.query(`SELECT turn_id FROM ${target.table} WHERE ${where}`).get(...values) as {
      turn_id: string | null;
    } | null;
    if (!row) throw new Error('Unknown turn association target');
    if (row.turn_id !== null && row.turn_id !== turnId) throw new Error('Record already belongs to another turn');
    if (row.turn_id === null)
      db.query(`UPDATE ${target.table} SET turn_id = ? WHERE ${where}`).run(turnId, ...values);
  })();
}
