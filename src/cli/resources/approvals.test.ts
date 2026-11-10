import { afterEach, beforeEach, expect, it } from 'vitest';
import { closeDb, initTestDb } from '../../db/connection.js';
import { runMigrations } from '../../db/migrations/index.js';
import { createApproval, getApproval, updateApprovalStatus } from '../../db/approvals.js';
import { getDb } from '../../db/connection.js';
import { beginApprovalExecution, endApprovalExecution } from '../../db/sessions.js';
import { createApprovalWorkflow, linkApprovalSubmission } from '../../modules/approvals/workflows.js';
import type { CallerContext } from '../frame.js';
import { dispatch } from '../dispatch.js';
import './approvals.js';

beforeEach(() => {
  runMigrations(initTestDb());
  createApproval({
    id: 'current',
    request_id: 'current',
    created_at: 0,
    input: { action: 'test', title: 'Review', payload: {}, options: [] },
  });
});
afterEach(closeDb);

function agent(scope: 'group' | 'global' | 'disabled' = 'group'): CallerContext {
  getDb().prepare('UPDATE container_configs SET cli_scope=? WHERE agent_group_id=?').run(scope, 'group');
  return { caller: 'agent', sessionId: 'session', agentGroupId: 'group', messagingGroupId: 'web' };
}

function ownRequests() {
  getDb().exec(`
    INSERT INTO agent_groups(id,name,folder,created_at) VALUES('group','Agent','agent',0);
    INSERT INTO container_configs(agent_group_id,updated_at) VALUES('group',0);
    INSERT INTO sessions(id,agent_group_id,created_at) VALUES('session','group',0),('sibling','group',0);
  `);
  for (const sessionId of ['session', 'sibling']) {
    createApproval({
      id: sessionId,
      request_id: sessionId,
      session_id: sessionId,
      created_at: 0,
      input: { action: 'test', title: 'Review', payload: {}, options: [] },
    });
  }
}

it.each(['group', 'global'] as const)(
  'scopes approval inspection and withdrawal to the originating session with %s CLI access',
  async (scope) => {
    ownRequests();
    const ctx = agent(scope);
    const list = await dispatch({ id: 'list', command: 'approvals-list', args: { status: 'pending' } }, ctx);
    expect(list).toMatchObject({ ok: true, data: [{ id: 'session' }] });
    if (!list.ok || !Array.isArray(list.data)) throw new Error('Expected request list');
    expect(list.data).toHaveLength(1);
    for (const command of ['approvals-get', 'approvals-withdraw']) {
      const response = await dispatch({ id: 'other', command, args: { id: 'sibling' } }, ctx);
      expect(response.ok).toBe(false);
    }
    expect(getApproval('sibling')?.status).toBe('pending');
    expect(
      (await dispatch({ id: 'override', command: 'approvals-list', args: { session_id: 'sibling' } }, ctx)).ok,
    ).toBe(false);
    expect(await dispatch({ id: 'own', command: 'approvals-get', args: { id: 'session' } }, ctx)).toMatchObject({
      ok: true,
      data: { id: 'session', status: 'pending' },
    });
    expect(
      await dispatch({ id: 'withdraw', command: 'approvals-withdraw', args: { id: 'session' } }, ctx),
    ).toMatchObject({ ok: true, data: { id: 'session', status: 'cancelled' } });
    expect(getApproval('session')).toMatchObject({ status: 'cancelled', revision: 2, responded_by: null });
    expect((await dispatch({ id: 'repeat', command: 'approvals-withdraw', args: { id: 'session' } }, ctx)).ok).toBe(
      false,
    );
  },
);

it.each(['applying', 'approved', 'rejected', 'failed', 'cancelled', 'expired'] as const)(
  'does not withdraw a request that is already %s',
  async (status) => {
    ownRequests();
    updateApprovalStatus('session', status);
    const response = await dispatch(
      { id: 'withdraw', command: 'approvals-withdraw', args: { id: 'session' } },
      agent(),
    );
    expect(response).toMatchObject({
      ok: false,
      error: { message: expect.stringContaining('Only a pending request') },
    });
    expect(getApproval('session')?.status).toBe(status);
  },
);

it('cannot withdraw a pending request claimed by an executing approval callback', async () => {
  ownRequests();
  beginApprovalExecution(getApproval('session')!);
  try {
    expect(
      (await dispatch({ id: 'withdraw', command: 'approvals-withdraw', args: { id: 'session' } }, agent())).ok,
    ).toBe(false);
    expect(getApproval('session')?.status).toBe('pending');
  } finally {
    endApprovalExecution('session');
  }
});

it('resolves credential submission aliases without exposing private recovery data', async () => {
  ownRequests();
  createApprovalWorkflow('session', 'workflow');
  linkApprovalSubmission('session', 'submission-alias');
  const inspected = await dispatch({ id: 'get', command: 'approvals-get', args: { id: 'submission-alias' } }, agent());
  expect(inspected).toMatchObject({ ok: true, data: { id: 'session' } });
  if (!inspected.ok) throw new Error('Expected request inspection');
  expect(inspected.data).not.toHaveProperty('data_json');
  expect(inspected.data).not.toHaveProperty('submission_ids_json');
  expect(
    await dispatch({ id: 'withdraw', command: 'approvals-withdraw', args: { id: 'submission-alias' } }, agent()),
  ).toMatchObject({ ok: true, data: { id: 'session', status: 'cancelled' } });
});

it('preserves disabled CLI scope and requires agent authentication to withdraw', async () => {
  ownRequests();
  const req = { id: 'withdraw', command: 'approvals-withdraw', args: { id: 'session' } };
  expect((await dispatch(req, agent('disabled'))).ok).toBe(false);
  expect((await dispatch(req, { caller: 'host' })).ok).toBe(false);
  expect(getApproval('session')?.status).toBe('pending');
});

it.each([null, '1970-01-01T00:00:00Z'])(
  'rejects retired expiry filter %s rather than silently broadening the list',
  async (expires_at) => {
    const response = await dispatch(
      { id: 'list', command: 'approvals-list', args: { expires_at } },
      { caller: 'host' },
    );
    expect(response.ok).toBe(false);
    if (response.ok) throw new Error('Expected obsolete filter rejection');
    expect(response.error.message).toContain('expiry filters are no longer supported');
  },
);

it('retains the ordinary created-at filter and external timestamp format', async () => {
  const response = await dispatch(
    { id: 'list', command: 'approvals-list', args: { created_at: '1970-01-01T00:00:00Z' } },
    { caller: 'host' },
  );
  expect(response).toMatchObject({ ok: true, data: [{ id: 'current', created_at: '1970-01-01T00:00:00.000Z' }] });
});
