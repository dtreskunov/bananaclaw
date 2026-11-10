import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { parseTimestamp, formatTimestamp } from '../time.js';
import { assertStorageVersion, STORAGE_VERSION } from './storage-lifecycle.js';
import { runMigrations } from './migrations/index.js';
import { initTestDb, closeDb } from './connection.js';
import { recordDroppedMessage, getUnregisteredSenders } from './dropped-messages.js';
import { INBOUND_SCHEMA, OUTBOUND_SCHEMA } from './schema.js';

afterEach(closeDb);

describe('current storage contracts', () => {
  it('stores and returns audit instants as numeric host records', () => {
    const db = initTestDb();
    runMigrations(db);
    recordDroppedMessage({
      channel_type: 'web',
      platform_id: 'p',
      user_id: null,
      sender_name: null,
      reason: 'unknown',
      messaging_group_id: null,
      agent_group_id: null,
    });
    expect(
      db.prepare('SELECT typeof(first_seen) first_type,typeof(last_seen) last_type FROM unregistered_senders').get(),
    ).toEqual({ first_type: 'integer', last_type: 'integer' });
    const [row] = getUnregisteredSenders();
    expect(Number.isSafeInteger(row.first_seen)).toBe(true);
    expect(row.last_seen).toBe(row.first_seen);
  });

  it('validates external timestamps without accepting historical numeric text', () => {
    expect(formatTimestamp(parseTimestamp('2026-09-01T04:30:00.123+04:30'))).toBe('2026-09-01T00:00:00.123Z');
    expect(formatTimestamp(parseTimestamp('2026-09-01 00:00:00'))).toBe('2026-09-01T00:00:00.000Z');
    for (const invalid of [
      '2026-02-30T00:00:00Z',
      '2026-09-01',
      '2026:09:01T00:00:00Z',
      '2026-09-01T00:00:00',
      '1787342173990.0',
    ])
      expect(() => parseTimestamp(invalid)).toThrow('Invalid timestamp');
    expect(() => formatTimestamp(Number.NaN)).toThrow('Invalid epoch-millisecond timestamp');
  });

  it('allows only empty fresh or current-version stores without modifying rejected files', () => {
    const db = new Database(':memory:');
    try {
      expect(() => assertStorageVersion(db, 'inbound', true)).not.toThrow();
      db.exec("CREATE TABLE old(timestamp TEXT); INSERT INTO old VALUES ('2026-09-01T00:00:00Z')");
      expect(() => assertStorageVersion(db, 'inbound', true)).toThrow('Unsupported inbound storage version 0');
      expect(db.prepare('SELECT timestamp FROM old').get()).toEqual({ timestamp: '2026-09-01T00:00:00Z' });
      db.pragma('user_version=99');
      expect(() => assertStorageVersion(db, 'inbound', true)).toThrow('storage version 99');
      db.pragma(`user_version=${STORAGE_VERSION}`);
      expect(() => assertStorageVersion(db, 'inbound')).not.toThrow();
    } finally {
      db.close();
    }
  });

  it('refuses populated version-2 stores instead of doing an online cutover', () => {
    const db = new Database(':memory:');
    try {
      db.exec(OUTBOUND_SCHEMA);
      db.pragma('user_version=2');
      const schema = db.prepare('SELECT * FROM sqlite_schema ORDER BY name').all();
      expect(() => assertStorageVersion(db, 'outbound')).toThrow('docs/usage-efficiency.md#offline-cutover');
      expect(db.pragma('user_version', { simple: true })).toBe(2);
      expect(db.prepare('SELECT * FROM sqlite_schema ORDER BY name').all()).toEqual(schema);
    } finally { db.close(); }
  });

  it('writes direct integer host schemas and retains ISO strings in durable journals', () => {
    const inbound = new Database(':memory:');
    const outbound = new Database(':memory:');
    try {
      inbound.exec(INBOUND_SCHEMA);
      outbound.exec(OUTBOUND_SCHEMA);
      inbound
        .prepare(`INSERT INTO messages_in(id,seq,kind,timestamp,content) VALUES('in',2,'chat',?,'{}')`)
        .run(parseTimestamp('2026-09-01T00:00:00.123Z'));
      expect(inbound.prepare('SELECT typeof(timestamp) type FROM messages_in').get()).toEqual({ type: 'integer' });
      const event = inbound
        .prepare("SELECT payload FROM pending_host_events WHERE event_type='message.upsert'")
        .get() as { payload: string };
      expect(JSON.parse(event.payload).timestamp).toBe('2026-09-01T00:00:00.123Z');
      expect(() =>
        outbound.exec(`INSERT INTO messages_out(id,timestamp,kind,content)
        VALUES('old','2026-09-01T00:00:00Z','chat','{}')`),
      ).toThrow('CHECK');
    } finally {
      inbound.close();
      outbound.close();
    }
  });
});
