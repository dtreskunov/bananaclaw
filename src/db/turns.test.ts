import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { OUTBOUND_SCHEMA } from './schema.js';
import { getTurnAssociations, linkTurnRecord, TURN_SCHEMA, TURN_ACTIVITY_SCHEMA, TURN_INDEX_SCHEMA } from './turns.js';

const opened: Database.Database[] = [];
afterEach(() => {
  opened.splice(0).forEach((db) => db.close());
});

describe('durable turn schema', () => {
  it('keeps host and runner SQL contracts identical without cross-runtime imports', () => {
    const runner = fs.readFileSync(path.join(process.cwd(), 'container/agent-runner/src/db/turns.ts'), 'utf8');
    for (const [name, sql] of Object.entries({ TURN_SCHEMA, TURN_ACTIVITY_SCHEMA, TURN_INDEX_SCHEMA })) {
      expect(runner.match(new RegExp('export const ' + name + ' = `([\\s\\S]*?)`;'))?.[1]).toBe(sql);
    }
  });

  it('supports the fresh schema and unanchored activity without allowing duplicate turn ordinals', () => {
    const db = new Database(':memory:');
    opened.push(db);
    db.pragma('foreign_keys = ON');
    db.exec(OUTBOUND_SCHEMA);
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
