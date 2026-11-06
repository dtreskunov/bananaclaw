import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { closeDb, initTestDb } from './connection.js';
import { runMigrations } from './migrations/index.js';
import { INBOUND_SCHEMA, OUTBOUND_SCHEMA } from './schema.js';
import { getDueOutboundMessages, markDelivered, markDeliveryFailed } from './session-db.js';
import { toEpoch } from './time.js';

afterEach(closeDb);

it('indexes reverse lookups and expiry sweeps', () => {
  const db = initTestDb();
  runMigrations(db);
  for (const [sql, index] of [
    ["SELECT * FROM agent_group_members WHERE agent_group_id='g'", 'agent_group_members_group'],
    ["SELECT * FROM messaging_group_agents WHERE agent_group_id='g'", 'messaging_group_agents_group'],
    ["SELECT * FROM ui_private_web_sessions WHERE parent_ui_session_hash='s'", 'ui_private_web_sessions_parent'],
    ['SELECT * FROM chat_sdk_kv WHERE expires_at < 1', 'chat_sdk_kv_expires'],
    ['SELECT * FROM ui_sessions WHERE expires_at < 1788220800000', 'ui_sessions_expires'],
  ]) {
    expect(db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all()).toEqual(
      expect.arrayContaining([expect.objectContaining({ detail: expect.stringContaining(index) })]),
    );
  }
});

it('excludes completed history from the pending wake index', () => {
  const db = new Database(':memory:');
  try {
    db.exec(INBOUND_SCHEMA);
    expect(
      db
        .prepare(
          `EXPLAIN QUERY PLAN SELECT count(*) FROM messages_in
      WHERE status='pending' AND trigger=1 AND kind!='system'
      AND (process_after IS NULL OR process_after<=1788220800000)`,
        )
        .all(),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ detail: expect.stringContaining('idx_messages_in_pending_wake') }),
      ]),
    );
  } finally {
    db.close();
  }
});

it('returns only due unreceipted messages over a read-only outbound connection', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'delivery-query-'));
  const outboundPath = path.join(directory, 'outbound.db');
  const inbound = new Database(path.join(directory, 'inbound.db'));
  const writer = new Database(outboundPath);
  let reader: Database.Database | undefined;
  try {
    inbound.exec(INBOUND_SCHEMA);
    writer.exec(OUTBOUND_SCHEMA);
    const insert = writer.prepare(`INSERT INTO messages_out(id,timestamp,deliver_after,kind,content)
      VALUES(?,?,?,'chat','{}')`);
    writer.transaction(() => inbound.transaction(() => {
      for (let i = 0; i < 1000; i++) {
        insert.run(`old-${i}`, toEpoch('2020-01-01T00:00:00Z'), null);
        markDelivered(inbound, `old-${i}`, null);
      }
    })())();
    insert.run('due', toEpoch('2020-01-01T00:00:00Z'), Date.now() - 60_000);
    insert.run('failed', toEpoch('2020-01-01T00:00:00Z'), null);
    markDeliveryFailed(inbound, 'failed');
    insert.run('future', toEpoch('2020-01-01T00:00:00Z'), toEpoch('2999-01-01T00:00:00.000Z'));
    reader = new Database(outboundPath, { readonly: true });
    expect(getDueOutboundMessages(reader, inbound.name).map((row) => row.id)).toEqual(['due']);
    expect(getDueOutboundMessages(reader, inbound.name).map((row) => row.id)).toEqual(['due']);
    expect(reader.prepare('PRAGMA database_list').all()).toHaveLength(1);
    expect(reader.prepare(`EXPLAIN QUERY PLAN SELECT * FROM messages_out ORDER BY timestamp,id`).all()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ detail: expect.stringContaining('idx_messages_out_delivery_order') }),
      ]),
    );
  } finally {
    reader?.close();
    writer.close();
    inbound.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
