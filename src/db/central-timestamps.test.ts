import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { initTestDb, closeDb, getDb } from './connection.js';
import { runMigrations } from './migrations/index.js';
import { createAgentGroup, getAgentGroup } from './agent-groups.js';
import { createMessagingGroup, getMessagingGroup, setMessagingGroupDeniedAt } from './messaging-groups.js';
import { createSession, getSession, updateSession } from './sessions.js';
import { ensureContainerConfig, getContainerConfig } from './container-configs.js';
import { createThreadFork, getThreadFork } from './thread-forks.js';
import { createApproval, getApproval, updateApprovalStatus } from './approvals.js';
import { createInteraction, getInteraction } from './interactions.js';
import { assertTimestampFields } from './validate-timestamps.js';
import { legacyInteractionExpired } from './interactions.js';
import { createUser, getUser, isUserOnboarded, markUserOnboarded } from '../modules/permissions/db/users.js';
import { addMember, getMembers } from '../modules/permissions/db/agent-group-members.js';
import { grantRole, getUserRoles } from '../modules/permissions/db/user-roles.js';
import { createChallenge, getChallenge } from '../modules/permissions/db/identity-link-challenges.js';

beforeEach(() => {
  runMigrations(initTestDb());
  vi.spyOn(Date, 'now').mockReturnValue(0);
  createAgentGroup({ id: 'g', name: 'Group', folder: 'g', agent_provider: null, created_at: 0 });
  createUser({ id: 'u', kind: 'web', display_name: 'User', created_at: 0 });
});
afterEach(() => {
  vi.restoreAllMocks();
  closeDb();
});

it('keeps zero and null distinct across central records, permissions and configuration', () => {
  createMessagingGroup({
    id: 'mg',
    channel_type: 'web',
    platform_id: 'group:g',
    name: null,
    is_group: 1,
    unknown_sender_policy: 'strict',
    created_at: 0,
  });
  createSession({
    id: 's',
    agent_group_id: 'g',
    messaging_group_id: 'mg',
    thread_id: 't',
    agent_provider: null,
    status: 'active',
    container_status: 'stopped',
    last_active: null,
    created_at: 0,
  });
  ensureContainerConfig('g');
  addMember({ user_id: 'u', agent_group_id: 'g', added_by: null, added_at: 0 });
  grantRole({ user_id: 'u', role: 'admin', agent_group_id: 'g', granted_by: null, granted_at: 0 });
  expect(getAgentGroup('g')?.created_at).toBe(0);
  expect(getUser('u')).toMatchObject({ created_at: 0, onboarded_at: null });
  expect(getSession('s')).toMatchObject({ created_at: 0, last_active: null });
  updateSession('s', { last_active: 0 });
  expect(getSession('s')?.last_active).toBe(0);
  setMessagingGroupDeniedAt('mg', 0);
  expect(getMessagingGroup('mg')?.denied_at).toBe(0);
  setMessagingGroupDeniedAt('mg', null);
  expect(getMessagingGroup('mg')?.denied_at).toBeNull();
  expect(getContainerConfig('g')?.updated_at).toBe(0);
  expect(getMembers('g')[0].added_at).toBe(0);
  expect(getUserRoles('u')[0].granted_at).toBe(0);
  expect(isUserOnboarded('missing')).toBe(false);
  expect(isUserOnboarded('u')).toBe(false);
  markUserOnboarded('u');
  expect(isUserOnboarded('u')).toBe(true);
  expect(getUser('u')?.onboarded_at).toBe(0);
  createThreadFork({
    agent_group_id: 'g',
    messaging_group_id: 'mg',
    thread_id: 'child',
    parent_thread_id: 't',
    parent_message_id: 'anchor',
    parent_message_ts: 0,
    parent_title: null,
    fidelity: 'transcript',
    created_at: 0,
  });
  expect(getThreadFork('g', 'mg', 'child')).toMatchObject({ parent_message_ts: 0, created_at: 0 });
});

it('uses numeric deadlines and records resolved decisions at epoch zero', () => {
  createApproval({
    id: 'a',
    request_id: 'a',
    agent_group_id: 'g',
    created_at: 0,
    expires_at: 0,
    input: { action: 'test', payload: {}, title: 'Test', options: [] },
  });
  const pending = getApproval('a')!;
  expect(pending).toMatchObject({ created_at: 0, updated_at: 0, expires_at: 0, resolved_at: null });
  expect(legacyInteractionExpired(pending, -1)).toBe(false);
  expect(legacyInteractionExpired(pending, 0)).toBe(true);
  expect(legacyInteractionExpired({ status: 'pending', expires_at: null }, 0)).toBe(false);
  updateApprovalStatus('a', 'approved', { userId: 'u', decision: 'approve' });
  expect(getApproval('a')).toMatchObject({ updated_at: 0, responded_at: 0, resolved_at: 0 });
  updateApprovalStatus('a', 'pending');
  expect(getApproval('a')).toMatchObject({ responded_at: null, resolved_at: null });
  const { row } = createChallenge({ user_id: 'u', channel_type: 'web', handle: 'u', ttl_ms: 1000 });
  expect(row.expires_at).toBe(1000);
  getDb().prepare('UPDATE identity_link_challenges SET consumed_at=0 WHERE id=?').run(row.id);
  expect(getChallenge(row.id)?.consumed_at).toBe(0);
});

it.each([NaN, Infinity, -Infinity, 0.5, 8640000000000001, -8640000000000001])(
  'rejects invalid numeric instants (%s) before nullable central fields can become NULL',
  (invalid) => {
    createSession({
      id: 's',
      agent_group_id: 'g',
      messaging_group_id: null,
      thread_id: null,
      agent_provider: null,
      status: 'active',
      container_status: 'stopped',
      last_active: 1000,
      created_at: 0,
    });
    expect(() => updateSession('s', { last_active: invalid })).toThrow('Invalid epoch-millisecond timestamp');
    expect(getSession('s')?.last_active).toBe(1000);
    expect(() =>
      createSession({
        id: 'invalid',
        agent_group_id: 'g',
        messaging_group_id: null,
        thread_id: null,
        agent_provider: null,
        status: 'active',
        container_status: 'stopped',
        last_active: invalid,
        created_at: 0,
      }),
    ).toThrow('Invalid epoch-millisecond timestamp');
    expect(getSession('invalid')).toBeUndefined();
    expect(() =>
      createInteraction({
        id: 'invalid-interaction',
        kind: 'confirmation',
        created_at: 0,
        expires_at: invalid,
        input: { action: 'test', payload: {}, title: 'Test', options: [] },
      }),
    ).toThrow('Invalid epoch-millisecond timestamp');
    expect(getInteraction('invalid-interaction')).toBeUndefined();
    vi.mocked(Date.now).mockReturnValue(invalid);
    expect(() => markUserOnboarded('u')).toThrow('Invalid epoch-millisecond timestamp');
    expect(getUser('u')?.onboarded_at).toBeNull();
  },
);

it('validates only declared supplied timestamp fields without normalizing records', () => {
  const row = {
    created_at: 0,
    expires_at: null,
    responded_at: undefined,
    input: { timestamp: NaN, created_at: 0.5 },
  };
  const input = row.input;
  expect(() => assertTimestampFields(row, ['created_at', 'expires_at', 'responded_at'])).not.toThrow();
  expect(row.created_at).toBe(0);
  expect(row.expires_at).toBeNull();
  expect(row.input).toBe(input);
  expect(row.input.timestamp).toBeNaN();
  expect(() => assertTimestampFields({ created_at: 8640000000000000 }, ['created_at'])).not.toThrow();
});
