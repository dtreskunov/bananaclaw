import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TURN_SCHEMA } from '../src/db/turns.js';
import { inputStateKey } from '../src/input-timeline.js';
import { applyActivityOrder, hasStrictActivityOrder, planActivityOrder } from './activity-order-migration.js';

let root: string;
let inbound: Database.Database;
let outbound: Database.Database;
let runner: Database.Database;
const at = '2026-09-01T00:00:00.000Z';
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-order-migration-'));
  inbound = new Database(path.join(root, 'inbound.db'));
  outbound = new Database(path.join(root, 'outbound.db'));
  runner = new Database(path.join(root, 'runner.db'));
  inbound.exec(`CREATE TABLE messages_in (id TEXT PRIMARY KEY,seq INTEGER,timestamp TEXT,status TEXT);
    INSERT INTO messages_in VALUES ('ask',2,'${at}','completed'),('queued',6,'${at}','pending');`);
  for (const db of [outbound, runner]) {
    db.exec(`${TURN_SCHEMA}
      CREATE TABLE turn_activity (message_out_id TEXT,ordinal INTEGER,ts TEXT,text TEXT,turn_id TEXT,
        PRIMARY KEY(message_out_id,ordinal));
      CREATE TABLE messages_out (id TEXT PRIMARY KEY,seq INTEGER,timestamp TEXT,content TEXT);
      CREATE TABLE session_state (key TEXT PRIMARY KEY,value TEXT,updated_at TEXT);
      CREATE TABLE timeline_clock (id INTEGER PRIMARY KEY,position INTEGER);
      CREATE TABLE pending_runner_events (sequence INTEGER PRIMARY KEY AUTOINCREMENT,event_id TEXT,event_type TEXT,payload TEXT,created_at TEXT);
      INSERT INTO timeline_clock VALUES (1,102);
      INSERT INTO turns(id,phase,outcome,provenance) VALUES ('turn','settled','replied','native');
      INSERT INTO turn_inputs VALUES ('turn','ask','consumed');
      INSERT INTO messages_out VALUES ('early',1,'${at}','{"text":"early","timelinePosition":101}'),
        ('final',3,'${at}','{"text":"final","timelinePosition":102}');
      INSERT INTO turn_activity VALUES ('early',0,'backwards','first','turn'),('final',1,'not-a-time','second','turn');
      INSERT INTO session_state VALUES ('continuation:native','private-continuation','${at}');`);
    db.prepare('INSERT INTO session_state VALUES (?,?,?)').run(
      inputStateKey('ask'),
      JSON.stringify({ messageId: 'ask', status: 'processing', timelinePosition: 100 }),
      at,
    );
    db.prepare('INSERT INTO session_state VALUES (?,?,?)').run(
      inputStateKey('queued'),
      JSON.stringify({ messageId: 'queued', status: 'queued', queuedForNextTurn: true }),
      at,
    );
  }
  runner.exec(`CREATE TRIGGER journal_turn_activity_insert AFTER INSERT ON turn_activity BEGIN
    INSERT INTO pending_runner_events(event_id,event_type,payload,created_at) VALUES(
      'event','activity.persist',json_object('message_out_id',NEW.message_out_id,'ordinal',NEW.ordinal,
      'ts',NEW.ts,'text',NEW.text,'turn_id',NEW.turn_id),'${at}'); END;`);
});
afterEach(() => {
  inbound.close();
  outbound.close();
  runner.close();
  fs.rmSync(root, { recursive: true, force: true });
});
const migrate = () => {
  const plan = planActivityOrder(inbound, outbound, runner);
  applyActivityOrder(path.join(root, 'outbound.db'), path.join(root, 'runner.db'), plan);
  return plan;
};

describe('offline canonical activity order', () => {
  it('preserves saved associations and ordinals without reading activity timestamps, and upgrades both copies', () => {
    const plan = migrate();
    expect(plan.needed).toBe(true);
    for (const db of [outbound, runner]) {
      expect(hasStrictActivityOrder(db)).toBe(true);
      const rows = db.prepare('SELECT * FROM turn_activity ORDER BY ordinal').all() as Array<{
        timeline_position: number;
      }>;
      expect(rows).toMatchObject([
        { message_out_id: 'early', ordinal: 0, ts: 'backwards', text: 'first', timeline_position: 101 },
        { message_out_id: 'final', ordinal: 1, ts: 'not-a-time', text: 'second', timeline_position: 103 },
      ]);
      expect(
        JSON.parse(db.prepare("SELECT content FROM messages_out WHERE id='early'").pluck().get() as string),
      ).toEqual({ text: 'early', timelinePosition: 102 });
      expect(
        JSON.parse(db.prepare("SELECT content FROM messages_out WHERE id='final'").pluck().get() as string),
      ).toEqual({ text: 'final', timelinePosition: 104 });
      expect(db.prepare("SELECT value FROM session_state WHERE key='continuation:native'").pluck().get()).toBe(
        'private-continuation',
      );
      expect(
        JSON.parse(
          db.prepare('SELECT value FROM session_state WHERE key=?').pluck().get(inputStateKey('queued')) as string,
        ),
      ).not.toHaveProperty('timelinePosition');
      expect(db.pragma('integrity_check', { simple: true })).toBe('ok');
    }
    expect(runner.prepare('SELECT COUNT(*) FROM pending_runner_events').pluck().get()).toBe(0);
    expect(runner.prepare('SELECT position FROM timeline_clock').pluck().get()).toBe(104);
    runner.exec("INSERT INTO turn_activity VALUES ('final',2,'display-time','new','turn',105)");
    expect(
      JSON.parse(runner.prepare('SELECT payload FROM pending_runner_events').pluck().get() as string).timeline_position,
    ).toBe(105);
  });

  it('creates enough room in an adjacent message-clock gap without dropping or changing any activity', () => {
    for (const db of [outbound, runner]) {
      if (db === runner) db.exec('DROP TRIGGER journal_turn_activity_insert');
      db.exec('DELETE FROM turn_activity');
      const insert = db.prepare('INSERT INTO turn_activity VALUES (?,?,?,?,?)');
      for (let ordinal = 0; ordinal < 20; ordinal++)
        insert.run('final', ordinal, String(20 - ordinal), `step ${ordinal}`, 'turn');
    }
    migrate();
    const positions = outbound.prepare('SELECT timeline_position FROM turn_activity ORDER BY ordinal').pluck().all();
    expect(positions).toEqual(Array.from({ length: 20 }, (_, i) => 102 + i));
    expect(
      JSON.parse(outbound.prepare("SELECT content FROM messages_out WHERE id='final'").pluck().get() as string)
        .timelinePosition,
    ).toBe(122);
  });

  it('places an outputless trace after its consumed input and backfills missing input receipts once', () => {
    for (const db of [outbound, runner]) {
      if (db === runner) db.exec('DROP TRIGGER journal_turn_activity_insert');
      db.exec("DELETE FROM messages_out; DELETE FROM turn_activity; UPDATE turns SET outcome='silent';");
      db.prepare('DELETE FROM session_state WHERE key=?').run(inputStateKey('ask'));
      db.exec("INSERT INTO turn_activity VALUES (NULL,0,'unknown','silent work','turn')");
    }
    migrate();
    const input = JSON.parse(
      outbound.prepare('SELECT value FROM session_state WHERE key=?').pluck().get(inputStateKey('ask')) as string,
    );
    expect(outbound.prepare('SELECT timeline_position FROM turn_activity').pluck().get()).toBe(
      input.timelinePosition + 1,
    );
    expect(input.status).toBe('processing');
  });

  it('retains already-recorded activity placement even when its saved output was reanchored', () => {
    for (const db of [outbound, runner]) {
      if (db === runner) db.exec('DROP TRIGGER journal_turn_activity_insert');
      db.exec(`ALTER TABLE turn_activity ADD COLUMN timeline_position INTEGER;
        UPDATE turn_activity SET message_out_id='final',timeline_position=CASE ordinal WHEN 0 THEN 100 ELSE 103 END;`);
    }
    migrate();
    const rows = outbound
      .prepare('SELECT timeline_position FROM turn_activity ORDER BY ordinal')
      .pluck()
      .all() as number[];
    const early = JSON.parse(
      outbound.prepare("SELECT content FROM messages_out WHERE id='early'").pluck().get() as string,
    ).timelinePosition;
    expect(rows[0]).toBeLessThan(early);
    expect(rows[1]).toBeGreaterThan(early);
  });

  it('refuses a nonempty journal or unfinished turn without modifying schemas', () => {
    runner.exec("INSERT INTO pending_runner_events(event_type,payload) VALUES ('activity.persist','{}')");
    expect(() => planActivityOrder(inbound, outbound, runner)).toThrow('Drain the runner journal');
    runner.exec("DELETE FROM pending_runner_events; UPDATE turns SET phase='running'");
    expect(() => planActivityOrder(inbound, outbound, runner)).toThrow('Finish all active turns');
    expect(hasStrictActivityOrder(outbound)).toBe(false);
    expect(hasStrictActivityOrder(runner)).toBe(false);
  });

  it('rolls back both database copies when a trigger cannot be converted', () => {
    const plan = planActivityOrder(inbound, outbound, runner);
    runner.exec(`DROP TRIGGER journal_turn_activity_insert;
      CREATE TRIGGER journal_turn_activity_insert AFTER INSERT ON turn_activity BEGIN
        INSERT INTO pending_runner_events(payload) VALUES ('{}'); END;`);
    expect(() => applyActivityOrder(path.join(root, 'outbound.db'), path.join(root, 'runner.db'), plan))
      .toThrow('Unrecognized activity journal trigger');
    expect(hasStrictActivityOrder(outbound)).toBe(false);
    expect(hasStrictActivityOrder(runner)).toBe(false);
    expect(
      JSON.parse(outbound.prepare("SELECT content FROM messages_out WHERE id='final'").pluck().get() as string)
        .timelinePosition,
    ).toBe(102);
  });

  it('does not rewrite canonical databases on a repeat run', () => {
    migrate();
    const before = fs.readFileSync(path.join(root, 'outbound.db'));
    expect(migrate().needed).toBe(false);
    expect(fs.readFileSync(path.join(root, 'outbound.db'))).toEqual(before);
  });

  it('never decreases an existing runner clock floor during conversion', () => {
    runner.exec('UPDATE timeline_clock SET position=200 WHERE id=1');
    migrate();
    expect(runner.prepare('SELECT position FROM timeline_clock').pluck().get()).toBe(200);
  });

  it('normalizes explicitly recorded numeric message times once, without changing display timestamps', () => {
    inbound.prepare("UPDATE messages_in SET timestamp=? WHERE id='ask'").run(String(Date.parse(at)) + '.0');
    for (const db of [outbound, runner]) db.prepare('DELETE FROM session_state WHERE key=?').run(inputStateKey('ask'));
    const plan = planActivityOrder(inbound, outbound, runner);
    expect(plan.normalizedMessageTimestamps).toBe(1);
    expect(inbound.prepare("SELECT timestamp FROM messages_in WHERE id='ask'").pluck().get()).toBe(
      String(Date.parse(at)) + '.0',
    );
  });
});
