import { afterEach, describe, expect, it } from 'vitest';
import { closeDb, initTestDb } from '../connection.js';
import { runMigrations } from './index.js';
import { insertIdentity } from '../../modules/permissions/db/identities.js';

afterEach(closeDb);

function seed() {
  const db = initTestDb();
  runMigrations(db);
  db.exec(`
    INSERT INTO users(id,kind,created_at) VALUES('u','web',1767225600000);
    INSERT INTO agent_groups(id,name,folder,created_at) VALUES('g','Group','group',1767225600000);
    INSERT INTO messaging_groups(id,channel_type,platform_id,instance,created_at)
      VALUES('m','web','p','web',1767225600000);
  `);
  return db;
}

describe('central integrity', () => {
  it('rejects null entity keys, duplicate global roles, invalid roles and scoped owners', () => {
    const db = seed();
    expect(() => db.exec("INSERT INTO users(id,kind,created_at) VALUES(NULL,'web',1767225600000)")).toThrow('NOT NULL');
    db.exec("INSERT INTO user_roles(user_id,role,granted_at) VALUES('u','owner',1767225600000)");
    expect(() => db.exec("INSERT INTO user_roles(user_id,role,granted_at) VALUES('u','owner',1767225600000)")).toThrow(
      'UNIQUE',
    );
    for (const role of ['owner', 'invented']) {
      expect(() =>
        db
          .prepare("INSERT INTO user_roles(user_id,role,agent_group_id,granted_at) VALUES('u',?,'g',1767225600000)")
          .run(role),
      ).toThrow('CHECK');
    }
    expect(db.pragma('foreign_key_check')).toEqual([]);
  });

  it('keeps global scope nullable and enforces active routes without blocking closed sessions', () => {
    const db = seed();
    db.exec(`
      INSERT INTO sessions(id,agent_group_id,messaging_group_id,created_at) VALUES('s','g','m',1767225600000);
      INSERT INTO sessions(id,agent_group_id,messaging_group_id,status,created_at) VALUES('old','g','m','closed',1767225600000);
    `);
    expect(() =>
      db.exec(
        "INSERT INTO sessions(id,agent_group_id,messaging_group_id,created_at) VALUES('duplicate','g','m',1767225600000)",
      ),
    ).toThrow('UNIQUE');
    db.exec(
      "INSERT INTO sessions(id,agent_group_id,messaging_group_id,thread_id,created_at) VALUES('thread','g','m','t',1767225600000)",
    );
    expect(() =>
      db.exec(
        "INSERT INTO sessions(id,agent_group_id,messaging_group_id,thread_id,created_at) VALUES('duplicate','g','m','t',1767225600000)",
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
    runMigrations(db);
    db.exec("INSERT INTO users(rowid,id,kind,created_at) VALUES(99,'u','web',1767225600000)");
    runMigrations(db);
    expect(db.prepare("SELECT rowid FROM users WHERE id='u'").get()).toEqual({ rowid: 99 });
    db.exec("INSERT INTO users(id,kind,created_at) VALUES('second','web',1767225600000)");
    expect(db.prepare("SELECT user_id FROM credential_gateway_sync WHERE user_id='second'").get()).toEqual({
      user_id: 'second',
    });
    expect(db.pragma('foreign_key_check')).toEqual([]);
    runMigrations(db);
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
  });

  it('enforces primary identity uniqueness even for direct SQL writers', () => {
    const db = seed();
    db.exec(`INSERT INTO identities(user_id,channel,handle,verified_at,primary_for_channel)
      VALUES('u','web','first',0,1)`);
    expect(() =>
      db.exec(`INSERT INTO identities(user_id,channel,handle,verified_at,primary_for_channel)
      VALUES('u','web','second',0,1)`),
    ).toThrow('UNIQUE');
    db.exec(`INSERT INTO identities(user_id,channel,handle,verified_at,primary_for_channel)
      VALUES('u','web','secondary',0,0),('u','slack','first',0,1)`);
    expect(() => db.exec("UPDATE identities SET primary_for_channel=1 WHERE handle='secondary'")).toThrow('UNIQUE');
    expect(db.pragma('foreign_key_check')).toEqual([]);
  });

  it('journals identity/access mutations and preserves deleted-user reconciliation tombstones', () => {
    const db = seed();
    const revision = () =>
      db.prepare("SELECT revision FROM credential_gateway_sync WHERE user_id='u'").pluck().get() as number;
    let previous = revision();
    const mutate = (sql: string) => {
      db.exec(sql);
      expect(revision()).toBeGreaterThan(previous);
      previous = revision();
    };
    mutate("UPDATE users SET display_name='Updated' WHERE id='u'");
    mutate("INSERT INTO user_roles(user_id,role,granted_at) VALUES('u','admin',0)");
    mutate("UPDATE user_roles SET agent_group_id='g' WHERE user_id='u'");
    mutate("DELETE FROM user_roles WHERE user_id='u'");
    mutate("INSERT INTO agent_group_members(user_id,agent_group_id,added_at) VALUES('u','g',0)");
    mutate("UPDATE agent_group_members SET added_by='u' WHERE user_id='u'");
    mutate("DELETE FROM agent_group_members WHERE user_id='u'");
    mutate("INSERT INTO agent_groups(id,name,folder,created_at) VALUES('other','Other','other',0)");
    mutate("DELETE FROM agent_groups WHERE id='other'");
    mutate("DELETE FROM users WHERE id='u'");
    expect(db.prepare("SELECT id FROM users WHERE id='u'").get()).toBeUndefined();
    expect(db.prepare("SELECT user_id FROM credential_gateway_sync WHERE user_id='u'").get()).toEqual({ user_id: 'u' });
    expect(db.pragma('foreign_key_check')).toEqual([]);
  });
});
