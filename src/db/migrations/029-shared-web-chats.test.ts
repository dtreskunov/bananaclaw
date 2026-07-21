import { afterEach, describe, expect, it } from 'vitest';

import { closeDb, initTestDb } from '../connection.js';
import { migrations, runMigrations } from './index.js';
import { migration029 } from './029-shared-web-chats.js';

const NOW = '2026-07-21T00:00:00.000Z';

afterEach(() => closeDb());

describe('shared web chats migration', () => {
  it('moves legacy web sessions without changing session or thread identity', () => {
    const db = initTestDb();
    runMigrations(
      db,
      migrations.filter((migration) => migration.name !== migration029.name),
    );

    db.prepare(
      `INSERT INTO agent_groups (id, name, folder, agent_provider, created_at)
       VALUES ('ag-team', 'Team', 'team', NULL, ?)`,
    ).run(NOW);
    db.prepare(
      `INSERT INTO messaging_groups
         (id, channel_type, platform_id, instance, name, is_group,
          unknown_sender_policy, denied_at, created_at)
       VALUES ('mg-private', 'web', 'user-priya#ag-team', 'web', NULL, 0,
               'request_approval', NULL, ?)`,
    ).run(NOW);
    db.prepare(
      `INSERT INTO messaging_group_agents
         (id, messaging_group_id, agent_group_id, engage_mode, engage_pattern,
          sender_scope, ignored_message_policy, session_mode, priority, created_at)
       VALUES ('mga-private', 'mg-private', 'ag-team', 'pattern', '.', 'all',
               'drop', 'per-thread', 0, ?)`,
    ).run(NOW);
    db.prepare(
      `INSERT INTO sessions
         (id, agent_group_id, messaging_group_id, thread_id, agent_provider,
          status, container_status, last_active, created_at)
       VALUES ('session-priya', 'ag-team', 'mg-private', 'thread-priya', NULL,
               'active', 'stopped', ?, ?)`,
    ).run(NOW, NOW);

    runMigrations(db, [migration029]);

    expect(
      db
        .prepare(
          `SELECT id, agent_group_id, messaging_group_id, thread_id
           FROM sessions WHERE id = 'session-priya'`,
        )
        .get(),
    ).toEqual({
      id: 'session-priya',
      agent_group_id: 'ag-team',
      messaging_group_id: 'mg-web-shared-ag-team',
      thread_id: 'thread-priya',
    });
    expect(
      db
        .prepare(
          `SELECT mg.platform_id, mg.is_group, mga.session_mode
           FROM messaging_groups mg
           JOIN messaging_group_agents mga ON mga.messaging_group_id = mg.id
          WHERE mga.agent_group_id = 'ag-team' AND mg.channel_type = 'web'`,
        )
        .all(),
    ).toEqual([{ platform_id: 'group:ag-team', is_group: 1, session_mode: 'per-thread' }]);
  });
});
