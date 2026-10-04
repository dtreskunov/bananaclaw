import Database from 'better-sqlite3';
import { inputStateKey } from '../src/input-timeline.js';
import { TURN_ACTIVITY_SCHEMA } from '../src/db/turns.js';
import { parseTimelinePosition, timelineSortKey } from '../src/ui/shared/timeline.js';

interface ActivityRow {
  message_out_id: string | null;
  turn_id: string | null;
  ordinal: number;
  ts: string;
  text: string;
  timeline_position?: number | null;
}
interface OutputRow {
  id: string;
  seq: number;
  timestamp: string;
  content: string;
}
interface StateRow {
  key: string;
  value: string;
  updated_at: string;
}
interface InputRow {
  id: string;
  seq: number;
  timestamp: string;
  status: string;
}
interface Event {
  id: string;
  key: number;
  seq: number;
}
interface Projection {
  activity: ActivityRow[];
  outputs: OutputRow[];
  states: StateRow[];
}
export interface ActivityOrderPlan {
  needed: boolean;
  activityPositions: Map<string, number>;
  messagePositions: Map<string, number>;
  inputStates: Map<string, StateRow>;
  clock: number;
  normalizedMessageTimestamps: number;
  projections: [Projection, Projection];
}

const activityId = (row: ActivityRow) => JSON.stringify([row.turn_id ?? row.message_out_id, row.ordinal]);
function record(value: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(value);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Invalid stored JSON object');
  return parsed as Record<string, unknown>;
}
function projection(db: Database.Database): Projection {
  return {
    activity: db.prepare('SELECT * FROM turn_activity').all() as ActivityRow[],
    outputs: db.prepare('SELECT id, seq, timestamp, content FROM messages_out').all() as OutputRow[],
    states: db.prepare('SELECT key, value, updated_at FROM session_state').all() as StateRow[],
  };
}
export function hasStrictActivityOrder(db: Database.Database): boolean {
  const columns = db.prepare('PRAGMA table_info(turn_activity)').all() as Array<{ name: string; notnull: number }>;
  return columns.some((column) => column.name === 'timeline_position' && column.notnull === 1);
}

/** Offline conversion only: associations define old activity placement, never activity timestamps. */
export function planActivityOrder(
  inbound: Database.Database,
  outbound: Database.Database,
  runner: Database.Database,
): ActivityOrderPlan {
  const projections: [Projection, Projection] = [projection(outbound), projection(runner)];
  const needed = !hasStrictActivityOrder(outbound) || !hasStrictActivityOrder(runner);
  const plan: ActivityOrderPlan = {
    needed,
    projections,
    activityPositions: new Map(),
    messagePositions: new Map(),
    inputStates: new Map(),
    clock: 0,
    normalizedMessageTimestamps: 0,
  };
  if (!needed) {
    for (const view of projections) {
      for (const row of view.activity) {
        if (!parseTimelinePosition(row.timeline_position)) throw new Error('Invalid canonical activity position');
      }
    }
    return plan;
  }
  for (const db of [outbound, runner]) {
    if (db.prepare("SELECT COUNT(*) FROM turns WHERE phase != 'settled'").pluck().get()) {
      throw new Error('Finish all active turns before migrating activity order');
    }
    const foreignKeys = db.pragma('foreign_key_check');
    if (!Array.isArray(foreignKeys) || foreignKeys.length || db.pragma('integrity_check', { simple: true }) !== 'ok') {
      throw new Error('Database validation failed before conversion');
    }
    for (const trigger of db
      .prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name LIKE 'journal_%'")
      .all() as Array<{ sql: string }>) {
      restoreJournalTrigger(trigger.sql, 'main');
    }
  }
  if (runner.prepare('SELECT COUNT(*) FROM pending_runner_events').pluck().get()) {
    throw new Error('Drain the runner journal with the previous host before migrating activity order');
  }
  const activity = new Map<string, ActivityRow>();
  for (const row of projections[0].activity) {
    const id = activityId(row);
    if (activity.has(id)) throw new Error('Duplicate logical activity ordinal requires explicit repair');
    activity.set(id, row);
  }
  if (activity.size !== projections[1].activity.length)
    throw new Error('Host and runner activity are not synchronized');
  for (const row of projections[1].activity) {
    const source = activity.get(activityId(row));
    if (
      !source ||
      source.message_out_id !== row.message_out_id ||
      source.ts !== row.ts ||
      source.text !== row.text ||
      source.timeline_position !== row.timeline_position
    ) {
      throw new Error('Host and runner activity are not synchronized');
    }
  }
  const events = new Map<string, Event>();
  const addEvent = (id: string, timestamp: string, seq: number, position: unknown) => {
    const recorded = parseTimelinePosition(position);
    const numeric = /^\d{13}(?:\.0+)?$/.test(timestamp) && Number.isSafeInteger(Number(timestamp));
    const key = recorded ?? (numeric ? Number(timestamp) * 1000 : timelineSortKey(timestamp));
    if (!key || !Number.isSafeInteger(key))
      throw new Error(`Cannot establish stored message order (${id}, ${timestamp})`);
    const previous = events.get(id);
    if (previous && previous.key !== key) throw new Error('Host and runner message order are not synchronized');
    if (!previous && !recorded && numeric) plan.normalizedMessageTimestamps++;
    events.set(id, { id, key, seq });
  };
  for (const view of projections) {
    for (const row of view.outputs)
      addEvent(`out:${row.id}`, row.timestamp, row.seq, record(row.content).timelinePosition);
    for (const row of view.states) {
      if (!row.key.startsWith('input:')) continue;
      const value = record(row.value);
      if (typeof value.messageId !== 'string' || inputStateKey(value.messageId) !== row.key) {
        throw new Error('Invalid stored input receipt');
      }
      const previous = plan.inputStates.get(value.messageId);
      if (previous && previous.value !== row.value)
        throw new Error('Host and runner input receipts are not synchronized');
      plan.inputStates.set(value.messageId, row);
    }
  }
  const turnInputs = outbound.prepare('SELECT turn_id, message_in_id FROM turn_inputs').all() as Array<{
    turn_id: string;
    message_in_id: string;
  }>;
  const consumed = new Set(turnInputs.map((row) => row.message_in_id));
  for (const row of inbound.prepare('SELECT id, seq, timestamp, status FROM messages_in').all() as InputRow[]) {
    const receipt = plan.inputStates.get(row.id);
    const value = receipt ? record(receipt.value) : undefined;
    if (value?.status === 'cancelled') continue;
    if (
      !consumed.has(row.id) &&
      !parseTimelinePosition(value?.timelinePosition) &&
      !['processing', 'processed', 'completed', 'failed'].includes(row.status)
    )
      continue;
    addEvent(`in:${row.id}`, row.timestamp, row.seq, value?.timelinePosition);
    if (!receipt)
      plan.inputStates.set(row.id, {
        key: inputStateKey(row.id),
        updated_at: row.timestamp,
        value: JSON.stringify({ messageId: row.id, status: 'processing' }),
      });
  }
  for (const row of activity.values()) {
    const position = parseTimelinePosition(row.timeline_position);
    if (position)
      events.set(`activity:${activityId(row)}`, { id: `activity:${activityId(row)}`, key: position, seq: row.ordinal });
  }
  const ordered = [...events.values()].sort((a, b) => a.key - b.key || a.seq - b.seq || a.id.localeCompare(b.id));
  const before = new Map<string, ActivityRow[]>();
  const after = new Map<string, ActivityRow[]>();
  const lastInputs = new Map<string, Event>();
  for (const row of turnInputs) {
    const event = events.get(`in:${row.message_in_id}`);
    if (!event) throw new Error('Turn input has no canonical ordering boundary');
    const previous = lastInputs.get(row.turn_id);
    if (!previous || previous.key < event.key || (previous.key === event.key && previous.seq < event.seq)) {
      lastInputs.set(row.turn_id, event);
    }
  }
  for (const row of activity.values()) {
    if (parseTimelinePosition(row.timeline_position)) continue;
    const anchor = row.message_out_id
      ? events.get(`out:${row.message_out_id}`)
      : ((row.turn_id ? lastInputs.get(row.turn_id) : undefined) ?? ordered.at(-1));
    if (row.message_out_id && !anchor) throw new Error('Activity output association is missing');
    const buckets = row.message_out_id ? before : after;
    const id = anchor?.id ?? 'end';
    const lines = buckets.get(id) ?? [];
    lines.push(row);
    buckets.set(id, lines);
  }
  const allocate = (key: number) => {
    plan.clock = Math.max(plan.clock + 1, key);
    if (!Number.isSafeInteger(plan.clock)) throw new Error('Canonical timeline exceeds safe integer range');
    return plan.clock;
  };
  const place = (rows: ActivityRow[] = [], key: number) => {
    rows.sort((a, b) => String(a.turn_id).localeCompare(String(b.turn_id)) || a.ordinal - b.ordinal);
    for (const row of rows) plan.activityPositions.set(activityId(row), allocate(key++));
  };
  for (const event of ordered) {
    const preceding = before.get(event.id);
    place(preceding, event.key - (preceding?.length ?? 0));
    const position = allocate(event.key);
    if (event.id.startsWith('activity:')) plan.activityPositions.set(event.id.slice('activity:'.length), position);
    else plan.messagePositions.set(event.id, position);
    place(after.get(event.id), plan.clock + 1);
  }
  place(after.get('end'), plan.clock + 1);
  const previousByTurn = new Map<string, number>();
  for (const row of [...activity.values()].sort((a, b) => a.ordinal - b.ordinal)) {
    const position = plan.activityPositions.get(activityId(row));
    if (!position) throw new Error('Unplaced activity');
    if (row.turn_id && position <= (previousByTurn.get(row.turn_id) ?? 0)) {
      throw new Error('Saved activity associations conflict with ordinal order');
    }
    if (row.turn_id) previousByTurn.set(row.turn_id, position);
  }
  return plan;
}

function restoreJournalTrigger(sql: string, schema: string): string {
  let restored = sql.replace(/^(CREATE TRIGGER(?: IF NOT EXISTS)?)\s+/i, `$1 ${schema}.`);
  if (/journal_turn_activity_(insert|update)/i.test(sql) && !sql.includes("'timeline_position'")) {
    const updated = restored.replace(
      /('turn_id',\s*NEW\.turn_id)\s*\)/i,
      "$1, 'timeline_position', NEW.timeline_position)",
    );
    if (updated === restored) throw new Error('Unrecognized activity journal trigger');
    restored = updated;
  }
  return restored;
}

/** One SQLite transaction commits the attached host/runner pair together. Writers must be stopped. */
export function applyActivityOrder(outboundPath: string, runnerPath: string, plan: ActivityOrderPlan): void {
  if (!plan.needed) return;
  const db = new Database(outboundPath);
  try {
    db.prepare('ATTACH DATABASE ? AS runner').run(runnerPath);
    db.pragma('foreign_keys = ON');
    for (const schema of ['main', 'runner']) {
      if (db.pragma(`${schema}.journal_mode`, { simple: true }) !== 'delete') {
        throw new Error('Offline paired migration requires DELETE journal mode');
      }
    }
    db.transaction(() => {
      for (const [index, schema] of ['main', 'runner'].entries()) {
        const view = plan.projections[index];
        const triggers = db
          .prepare(`SELECT name, sql FROM ${schema}.sqlite_master WHERE type='trigger' AND name LIKE 'journal_%'`)
          .all() as Array<{ name: string; sql: string }>;
        for (const trigger of triggers) db.exec(`DROP TRIGGER ${schema}."${trigger.name.replaceAll('"', '""')}"`);
        const updateOutput = db.prepare(`UPDATE ${schema}.messages_out SET content = ? WHERE id = ?`);
        for (const row of view.outputs) {
          const position = plan.messagePositions.get(`out:${row.id}`);
          if (!position) throw new Error('Unplaced output');
          updateOutput.run(JSON.stringify({ ...record(row.content), timelinePosition: position }), row.id);
        }
        const updateState = db.prepare(`INSERT INTO ${schema}.session_state (key,value,updated_at) VALUES (?,?,?)
          ON CONFLICT(key) DO UPDATE SET value=excluded.value`);
        for (const [id, row] of plan.inputStates) {
          const position = plan.messagePositions.get(`in:${id}`);
          if (position)
            updateState.run(
              row.key,
              JSON.stringify({ ...record(row.value), timelinePosition: position }),
              row.updated_at,
            );
        }
        db.exec(
          TURN_ACTIVITY_SCHEMA.replace(
            'CREATE TABLE IF NOT EXISTS turn_activity',
            `CREATE TABLE ${schema}.turn_activity_canonical`,
          ),
        );
        const insert = db.prepare(`INSERT INTO ${schema}.turn_activity_canonical
          (message_out_id,ordinal,ts,text,turn_id,timeline_position) VALUES (?,?,?,?,?,?)`);
        for (const row of view.activity) {
          insert.run(
            row.message_out_id,
            row.ordinal,
            row.ts,
            row.text,
            row.turn_id,
            plan.activityPositions.get(activityId(row)),
          );
        }
        db.exec(`DROP TABLE ${schema}.turn_activity;
          ALTER TABLE ${schema}.turn_activity_canonical RENAME TO turn_activity;
          CREATE INDEX ${schema}.idx_turn_activity_turn ON turn_activity(turn_id);
          CREATE UNIQUE INDEX ${schema}.idx_turn_activity_unanchored ON turn_activity(turn_id,ordinal) WHERE message_out_id IS NULL;`);
        for (const trigger of triggers) db.exec(restoreJournalTrigger(trigger.sql, schema));
        const foreignKeys = db.pragma(`${schema}.foreign_key_check`);
        if (!Array.isArray(foreignKeys) || foreignKeys.length) throw new Error('Foreign key validation failed');
      }
      db.exec(`CREATE TABLE IF NOT EXISTS runner.timeline_clock (
        id INTEGER PRIMARY KEY CHECK (id=1),
        position INTEGER NOT NULL CHECK (position >= 0 AND position <= 9007199254740991));`);
      db.prepare(
        'INSERT INTO runner.timeline_clock (id,position) VALUES (1,?) ON CONFLICT(id) DO UPDATE SET position=MAX(position,excluded.position)',
      ).run(plan.clock);
      if (Number(db.prepare('SELECT position FROM runner.timeline_clock WHERE id=1').pluck().get()) < plan.clock) {
        throw new Error('Missing runner timeline clock');
      }
    }).immediate();
    if (
      db.pragma('integrity_check', { simple: true }) !== 'ok' ||
      db.pragma('runner.integrity_check', { simple: true }) !== 'ok'
    )
      throw new Error('Database integrity validation failed');
  } finally {
    db.close();
  }
}
