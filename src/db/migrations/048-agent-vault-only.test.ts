import { afterEach, expect, it } from 'vitest';
import { closeDb, initTestDb } from '../connection.js';
import { migrations, runMigrations } from './index.js';
import { migration048 } from './048-agent-vault-only.js';

afterEach(closeDb);
function beforeRetirement() {
  const db = initTestDb();
  runMigrations(
    db,
    migrations.filter((migration) => migration.name !== migration048.name),
  );
  db.exec("INSERT INTO agent_groups(id,name,folder,created_at) VALUES('g','Agent','agent','created')");
  return db;
}
it('preserves approved groups, renames both skill selections and rejects retired backends', () => {
  const db = beforeRetirement();
  db.prepare('INSERT INTO container_configs(agent_group_id,skills,disabled_skills,updated_at) VALUES(?,?,?,?)').run(
    'g',
    '["onecli-gateway","agent-vault","other"]',
    '["onecli-gateway"]',
    'original',
  );
  runMigrations(db);
  expect(
    db.prepare('SELECT skills,disabled_skills,credential_backend,updated_at FROM container_configs').get(),
  ).toEqual({
    skills: '["agent-vault","other"]',
    disabled_skills: '["agent-vault"]',
    credential_backend: 'agent-vault',
    updated_at: 'original',
  });
  expect(() => db.prepare("UPDATE container_configs SET credential_backend='onecli'").run()).toThrow();
  runMigrations(db);
  expect(db.prepare('SELECT COUNT(*) FROM container_configs').pluck().get()).toBe(1);
});
it('blocks an unmigrated installation without silently changing access', () => {
  const db = beforeRetirement();
  db.exec(
    "INSERT INTO container_configs(agent_group_id,credential_backend,updated_at) VALUES('g','onecli','original')",
  );
  expect(() => runMigrations(db)).toThrow('Complete the reviewed credential cutovers');
  expect(db.prepare('SELECT credential_backend FROM container_configs').pluck().get()).toBe('onecli');
});
it('blocks pending retired approvals without discarding their audit or response state', () => {
  const db = beforeRetirement();
  db.exec(
    'CREATE TABLE pending_approvals(approval_id TEXT,request_id TEXT,action TEXT,payload TEXT,created_at TEXT);' +
      "INSERT INTO pending_approvals(approval_id,request_id,action,payload,created_at) VALUES('p','p','onecli_credential','{}','created')",
  );
  expect(() => runMigrations(db)).toThrow('Resolve retired gateway approvals');
  expect(db.prepare('SELECT COUNT(*) FROM pending_approvals').pluck().get()).toBe(1);
});
