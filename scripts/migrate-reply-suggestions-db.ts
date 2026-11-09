import Database from 'better-sqlite3';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { CENTRAL_SCHEMA_SQL } from '../src/db/central-schema.js';
import { INBOUND_SCHEMA, OUTBOUND_SCHEMA } from '../src/db/schema.js';
import { STORAGE_VERSION } from '../src/db/storage-lifecycle.js';
import { ensureRunnerStateSchema } from '../container/agent-runner/src/db/runner-state.js';
import { STORAGE_VERSION as RUNNER_VERSION } from '../container/agent-runner/src/db/storage-lifecycle.js';

export type Row = Record<string, string | number | null | Buffer>;
export type Store = 'central' | 'inbound' | 'outbound' | 'runner';
export type EventRow = Row & {
  event_id: string;
  sequence: number;
  event_type: string;
  payload: string;
  created_at: number;
};
export interface EventProof {
  direction: 'host' | 'runner';
  id: string;
  sequence: number;
  type: string;
  digest: string;
}

export function fail(message: string): never {
  throw new Error(`PREFLIGHT: ${message}`);
}

export function identifier(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

export function tables(db: Database.Database): string[] {
  return (
    db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as {
      name: string;
    }[]
  ).map((row) => row.name);
}

export function rows(db: Database.Database, table: string): Row[] {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)) {
    fail(`missing table ${table}; unsupported/incomplete source schema`);
  }
  return db.prepare(`SELECT * FROM ${identifier(table)}`).all() as Row[];
}

export function dropTriggers(db: Database.Database): void {
  db.transaction(() => {
    for (const row of db.prepare("SELECT name FROM sqlite_master WHERE type='trigger'").all() as { name: string }[]) {
      db.exec(`DROP TRIGGER ${identifier(row.name)}`);
    }
  })();
}

export function openSnapshot(file: string, scratch?: string): Database.Database {
  const source = new Database(file, { readonly: true, fileMustExist: true });
  try {
    const version = source.pragma('user_version', { simple: true });
    if (version !== 1 && version !== 2) fail(`${file}: storage version ${version} is not supported`);
    if (source.pragma('integrity_check', { simple: true }) !== 'ok') fail(`${file}: integrity check failed`);
    if ((source.pragma('foreign_key_check') as unknown[]).length) fail(`${file}: foreign keys are invalid`);
    let snapshot: Database.Database;
    if (scratch) {
      const filename = path.join(scratch, `${crypto.randomUUID()}.db`);
      fs.writeFileSync(filename, source.serialize(), { flag: 'wx', mode: 0o600 });
      snapshot = new Database(filename);
      snapshot.pragma('cache_size=-128');
      snapshot.pragma('journal_mode=MEMORY');
      snapshot.pragma('synchronous=OFF');
    } else snapshot = new Database(source.serialize());
    dropTriggers(snapshot);
    return snapshot;
  } finally {
    source.close();
  }
}

export function createTarget(store: Store, filename = ':memory:'): Database.Database {
  if (STORAGE_VERSION !== 2 || RUNNER_VERSION !== 2) fail('canonical host and runner DDL must both be version 2');
  if (CENTRAL_SCHEMA_SQL.includes("'question'")) fail('canonical central DDL still admits questions');
  const db = new Database(filename);
  db.pragma('cache_size=-128');
  db.pragma('journal_mode=MEMORY');
  db.pragma('synchronous=OFF');
  db.exec('BEGIN');
  if (store === 'runner') {
    // The canonical Bun schema only needs these synchronous SQLite methods.
    const facade = {
      exec: db.exec.bind(db),
      prepare: db.prepare.bind(db),
      query: db.prepare.bind(db),
      transaction: db.transaction.bind(db),
    };
    ensureRunnerStateSchema(facade as unknown as Parameters<typeof ensureRunnerStateSchema>[0]);
  } else {
    db.exec(store === 'central' ? CENTRAL_SCHEMA_SQL : store === 'inbound' ? INBOUND_SCHEMA : OUTBOUND_SCHEMA);
  }
  db.pragma('user_version=2');
  db.exec('COMMIT');
  return db;
}

export function put(db: Database.Database, table: string, row: Row): void {
  const columns = Object.keys(row);
  db.prepare(
    `INSERT INTO ${identifier(table)} (${columns.map(identifier).join(',')})
     VALUES (${columns.map(() => '?').join(',')}) ON CONFLICT DO UPDATE SET
     ${columns.map((name) => `${identifier(name)}=excluded.${identifier(name)}`).join(',')}`,
  ).run(...Object.values(row));
}

function normalized(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(normalized).sort().join(',')}]`;
  if (value && typeof value === 'object') {
    return JSON.stringify(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)));
  }
  return JSON.stringify(value);
}

function sameTable(a: Database.Database, b: Database.Database, table: string): void {
  const project = (db: Database.Database) =>
    rows(db, table).map((row) => {
      // The host deliberately stamps receipt time; runner retains transition time.
      if (table === 'processing_ack') {
        const { status_changed: _receivedAt, ...state } = row;
        return state;
      }
      return row;
    });
  if (normalized(project(a)) !== normalized(project(b))) fail(`projections have not converged: ${table}`);
}

function eventPayload(event: EventRow): Row {
  let payload: unknown;
  try {
    payload = JSON.parse(event.payload);
  } catch {
    fail(`invalid JSON event ${event.event_id}`);
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) fail(`invalid event ${event.event_id}`);
  const row = { ...payload } as Row;
  for (const [key, value] of Object.entries(row)) {
    if (typeof value === 'string' && /(?:timestamp|_at|_after|status_changed|^ts)$/.test(key)) {
      const time = Date.parse(value);
      if (!Number.isSafeInteger(time)) fail(`invalid event timestamp ${event.event_id}:${key}`);
      row[key] = time;
    }
  }
  return row;
}

function exactColumns(db: Database.Database, table: string, payload: Row): void {
  const columns = (db.prepare(`PRAGMA table_info(${identifier(table)})`).all() as { name: string }[])
    .map((column) => column.name)
    .sort();
  if (JSON.stringify(columns) !== JSON.stringify(Object.keys(payload).sort())) fail(`unsafe ${table} event shape`);
}

function validMessage(row: Row, direction: 'host' | 'runner' | 'outbound'): void {
  if (
    !Number.isSafeInteger(row.seq) ||
    Number(row.seq) <= 0 ||
    (direction !== 'outbound' && Number(row.seq) % 2 !== (direction === 'host' ? 0 : 1)) ||
    typeof row.id !== 'string' ||
    row.id.length === 0 ||
    row.id.length > 256 ||
    typeof row.kind !== 'string' ||
    row.kind.length === 0 ||
    row.kind.length > 64 ||
    !Number.isSafeInteger(row.timestamp) ||
    typeof row.content !== 'string' ||
    Buffer.byteLength(row.content) > 10485760
  )
    fail(`invalid ${direction} message envelope`);
  if (
    direction === 'host' &&
    (!['pending', 'processing', 'processed', 'completed', 'failed', 'paused'].includes(String(row.status)) ||
      !Number.isSafeInteger(row.tries) ||
      Number(row.tries) < 0 ||
      ![0, 1].includes(Number(row.trigger)) ||
      ![0, 1].includes(Number(row.on_wake)))
  )
    fail('invalid host input state');
  if (direction !== 'host') {
    try {
      const value: unknown = JSON.parse(row.content);
      if (!value || typeof value !== 'object' || Array.isArray(value)) fail('invalid output content');
    } catch (error) {
      if (error instanceof SyntaxError) fail('invalid output JSON');
      throw error;
    }
  }
}

function validateInputState(runner: Database.Database, row: Row): void {
  let input: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(String(row.value));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) fail('invalid input application state');
    input = parsed as Record<string, unknown>;
  } catch (error) {
    if (error instanceof SyntaxError) fail('invalid input application state JSON');
    throw error;
  }
  if (
    Object.keys(input).some(
      (key) => !['messageId', 'status', 'turnId', 'reason', 'timelinePosition', 'queuedForNextTurn'].includes(key),
    ) ||
    typeof input.messageId !== 'string' ||
    !['queued', 'steering', 'applied', 'processing', 'cancelled'].includes(String(input.status)) ||
    row.key !== `input:${crypto.createHash('sha256').update(input.messageId).digest('hex')}` ||
    !runner.prepare('SELECT id FROM messages_in WHERE id=?').get(input.messageId) ||
    (input.turnId !== undefined &&
      (typeof input.turnId !== 'string' || !runner.prepare('SELECT id FROM turns WHERE id=?').get(input.turnId))) ||
    (input.reason !== undefined &&
      !['turn_finished', 'different_conversation', 'unsupported'].includes(String(input.reason))) ||
    (input.queuedForNextTurn !== undefined && typeof input.queuedForNextTurn !== 'boolean')
  )
    fail('unsupported or orphaned input application state');
}

function digest(event: EventRow): string {
  let payload: unknown;
  try {
    payload = JSON.parse(event.payload);
  } catch {
    fail(`invalid JSON event ${event.event_id}`);
  }
  return crypto
    .createHash('sha256')
    .update(JSON.stringify({ type: event.event_type, payload }))
    .digest('hex');
}

function checkSequence(sequence: number, prior: number, id: string, snapshotCoversGaps = false): void {
  if (typeof id !== 'string' || id.length === 0 || id.length > 256) fail('invalid event ID');
  if (!Number.isSafeInteger(sequence) || sequence <= 0) fail(`invalid event sequence ${id}`);
  if (!snapshotCoversGaps && sequence > prior && sequence !== prior + 1) fail(`out-of-order durable event ${id}`);
}

/** Pure projection only: no wake, delivery, approval, provider, or telemetry fallback. */
export function converge(
  inbound: Database.Database,
  outbound: Database.Database,
  runner: Database.Database,
  canonicalHostProjection = false,
): EventProof[] {
  const proofs: EventProof[] = [];
  let floor = Number(rows(runner, 'applied_host_events')[0]?.last_sequence);
  if (!Number.isSafeInteger(floor) || floor < 0) fail('invalid applied_host_events watermark');
  for (const event of rows(inbound, 'pending_host_events').sort(
    (a, b) => Number(a.sequence) - Number(b.sequence),
  ) as EventRow[]) {
    if (
      ![
        'message.upsert',
        'message.delete',
        'sequence.floor',
        'destinations.replace',
        'routing.upsert',
        'fork.upsert',
        'thread-title.upsert',
        'thread-title.delete',
      ].includes(event.event_type)
    )
      fail(`unknown host event ${event.event_type}`);
    checkSequence(event.sequence, floor, event.event_id, canonicalHostProjection);
    const payload = eventPayload(event);
    if (event.sequence > floor) {
      if (event.event_type === 'message.upsert') {
        const hex = payload.content_hex;
        if (typeof hex !== 'string' || !/^(?:[a-fA-F0-9]{2})*$/.test(hex)) fail('unsafe host content_hex');
        delete payload.content_hex;
        payload.content = Buffer.from(hex, 'hex').toString('utf8');
        exactColumns(runner, 'messages_in', payload);
        validMessage(payload, 'host');
        put(runner, 'messages_in', payload);
      } else if (event.event_type === 'message.delete') {
        if (Object.keys(payload).join() !== 'id') fail('unsafe message.delete');
        runner.prepare('DELETE FROM messages_in WHERE id=?').run(payload.id);
      } else if (event.event_type === 'sequence.floor') {
        if (Object.keys(payload).join() !== 'seq' || !Number.isSafeInteger(payload.seq) || Number(payload.seq) < 0) {
          fail('unsafe sequence.floor');
        }
        const prior = runner.prepare("SELECT value FROM host_state WHERE key='sequence_floor'").get() as
          | Row
          | undefined;
        put(runner, 'host_state', {
          key: 'sequence_floor',
          value: String(Math.max(Number(prior?.value ?? 0), Number(payload.seq))),
        });
      } else if (event.event_type === 'thread-title.upsert') {
        exactColumns(runner, 'thread_titles', payload);
        if (
          typeof payload.channel_type !== 'string' ||
          !payload.channel_type ||
          typeof payload.platform_id !== 'string' ||
          typeof payload.thread_id !== 'string' ||
          typeof payload.title !== 'string' ||
          !payload.title ||
          payload.title.length > 60 ||
          typeof payload.source !== 'string' ||
          !payload.source ||
          typeof payload.request_message_id !== 'string' ||
          !payload.request_message_id ||
          ![0, 1].includes(Number(payload.published)) ||
          !Number.isSafeInteger(payload.updated_at)
        )
          fail('invalid thread title event');
        put(runner, 'thread_titles', payload);
      } else {
        fail(`unsupported unacknowledged host event ${event.event_type}; drain online before cutover`);
      }
      floor = event.sequence;
    }
    proofs.push({
      direction: 'host',
      id: event.event_id,
      sequence: event.sequence,
      type: event.event_type,
      digest: digest(event),
    });
  }
  if (canonicalHostProjection) {
    const counter = inbound.prepare("SELECT seq FROM sqlite_sequence WHERE name='pending_host_events'").get() as
      | Row
      | undefined;
    floor = Math.max(floor, Number(counter?.seq ?? 0));
  }
  put(runner, 'applied_host_events', { id: 1, last_sequence: floor });

  let runnerFloor = Number(
    (outbound.prepare('SELECT COALESCE(MAX(sequence),0) AS value FROM applied_runner_events').get() as Row).value,
  );
  for (const event of rows(runner, 'pending_runner_events').sort(
    (a, b) => Number(a.sequence) - Number(b.sequence),
  ) as EventRow[]) {
    if (
      ![
        'message.upsert',
        'processing.upsert',
        'processing.delete',
        'state.upsert',
        'state.delete',
        'turn.upsert',
        'turn-input.upsert',
        'activity.persist',
        'usage.persist',
        'container.upsert',
        'checkpoint.upsert',
        'task-attempt.upsert',
        'batch.persisted',
      ].includes(event.event_type)
    )
      fail(`unknown runner event ${event.event_type}`);
    checkSequence(event.sequence, runnerFloor, event.event_id);
    const hash = digest(event);
    const receipt = outbound.prepare('SELECT * FROM applied_runner_events WHERE event_id=?').get(event.event_id) as
      | Row
      | undefined;
    if (receipt) {
      if (
        receipt.sequence !== event.sequence ||
        receipt.event_type !== event.event_type ||
        receipt.event_digest !== hash
      ) {
        fail(`conflicting durable event replay ${event.event_id}`);
      }
    } else {
      if (event.sequence <= runnerFloor) fail(`missing durable receipt ${event.event_id}`);
      const payload = eventPayload(event);
      const upserts: Record<string, string> = {
        'message.upsert': 'messages_out',
        'processing.upsert': 'processing_ack',
        'state.upsert': 'session_state',
      };
      const table = upserts[event.event_type];
      if (table) {
        if (table === 'session_state' && !String(payload.key).startsWith('input:')) {
          fail(`unsupported unacknowledged state ${payload.key}; provider/edits/metadata require online convergence`);
        }
        exactColumns(outbound, table, payload);
        if (table === 'messages_out') {
          validMessage(payload, 'runner');
          const prior = outbound.prepare('SELECT * FROM messages_out WHERE id=?').get(payload.id);
          const maxOdd = Number(
            (outbound.prepare('SELECT COALESCE(MAX(seq),-1) AS value FROM messages_out WHERE seq%2=1').get() as Row)
              .value,
          );
          const maxObserved = Math.max(
            Number((inbound.prepare('SELECT COALESCE(MAX(seq),0) AS value FROM messages_in').get() as Row).value),
            Number((outbound.prepare('SELECT COALESCE(MAX(seq),0) AS value FROM messages_out').get() as Row).value),
          );
          if (
            prior ||
            !Number.isSafeInteger(payload.seq) ||
            Number(payload.seq) % 2 !== 1 ||
            Number(payload.seq) <= maxOdd ||
            Number(payload.seq) > maxObserved + (maxObserved % 2 ? 2 : 1)
          ) {
            fail('unsafe runner message sequence or duplicate');
          }
          if (payload.turn_id !== null && !outbound.prepare('SELECT id FROM turns WHERE id=?').get(payload.turn_id)) {
            fail('unacknowledged output references unknown turn');
          }
        }
        if (
          table === 'processing_ack' &&
          (!['processing', 'completed', 'failed'].includes(String(payload.status)) ||
            !Number.isSafeInteger(payload.status_changed) ||
            typeof payload.message_id !== 'string')
        )
          fail('invalid processing event');
        if (
          table === 'session_state' &&
          (typeof payload.value !== 'string' ||
            Buffer.byteLength(payload.value) > 1048576 ||
            !Number.isSafeInteger(payload.updated_at))
        )
          fail('invalid input state event');
        if (table === 'session_state') validateInputState(runner, payload);
        put(outbound, table, payload);
      } else if (event.event_type === 'processing.delete' && Object.keys(payload).join() === 'message_id') {
        outbound.prepare('DELETE FROM processing_ack WHERE message_id=?').run(payload.message_id);
      } else if (event.event_type === 'batch.persisted' && Object.keys(payload).length === 0) {
        // This event is a notification barrier, not a persisted state mutation.
      } else {
        fail(`unsupported unacknowledged runner event ${event.event_type}; drain online before cutover`);
      }
      put(outbound, 'applied_runner_events', {
        event_id: event.event_id,
        sequence: event.sequence,
        event_type: event.event_type,
        event_digest: hash,
        applied_at: event.created_at,
      });
      runnerFloor = event.sequence;
    }
    proofs.push({
      direction: 'runner',
      id: event.event_id,
      sequence: event.sequence,
      type: event.event_type,
      digest: hash,
    });
  }
  if (canonicalHostProjection) {
    const hostOutputs = new Set(rows(outbound, 'messages_out').map((row) => row.id));
    if (rows(runner, 'messages_out').some((row) => !hostOutputs.has(row.id) && row.kind !== 'internal'))
      fail('canonical host projection cannot discard runner-only conversation or action outputs');
    const observedMax = Math.max(
      Number((runner.prepare('SELECT COALESCE(MAX(seq),0) AS value FROM messages_out').get() as Row).value),
      Number((outbound.prepare('SELECT COALESCE(MAX(seq),0) AS value FROM messages_out').get() as Row).value),
      Number((inbound.prepare('SELECT COALESCE(MAX(seq),0) AS value FROM messages_in').get() as Row).value),
    );
    for (const db of [outbound, runner]) {
      if (
        rows(db, 'turns').some((row) => row.phase !== 'settled') ||
        rows(db, 'container_state').some((row) => row.current_tool !== null)
      )
        fail('canonical-host projection requires settled, stopped runners');
    }
    const foreignKeys = runner.pragma('foreign_keys', { simple: true });
    runner.pragma('foreign_keys=OFF');
    try {
      runner.transaction(() => {
        for (const [source, names] of [
          [inbound, ['messages_in', 'destinations', 'session_routing', 'fork_origin', 'thread_titles']],
          [
            outbound,
            [
              'messages_out',
              'processing_ack',
              'session_state',
              'container_state',
              'turns',
              'turn_inputs',
              'turn_activity',
              'turn_usage',
              'turn_checkpoints',
              'task_attempts',
            ],
          ],
        ] as [Database.Database, string[]][]) {
          for (const table of names) {
            const authoritative = rows(source, table);
            for (const row of authoritative) exactColumns(runner, table, row);
            if (normalized(authoritative) !== normalized(rows(runner, table)))
              console.error(`Rebuilt operator-approved canonical host projection: ${table}`);
            runner.exec(`DELETE FROM ${identifier(table)}`);
            for (const row of authoritative) put(runner, table, row);
          }
        }
      })();
    } finally {
      runner.pragma(`foreign_keys=${foreignKeys}`);
    }
    if ((runner.pragma('foreign_key_check') as unknown[]).length)
      fail('canonical host projection has dangling references');
    const evenFloor = observedMax % 2 === 0 ? observedMax : observedMax + 1;
    inbound.prepare('UPDATE host_sequence SET last_even=MAX(last_even,?) WHERE id=1').run(evenFloor);
    const previous = runner.prepare("SELECT value FROM host_state WHERE key='sequence_floor'").get() as Row | undefined;
    put(runner, 'host_state', {
      key: 'sequence_floor',
      value: String(Math.max(Number(previous?.value ?? 0), evenFloor)),
    });
  }
  for (const table of ['messages_in', 'destinations', 'session_routing', 'fork_origin', 'thread_titles']) {
    if (table !== 'messages_in') {
      const authoritative = rows(inbound, table);
      if (normalized(authoritative) !== normalized(rows(runner, table))) {
        for (const row of authoritative) exactColumns(runner, table, row);
        runner.exec(`DELETE FROM ${identifier(table)}`);
        for (const row of authoritative) put(runner, table, row);
        console.error(`Reprojected authoritative host table: ${table}`);
      }
    }
    sameTable(inbound, runner, table);
  }
  for (const table of [
    'messages_out',
    'processing_ack',
    'session_state',
    'container_state',
    'turns',
    'turn_inputs',
    'turn_activity',
    'turn_usage',
    'turn_checkpoints',
    'task_attempts',
  ])
    sameTable(outbound, runner, table);
  const lastEven = Number(rows(inbound, 'host_sequence')[0]?.last_even);
  const maxEven = Number((inbound.prepare('SELECT COALESCE(MAX(seq),0) AS value FROM messages_in').get() as Row).value);
  const observedFloor = Number(
    (runner.prepare("SELECT value FROM host_state WHERE key='sequence_floor'").get() as Row | undefined)?.value ?? 0,
  );
  if (
    !Number.isSafeInteger(lastEven) ||
    !Number.isSafeInteger(observedFloor) ||
    lastEven < maxEven ||
    lastEven % 2 !== 0 ||
    observedFloor < lastEven
  )
    fail('sequence floors have not converged');
  for (const row of rows(inbound, 'messages_in')) validMessage(row, 'host');
  for (const row of rows(outbound, 'messages_out')) validMessage(row, 'outbound');
  for (const row of rows(runner, 'session_state').filter((row) => String(row.key).startsWith('input:')))
    validateInputState(runner, row);
  if (rows(runner, 'turns').some((row) => row.phase !== 'settled'))
    fail('unsettled turn requires online recovery/settlement before cutover');
  if (rows(runner, 'container_state').some((row) => row.current_tool !== null))
    fail('tool-in-flight state requires online recovery before cutover');
  let clock = Number(rows(runner, 'timeline_clock')[0]?.position);
  const positions = [
    ...rows(runner, 'messages_out').map((row) => {
      try {
        return (JSON.parse(String(row.content)) as { timelinePosition?: unknown }).timelinePosition;
      } catch {
        return undefined;
      }
    }),
    ...rows(runner, 'session_state')
      .filter((row) => String(row.key).startsWith('input:'))
      .map((row) => {
        try {
          return (JSON.parse(String(row.value)) as { timelinePosition?: unknown }).timelinePosition;
        } catch {
          return undefined;
        }
      }),
    ...rows(runner, 'turn_activity').map((row) => row.timeline_position),
  ].filter((position) => position !== undefined && position !== null);
  if (
    canonicalHostProjection &&
    Number.isSafeInteger(clock) &&
    clock >= 0 &&
    positions.every((position) => typeof position === 'number' && Number.isSafeInteger(position) && position > 0)
  ) {
    clock = positions.reduce<number>((maximum, position) => Math.max(maximum, Number(position)), clock);
    runner.prepare('UPDATE timeline_clock SET position=? WHERE id=1').run(clock);
  }
  if (
    !Number.isSafeInteger(clock) ||
    clock < 0 ||
    positions.some(
      (position) => typeof position !== 'number' || !Number.isSafeInteger(position) || position < 1 || position > clock,
    )
  )
    fail('timeline clock is missing/regressed; cannot invent positions');
  inbound.exec('DELETE FROM pending_host_events');
  runner.exec('DELETE FROM pending_runner_events');
  return proofs;
}

/** Fresh canonical tables, never the source's old CHECK clauses or triggers. */
export function canonicalCopy(source: Database.Database, store: Store, filename = ':memory:'): Database.Database {
  const target = createTarget(store, filename);
  const triggerSql = (
    target.prepare("SELECT sql FROM sqlite_master WHERE type='trigger'").all() as { sql: string }[]
  ).map((row) => row.sql);
  dropTriggers(target);
  const names = tables(target);
  for (const name of tables(source))
    if (!names.includes(name)) fail(`unknown ${store} table ${name}; explicit converter required`);
  target.pragma('foreign_keys=OFF');
  target.exec('BEGIN');
  for (const name of names) target.exec(`DELETE FROM ${identifier(name)}`);
  const remaining = new Set(names);
  while (remaining.size) {
    let progressed = false;
    for (const name of remaining) {
      const dependencies = (target.prepare(`PRAGMA foreign_key_list(${identifier(name)})`).all() as { table: string }[])
        .map((row) => row.table)
        .filter((dependency) => dependency !== name);
      if (dependencies.some((dependency) => remaining.has(dependency))) continue;
      for (const row of tables(source).includes(name) ? rows(source, name) : []) {
        if (name === 'interactions') {
          delete row.message_out_id;
          delete row.in_reply_to;
        }
        const columns = Object.keys(row);
        target
          .prepare(
            `INSERT INTO ${identifier(name)} (${columns.map(identifier).join(',')})
          VALUES (${columns.map(() => '?').join(',')})`,
          )
          .run(...Object.values(row));
      }
      remaining.delete(name);
      progressed = true;
    }
    if (!progressed) fail(`cyclic canonical foreign key dependencies: ${[...remaining].join(',')}`);
  }
  // AUTOINCREMENT clocks must not regress after converged queues are emptied.
  if (source.prepare("SELECT 1 FROM sqlite_master WHERE name='sqlite_sequence'").get()) {
    for (const row of rows(source, 'sqlite_sequence')) {
      target.prepare('DELETE FROM sqlite_sequence WHERE name=?').run(row.name);
      target.prepare('INSERT INTO sqlite_sequence(name,seq) VALUES (?,?)').run(row.name, row.seq);
    }
  }
  target.exec('COMMIT');
  target.pragma('foreign_keys=ON');
  if ((target.pragma('foreign_key_check') as unknown[]).length) fail(`${store}: converted foreign keys invalid`);
  target.transaction(() => {
    for (const sql of triggerSql) target.exec(sql);
  })();
  if (target.pragma('integrity_check', { simple: true }) !== 'ok') fail(`${store}: target integrity check failed`);
  return target;
}
