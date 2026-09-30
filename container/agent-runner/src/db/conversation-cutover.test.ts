import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { cutover, discoverSessionFiles } from '../../../../scripts/conversation-cutover.js';
import { assertConversationCutoverComplete } from '../../../../src/conversation-cutover.js';
import { INBOUND_SCHEMA, OUTBOUND_BASE_SCHEMA } from '../../../../src/db/schema.js';
import { historicalTurnId, TURN_ACTIVITY_SCHEMA } from './turns.js';

const root = path.resolve('.test-offline-conversation-cutover');
const session = path.join(root, 'v2-sessions/agent/session');
const input = path.join(session, 'inbound.db');
const output = path.join(session, 'outbound.db');
const runner = path.join(session, 'runner-state/runner-state.db');
const manifestFile = path.join(root, '.conversation-cutover/manifest.json');
const hash = (file: string) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const legacy = OUTBOUND_BASE_SCHEMA.replace(
  TURN_ACTIVITY_SCHEMA,
  `CREATE TABLE turn_activity (
    message_out_id TEXT NOT NULL, ordinal INTEGER NOT NULL, ts TEXT NOT NULL, text TEXT NOT NULL,
    PRIMARY KEY(message_out_id, ordinal));`,
)
  .replace(/^\s*turn_id\s+TEXT REFERENCES turns\(id\),?\n/gm, '')
  .replace(/,\s*\);/g, ');');

function withDb<T>(file: string, run: (db: Database) => T): T {
  const db = new Database(file);
  try {
    return run(db);
  } finally {
    db.close();
  }
}
function fixture() {
  fs.mkdirSync(path.dirname(runner), { recursive: true });
  withDb(input, (db) => {
    db.exec(INBOUND_SCHEMA);
    db.query(
      `INSERT INTO messages_in (id,seq,kind,timestamp,content,channel_type,platform_id,thread_id)
      VALUES ('in',2,'chat','original timestamp','{"text":"private contents"}','web','chat','thread')`,
    ).run();
    // This fixture represents the old peers' acknowledged, fully drained state.
    db.exec('DELETE FROM pending_host_events');
  });
  for (const file of [output, runner])
    withDb(file, (db) => {
      db.exec(legacy);
      db.query(
        `INSERT INTO messages_out (id,seq,in_reply_to,kind,timestamp,content)
      VALUES ('common',1,'in','chat','unchanged','{"text":"answer"}')`,
      ).run();
      db.query(
        `INSERT INTO turn_usage (id,message_out_id,input_tokens,cost_usd,timestamp)
      VALUES ('billing-id','common',17,0.123,'original usage time'),('orphan',NULL,9,0.25,'other time')`,
      ).run();
      db.exec(`INSERT INTO turn_activity VALUES ('common',0,'original activity time','work');
      INSERT INTO turn_usage(id,message_out_id,timestamp) VALUES ('host-bill','host-only','original time');
      INSERT INTO applied_runner_events VALUES ('old-event',10,'message.upsert','digest','old time');`);
    });
  withDb(output, (db) => {
    // Host-only explicit identity collides with the deterministic ID of a shared output.
    db.query(
      `INSERT INTO messages_out (id,seq,kind,timestamp,content)
      VALUES ('host-only',4,'chat','unchanged',?)`,
    ).run(JSON.stringify({ turn_id: historicalTurnId('common'), text: 'host notice' }));
  });
  withDb(runner, (db) => {
    db.exec(`CREATE TABLE pending_runner_events (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT NOT NULL UNIQUE,
      event_type TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TRIGGER journal_turn_usage_update AFTER UPDATE ON turn_usage BEGIN
        INSERT INTO pending_runner_events(event_id,event_type,payload,created_at)
        VALUES (lower(hex(randomblob(16))),'usage.persist','{}','old time');
      END;`);
  });
}
beforeEach(fixture);
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe('offline coordinated conversation cutover', () => {
  it('requires the explicit staging-copy attestation at the executable boundary', () => {
    const before = [input, output, runner].map(hash);
    const result = spawnSync(
      process.execPath,
      [
        path.resolve(import.meta.dir, '../../../../scripts/conversation-cutover.ts'),
        '--staging-data-dir',
        root,
        '--apply',
      ],
      { encoding: 'utf8' },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('--attest-offline-copy');
    expect(result.stdout).toBe('');
    expect([input, output, runner].map(hash)).toEqual(before);
  });
  it('dry-runs exact flat/nested scope without changing bytes or creating a manifest', () => {
    const flat = path.join(root, 'v2-sessions/flat');
    fs.mkdirSync(flat);
    fs.copyFileSync(input, path.join(flat, 'inbound.db'));
    fs.copyFileSync(output, path.join(flat, 'outbound.db'));
    const files = discoverSessionFiles(root);
    const before = files.map((f) => hash(path.join(root, f)));
    expect(cutover(root, 'dry-run')).toMatchObject({ sessions: 2, files: 5, phase: 'preflight-ok' });
    expect(files.map((f) => hash(path.join(root, f)))).toEqual(before);
    expect(fs.existsSync(manifestFile)).toBe(false);
  });

  it('leaves session workspaces and provider stores outside database discovery', () => {
    const workspace = path.join(session, 'group', 'node_modules');
    fs.mkdirSync(workspace, { recursive: true });
    fs.symlinkSync('/not-a-migration-input', path.join(workspace, 'dependency'));
    fs.writeFileSync(path.join(workspace, 'inbound.db'), 'user file, not a session journal');
    fs.mkdirSync(path.join(session, 'opencode-xdg'));
    fs.writeFileSync(path.join(session, 'opencode-xdg', 'opencode.db-wal'), 'provider journal');
    expect(discoverSessionFiles(root)).toHaveLength(3);
    expect(cutover(root, 'dry-run')).toMatchObject({ sessions: 1, files: 3, phase: 'preflight-ok' });
    expect(fs.readlinkSync(path.join(workspace, 'dependency'))).toBe('/not-a-migration-input');
  });

  it('preserves rows and accounting, uses shared input/collision evidence, and verifies idempotently', () => {
    withDb(output, (db) => {
      const key = `input:${createHash('sha256').update('in').digest('hex')}`;
      db.query('INSERT INTO session_state VALUES(?,?,?)').run(
        key,
        JSON.stringify({ messageId: 'in', turnId: 'applied-only', status: 'applied' }),
        'original time',
      );
    });
    const before = [input, output, runner].map(hash);
    expect(cutover(root, 'apply').phase).toBe('verified');
    assertConversationCutoverComplete(root);
    for (const file of [output, runner])
      withDb(file, (db) => {
        expect(db.query("SELECT turn_id FROM messages_out WHERE id='common'").get()).toEqual({
          turn_id: `${historicalTurnId('common')}:1`,
        });
        expect(
          db
            .query('SELECT origin_channel_type,origin_platform_id,started_at,ended_at FROM turns WHERE id=?')
            .get(`${historicalTurnId('common')}:1`),
        ).toEqual({
          origin_channel_type: 'web',
          origin_platform_id: 'chat',
          started_at: null,
          ended_at: null,
        });
        expect(db.query('SELECT SUM(input_tokens) AS tokens, SUM(cost_usd) AS cost FROM turn_usage').get()).toEqual({
          tokens: 26,
          cost: 0.373,
        });
        expect(db.query('PRAGMA foreign_key_check').all()).toEqual([]);
        expect(db.query("SELECT origin_channel_type,started_at FROM turns WHERE id='applied-only'").get()).toEqual({
          origin_channel_type: 'web',
          started_at: null,
        });
      });
    withDb(runner, (db) => {
      expect(db.query("SELECT 1 FROM messages_out WHERE id='host-only'").get()).toBeNull();
      expect(db.query("SELECT turn_id FROM turn_usage WHERE id='host-bill'").get()).toEqual({
        turn_id: historicalTurnId('common'),
      });
      expect(db.query('SELECT * FROM pending_runner_events').all()).toEqual([]);
      const trigger = db.query("SELECT sql FROM sqlite_master WHERE name='journal_turn_usage_update'").get() as {
        sql: string;
      };
      expect(trigger.sql).toContain("'turn_id', NEW.turn_id");
    });
    const after = [input, output, runner].map(hash);
    expect(after[0]).toBe(before[0]);
    expect(cutover(root, 'verify').phase).toBe('verified');
    expect(cutover(root, 'apply').phase).toBe('verified');
    expect([input, output, runner].map(hash)).toEqual(after);
    expect(cutover(root, 'rollback').phase).toBe('rolled-back');
    expect([input, output, runner].map(hash)).toEqual(before);
    expect(() => assertConversationCutoverComplete(root)).toThrow('incomplete');
  });

  it.each(['pending_runner_events', 'pending_host_events'])('refuses undrained %s before backing up', (table) => {
    const file = table === 'pending_runner_events' ? runner : input;
    withDb(file, (db) =>
      db
        .query(
          `INSERT INTO ${table}(event_id,event_type,payload,created_at)
      VALUES ('old-frame','message.upsert','{}','old time')`,
        )
        .run(),
    );
    const before = [input, output, runner].map(hash);
    expect(() => cutover(root, 'apply')).toThrow(`Undrained ${table}`);
    expect(fs.existsSync(manifestFile)).toBe(false);
    expect([input, output, runner].map(hash)).toEqual(before);
  });

  it('fails closed on conflicts, orphan stores, links, sidecars and active SQLite readers', () => {
    fs.writeFileSync(output + '-journal', 'rollback journal');
    expect(() => cutover(root, 'dry-run')).toThrow('sidecar');
    fs.unlinkSync(output + '-journal');
    const reader = new Database(output);
    reader.exec('BEGIN; SELECT * FROM messages_out');
    expect(() => cutover(root, 'apply')).toThrow();
    reader.exec('ROLLBACK');
    reader.close();
    withDb(runner, (db) => db.exec("UPDATE messages_out SET content='conflict'"));
    expect(() => cutover(root, 'apply')).toThrow('Conflicting');
    fs.renameSync(input, input + '.saved');
    expect(() => cutover(root, 'apply')).toThrow('Incomplete session');
    fs.symlinkSync(input + '.saved', input);
    expect(() => cutover(root, 'apply')).toThrow('Symlink');
    expect(fs.existsSync(manifestFile)).toBe(false);
  });

  it('retains the original snapshot across partial failure and an explicit retry', () => {
    const original = [input, output, runner].map(hash);
    const rename = fs.renameSync;
    const fail = spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (String(from).endsWith('manifest.json.next')) {
        const next = JSON.parse(fs.readFileSync(from, 'utf8'));
        if (next.phase === 'applying' && next.completedFiles?.length === 1)
          throw new Error('injected post-commit failure');
      }
      return rename(from, to);
    });
    try {
      expect(() => cutover(root, 'apply')).toThrow('injected');
    } finally {
      fail.mockRestore();
    }
    expect(() => assertConversationCutoverComplete(root)).toThrow('incomplete');
    expect(() => cutover(root, 'apply')).toThrow('Incomplete');
    expect(cutover(root, 'retry').phase).toBe('verified');
    const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
    expect(manifest.files.map((f: { name: string; before: string }) => [f.name, f.before])).toEqual(
      discoverSessionFiles(root).map((name) => [
        name,
        original[[input, output, runner].findIndex((f) => f === path.join(root, name))],
      ]),
    );
    cutover(root, 'rollback');
    expect([input, output, runner].map(hash)).toEqual(original);
  });

  it('resumes an interrupted backup without overwriting its original snapshot', () => {
    const before = [input, output, runner].map(hash);
    const copy = fs.copyFileSync;
    let count = 0;
    const fail = spyOn(fs, 'copyFileSync').mockImplementation((from, to, flags) => {
      if (++count === 2) throw new Error('interrupted snapshot');
      return copy(from, to, flags);
    });
    try {
      expect(() => cutover(root, 'apply')).toThrow('interrupted snapshot');
    } finally {
      fail.mockRestore();
    }
    expect([input, output, runner].map(hash)).toEqual(before);
    expect(() => assertConversationCutoverComplete(root)).toThrow('incomplete');
    expect(cutover(root, 'retry').phase).toBe('verified');
    cutover(root, 'rollback');
    expect([input, output, runner].map(hash)).toEqual(before);
  });

  it('refuses post-verification writes without restoring any file', () => {
    cutover(root, 'apply');
    withDb(output, (db) => db.exec("UPDATE messages_out SET content='later write' WHERE id='common'"));
    expect(() => cutover(root, 'verify')).toThrow('changed');
    const before = [input, output, runner].map(hash);
    expect(() => cutover(root, 'rollback')).toThrow('changed');
    expect(() => cutover(root, 'retry')).toThrow('changed');
    expect([input, output, runner].map(hash)).toEqual(before);
  });

  it('validates the entire snapshot before restoring any original', () => {
    cutover(root, 'apply');
    const backup = path.join(root, '.conversation-cutover/snapshot', path.relative(root, input));
    fs.appendFileSync(backup, 'damage');
    const before = [input, output, runner].map(hash);
    expect(() => cutover(root, 'rollback')).toThrow('damaged');
    expect([input, output, runner].map(hash)).toEqual(before);
  });

  it('rejects foreign key corruption and untracked partial backfills', () => {
    withDb(output, (db) =>
      db.exec(`CREATE TABLE parent(id TEXT PRIMARY KEY);
      CREATE TABLE child(id TEXT REFERENCES parent(id)); INSERT INTO child VALUES ('missing');`),
    );
    expect(() => cutover(root, 'apply')).toThrow('foreign key');
    withDb(output, (db) => {
      db.exec(
        "DROP TABLE child; CREATE TABLE conversation_sync_migrations(step TEXT PRIMARY KEY); INSERT INTO conversation_sync_migrations VALUES('backfill:1')",
      );
    });
    expect(() => cutover(root, 'apply')).toThrow('untracked');
  });
});
