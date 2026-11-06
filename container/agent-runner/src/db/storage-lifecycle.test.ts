import { afterEach, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { NativeStore } from '../providers/native/store.js';
import { ensureRunnerStateSchema, listPendingRunnerEvents } from './runner-state.js';
import { closeSessionDb, initTestSessionDb } from './connection.js';
import { writeMessageOut } from './messages-out.js';
import { writeTurnActivity } from './turn-activity.js';
import { setContinuation } from './session-state.js';

const root = path.resolve(`.test-runner-epoch-${process.pid}`);
afterEach(() => {
  closeSessionDb();
  fs.rmSync(root, { recursive: true, force: true });
});

it('refuses old populated and future runner stores without changing their schema', () => {
  const db = new Database(':memory:');
  db.exec("CREATE TABLE old(timestamp TEXT); INSERT INTO old VALUES('2026-01-01T00:00:00Z')");
  expect(() => ensureRunnerStateSchema(db)).toThrow('Unsupported runner-state storage version 0');
  expect(db.query('SELECT timestamp FROM old').get()).toEqual({ timestamp: '2026-01-01T00:00:00Z' });
  db.exec('PRAGMA user_version=99');
  expect(() => ensureRunnerStateSchema(db)).toThrow('storage version 99');
  db.close();
});

it('stores integers while pending durable events retain their ISO/decimal string contracts', () => {
  const { outbound } = initTestSessionDb({ unifiedHostProjection: true });
  setContinuation('native', 'conversation');
  writeMessageOut({ id: 'output', kind: 'chat', content: '{"text":"hello"}' });
  writeTurnActivity('output', [{ ts: '1788220800123', text: 'work', timelinePosition: 2 }]);
  expect(outbound.query('SELECT typeof(timestamp) AS type FROM messages_out').get()).toEqual({ type: 'integer' });
  expect(outbound.query('SELECT typeof(updated_at) AS type FROM session_state').get()).toEqual({ type: 'integer' });
  expect(outbound.query('SELECT ts,typeof(ts) AS type FROM turn_activity').get()).toEqual({
    ts: 1788220800123,
    type: 'integer',
  });
  const events = listPendingRunnerEvents(outbound).map((event) => ({
    type: event.event_type,
    payload: JSON.parse(event.payload),
  }));
  expect(events.find((event) => event.type === 'message.upsert')?.payload.timestamp).toMatch(/^\d{4}-.*\.\d{3}Z$/);
  expect(events.find((event) => event.type === 'activity.persist')?.payload.ts).toBe('1788220800123');
  expect(() =>
    outbound
      .prepare("INSERT INTO messages_out(id,timestamp,kind,content) VALUES('old','2026-01-01T00:00:00Z','chat','{}')")
      .run(),
  ).toThrow();
});

it('version-gates native state and persists every maintained instant as INTEGER', () => {
  fs.mkdirSync(root, { recursive: true });
  const filename = path.join(root, 'native.db');
  const old = new Database(filename);
  old.exec('CREATE TABLE conversations(id TEXT PRIMARY KEY,created_at TEXT,updated_at TEXT)');
  old.close();
  expect(() => new NativeStore(filename)).toThrow('Unsupported native-provider storage version 0');
  fs.unlinkSync(filename);
  const store = new NativeStore(filename);
  const id = store.createConversation();
  store.append(id, [{ role: 'user', content: 'hello' }]);
  store.close();
  const inspect = new Database(filename);
  expect(inspect.query('PRAGMA user_version').get()).toEqual({ user_version: 1 });
  expect(
    inspect.query('SELECT typeof(created_at) AS created,typeof(updated_at) AS updated FROM conversations').get(),
  ).toEqual({ created: 'integer', updated: 'integer' });
  expect(inspect.query('SELECT typeof(created_at) AS type FROM messages').get()).toEqual({ type: 'integer' });
  inspect.exec('PRAGMA user_version=99');
  inspect.close();
  expect(() => new NativeStore(filename)).toThrow('storage version 99');
});
