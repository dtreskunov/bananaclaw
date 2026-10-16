import { afterEach, describe, expect, it, vi } from 'vitest';

import { closeDb, initTestDb } from '../db/connection.js';
import { runMigrations } from '../db/migrations/index.js';
import { createWebAdapter, getWebPushRecipientIds, submitWebInbound } from './web.js';

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

  it('routes an attributed inbound message', async () => {
    const onInboundEvent = vi.fn();
    await adapter.setup({
      onInbound: vi.fn(),
      onInboundEvent,
      onMetadata: vi.fn(),
      onAction: vi.fn(),
    });

    const id = await submitWebInbound({
      userId: 'user-priya',
      senderDisplayName: 'Priya',
      platformId: 'group:ag-team',
      threadId: 'thread-1',
      text: 'Run the tests first',
      clientMessageId: 'client_msg_1',
    });

    expect(id).toBe('web-client_msg_1');
    expect(onInboundEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        platformId: 'group:ag-team',
        threadId: 'thread-1',
        message: expect.objectContaining({
          id: 'web-client_msg_1',
          content: JSON.stringify({
            text: 'Run the tests first',
            sender: 'Priya',
            senderId: 'user-priya',
          }),
        }),
      }),
    );
  });

  it('persists submission intent without claiming it was applied', async () => {
    const onInboundEvent = vi.fn();
    await adapter.setup({ onInbound: vi.fn(), onInboundEvent, onMetadata: vi.fn(), onAction: vi.fn() });
    const inputHandling = { mode: 'steer' as const, turnId: 'captured-turn' };
    const args = {
      userId: 'member',
      senderDisplayName: 'Member',
      platformId: 'group:agent',
      threadId: 'thread',
      text: 'Use the new requirement',
      clientMessageId: 'stable-client-id',
      inputHandling,
    };
    expect(await submitWebInbound(args)).toBe('web-stable-client-id');
    expect(await submitWebInbound(args)).toBe('web-stable-client-id');
    expect(JSON.parse(onInboundEvent.mock.calls[0][0].message.content)).toMatchObject({ inputHandling });
    expect(onInboundEvent.mock.calls[0][0].message.idempotent).toBe(true);
    expect(onInboundEvent.mock.calls[0][0].message.content).not.toContain('applied');
  });
});
