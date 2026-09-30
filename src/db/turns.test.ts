import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { inputStateKey } from '../input-timeline.js';
import { OUTBOUND_SCHEMA } from './schema.js';
import { ensureSchema } from './session-db.js';
import {
  backfillTurns,
  getTurn,
  getTurnAssociations,
  getTurnInputs,
  historicalTurnId,
  linkTurnRecord,
  migrateTurnSchema,
  TURN_SCHEMA,
  TURN_ACTIVITY_SCHEMA,
  TURN_INDEX_SCHEMA,
} from './turns.js';

const opened: Database.Database[] = [];
const testDir = path.join(process.cwd(), '.test-conversation-turn-schema');
afterEach(() => {
  opened.splice(0).forEach((db) => db.close());
  fs.rmSync(testDir, { recursive: true, force: true });
});

function legacy(): Database.Database {
  const db = new Database(':memory:');
  opened.push(db);
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE messages_out (id TEXT PRIMARY KEY, content TEXT NOT NULL, in_reply_to TEXT, timestamp TEXT NOT NULL);
    CREATE TABLE turn_usage (id TEXT PRIMARY KEY, message_out_id TEXT, cost_usd REAL, input_tokens INTEGER, timestamp TEXT);
    CREATE TABLE turn_activity (message_out_id TEXT NOT NULL, ordinal INTEGER NOT NULL, ts TEXT NOT NULL, text TEXT NOT NULL,
      PRIMARY KEY (message_out_id, ordinal));
    CREATE TABLE session_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE journal (value TEXT);
    CREATE TRIGGER activity_updated AFTER UPDATE ON turn_activity BEGIN INSERT INTO journal VALUES (NEW.text); END;
    CREATE TRIGGER usage_updated AFTER UPDATE ON turn_usage BEGIN INSERT INTO journal VALUES (NEW.id); END;
  `);
  return db;
}

const evidence = [
  {
    id: 'input',
    channel_type: 'web',
    platform_id: 'chat',
    thread_id: 'thread',
    source_session_id: null,
  },
];

function seed(db: Database.Database): void {
  for (const [id, content, reply] of [
    ['one', '{"turn_id":"explicit","text":"one"}', 'input'],
    ['two', '{"turn_id":"explicit","text":"two"}', null],
    ['three', 'not json', 'missing'],
    ['four', '{"turn_id":42}', null],
  ]) {
    db.prepare('INSERT INTO messages_out VALUES (?, ?, ?, ?)').run(id, content, reply, 'same timestamp');
  }
  db.exec(`
    INSERT INTO turn_usage VALUES ('u1', 'one', 0.25, 10, 'same timestamp');
    INSERT INTO turn_usage VALUES ('u2', 'two', 0.50, 20, 'same timestamp');
    INSERT INTO turn_usage VALUES ('u3', NULL, 1.00, 30, 'same timestamp');
    INSERT INTO turn_usage VALUES ('u4', 'missing', 2.00, 40, 'same timestamp');
    INSERT INTO turn_activity VALUES ('one', 0, 'same timestamp', 'first');
    INSERT INTO turn_activity VALUES ('two', 0, 'same timestamp', 'second');
    INSERT INTO turn_activity VALUES ('missing', 0, 'same timestamp', 'orphan');
  `);
}

function originalRows(db: Database.Database, table: string) {
  return (db.prepare(`SELECT * FROM ${table}`).all() as Array<Record<string, unknown>>).map(
    ({ turn_id: _turnId, ...row }) => row,
  );
}

describe('durable turn migration', () => {
  it('keeps host and runner SQL contracts identical without cross-runtime imports', () => {
    const runner = fs.readFileSync(path.join(process.cwd(), 'container/agent-runner/src/db/turns.ts'), 'utf8');
    for (const [name, sql] of Object.entries({ TURN_SCHEMA, TURN_ACTIVITY_SCHEMA, TURN_INDEX_SCHEMA })) {
      expect(runner.match(new RegExp('export const ' + name + ' = `([\\s\\S]*?)`;'))?.[1]).toBe(sql);
    }
  });

  it('does not migrate or backfill existing files from ensureSchema', async () => {
    const db = legacy();
    seed(db);
    fs.mkdirSync(testDir, { recursive: true });
    const file = path.join(testDir, 'outbound.db');
    await db.backup(file);
    ensureSchema(file, 'outbound');
    const reopened = new Database(file);
    opened.push(reopened);
    expect(reopened.prepare("SELECT name FROM sqlite_master WHERE name = 'turns'").all()).toEqual([]);
    expect(
      (reopened.prepare('PRAGMA table_info(messages_out)').all() as Array<{ name: string }>).some(
        (r) => r.name === 'turn_id',
      ),
    ).toBe(false);
  });

  it('backfills deterministically without changing existing IDs, accounting, activity or journals; reruns are no-ops', () => {
    const db = legacy();
    seed(db);
    const before = ['messages_out', 'turn_usage', 'turn_activity'].map((table) => originalRows(db, table));
    const triggers = db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'trigger' ORDER BY name").all();
    backfillTurns(db, evidence);
    const after = db.prepare('SELECT * FROM turns ORDER BY id').all();
    migrateTurnSchema(db);
    backfillTurns(db, evidence);
    expect(db.prepare('SELECT * FROM turns ORDER BY id').all()).toEqual(after);
    expect(after).toHaveLength(3);
    expect(['messages_out', 'turn_usage', 'turn_activity'].map((table) => originalRows(db, table))).toEqual(before);
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
    expect(getTurnInputs(db, 'explicit')).toEqual([
      { turn_id: 'explicit', message_in_id: 'input', association: 'reply' },
    ]);
    expect(getTurn(db, historicalTurnId('three'))?.origin_channel_type).toBeNull();
    expect(getTurn(db, historicalTurnId('four'))).toBeDefined();
    expect(db.prepare('SELECT * FROM journal').all()).toEqual([]);
    expect(db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'trigger' ORDER BY name").all()).toEqual(
      triggers,
    );
    expect(db.pragma('foreign_key_check')).toEqual([]);
    expect(db.pragma('quick_check')).toEqual([{ quick_check: 'ok' }]);
  });

  it('uses only applied input receipts, not requested/queued turn targets or timestamps', () => {
    const db = legacy();
    const inputs = ['input', 'queued', 'steering', 'processing', 'cancelled'].map((id) => ({ ...evidence[0], id }));
    for (const input of inputs) {
      db.prepare('INSERT INTO session_state VALUES (?, ?)').run(
        inputStateKey(input.id),
        JSON.stringify({
          messageId: input.id,
          status: input.id === 'input' ? 'applied' : input.id,
          turnId: `turn-${input.id}`,
        }),
      );
    }
    db.prepare('INSERT INTO session_state VALUES (?, ?)').run(
      'input:forged',
      JSON.stringify({
        messageId: 'input',
        status: 'applied',
        turnId: 'forged',
      }),
    );
    db.prepare('INSERT INTO session_state VALUES (?, ?)').run('input:invalid', '{bad');
    backfillTurns(db, inputs);
    expect(db.prepare('SELECT id FROM turns').all()).toEqual([{ id: 'turn-input' }]);
    expect(getTurnInputs(db, 'turn-input')[0].association).toBe('applied');
    expect(getTurn(db, 'turn-input')?.outcome).toBe('unknown');
  });

  it('does not merge a generated historical ID with a conflicting explicit ID', () => {
    const db = legacy();
    db.prepare("INSERT INTO messages_out VALUES ('one', '{}', NULL, 'now')").run();
    db.prepare("INSERT INTO messages_out VALUES ('two', ?, NULL, 'now')").run(
      JSON.stringify({ turn_id: historicalTurnId('one') }),
    );
    backfillTurns(db);
    expect(db.prepare('SELECT id, turn_id FROM messages_out ORDER BY id').all()).toEqual([
      { id: 'one', turn_id: `${historicalTurnId('one')}:1` },
      { id: 'two', turn_id: historicalTurnId('one') },
    ]);
  });

  it('leaves conflicting origin routes unknown rather than picking a destination', () => {
    const db = legacy();
    seed(db);
    db.exec("UPDATE messages_out SET in_reply_to = 'other' WHERE id = 'two'");
    backfillTurns(db, [...evidence, { ...evidence[0], id: 'other', thread_id: 'other-thread' }]);
    expect(getTurn(db, 'explicit')?.origin_thread_id).toBeNull();
    expect(getTurnInputs(db, 'explicit')).toHaveLength(2);
  });

  it('rolls back schema, data, markers and trigger changes when a backfill fails', () => {
    const db = legacy();
    seed(db);
    db.exec(`${TURN_SCHEMA}
      CREATE TRIGGER reject_import BEFORE INSERT ON turns BEGIN SELECT RAISE(ABORT, 'reject import'); END;`);
    const before = db
      .prepare("SELECT name, sql FROM sqlite_master WHERE type IN ('table', 'trigger', 'index') ORDER BY name")
      .all();
    expect(() => backfillTurns(db, evidence)).toThrow('reject import');
    expect(
      db.prepare("SELECT name, sql FROM sqlite_master WHERE type IN ('table', 'trigger', 'index') ORDER BY name").all(),
    ).toEqual(before);
    expect(db.prepare('SELECT * FROM conversation_sync_migrations').all()).toEqual([]);
    expect(db.prepare('SELECT * FROM journal').all()).toEqual([]);
    db.exec('DROP TRIGGER reject_import');
    backfillTurns(db, evidence);
    expect(getTurn(db, 'explicit')).toBeDefined();
  });

  it('supports the fresh schema and unanchored activity without allowing duplicate turn ordinals', () => {
    const db = new Database(':memory:');
    opened.push(db);
    db.pragma('foreign_keys = ON');
    db.exec(OUTBOUND_SCHEMA);
    migrateTurnSchema(db);
    backfillTurns(db);
    expect(db.prepare('SELECT * FROM turns').all()).toEqual([]);
    db.exec(`INSERT INTO turns (id, phase, outcome, provenance) VALUES ('silent', 'settled', 'silent', 'native');
      INSERT INTO turn_activity (turn_id, ordinal, ts, text) VALUES ('silent', 0, 'now', 'activity');
      INSERT INTO turn_usage (id, turn_id, cost_usd) VALUES ('usage', 'silent', 0.2);`);
    expect(() =>
      db.exec("INSERT INTO turn_activity (turn_id, ordinal, ts, text) VALUES ('silent', 0, 'now', 'duplicate')"),
    ).toThrow();
    expect(() => db.exec("INSERT INTO turn_activity (ordinal, ts, text) VALUES (1, 'now', 'unassociated')")).toThrow();
    expect(db.pragma('foreign_key_check')).toEqual([]);
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
