import { afterEach, expect, it } from 'vitest';
import { closeDb, initTestDb } from '../connection.js';
import { runMigrations } from './index.js';

afterEach(closeDb);

it('starts ready, baselines new users at the current publication and retains existing read state', () => {
  const db = initTestDb();
  runMigrations(db);
  expect(db.prepare('SELECT ready,unread_ready FROM thread_summary_meta').get()).toEqual({ ready: 1, unread_ready: 1 });
  db.exec(`
    INSERT INTO users(id,kind,display_name,created_at) VALUES('existing','web','Existing',1767225600000);
    INSERT INTO agent_groups(id,name,folder,created_at) VALUES('g','Group','g',1767225600000);
    INSERT INTO sessions(id,agent_group_id,created_at) VALUES('s','g',1767225600000);
    INSERT INTO conversation_publications(session_id,kind,item_id,channel_type,platform_id,thread_id)
      VALUES('s','message','reply','web','group:g','thread');
    INSERT INTO users(id,kind,created_at) VALUES('new','web',1767225600000);
    INSERT INTO conversation_reads(user_id,session_id,channel_type,platform_id,thread_id,position)
      VALUES('existing','s','web','group:g','thread',1);
  `);
  runMigrations(db);
  expect(db.prepare('SELECT id,unread_baseline FROM users ORDER BY id').all()).toEqual([
    { id: 'existing', unread_baseline: 0 },
    { id: 'new', unread_baseline: 1 },
  ]);
  expect(db.prepare('SELECT position FROM conversation_reads').pluck().get()).toBe(1);
  const firstKey = db.prepare('SELECT key FROM conversation_publications').pluck().get();
  expect(firstKey).toMatch(/^[a-f0-9]{32}$/);
  db.exec(`DELETE FROM conversation_publications;
    INSERT INTO conversation_publications(session_id,kind,item_id,channel_type,platform_id,thread_id)
      VALUES('s','message','another','web','group:g','thread')`);
  expect(db.prepare('SELECT position,key FROM conversation_publications').get()).toEqual({
    position: 2,
    key: expect.not.stringMatching(`^${firstKey}$`),
  });
  db.exec("DELETE FROM users WHERE id='existing'");
  expect(db.prepare('SELECT * FROM conversation_reads').all()).toEqual([]);
  db.exec("DELETE FROM sessions WHERE id='s'");
  expect(db.prepare('SELECT * FROM conversation_publications').all()).toEqual([]);
  expect(db.pragma('foreign_key_check')).toEqual([]);
});
