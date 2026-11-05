import { afterEach, expect, it } from 'vitest';
import { closeDb, initTestDb } from '../connection.js';
import { migrations, runMigrations } from './index.js';
import { migration051 } from './051-conversation-reads.js';

afterEach(closeDb);

it('preserves existing users, sessions and interactions while requiring explicit unread bootstrap', () => {
  const db = initTestDb();
  runMigrations(db, migrations.slice(0, migrations.indexOf(migration051)));
  db.exec(`
    INSERT INTO users(id,kind,display_name,created_at) VALUES('existing','web','Existing','now');
    INSERT INTO agent_groups(id,name,folder,created_at) VALUES('g','Group','g','now');
    INSERT INTO sessions(id,agent_group_id,created_at) VALUES('s','g','now');
    INSERT INTO interactions(id,kind,request_id,created_at,updated_at,input_json,response_json)
      VALUES('approval','confirmation','request','now','now','{"action":"test","title":"Keep","payload":{},"options":[]}',
        '{"decision":null,"message":null}');
  `);
  const before = db.prepare('SELECT id,input_json,response_json,status FROM interactions').all();
  runMigrations(db);
  expect(db.prepare('SELECT id,input_json,response_json,status FROM interactions').all()).toEqual(before);
  expect(db.prepare('SELECT unread_ready FROM thread_summary_meta').pluck().get()).toBe(0);
  expect(db.prepare("SELECT display_name,unread_baseline FROM users WHERE id='existing'").get()).toEqual({
    display_name: 'Existing', unread_baseline: 0,
  });
  db.exec(`INSERT INTO conversation_publications(session_id,kind,item_id,channel_type,platform_id,thread_id)
    VALUES('s','message','reply','web','group:g','thread');
    INSERT INTO users(id,kind,created_at) VALUES('new','web','now');`);
  expect(db.prepare("SELECT unread_baseline FROM users WHERE id='new'").pluck().get()).toBe(1);
});
