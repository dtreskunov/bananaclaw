import { afterEach, describe, expect, it, vi } from 'vitest';

import { closeDb, initTestDb } from '../db/connection.js';
import { runMigrations } from '../db/migrations/index.js';
import { createWebAdapter, getWebPushRecipientIds, submitWebInbound, subscribeWeb } from './web.js';

const adapter = createWebAdapter();

afterEach(async () => {
  await adapter.teardown();
  closeDb();
});

describe('shared web chat', () => {
  it('notifies explicit members but not role-only administrators', () => {
    const db = initTestDb();
    runMigrations(db);
    const now = '2026-08-06T12:00:00.000Z';
    db.prepare(
      `INSERT INTO agent_groups (id, name, folder, agent_provider, created_at)
       VALUES ('ag-team', 'Team', 'team', NULL, ?)`,
    ).run(now);
    for (const id of ['member', 'owner', 'global-admin', 'scoped-admin']) {
      db.prepare(
        `INSERT INTO users (id, kind, display_name, created_at)
         VALUES (?, 'web', ?, ?)`,
      ).run(id, id, now);
    }
    db.prepare(
      `INSERT INTO agent_group_members (user_id, agent_group_id, added_by, added_at)
       VALUES ('member', 'ag-team', NULL, ?)`,
    ).run(now);
    db.prepare(
      `INSERT INTO user_roles (user_id, role, agent_group_id, granted_by, granted_at)
       VALUES ('owner', 'owner', NULL, NULL, ?),
              ('global-admin', 'admin', NULL, NULL, ?),
              ('scoped-admin', 'admin', 'ag-team', NULL, ?)`,
    ).run(now, now, now);

    expect(getWebPushRecipientIds('ag-team')).toEqual(['member']);
  });

  it('echoes an attributed inbound message to every room subscriber', async () => {
    const onInboundEvent = vi.fn();
    await adapter.setup({
      onInbound: vi.fn(),
      onInboundEvent,
      onMetadata: vi.fn(),
      onAction: vi.fn(),
    });

    const firstEcho = vi.fn();
    const secondEcho = vi.fn();
    const subscriber = (onInboundEcho: typeof firstEcho) => ({
      onOutbound: vi.fn(),
      onInboundEcho,
    });
    subscribeWeb('group:ag-team', 'thread-1', subscriber(firstEcho));
    subscribeWeb('group:ag-team', 'thread-1', subscriber(secondEcho));

    await submitWebInbound({
      userId: 'user-priya',
      senderDisplayName: 'Priya',
      platformId: 'group:ag-team',
      threadId: 'thread-1',
      text: 'Run the tests first',
      clientMessageId: 'client_msg_1',
    });

    const expectedAuthor = { userId: 'user-priya', displayName: 'Priya' };
    expect(firstEcho).toHaveBeenCalledWith('web-client_msg_1', 'Run the tests first', expectedAuthor, undefined);
    expect(secondEcho).toHaveBeenCalledWith('web-client_msg_1', 'Run the tests first', expectedAuthor, undefined);
    expect(onInboundEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        platformId: 'group:ag-team',
        threadId: 'thread-1',
        message: expect.objectContaining({
          content: JSON.stringify({
            text: 'Run the tests first',
            sender: 'Priya',
            senderId: 'user-priya',
          }),
        }),
      }),
    );
  });
});
