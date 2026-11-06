import { afterEach, expect, it } from 'vitest';
import { closeDb, initTestDb } from '../connection.js';
import { runMigrations } from './index.js';

afterEach(closeDb);

function seed() {
  const db = initTestDb();
  runMigrations(db);
  db.exec(`
    INSERT INTO agent_groups(id,name,folder,created_at) VALUES('g','Group','group',0);
    INSERT INTO messaging_groups(id,channel_type,platform_id,instance,created_at)
      VALUES('m','web','p','web',0);
    INSERT INTO container_configs(agent_group_id,updated_at) VALUES('g',0);
    INSERT INTO users(id,kind,created_at) VALUES('u','web',0);
  `);
  return db;
}

it('validates configuration JSON shapes, scope and positive integer prompt limits', () => {
  const db = seed();
  for (const [column, value] of [
    ['packages_apt', '{}'],
    ['mcp_servers', '[]'],
    ['model_params', 'null'],
    ['disabled_skills', '"all"'],
    ['skills', '"other"'],
    ['cli_scope', 'owner'],
    ['max_messages_per_prompt', 0],
    ['max_messages_per_prompt', 1.5],
  ]) {
    expect(() => db.prepare(`UPDATE container_configs SET ${column}=?`).run(value)).toThrow('domain');
  }
  db.exec(`UPDATE container_configs SET skills='["welcome"]',model_params='{"temperature":0.5}'`);
  expect(() => db.exec("UPDATE container_configs SET packages_npm='not json'")).toThrow();
});

it('rejects invalid routing values and incomplete pattern rules on insert and update', () => {
  const db = seed();
  expect(() => db.exec('UPDATE messaging_groups SET is_group=2')).toThrow('domain');
  expect(() => db.exec("UPDATE messaging_groups SET unknown_sender_policy='anything'")).toThrow('domain');
  const insert = db.prepare(`INSERT INTO messaging_group_agents
    (id,messaging_group_id,agent_group_id,created_at,session_mode,engage_mode,
      engage_pattern,sender_scope,ignored_message_policy)
    VALUES('w','m','g',0,'shared',?,?,'all','drop')`);
  expect(() => insert.run('pattern', null)).toThrow('domain');
  expect(() => insert.run('pattern', '  ')).toThrow('domain');
  insert.run('pattern', '.');
  expect(() => db.exec('UPDATE messaging_group_agents SET engage_pattern=NULL')).toThrow('domain');
  expect(() => db.exec("UPDATE messaging_group_agents SET sender_scope='everyone'")).toThrow('domain');
});

it('provides routing defaults when columns are omitted, not when explicitly null', () => {
  const db = seed();
  db.exec(`INSERT INTO messaging_group_agents(id,messaging_group_id,agent_group_id,created_at)
    VALUES('w','m','g',0)`);
  expect(
    db.prepare('SELECT engage_mode,sender_scope,ignored_message_policy FROM messaging_group_agents').get(),
  ).toEqual({ engage_mode: 'mention', sender_scope: 'all', ignored_message_policy: 'drop' });
  expect(() => db.exec('UPDATE messaging_group_agents SET engage_mode=NULL')).toThrow();
});

it('requires integer watermarks and counters without inventing user ownership references', () => {
  const db = seed();
  expect(() => db.exec('UPDATE users SET unread_baseline=-1')).toThrow('domain');
  expect(() => db.exec('UPDATE users SET unread_baseline=0.5')).toThrow('domain');
  expect(() => db.exec('UPDATE credential_gateway_sync SET revision=0')).toThrow('domain');
  expect(() => db.exec('UPDATE credential_gateway_sync SET revision=1.5')).toThrow('domain');
  db.exec("INSERT INTO credential_gateway_sync(user_id,revision) VALUES('deleted-user',1)");
  expect(db.pragma('foreign_key_check')).toEqual([]);
});

it('validates session enums, identity metadata and bounded counters on insert and update', () => {
  const db = seed();
  expect(() =>
    db.exec(`INSERT INTO sessions(id,agent_group_id,status,created_at)
    VALUES('invalid','g','deleted',0)`),
  ).toThrow('domain');
  db.exec("INSERT INTO sessions(id,agent_group_id,created_at) VALUES('s','g',0)");
  expect(() => db.exec("UPDATE sessions SET container_status='starting'")).toThrow('domain');
  expect(() =>
    db.exec(`INSERT INTO identities(user_id,channel,handle,verified_at,metadata_json)
    VALUES('u','web','bad',0,'[]')`),
  ).toThrow('domain');
  db.exec(`INSERT INTO identities(user_id,channel,handle,verified_at,metadata_json)
    VALUES('u','web','valid',0,'{}')`);
  expect(() => db.exec("UPDATE identities SET metadata_json='[]'")).toThrow('domain');
  expect(() =>
    db.exec(`INSERT INTO conversation_reads(user_id,session_id,channel_type,platform_id,thread_id,position)
    VALUES('u','s','web','p','t',9007199254740992)`),
  ).toThrow('domain');
  db.exec(`INSERT INTO conversation_reads(user_id,session_id,channel_type,platform_id,thread_id,position)
    VALUES('u','s','web','p','t',9007199254740991)`);
  expect(() => db.exec('UPDATE conversation_reads SET position=-1')).toThrow('domain');
  expect(() => db.exec("INSERT INTO chat_sdk_lists(key,idx,value) VALUES('k',-1,'v')")).toThrow('domain');
  db.exec("INSERT INTO chat_sdk_lists(key,idx,value) VALUES('k',0,'v')");
  expect(() => db.exec('UPDATE chat_sdk_lists SET idx=0.5')).toThrow('domain');
  expect(() =>
    db.exec(`INSERT INTO identity_link_challenges
    (id,user_id,channel_type,handle,code_hash,expires_at,attempts)
    VALUES('bad','u','web','h','hash',0,-1)`),
  ).toThrow('domain');
  db.exec(`INSERT INTO identity_link_challenges(id,user_id,channel_type,handle,code_hash,expires_at)
    VALUES('valid','u','web','h','hash',0)`);
  expect(() => db.exec('UPDATE identity_link_challenges SET attempts=0.5')).toThrow('domain');
  expect(() =>
    db.exec(`INSERT INTO push_subscriptions(id,user_id,endpoint,p256dh,auth,created_at,fail_count)
    VALUES('bad','u','endpoint','key','auth',0,-1)`),
  ).toThrow('domain');
  db.exec(`INSERT INTO push_subscriptions(id,user_id,endpoint,p256dh,auth,created_at)
    VALUES('valid','u','endpoint','key','auth',0)`);
  expect(() => db.exec('UPDATE push_subscriptions SET fail_count=0.5')).toThrow('domain');
  expect(() =>
    db.exec(`INSERT INTO unregistered_senders(channel_type,platform_id,reason,first_seen,last_seen,message_count)
    VALUES('web','p','unknown',0,0,0)`),
  ).toThrow('domain');
  db.exec(`INSERT INTO unregistered_senders(channel_type,platform_id,reason,first_seen,last_seen)
    VALUES('web','p','unknown',0,0)`);
  expect(() => db.exec('UPDATE unregistered_senders SET message_count=0')).toThrow('domain');
});

it('rejects invalid inserted configuration and rolls back an invalid transactional update', () => {
  const db = seed();
  db.exec("INSERT INTO agent_groups(id,name,folder,created_at) VALUES('other','Other','other',0)");
  expect(() =>
    db.exec(`INSERT INTO container_configs(agent_group_id,updated_at,model_params)
    VALUES('other',0,'[]')`),
  ).toThrow('domain');
  expect(() =>
    db.transaction(() => {
      db.exec('UPDATE container_configs SET model_params=\'{"temperature":0.5}\'');
      db.exec("UPDATE container_configs SET model_params='[]'");
    })(),
  ).toThrow('domain');
  expect(db.prepare('SELECT model_params FROM container_configs').get()).toEqual({ model_params: '{}' });
  runMigrations(db);
  expect(() => db.exec("UPDATE container_configs SET cli_scope='owner'")).toThrow('domain');
});
