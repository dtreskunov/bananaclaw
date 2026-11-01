import { afterEach, expect, it } from 'vitest';
import { closeDb, initTestDb } from '../connection.js';
import { migrations, runMigrations } from './index.js';
import { migration047 } from './047-approval-history.js';
afterEach(() => closeDb());
it('backfills existing session-bound decisions without inventing conversations for gateway approvals', () => {
  const db = initTestDb();
  runMigrations(
    db,
    migrations.filter((migration) => migration.version < 47),
  );
  db.exec(`
    INSERT INTO agent_groups(id,name,folder,created_at) VALUES('g','Agent','agent','created');
    INSERT INTO sessions(id,agent_group_id,created_at) VALUES('s','g','created');
    INSERT INTO pending_approvals(approval_id,session_id,request_id,action,payload,title,options_json,created_at,status)
      VALUES('access','s','access','request_access','{}','Access','[]','created','approved'),
        ('gateway',NULL,'gateway','onecli_credential','{}','Gateway','[]','created','pending');
    INSERT INTO approval_workflows(approval_id,dedupe_key,origin_json,stage,data_json,result_json,updated_at)
      VALUES('access','access','{"messageId":"original-input"}','completed','{"userId":"owner"}',
        '{"response_message":{"userId":"owner","message":"Use read-only operations."}}','resolved');
  `);
  runMigrations(db, [migration047]);
  expect(
    db
      .prepare(
        'SELECT approval_id,origin_message_id,status,responded_by,response_message,resolved_at FROM approval_history',
      )
      .all(),
  ).toEqual([
    {
      approval_id: 'access',
      origin_message_id: 'original-input',
      status: 'approved',
      responded_by: 'owner',
      response_message: 'Use read-only operations.',
      resolved_at: 'resolved',
    },
  ]);
  runMigrations(db, [migration047]);
  expect(db.prepare('SELECT COUNT(*) FROM approval_history').pluck().get()).toBe(1);
});
