import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import { closeDb, initTestDb } from '../connection.js';
import { createAgentGroup, getAgentGroup } from '../agent-groups.js';
import { CENTRAL_BASELINE_MIGRATION_NAMES } from '../central-schema.js';
import { INSTANT_COLUMNS } from '../time.js';
import { runMigrations, type Migration } from './index.js';
import { STORAGE_VERSION } from '../storage-lifecycle.js';

afterEach(closeDb);

describe('canonical central baseline', () => {
  it('requires explicit removal of legacy expiring requests without changing current requests', () => {
    const db = initTestDb();
    runMigrations(db);
    db.exec(`ALTER TABLE interactions ADD COLUMN expires_at INTEGER;
      INSERT INTO interactions(id,kind,request_id,input_json,response_json,created_at,updated_at,expires_at)
      VALUES('legacy','confirmation','legacy','{}','{}',0,0,0),
        ('current','confirmation','current','{}','{}',0,0,NULL);
      INSERT INTO interaction_progress(id) VALUES('legacy');
      INSERT INTO agent_groups(id,name,folder,created_at) VALUES('g','Group','group',0);
      INSERT INTO sessions(id,agent_group_id,created_at) VALUES('s','g',0);
      INSERT INTO conversation_publications(session_id,kind,item_id,channel_type,platform_id,thread_id)
        VALUES('s','approval','legacy','web','group:g','t'),
          ('s','approval','current','web','group:g','t')`);
    const current = db.prepare("SELECT * FROM interactions WHERE id='current'").get();
    expect(() => runMigrations(db)).toThrow('Unsupported interaction expiry storage');
    expect(db.prepare('SELECT count(*) FROM interactions').pluck().get()).toBe(2);
    db.exec(`PRAGMA foreign_keys=ON;
      BEGIN;
      UPDATE conversation_publications SET visible=0
        WHERE kind IN ('question','approval') AND item_id IN (SELECT id FROM interactions WHERE expires_at IS NOT NULL);
      DELETE FROM interactions WHERE expires_at IS NOT NULL;
      ALTER TABLE interactions DROP COLUMN expires_at;
      COMMIT;`);
    const { expires_at: _retired, ...expected } = current as Record<string, unknown>;
    expect(db.prepare('SELECT * FROM interactions').all()).toEqual([expected]);
    expect(db.prepare('SELECT * FROM interaction_progress').all()).toEqual([]);
    expect(db.prepare('SELECT item_id,visible FROM conversation_publications ORDER BY position').all()).toEqual([
      { item_id: 'legacy', visible: 0 },
      { item_id: 'current', visible: 1 },
    ]);
    expect(db.pragma('foreign_key_check')).toEqual([]);
    expect(() => runMigrations(db)).not.toThrow();
    expect(() => db.exec('UPDATE interactions SET expires_at=0')).toThrow('no such column');
  });

  it('creates integer-millisecond storage directly, without table rebuilds or text timestamp DDL', () => {
    const statements: string[] = [];
    const db = new Database(':memory:', { verbose: (sql) => statements.push(String(sql)) });
    try {
      runMigrations(db);
      expect(db.pragma('user_version', { simple: true })).toBe(STORAGE_VERSION);
      expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
      expect(db.pragma('foreign_key_check')).toEqual([]);
      expect(db.pragma('integrity_check', { simple: true })).toBe('ok');
      expect(statements.join('\n')).not.toMatch(/\b(?:ALTER|DROP)\s+(?:TABLE|INDEX|TRIGGER)\b/i);
      expect(statements.join('\n')).not.toMatch(/\b(?:created_at|updated_at|applied|expires_at|ts)\s+TEXT\b/i);
      const tables = db
        .prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'")
        .all() as { name: string }[];
      expect(tables).toHaveLength(39);
      for (const table of tables) {
        const columns = db.pragma(`table_info("${table.name}")`) as { name: string; type: string }[];
        for (const column of columns.filter((column) => INSTANT_COLUMNS.has(column.name))) {
          expect(column.type, `${table.name}.${column.name}`).toBe('INTEGER');
        }
      }
      expect(
        db
          .prepare("SELECT count(*) FROM sqlite_schema WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%'")
          .pluck()
          .get(),
      ).toBe(115);
      expect(CENTRAL_BASELINE_MIGRATION_NAMES).toHaveLength(49);
      expect(
        db.prepare('SELECT version,name,typeof(applied) AS type FROM schema_version ORDER BY version').all(),
      ).toEqual(
        [...CENTRAL_BASELINE_MIGRATION_NAMES, 'central-baseline-v1'].map((name, index) => ({
          version: index + 1,
          name,
          type: 'integer',
        })),
      );
    } finally {
      db.close();
    }
  });

  it('initializes random installation identity and ready singleton rows once', () => {
    const db = initTestDb();
    runMigrations(db);
    const identity = db.prepare('SELECT * FROM credential_gateway_identity').get();
    expect(identity).toEqual({
      id: 1,
      installation_id: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/),
    });
    expect(db.prepare('SELECT * FROM thread_summary_meta').get()).toEqual({ id: 1, ready: 1, unread_ready: 1 });
    expect(() => db.exec("INSERT INTO credential_gateway_identity VALUES(2,'other')")).toThrow('CHECK');
    expect(() => db.exec('INSERT INTO thread_summary_meta VALUES(2,1,1)')).toThrow('CHECK');
    runMigrations(db);
    expect(db.prepare('SELECT * FROM credential_gateway_identity').get()).toEqual(identity);
    const other = new Database(':memory:');
    try {
      runMigrations(other);
      expect(other.prepare('SELECT * FROM credential_gateway_identity').get()).not.toEqual(identity);
    } finally {
      other.close();
    }
  });

  it('retains historic applied rows, current data, rowids, module objects and readiness on converted stores', () => {
    const db = initTestDb();
    runMigrations(db);
    db.exec(`
      DELETE FROM schema_version;
      INSERT INTO schema_version VALUES(1,'initial-v2-schema',1767225600000),
        (34,'container-configs-model-params',1767225600010),(49,'domain-integrity',1767225600123);
      INSERT INTO users(rowid,id,kind,created_at) VALUES(99,'u','web',1767225600123);
      CREATE TABLE installed_module(value TEXT);
      INSERT INTO installed_module VALUES('keep');
      CREATE INDEX installed_module_value ON installed_module(value);
      UPDATE thread_summary_meta SET ready=0,unread_ready=0;
    `);
    const objects = db.prepare('SELECT * FROM sqlite_schema ORDER BY rowid').all();
    const ledger = db.prepare('SELECT * FROM schema_version ORDER BY version').all();
    const identity = db.prepare('SELECT * FROM credential_gateway_identity').get();
    runMigrations(db, [
      {
        name: 'container-configs-model-params',
        up() {
          throw new Error('Already applied module name');
        },
      },
    ]);
    expect(db.prepare('SELECT * FROM sqlite_schema ORDER BY rowid').all()).toEqual(objects);
    expect(db.prepare('SELECT * FROM schema_version ORDER BY version').all()).toEqual(ledger);
    expect(db.prepare('SELECT * FROM credential_gateway_identity').get()).toEqual(identity);
    expect(db.prepare("SELECT rowid,created_at FROM users WHERE id='u'").get()).toEqual({
      rowid: 99,
      created_at: 1767225600123,
    });
    expect(db.prepare('SELECT value FROM installed_module').pluck().get()).toBe('keep');
    expect(db.prepare('SELECT ready,unread_ready FROM thread_summary_meta').get()).toEqual({
      ready: 0,
      unread_ready: 0,
    });
  });

  it.each([0, 1, STORAGE_VERSION + 1])(
    'rejects populated unsupported storage version %i before modifying any data or schema',
    (version) => {
      const db = initTestDb();
      db.exec(`CREATE TABLE users(id TEXT,created_at TEXT);
      INSERT INTO users VALUES('legacy','2026-01-01T00:00:00.000Z');
      PRAGMA user_version=${version}`);
      const objects = db.prepare('SELECT * FROM sqlite_schema').all();
      expect(() => runMigrations(db, [])).toThrow(`Unsupported central storage version ${version}`);
      expect(db.prepare('SELECT * FROM users').all()).toEqual([
        { id: 'legacy', created_at: '2026-01-01T00:00:00.000Z' },
      ]);
      expect(db.prepare('SELECT * FROM sqlite_schema').all()).toEqual(objects);
      expect(db.pragma('user_version', { simple: true })).toBe(version);
    },
  );

  it('rejects future storage even when empty', () => {
    const db = initTestDb();
    db.pragma(`user_version=${STORAGE_VERSION + 1}`);
    expect(() => runMigrations(db)).toThrow(`Unsupported central storage version ${STORAGE_VERSION + 1}`);
    expect(db.prepare('SELECT * FROM sqlite_schema').all()).toEqual([]);
  });

  it('stores milliseconds but preserves the public ISO codec and integer type guards', () => {
    const db = initTestDb();
    runMigrations(db);
    createAgentGroup({
      id: 'g',
      name: 'Group',
      folder: 'group',
      agent_provider: null,
      created_at: 1767225600123,
    });
    expect(getAgentGroup('g')?.created_at).toBe(1767225600123);
    expect(db.prepare('SELECT created_at,typeof(created_at) AS type FROM agent_groups').get()).toEqual({
      created_at: 1767225600123,
      type: 'integer',
    });
    expect(() => db.exec("UPDATE agent_groups SET created_at='2026-01-01T00:00:00.000Z'")).toThrow('CHECK');
    expect(() => db.exec('UPDATE agent_groups SET created_at=1.5')).toThrow('CHECK');
    expect(() => db.exec('UPDATE agent_groups SET created_at=NULL')).toThrow('NOT NULL');
    const before = Date.now();
    db.exec("INSERT INTO chat_sdk_subscriptions(thread_id) VALUES('t')");
    const subscribed = db.prepare('SELECT subscribed_at FROM chat_sdk_subscriptions').pluck().get() as number;
    expect(Number.isInteger(subscribed)).toBe(true);
    expect(subscribed).toBeGreaterThanOrEqual(before);
    expect(subscribed).toBeLessThanOrEqual(Date.now());
  });
});

describe('future named central migrations', () => {
  it('skips re-registered covered module names on a fresh baseline but runs a truly new name', () => {
    const db = initTestDb();
    runMigrations(db);
    const covered = [
      'agent-destinations',
      'agent-destinations-created-by',
      'container-configs-model-params',
      'container-configs-pip',
      'container-configs-voice-mode',
      'container-configs-transcription-model',
      'container-configs-small-model',
      'container-configs-upstream-provider',
      'container-configs-disabled-skills',
      'container-configs-credential-backend',
      'credential-connections-identity',
      'resend-thread-roots',
    ];
    const before = db.prepare('SELECT * FROM schema_version ORDER BY version').all();
    const registered: Migration[] = [
      ...covered.map((name) => ({
        name,
        up() {
          throw new Error(`Covered migration must not run: ${name}`);
        },
      })),
      { name: 'new-module-extension', up: (db) => db.exec('CREATE TABLE module_extension(value TEXT)') },
    ];
    runMigrations(db, registered);
    expect(db.prepare('SELECT * FROM schema_version WHERE version<=50 ORDER BY version').all()).toEqual(before);
    expect(db.prepare('SELECT version,name FROM schema_version WHERE version>50').all()).toEqual([
      { version: 51, name: 'new-module-extension' },
    ]);
    expect(db.prepare("SELECT name FROM sqlite_schema WHERE name='module_extension'").pluck().get()).toBe(
      'module_extension',
    );
    const after = db.prepare('SELECT * FROM schema_version ORDER BY version').all();
    runMigrations(db, registered);
    expect(db.prepare('SELECT * FROM schema_version ORDER BY version').all()).toEqual(after);
  });

  it('applies future names once in declaration order, retaining the historic applied sequence', () => {
    const db = initTestDb();
    runMigrations(db);
    db.exec("DELETE FROM schema_version; INSERT INTO schema_version VALUES(49,'domain-integrity',1767225600000)");
    const list: Migration[] = [
      { name: 'future-module', up: (db) => db.exec('CREATE TABLE future_module(value INTEGER)') },
      { name: 'future-module-data', up: (db) => db.exec('INSERT INTO future_module VALUES(7)') },
      {
        name: 'domain-integrity',
        up() {
          throw new Error('Already applied historic name');
        },
      },
      {
        name: 'future-module',
        up() {
          throw new Error('Already applied future name');
        },
      },
    ];
    runMigrations(db, list);
    const ledger = db.prepare('SELECT version,name,applied FROM schema_version ORDER BY version').all();
    expect(ledger).toEqual([
      { version: 49, name: 'domain-integrity', applied: 1767225600000 },
      { version: 50, name: 'future-module', applied: expect.any(Number) },
      { version: 51, name: 'future-module-data', applied: expect.any(Number) },
    ]);
    runMigrations(db, list);
    expect(db.prepare('SELECT * FROM future_module').all()).toEqual([{ value: 7 }]);
    expect(db.prepare('SELECT version,name,applied FROM schema_version ORDER BY version').all()).toEqual(ledger);
  });

  it('rolls back failed DDL/data and its ledger entry and restores foreign keys', () => {
    const db = initTestDb();
    runMigrations(db);
    expect(() =>
      runMigrations(db, [
        {
          name: 'failed-module',
          disableForeignKeys: true,
          up(db) {
            db.exec("CREATE TABLE failed_module(value TEXT); INSERT INTO failed_module VALUES('value')");
            throw new Error('test failure');
          },
        },
      ]),
    ).toThrow('test failure');
    expect(db.prepare("SELECT * FROM sqlite_schema WHERE name='failed_module'").get()).toBeUndefined();
    expect(db.prepare("SELECT * FROM schema_version WHERE name='failed-module'").get()).toBeUndefined();
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(db.inTransaction).toBe(false);
  });

  it('rejects newly introduced foreign-key violations atomically during rebuilds', () => {
    const db = initTestDb();
    runMigrations(db);
    expect(() =>
      runMigrations(db, [
        {
          name: 'invalid-fk-module',
          disableForeignKeys: true,
          up(db) {
            db.exec(
              "INSERT INTO user_dms(user_id,channel_type,messaging_group_id,resolved_at) VALUES('missing','web','missing',0)",
            );
          },
        },
      ]),
    ).toThrow('left FK violations');
    expect(db.prepare('SELECT * FROM user_dms').all()).toEqual([]);
    expect(db.prepare("SELECT * FROM schema_version WHERE name='invalid-fk-module'").get()).toBeUndefined();
    expect(db.pragma('foreign_key_check')).toEqual([]);
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
  });

  it('can rebuild a module parent under existing FK children without changing their identities', () => {
    const db = initTestDb();
    runMigrations(db);
    db.exec(`CREATE TABLE module_parent(id TEXT PRIMARY KEY NOT NULL);
      CREATE TABLE module_child(id TEXT PRIMARY KEY NOT NULL,parent_id TEXT REFERENCES module_parent(id));
      INSERT INTO module_parent VALUES('p');
      INSERT INTO module_child(rowid,id,parent_id) VALUES(99,'c','p')`);
    runMigrations(db, [
      {
        name: 'rebuild-module-parent',
        disableForeignKeys: true,
        up(db) {
          db.exec(`CREATE TABLE rebuilt_parent(id TEXT PRIMARY KEY NOT NULL,other TEXT);
          INSERT INTO rebuilt_parent(id) SELECT id FROM module_parent;
          DROP TABLE module_parent;
          ALTER TABLE rebuilt_parent RENAME TO module_parent`);
        },
      },
    ]);
    expect(db.prepare('SELECT rowid,id,parent_id FROM module_child').all()).toEqual([
      { rowid: 99, id: 'c', parent_id: 'p' },
    ]);
    expect(db.prepare('SELECT * FROM module_parent').all()).toEqual([{ id: 'p', other: null }]);
    expect(db.pragma('foreign_key_check')).toEqual([]);
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
  });

  it('does not silently repair existing FK orphans while applying unrelated migrations', () => {
    const db = initTestDb();
    runMigrations(db);
    db.pragma('foreign_keys=OFF');
    db.exec(
      "INSERT INTO user_dms(user_id,channel_type,messaging_group_id,resolved_at) VALUES('missing','web','missing',0)",
    );
    db.pragma('foreign_keys=ON');
    const violations = db.pragma('foreign_key_check');
    expect(violations).toHaveLength(2);
    runMigrations(db, [
      {
        name: 'unrelated-module',
        disableForeignKeys: true,
        up: (db) => db.exec('CREATE TABLE module_data(value TEXT)'),
      },
    ]);
    expect(db.pragma('foreign_key_check')).toEqual(violations);
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
  });

  it('refuses nested transactions before changing pragmas or the schema', () => {
    const db = initTestDb();
    expect(() => db.transaction(() => runMigrations(db))()).toThrow('must own their transaction');
    expect(db.pragma('user_version', { simple: true })).toBe(0);
    expect(db.prepare('SELECT * FROM sqlite_schema').all()).toEqual([]);
  });
});
