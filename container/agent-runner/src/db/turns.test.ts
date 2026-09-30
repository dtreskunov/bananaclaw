import { Database } from 'bun:sqlite';
import { afterEach, describe, expect, it } from 'bun:test';

import { ensureRunnerStateSchema } from './runner-state.js';
import { getTurnAssociations, linkTurnRecord } from './turns.js';

const opened: Database[] = [];
afterEach(() => opened.splice(0).forEach((db) => db.close()));

describe('runner durable turns', () => {
  it('creates the fresh schema and stores usage/activity without a reply, with unique per-turn activity ordinals', () => {
    const db = new Database(':memory:');
    opened.push(db);
    db.exec('PRAGMA foreign_keys = ON');
    ensureRunnerStateSchema(db);
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
