import Database from 'better-sqlite3';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { runMigrations } from '../src/db/migrations/index.js';
import { INBOUND_SCHEMA, OUTBOUND_SCHEMA } from '../src/db/schema.js';
import { backfillTurnUsage } from './backfill-turn-usage.js';

let root: string;
let source: string;
let output: string;
let socket: net.Server | undefined;
const relative = path.join('v2-sessions', 'g', 's');
const files = [
  'v2.db',
  path.join(relative, 'inbound.db'),
  path.join(relative, 'outbound.db'),
  path.join(relative, 'runner-state', 'runner-state.db'),
];
const hash = (file: string) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const run = () => backfillTurnUsage({ source, output, hostStopped: true, runnersStopped: true });

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-usage-cutover-'));
  source = path.join(root, 'data');
  output = path.join(root, 'cutover');
  fs.mkdirSync(path.join(source, relative, 'runner-state'), { recursive: true });
  const central = new Database(path.join(source, 'v2.db'));
  try {
    runMigrations(central);
    central.exec(`ALTER TABLE container_configs DROP COLUMN soft_turn_token_budget;
      INSERT INTO agent_groups(id,name,folder,created_at) VALUES('g','Group','group',0);
      INSERT INTO container_configs(agent_group_id,updated_at,model) VALUES('g',0,'keep-model');
      INSERT INTO sessions(id,agent_group_id,created_at) VALUES('s','g',0);
      PRAGMA user_version=2;`);
  } finally {
    central.close();
  }
  for (const [filename, schema] of [
    [files[1], INBOUND_SCHEMA],
    [files[2], OUTBOUND_SCHEMA],
    [files[3], OUTBOUND_SCHEMA],
  ]) {
    const db = new Database(path.join(source, filename));
    try {
      db.exec(schema);
      db.pragma('user_version=2');
      if (filename === files[1]) {
        db.exec("INSERT INTO session_routing(id,channel_type,platform_id,thread_id) VALUES(1,'web','room',NULL)");
      } else {
        db.exec(`ALTER TABLE turn_usage DROP COLUMN reported_tokens;
          ALTER TABLE turn_usage DROP COLUMN cost_source;
          INSERT INTO turns(id,phase,outcome,provenance) VALUES('t','settled','replied','native');
          INSERT INTO messages_out(id,seq,turn_id,timestamp,kind,content)
            VALUES('out',1,'t',0,'chat','{"text":"preserve"}');
          INSERT INTO turn_usage(id,turn_id,input_tokens,output_tokens,cost_usd,timestamp)
            VALUES('old-bill','t',1,2,0.1,0);`);
        if (filename === files[3])
          db.exec(`
          CREATE TABLE pending_runner_events(sequence INTEGER PRIMARY KEY,event_id TEXT,event_type TEXT,payload TEXT,created_at INTEGER);
          INSERT INTO turn_usage(id,turn_id,message_out_id,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,cost_usd,timestamp)
            VALUES('observed','t','out',10,3,2,0,0.2,0);
          INSERT INTO session_state(key,value,updated_at)
            VALUES('turn-metadata:t','{"turnId":"t","durationMs":1,"model":"stub","usageId":"observed","reportedTokens":15,"costSource":"estimated","usageAdvisory":null,"status":"final","final":true}',0);
          CREATE TRIGGER journal_test AFTER UPDATE ON session_state BEGIN
            INSERT INTO pending_runner_events VALUES(1,'unwanted','state.upsert','{}',0);
          END;
        `);
      }
    } finally {
      db.close();
    }
  }
});
afterEach(async () => {
  if (socket) {
    await new Promise<void>((resolve, reject) => socket!.close((error) => (error ? reject(error) : resolve())));
    socket = undefined;
  }
  fs.rmSync(root, { recursive: true, force: true });
});

it('produces verified candidates and rollback copies without changing the source', async () => {
  const before = files.map((file) => hash(path.join(source, file)));
  const manifest = await run();
  expect(manifest).toMatchObject({
    complete: true,
    fromVersion: 2,
    toVersion: 3,
    preservedMeasurements: 1,
    restoredHostUsageRows: 1,
  });
  expect(manifest.stores).toHaveLength(4);
  expect(files.map((file) => hash(path.join(source, file)))).toEqual(before);
  for (const file of files) {
    const backup = new Database(path.join(output, 'backup', file), { readonly: true });
    const candidate = new Database(path.join(output, 'candidate', file), { readonly: true });
    try {
      expect(backup.pragma('user_version', { simple: true })).toBe(2);
      expect(candidate.pragma('user_version', { simple: true })).toBe(3);
      expect(candidate.pragma('integrity_check', { simple: true })).toBe('ok');
      expect(candidate.pragma('foreign_key_check')).toEqual([]);
    } finally {
      candidate.close();
      backup.close();
    }
  }
  const host = new Database(path.join(output, 'candidate', files[2]), { readonly: true });
  const runner = new Database(path.join(output, 'candidate', files[3]), { readonly: true });
  try {
    expect(host.prepare("SELECT reported_tokens,cost_source FROM turn_usage WHERE id='observed'").get()).toEqual({
      reported_tokens: 15,
      cost_source: 'estimated',
    });
    expect(host.prepare("SELECT reported_tokens,cost_source FROM turn_usage WHERE id='old-bill'").get()).toEqual({
      reported_tokens: null,
      cost_source: null,
    });
    expect(host.prepare("SELECT content FROM messages_out WHERE id='out'").pluck().get()).toBe('{"text":"preserve"}');
    expect(runner.prepare('SELECT count(*) FROM pending_runner_events').pluck().get()).toBe(0);
    expect(runner.prepare("SELECT 1 FROM sqlite_schema WHERE name='journal_test'").get()).toBeUndefined();
    const metadata = runner
      .prepare("SELECT value FROM session_state WHERE key='turn-metadata:t'")
      .pluck()
      .get() as string;
    expect(JSON.parse(metadata)).toEqual({
      turnId: 't',
      durationMs: 1,
      model: 'stub',
      usageId: 'observed',
      usageAdvisory: null,
      status: 'final',
      final: true,
    });
    expect(host.prepare("SELECT value FROM session_state WHERE key='turn-metadata:t'").pluck().get()).toBe(metadata);
  } finally {
    host.close();
    runner.close();
  }
  const central = new Database(path.join(output, 'candidate', 'v2.db'), { readonly: true });
  try {
    expect(central.prepare('SELECT model,soft_turn_token_budget FROM container_configs').get()).toEqual({
      model: 'keep-model',
      soft_turn_token_budget: null,
    });
  } finally {
    central.close();
  }
});

it('requires stopped-writer attestations and rejects a live host socket', async () => {
  await expect(backfillTurnUsage({ source, output, hostStopped: false, runnersStopped: true })).rejects.toThrow(
    'Require',
  );
  socket = net.createServer();
  await new Promise<void>((resolve) => socket!.listen(path.join(source, 'ncl.sock'), resolve));
  await expect(run()).rejects.toThrow('Host CLI socket is active');
  expect(fs.existsSync(output)).toBe(false);
});

it('rejects undrained runner journals before creating any candidate', async () => {
  const db = new Database(path.join(source, files[3]));
  db.exec("INSERT INTO pending_runner_events VALUES(1,'pending','usage.persist','{}',0)");
  db.close();
  await expect(run()).rejects.toThrow('runner journal is not drained');
  expect(fs.existsSync(output)).toBe(false);
});

it('refuses unsupported versions and unsafe or existing output paths', async () => {
  await expect(
    backfillTurnUsage({ source, output: path.join(source, 'unsafe'), hostStopped: true, runnersStopped: true }),
  ).rejects.toThrow('outside the source');
  fs.mkdirSync(output);
  await expect(run()).rejects.toThrow('new directory');
  output = path.join(root, 'another-output');
  const db = new Database(path.join(source, 'v2.db'));
  db.pragma('user_version=1');
  db.close();
  await expect(run()).rejects.toThrow('expected storage version 2');
  expect(fs.existsSync(output)).toBe(false);
});

it('retains the source and incomplete manifest if an observed record cannot be anchored safely', async () => {
  const db = new Database(path.join(source, files[2]));
  db.exec("DELETE FROM messages_out WHERE id='out'");
  db.close();
  const before = files.map((file) => hash(path.join(source, file)));
  await expect(run()).rejects.toThrow('no matching output');
  expect(files.map((file) => hash(path.join(source, file)))).toEqual(before);
  expect(JSON.parse(fs.readFileSync(path.join(output, 'manifest.json'), 'utf8')).complete).toBe(false);
  expect(fs.existsSync(path.join(output, 'backup', 'v2.db'))).toBe(true);
});

it('uses SQLite backups so committed WAL content is retained', async () => {
  const db = new Database(path.join(source, 'v2.db'));
  try {
    db.pragma('journal_mode=WAL');
    db.prepare("UPDATE agent_groups SET name='committed-in-wal'").run();
    await run();
    const candidate = new Database(path.join(output, 'candidate', 'v2.db'), { readonly: true });
    try {
      expect(candidate.prepare('SELECT name FROM agent_groups').pluck().get()).toBe('committed-in-wal');
    } finally {
      candidate.close();
    }
  } finally {
    db.close();
  }
});
