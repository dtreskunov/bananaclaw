import { afterEach, describe, expect, it } from 'vitest';
import { closeDb, initTestDb } from '../connection.js';
import { migrations, runMigrations } from './index.js';
import { migration052 } from './052-integrity.js';
import { insertIdentity } from '../../modules/permissions/db/identities.js';

afterEach(closeDb);

function seed() {
  const db = initTestDb();
  runMigrations(db);
  db.exec(`
    INSERT INTO users(id,kind,created_at) VALUES('u','web','created');
    INSERT INTO agent_groups(id,name,folder,created_at) VALUES('g','Group','group','created');
    INSERT INTO messaging_groups(id,channel_type,platform_id,instance,created_at)
      VALUES('m','web','p','web','created');
  `);
  return db;
}

describe('central integrity', () => {
  it('rejects null entity keys, duplicate global roles, invalid roles and scoped owners', () => {
    const db = seed();
    expect(() => db.exec("INSERT INTO users(id,kind,created_at) VALUES(NULL,'web','created')")).toThrow('NOT NULL');
    db.exec("INSERT INTO user_roles(user_id,role,granted_at) VALUES('u','owner','created')");
    expect(() => db.exec("INSERT INTO user_roles(user_id,role,granted_at) VALUES('u','owner','created')")).toThrow(
      'UNIQUE',
    );
    for (const role of ['owner', 'invented']) {
      expect(() =>
        db
          .prepare("INSERT INTO user_roles(user_id,role,agent_group_id,granted_at) VALUES('u',?,'g','created')")
          .run(role),
      ).toThrow('CHECK');
    }
    expect(db.pragma('foreign_key_check')).toEqual([]);
  });

  it('keeps global scope nullable and enforces active routes without blocking closed sessions', () => {
    const db = seed();
    db.exec(`
      INSERT INTO sessions(id,agent_group_id,messaging_group_id,created_at) VALUES('s','g','m','created');
      INSERT INTO sessions(id,agent_group_id,messaging_group_id,status,created_at) VALUES('old','g','m','closed','created');
    `);
    expect(() =>
      db.exec(
        "INSERT INTO sessions(id,agent_group_id,messaging_group_id,created_at) VALUES('duplicate','g','m','created')",
      ),
    ).toThrow('UNIQUE');
    db.exec(
      "INSERT INTO sessions(id,agent_group_id,messaging_group_id,thread_id,created_at) VALUES('thread','g','m','t','created')",
    );
    expect(() =>
      db.exec(
        "INSERT INTO sessions(id,agent_group_id,messaging_group_id,thread_id,created_at) VALUES('duplicate','g','m','t','created')",
      ),
    ).toThrow('UNIQUE');
  });

  it('switches primary identity atomically and rolls back a failed switch', () => {
    const db = seed();
    insertIdentity({ userId: 'u', channel: 'web', handle: 'first', primary: true });
    insertIdentity({ userId: 'u', channel: 'web', handle: 'second', primary: true });
    expect(() => insertIdentity({ userId: 'u', channel: 'web', handle: 'first', primary: true })).toThrow('UNIQUE');
    expect(db.prepare('SELECT handle FROM identities WHERE primary_for_channel=1').all()).toEqual([
      { handle: 'second' },
    ]);
  });

  it('preserves rows, rowids, trigger behavior and migration idempotence', () => {
    const db = initTestDb();
    runMigrations(
      db,
      migrations.filter((migration) => migration !== migration052),
    );
    db.exec("INSERT INTO users(rowid,id,kind,created_at) VALUES(99,'u','web','created')");
    runMigrations(db);
    expect(db.prepare("SELECT rowid FROM users WHERE id='u'").get()).toEqual({ rowid: 99 });
    db.exec("INSERT INTO users(id,kind,created_at) VALUES('second','web','created')");
    expect(db.prepare("SELECT user_id FROM credential_gateway_sync WHERE user_id='second'").get()).toEqual({
      user_id: 'second',
    });
    expect(db.pragma('foreign_key_check')).toEqual([]);
    runMigrations(db);
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
  });

  it('rolls back rather than silently repairing incompatible data', () => {
    const db = initTestDb();
    runMigrations(
      db,
      migrations.filter((migration) => migration !== migration052),
    );
    db.exec("INSERT INTO users(id,kind,created_at) VALUES(NULL,'web','created')");
    expect(() => runMigrations(db)).toThrow('NOT NULL');
    expect(db.prepare('SELECT count(*) n FROM users WHERE id IS NULL').get()).toEqual({ n: 1 });
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(db.pragma('legacy_alter_table', { simple: true })).toBe(0);
  });
});
