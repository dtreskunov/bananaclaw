import { Database } from 'bun:sqlite';
import { afterEach, describe, expect, it } from 'bun:test';
import { createHash } from 'node:crypto';

import { ensureRunnerStateSchema } from './runner-state.js';
import {
  backfillTurns,
  getTurn,
  getTurnAssociations,
  getTurnInputs,
  historicalTurnId,
  linkTurnRecord,
  migrateTurnSchema,
  TURN_SCHEMA,
} from './turns.js';

const opened: Database[] = [];
afterEach(() => opened.splice(0).forEach((db) => db.close()));

function legacy(): Database {
  const db = new Database(':memory:');
  opened.push(db);
  db.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE messages_out (
      id TEXT PRIMARY KEY, seq INTEGER, in_reply_to TEXT, timestamp TEXT, deliver_after TEXT, recurrence TEXT,
      kind TEXT, platform_id TEXT, channel_type TEXT, thread_id TEXT, content TEXT NOT NULL
    );
    CREATE TABLE turn_usage (
      id TEXT PRIMARY KEY, message_out_id TEXT, cost_usd REAL, input_tokens INTEGER, output_tokens INTEGER,
      cache_read_tokens INTEGER, cache_write_tokens INTEGER, reasoning_tokens INTEGER,
      num_turns INTEGER, duration_ms INTEGER, duration_api_ms INTEGER, model TEXT,
      context_window INTEGER, max_output_tokens INTEGER, context_tokens INTEGER, timestamp TEXT
    );
    CREATE TABLE turn_activity (message_out_id TEXT NOT NULL, ordinal INTEGER NOT NULL, ts TEXT NOT NULL, text TEXT NOT NULL,
      PRIMARY KEY (message_out_id, ordinal));
  `);
  ensureRunnerStateSchema(db);
  return db;
}

function seed(db: Database): void {
  db.exec(`
    INSERT INTO messages_in (id, seq, kind, timestamp, channel_type, platform_id, thread_id, content)
      VALUES ('input', 2, 'chat', 'same timestamp', 'web', 'chat', 'thread', '{}');
    INSERT INTO messages_in (id, seq, kind, timestamp, content) VALUES ('steer', 4, 'chat', 'same timestamp', '{}');
  `);
  for (const [id, content, reply] of [
    ['one', '{"turn_id":"explicit","text":"one"}', 'input'],
    ['two', '{"turn_id":"explicit","text":"two"}', null],
    ['three', 'not json', null],
    ['four', '{"turn_id":42}', null],
  ]) {
    db.prepare('INSERT INTO messages_out (id, content, in_reply_to, timestamp) VALUES (?, ?, ?, ?)').run(
      id,
      content,
      reply,
      'same timestamp',
    );
  }
  db.exec(`
    INSERT INTO turn_usage (id, message_out_id, cost_usd, input_tokens, timestamp) VALUES ('u1', 'one', 0.25, 10, 'same timestamp');
    INSERT INTO turn_usage (id, message_out_id, cost_usd, input_tokens, timestamp) VALUES ('u2', 'two', 0.50, 20, 'same timestamp');
    INSERT INTO turn_usage (id, message_out_id, cost_usd, input_tokens, timestamp) VALUES ('u3', NULL, 1.00, 30, 'same timestamp');
    INSERT INTO turn_usage (id, message_out_id, cost_usd, input_tokens, timestamp) VALUES ('u4', 'missing', 2.00, 40, 'same timestamp');
    INSERT INTO turn_activity VALUES ('one', 0, 'same timestamp', 'first');
    INSERT INTO turn_activity VALUES ('two', 0, 'same timestamp', 'second');
    INSERT INTO turn_activity VALUES ('missing', 0, 'same timestamp', 'orphan');
  `);
}

function receipt(db: Database, status: string) {
  db.prepare('INSERT INTO session_state VALUES (?, ?, ?)').run(
    `input:${createHash('sha256').update('steer').digest('hex')}`,
    JSON.stringify({ messageId: 'steer', status, turnId: 'steered-turn' }),
    'now',
  );
}

function originalRows(db: Database, table: string) {
  return (db.prepare(`SELECT * FROM ${table}`).all() as Array<Record<string, unknown>>).map(
    ({ turn_id: _turnId, ...row }) => row,
  );
}

describe('runner durable turns', () => {
  it('does not implicitly migrate or backfill an existing DB on runtime open', () => {
    const db = legacy();
    seed(db);
    ensureRunnerStateSchema(db);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'turns'").all()).toEqual([]);
    expect(
      (db.prepare('PRAGMA table_info(messages_out)').all() as Array<{ name: string }>).some(
        (r) => r.name === 'turn_id',
      ),
    ).toBe(false);
  });

  it('backfills explicit IDs and message anchors, preserving original records, totals and pending events on reruns', () => {
    const db = legacy();
    seed(db);
    receipt(db, 'applied');
    const before = ['messages_out', 'turn_usage', 'turn_activity', 'pending_runner_events'].map((t) =>
      originalRows(db, t),
    );
    const triggers = db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'trigger' ORDER BY name").all();
    backfillTurns(db);
    const turns = db.prepare('SELECT * FROM turns ORDER BY id').all();
    migrateTurnSchema(db);
    ensureRunnerStateSchema(db);
    backfillTurns(db);
    expect(db.prepare('SELECT * FROM turns ORDER BY id').all()).toEqual(turns);
    expect(turns).toHaveLength(4);
    expect(
      ['messages_out', 'turn_usage', 'turn_activity', 'pending_runner_events'].map((t) => originalRows(db, t)),
    ).toEqual(before);
    expect(db.prepare('SELECT sum(cost_usd) AS cost, sum(input_tokens) AS tokens FROM turn_usage').get()).toEqual({
      cost: 3.75,
      tokens: 100,
    });
    expect(db.prepare('SELECT id, turn_id FROM turn_usage ORDER BY id').all()).toEqual([
      { id: 'u1', turn_id: 'explicit' },
      { id: 'u2', turn_id: 'explicit' },
      { id: 'u3', turn_id: null },
      { id: 'u4', turn_id: null },
    ]);
    expect(getTurn(db, 'explicit')).toMatchObject({
      phase: 'settled',
      outcome: 'unknown',
      started_at: null,
      ended_at: null,
      provenance: 'backfill',
      origin_channel_type: 'web',
      origin_platform_id: 'chat',
      origin_thread_id: 'thread',
    });
    expect(getTurn(db, historicalTurnId('three'))).toBeDefined();
    expect(getTurn(db, historicalTurnId('four'))).toBeDefined();
    expect(getTurnInputs(db, 'steered-turn')).toEqual([
      { turn_id: 'steered-turn', message_in_id: 'steer', association: 'applied' },
    ]);
    expect(db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'trigger' ORDER BY name").all()).toEqual(
      triggers,
    );
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    expect(db.prepare('PRAGMA quick_check').all()).toEqual([{ quick_check: 'ok' }]);
    // Existing protocol triggers still work after the rebuild, with no payload changes.
    db.prepare("UPDATE turn_activity SET text = 'updated' WHERE message_out_id = 'one'").run();
    expect(db.prepare('SELECT event_type FROM pending_runner_events ORDER BY sequence DESC LIMIT 1').get()).toEqual({
      event_type: 'activity.persist',
    });
  });

  it.each(['queued', 'steering', 'processing', 'cancelled'])(
    'does not treat %s receipts as consumed-input evidence',
    (status) => {
      const db = legacy();
      seed(db);
      receipt(db, status);
      backfillTurns(db);
      expect(getTurn(db, 'steered-turn')).toBeUndefined();
      expect(db.prepare("SELECT * FROM turn_inputs WHERE message_in_id = 'steer'").all()).toEqual([]);
    },
  );

  it('rolls back failed schema/backfill updates including journals and restored triggers', () => {
    const db = legacy();
    seed(db);
    db.exec(`${TURN_SCHEMA}
      CREATE TRIGGER reject_import BEFORE INSERT ON turns BEGIN SELECT RAISE(ABORT, 'reject import'); END;`);
    const before = db
      .prepare("SELECT name, sql FROM sqlite_master WHERE type IN ('table', 'trigger', 'index') ORDER BY name")
      .all();
    const events = db.prepare('SELECT * FROM pending_runner_events').all();
    expect(() => backfillTurns(db)).toThrow('reject import');
    expect(
      db.prepare("SELECT name, sql FROM sqlite_master WHERE type IN ('table', 'trigger', 'index') ORDER BY name").all(),
    ).toEqual(before);
    expect(db.prepare('SELECT * FROM pending_runner_events').all()).toEqual(events);
    expect(db.prepare('SELECT * FROM conversation_sync_migrations').all()).toEqual([]);
    db.exec('DROP TRIGGER reject_import');
    backfillTurns(db);
    expect(getTurn(db, 'explicit')).toBeDefined();
  });

  it('creates the fresh schema and stores usage/activity without a reply, with unique per-turn activity ordinals', () => {
    const db = new Database(':memory:');
    opened.push(db);
    db.exec('PRAGMA foreign_keys = ON');
    ensureRunnerStateSchema(db);
    migrateTurnSchema(db);
    backfillTurns(db);
    db.exec(`INSERT INTO turns (id, phase, outcome, provenance) VALUES ('silent', 'settled', 'silent', 'native');
      INSERT INTO turn_activity (turn_id, ordinal, ts, text) VALUES ('silent', 0, 'now', 'activity');
      INSERT INTO turn_usage (id, turn_id, cost_usd) VALUES ('usage', 'silent', 0.2);`);
    expect(() =>
      db.exec("INSERT INTO turn_activity (turn_id, ordinal, ts, text) VALUES ('silent', 0, 'now', 'duplicate')"),
    ).toThrow();
    expect(() => db.exec("INSERT INTO turn_activity (ordinal, ts, text) VALUES (1, 'now', 'unassociated')")).toThrow();
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    expect(getTurnAssociations(db, 'silent')).toEqual({
      inputs: [],
      outputIds: [],
      usageIds: ['usage'],
      activity: [{ message_out_id: null, ordinal: 0 }],
    });
    expect(() => linkTurnRecord(db, 'missing', { table: 'turn_usage', id: 'usage' })).toThrow('Unknown turn');
    db.exec("INSERT INTO turns (id, phase, outcome, provenance) VALUES ('other', 'settled', 'unknown', 'native')");
    expect(() => linkTurnRecord(db, 'other', { table: 'turn_usage', id: 'usage' })).toThrow('already belongs');
  });
});
