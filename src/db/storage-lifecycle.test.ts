import { parseTimestamp, formatTimestamp } from '../time.js';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { assertStorageVersion, convertStoreTimes, epochSchema, STORAGE_VERSION } from './storage-lifecycle.js';

import { cutoverStores } from './offline-cutover.js';
import { migrations, runMigrations } from './migrations/index.js';
import { initTestDb, closeDb } from './connection.js';
import { recordDroppedMessage, getUnregisteredSenders } from './dropped-messages.js';

const directory = path.resolve('.test-epoch-cutover');
afterEach(() => fs.rmSync(directory, { recursive: true, force: true }));

describe('epoch storage lifecycle', () => {
  it('stores and returns dropped-message audit instants as numeric host records', () => {
    const db = initTestDb();
    try {
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
    } finally {
      closeDb();
    }
  });
  it('strictly validates dates and preserves offsets/millisecond precision', () => {
    expect(formatTimestamp(parseTimestamp('2026-09-01T04:30:00.123+04:30'))).toBe('2026-09-01T00:00:00.123Z');
    expect(formatTimestamp(parseTimestamp('2026-09-01 00:00:00'))).toBe('2026-09-01T00:00:00.000Z');
    for (const invalid of ['2026-02-30T00:00:00Z', '2026-09-01', '2026:09:01T00:00:00Z', '2026-09-01T00:00:00']) {
      expect(() => parseTimestamp(invalid)).toThrow('Invalid timestamp');
    }
  });

  it('blocks unversioned populated stores without changing their schema', () => {
    const db = new Database(':memory:');
    db.exec("CREATE TABLE old(timestamp TEXT); INSERT INTO old VALUES ('2026-09-01T00:00:00Z')");
    expect(() => assertStorageVersion(db, 'inbound', true)).toThrow('stop host AND runners');
    expect(db.pragma('user_version', { simple: true })).toBe(0);
    expect(db.prepare('SELECT typeof(timestamp) AS type FROM old').get()).toEqual({ type: 'text' });
    db.close();
  });

  it('preserves integral legacy epoch-millisecond text without accepting fractional or ambiguous values', () => {
    const db = new Database(':memory:');
    try {
      db.exec('CREATE TABLE events(timestamp TEXT)');
      db.prepare('INSERT INTO events VALUES (?)').run('1787342173990.0');
      convertStoreTimes(db);
      expect(db.prepare('SELECT timestamp,typeof(timestamp) type FROM events').get()).toEqual({
        timestamp: 1787342173990,
        type: 'integer',
      });
      expect(() => parseTimestamp('1787342173990.0')).toThrow('Invalid timestamp');
    } finally {
      db.close();
    }
    for (const value of ['1787342173990.1', '1787342173', '1.787342173990e12']) {
      const source = new Database(':memory:');
      try {
        source.exec('CREATE TABLE events(timestamp TEXT)');
        source.prepare('INSERT INTO events VALUES (?)').run(value);
        expect(() => convertStoreTimes(source)).toThrow('events.timestamp');
        expect(source.prepare('SELECT timestamp FROM events').get()).toEqual({ timestamp: value });
      } finally {
        source.close();
      }
    }
  });

  it('applies pending integrity migrations only to the offline central candidate', async () => {
    fs.mkdirSync(directory);
    const filename = path.join(directory, 'central.db');
    const db = new Database(filename);
    runMigrations(
      db,
      migrations.filter((migration) => migration.version < 52),
    );
    db.exec("INSERT INTO users(id,kind,created_at) VALUES('u','web','2026-01-01T00:00:00.000Z')");
    db.close();
    const backupDirectory = path.join(directory, 'backup');
    await cutoverStores([{ kind: 'central', path: filename }], backupDirectory, {
      serviceStopped: true,
      runnersStopped: true,
    });
    const converted = new Database(filename);
    const original = new Database(path.join(backupDirectory, '0-central.db'));
    try {
      expect(converted.prepare('SELECT typeof(created_at) AS type FROM users').get()).toEqual({ type: 'integer' });
      expect(converted.prepare("SELECT 1 FROM sqlite_schema WHERE name='user_roles_global_unique'").get()).toBeTruthy();
      expect(original.prepare('SELECT typeof(created_at) AS type FROM users').get()).toEqual({ type: 'text' });
      expect(
        original.prepare("SELECT 1 FROM sqlite_schema WHERE name='user_roles_global_unique'").get(),
      ).toBeUndefined();
    } finally {
      converted.close();
      original.close();
    }
  });

  it('preflights all rows, retains FKs/indexes/journals and autoincrement high-water marks', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys=ON');
    db.exec(`CREATE TABLE parents(id TEXT PRIMARY KEY, created_at TEXT NOT NULL);
      CREATE TABLE children(id INTEGER PRIMARY KEY AUTOINCREMENT, parent TEXT REFERENCES parents(id), timestamp TEXT);
      CREATE INDEX child_time ON children(timestamp);
      CREATE TABLE pending_host_events(sequence INTEGER PRIMARY KEY AUTOINCREMENT,event_id TEXT,event_type TEXT,payload TEXT,created_at TEXT);
      CREATE TRIGGER journal AFTER INSERT ON children BEGIN
        INSERT INTO pending_host_events(event_id,event_type,payload,created_at)
        VALUES('event','child',json_object('timestamp',NEW.timestamp),datetime('now')); END;
      INSERT INTO parents(rowid,id,created_at) VALUES(99,'p','2026-09-01T00:00:00.123Z');
      INSERT INTO children VALUES(10,'p','2026-09-01 00:00:00');
      DELETE FROM children;`);
    const journal = db.prepare('SELECT payload FROM pending_host_events').get();
    convertStoreTimes(db);
    expect(db.pragma('user_version', { simple: true })).toBe(STORAGE_VERSION);
    expect(db.prepare('SELECT created_at,typeof(created_at) AS type FROM parents').get()).toEqual({
      created_at: 1788220800123,
      type: 'integer',
    });
    expect(db.prepare('SELECT rowid FROM parents').get()).toEqual({ rowid: 99 });
    expect(db.prepare('SELECT payload FROM pending_host_events').get()).toEqual(journal);
    const row = db.prepare('INSERT INTO children(parent,timestamp) VALUES (?,?) RETURNING id').get('p', 1788220800123);
    expect(row).toEqual({ id: 11 });
    expect(db.prepare('SELECT payload FROM pending_host_events ORDER BY sequence DESC LIMIT 1').get()).toEqual({
      payload: '{"timestamp":"2026-09-01T00:00:00.123Z"}',
    });
    expect(db.pragma('foreign_key_check')).toEqual([]);
    expect(() => db.prepare('INSERT INTO children(parent,timestamp) VALUES (?,?)').run('p', 'bad')).toThrow();
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name='child_time'").get()).toBeTruthy();
    db.close();
  });

  it('rejects invalid or ambiguous legacy instants atomically', () => {
    for (const value of ['not-a-date', '2026-02-30T00:00:00Z', '2026-09-01T12:00:00', '2026-09-01']) {
      const db = new Database(':memory:');
      db.exec('CREATE TABLE events(timestamp TEXT)');
      db.prepare('INSERT INTO events VALUES (?)').run(value);
      expect(() => convertStoreTimes(db)).toThrow('events.timestamp');
      expect(db.pragma('user_version', { simple: true })).toBe(0);
      expect(db.prepare('SELECT timestamp FROM events').get()).toEqual({ timestamp: value });
      db.close();
    }
  });

  it('backs up and verifies every candidate before activation; refuses incomplete stop acknowledgement', async () => {
    fs.mkdirSync(directory);
    const inbound = path.join(directory, 'inbound.db');
    const runner = path.join(directory, 'runner-state.db');
    for (const [filename, journal] of [
      [inbound, 'pending_host_events'],
      [runner, 'pending_runner_events'],
    ]) {
      const db = new Database(filename);
      db.exec(`CREATE TABLE ${journal}(created_at TEXT, payload TEXT);
        INSERT INTO ${journal} VALUES('2026-09-01T00:00:00Z','{}')`);
      db.close();
    }
    const inventory = [
      { kind: 'inbound' as const, path: inbound },
      { kind: 'runner-state' as const, path: runner },
    ];
    await expect(
      cutoverStores(inventory, path.join(directory, 'refused'), {
        serviceStopped: true,
        runnersStopped: false,
      }),
    ).rejects.toThrow('stopped host AND runners');
    const invalid = new Database(runner);
    invalid.exec("UPDATE pending_runner_events SET created_at='ambiguous'");
    invalid.close();
    await expect(
      cutoverStores(inventory, path.join(directory, 'failed'), {
        serviceStopped: true,
        runnersStopped: true,
      }),
    ).rejects.toThrow('pending_runner_events.created_at');
    const original = new Database(inbound);
    expect(original.pragma('user_version', { simple: true })).toBe(0);
    original.close();
    const repair = new Database(runner);
    repair.exec("UPDATE pending_runner_events SET created_at='2026-09-01T00:00:00Z'");
    repair.close();
    const backup = path.join(directory, 'backup');
    await cutoverStores(inventory, backup, { serviceStopped: true, runnersStopped: true });
    const converted = new Database(inbound);
    expect(converted.prepare('SELECT typeof(created_at) AS type FROM pending_host_events').get()).toEqual({
      type: 'integer',
    });
    converted.close();
    const saved = new Database(path.join(backup, '0-inbound.db'));
    expect(saved.prepare('SELECT typeof(created_at) AS type FROM pending_host_events').get()).toEqual({ type: 'text' });
    saved.close();
    expect(fs.existsSync(path.join(backup, 'manifest.json'))).toBe(true);
    expect(fs.existsSync(`${inbound}.epoch-candidate`)).toBe(false);
  });

  it('rejects invalid pending wire instants before modifying the journal or schema', () => {
    const db = new Database(':memory:');
    db.exec('CREATE TABLE pending_runner_events(payload TEXT,created_at TEXT)');
    const payload = JSON.stringify({ timestamp: '2026-09-01T12:00:00' });
    db.prepare('INSERT INTO pending_runner_events VALUES (?,?)').run(payload, '2026-09-01T00:00:00Z');
    expect(() => convertStoreTimes(db)).toThrow('Invalid timestamp');
    expect(db.pragma('user_version', { simple: true })).toBe(0);
    expect(db.prepare('SELECT payload FROM pending_runner_events').get()).toEqual({ payload });
    db.close();
  });

  it('cuts over populated central, native and version-1 search stores together without losing identities or content', async () => {
    fs.mkdirSync(directory);
    const centralPath = path.join(directory, 'central.db');
    const central = new Database(centralPath);
    central.pragma('foreign_keys=ON');
    runMigrations(central, [...migrations]);
    central.exec("INSERT INTO users(rowid,id,kind,created_at) VALUES(99,'u','web','2026-09-01T00:00:00.123Z')");
    central.close();
    const nativePath = path.join(directory, 'native.db');
    const native = new Database(nativePath);
    native.exec(`CREATE TABLE conversations(id TEXT PRIMARY KEY,created_at TEXT,updated_at TEXT);
      CREATE TABLE messages(id INTEGER PRIMARY KEY AUTOINCREMENT,conversation_id TEXT REFERENCES conversations(id),content_json TEXT,created_at TEXT);
      INSERT INTO conversations VALUES('c','2026-09-01 00:00:00','2026-09-01 00:00:00');
      INSERT INTO messages VALUES(10,'c','{"role":"user","content":"keep exactly"}','2026-09-01T00:00:00.123Z');`);
    native.close();
    const searchPath = path.join(directory, 'search.db');
    const search = new Database(searchPath);
    search.exec(`CREATE TABLE message_index(
      rowid INTEGER PRIMARY KEY,id TEXT,session_id TEXT,agent_group_id TEXT,messaging_group_id TEXT,
      channel_type TEXT,thread_id TEXT,direction TEXT,timestamp TEXT,text TEXT,sender_user_id TEXT);
      INSERT INTO message_index VALUES(77,'m','s','g',NULL,'web','thread','in','2026-09-01T00:00:00.123Z','needle','u');
      PRAGMA user_version=1;`);
    search.close();
    await cutoverStores(
      [
        { kind: 'central', path: centralPath },
        { kind: 'native', path: nativePath },
        { kind: 'search', path: searchPath },
      ],
      path.join(directory, 'backup'),
      { serviceStopped: true, runnersStopped: true },
    );
    const current = new Database(centralPath);
    assertStorageVersion(current, 'central');
    expect(current.prepare("SELECT rowid,created_at FROM users WHERE id='u'").get()).toEqual({
      rowid: 99,
      created_at: 1788220800123,
    });
    expect(current.pragma('foreign_key_check')).toEqual([]);
    current.close();
    const nativeCurrent = new Database(nativePath);
    expect(nativeCurrent.prepare('SELECT id,content_json,created_at FROM messages').get()).toEqual({
      id: 10,
      content_json: '{"role":"user","content":"keep exactly"}',
      created_at: 1788220800123,
    });
    nativeCurrent.close();
    const searchCurrent = new Database(searchPath);
    expect(searchCurrent.pragma('user_version', { simple: true })).toBe(2);
    expect(searchCurrent.prepare('SELECT rowid,timestamp FROM message_index').get()).toEqual({
      rowid: 77,
      timestamp: 1788220800123,
    });
    expect(searchCurrent.prepare("SELECT rowid FROM message_fts WHERE message_fts MATCH 'needle'").get()).toEqual({
      rowid: 77,
    });
    searchCurrent.close();
  });

  it('new DDL rejects old writers instead of accepting TEXT in INTEGER columns', () => {
    const db = new Database(':memory:');
    db.exec(epochSchema('CREATE TABLE events(timestamp TEXT NOT NULL, recurrence TEXT, duration_ms INTEGER)'));
    expect(() =>
      db.prepare('INSERT INTO events VALUES (?,?,?)').run('2026-09-01T00:00:00Z', '0 9 * * *', 10),
    ).toThrow();
    db.prepare('INSERT INTO events VALUES (?,?,?)').run(1788220800000, '0 9 * * *', 10);
    expect(db.prepare('SELECT * FROM events').get()).toEqual({
      timestamp: 1788220800000,
      recurrence: '0 9 * * *',
      duration_ms: 10,
    });
    db.close();
  });
});
