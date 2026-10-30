import fs from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  wake: vi.fn().mockResolvedValue(undefined),
  messages: new Map<string, unknown>(),
  get: vi.fn(),
  grant: vi.fn(),
  directory: `/tmp/nanoclaw-access-${process.pid}`,
  origin: { id: 'human-request', sender_user_id: 'alice' },
}));
vi.mock('../../container-runner.js', () => ({
  wakeContainer: mocks.wake,
  isContainerRunning: () => false,
  killContainer: vi.fn(),
}));
vi.mock('../../session-manager.js', () => ({
  openInboundDb: () => ({ prepare: () => ({ get: () => mocks.origin }), close: () => {} }),
  writeSessionMessage: (_gid: string, _sid: string, message: { id: string }) => {
    if (!mocks.messages.has(message.id)) mocks.messages.set(message.id, message);
  },
}));
vi.mock('./shared-connections.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./shared-connections.js')>()),
  getConnection: mocks.get,
  grantConnection: mocks.grant,
  groupConnectionAccess: async () => [
    { connection_id: 'private-connection', status: 'active', services: [{ auth: { token: 'BIND_TESTHANDLE' } }] },
  ],
}));
vi.mock('./mcp-authentication.js', () => ({
  resolveMcpAuthentication: async (_group: string, servers: Record<string, unknown>) => ({
    servers,
    statuses: Object.keys(servers).map((server) => ({ server, status: 'ready' })),
  }),
}));
vi.mock('../approvals/primitive.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../approvals/primitive.js')>()),
  pickApprovalDelivery: vi.fn().mockResolvedValue(null),
}));
import { closeDb, getDb, initTestDb } from '../../db/connection.js';
import { runMigrations } from '../../db/migrations/index.js';
import { createSession, deleteSession, getPendingApproval } from '../../db/sessions.js';
import { grantRole } from '../permissions/db/user-roles.js';
import { getInteractiveApprovalHandler } from '../approvals/primitive.js';
import {
  getApprovalWorkflow,
  claimApprovalWorkflow,
  finishApprovalWorkflow,
  notifyApprovalWorkflow,
} from '../approvals/workflows.js';
import {
  accessRequestInput,
  accessRequestStatus,
  applyAccessRequest,
  cancelAccessRequest,
  previewAccessRequest,
  recoverAccessRequests,
  retryAccessRequest,
  requestAccess,
  reviewAccessRequest,
} from './access-requests.js';
import type { SharedConnection } from './shared-connections.js';
import type { Session } from '../../types.js';
import { getDeliveryAction } from '../../delivery.js';
import { dispatch } from '../../cli/dispatch.js';
import '../../cli/commands/access.js';

const rev = `"${'a'.repeat(64)}"`;
const session: Session = {
  id: 'sess-access',
  agent_group_id: 'ag-access',
  messaging_group_id: null,
  thread_id: 'original-thread',
  status: 'active',
  container_status: 'stopped',
  agent_provider: null,
  created_at: 'before',
  last_active: 'before',
};
const input = { resource_url: 'https://api.example.com/v1/items', reason: 'Finish the requested report.' };
let connection: SharedConnection;

beforeEach(() => {
  runMigrations(initTestDb());
  const db = getDb();
  for (const id of ['alice', 'bob', 'member'])
    db.prepare('INSERT INTO users(id,kind,display_name,created_at) VALUES(?,?,?,?)').run(id, 'test', id, 'before');
  db.prepare(
    "INSERT INTO agent_groups(id,name,folder,created_at) VALUES('ag-access','My Agent','agent','before')",
  ).run();
  db.prepare("INSERT INTO container_configs(agent_group_id,updated_at) VALUES('ag-access','before')").run();
  createSession(session);
  for (const id of ['alice', 'bob'])
    grantRole({
      user_id: id,
      role: 'admin',
      agent_group_id: session.agent_group_id,
      granted_by: null,
      granted_at: 'before',
    });
  connection = {
    id: 'private-connection',
    label: 'Personal API',
    kind: 'static',
    status: 'ready',
    revision: rev,
    owner: { id: 'native-alice' },
    services: [
      {
        name: 'api',
        host: 'api.example.com:443',
        path: '/v1/*',
        https_only: true,
        auth: { type: 'bearer', token: 'API_KEY' },
      },
    ],
    credentials: ['API_KEY'],
    grants: [],
  };
  mocks.get.mockReset().mockImplementation(async (userId: string) => {
    if (userId !== 'alice')
      throw new (await import('./shared-connections.js')).ConnectionInputError('Not your connection', 403);
    return structuredClone(connection);
  });
  mocks.grant.mockReset().mockImplementation(async () => {
    connection.grants = [{ vault: session.agent_group_id, services: ['api'], status: 'active' }];
    connection.revision = `"${'b'.repeat(64)}"`;
    return connection;
  });
  mocks.messages.clear();
  mocks.origin = { id: 'human-request', sender_user_id: 'alice' };
  mocks.wake.mockClear();
});
afterEach(() => {
  closeDb();
  if (fs.existsSync(mocks.directory)) fs.rmSync(mocks.directory, { recursive: true });
});

async function seed(id = 'appr-access-test') {
  // Web review remains available even without a delivery adapter or configured DM.
  return requestAccess(session, input, id);
}
const selection = (revision = 1) => ({
  connection_id: connection.id,
  connection_revision: connection.revision,
  request_revision: revision,
});
function resultMessage(id: string) {
  const result = JSON.parse(getApprovalWorkflow(id)!.result_json!) as { notification_id?: string };
  return mocks.messages.get(result.notification_id ?? `approval-result-${id}`);
}

describe('assisted access approvals', () => {
  it('accepts safe authentication JSON through ncl without granting access', async () => {
    const response = await dispatch(
      {
        id: 'auth-hint-cli',
        command: 'access-request',
        args: {
          'resource-url': input.resource_url,
          reason: input.reason,
          authentication: JSON.stringify({ type: 'api-key', header: 'X-Research-Key', prefix: 'Token ' }),
        },
      },
      { caller: 'agent', sessionId: session.id, agentGroupId: session.agent_group_id, messagingGroupId: '' },
    );
    expect(response).toMatchObject({
      ok: true,
      data: { status: 'pending', authentication: { type: 'api-key', header: 'X-Research-Key', prefix: 'Token ' } },
    });
    expect(mocks.grant).not.toHaveBeenCalled();
  });
  it('persists researched mechanism/scope hints and rejects incompatible direct grant attempts', async () => {
    const request = await requestAccess(session, {
      ...input,
      authentication: { type: 'mcp_oauth', app_id: 'google' },
      scopes: ['read'],
    });
    expect(accessRequestStatus(request.request_id)).toMatchObject({
      authentication: { type: 'mcp_oauth', app_id: 'google' },
      scopes: ['read'],
    });
    expect((await previewAccessRequest('alice', request.request_id, connection.id)).matches).toBe(false);
    await expect(applyAccessRequest('alice', request.request_id, selection())).rejects.toThrow('Connect a compatible');
    connection.kind = 'mcp_oauth';
    connection.app_id = 'google';
    connection.scope_source = 'provider';
    connection.granted_scopes = ['other'];
    await expect(applyAccessRequest('alice', request.request_id, selection())).rejects.toThrow('Connect a compatible');
    connection.granted_scopes = ['read'];
    expect((await applyAccessRequest('alice', request.request_id, selection())).status).toBe('completed');
  });
  it('accepts the real MCP transport envelope and provides session-scoped ncl parity', async () => {
    await getDeliveryAction('request_access')!(
      { action: 'request_access', requestId: 'appr-access-envelope', timelinePosition: 123, ...input },
      session,
      getDb(),
    );
    expect(accessRequestStatus('appr-access-envelope', session.id).status).toBe('pending');
    const ctx = {
      caller: 'agent' as const,
      sessionId: session.id,
      agentGroupId: session.agent_group_id,
      messagingGroupId: '',
    };
    const requested = await dispatch(
      {
        id: 'cli-request',
        command: 'access-request',
        args: { 'resource-url': input.resource_url, reason: input.reason },
      },
      ctx,
    );
    expect(requested).toMatchObject({ ok: true, data: { request_id: 'appr-access-envelope', status: 'pending' } });
    expect(
      await dispatch(
        { id: 'cli-status', command: 'access-status', args: { 'request-id': 'appr-access-envelope' } },
        ctx,
      ),
    ).toMatchObject({ ok: true, data: { status: 'pending' } });
    expect(
      await dispatch(
        { id: 'forged', command: 'access-status', args: { 'request-id': 'appr-access-envelope', group: 'other' } },
        ctx,
      ),
    ).toMatchObject({ ok: false });
  });

  it('persists in the common queue, deduplicates and never grants on submission', async () => {
    const first = await seed();
    const duplicate = await seed('appr-access-duplicate');
    expect(first.request_id).toBe(duplicate.request_id);
    expect(accessRequestStatus('appr-access-duplicate', session.id).request_id).toBe(first.request_id);
    expect(first.status).toBe('pending');
    expect(getPendingApproval(first.request_id)?.action).toBe('request_access');
    expect(getDb().prepare('SELECT COUNT(*) n FROM pending_approvals').get()).toEqual({ n: 1 });
    expect(mocks.grant).not.toHaveBeenCalled();
    expect(getDb().pragma('foreign_key_check')).toEqual([]);
  });
  it.each([
    { ...input, owner: 'someone' },
    { ...input, token: 'value' },
    { ...input, resource_url: 'http://api.example.com/' },
    { ...input, resource_url: 'https://user:pass@api.example.com/' },
    { ...input, resource_url: 'https://api.example.com/?key=value' },
    { ...input, resource_url: 'https://*.example.com/' },
    { ...input, scopes: ['contains whitespace'] },
  ])('rejects secret/authority overrides and unsafe requests: %j', (raw) => {
    expect(() => accessRequestInput(raw)).toThrow();
  });
  it('does not reveal a different session request or another owner connection', async () => {
    const request = await seed();
    expect(() => accessRequestStatus(request.request_id, 'other-session')).toThrow('not found');
    expect(() => reviewAccessRequest('member', request.request_id)).toThrow();
    await expect(previewAccessRequest('bob', request.request_id, connection.id)).rejects.toThrow('Not your connection');
    expect(JSON.stringify(accessRequestStatus(request.request_id, session.id))).not.toContain('private-connection');
  });
  it('requires private review; generic approve does not execute credentials', async () => {
    const request = await seed();
    const approval = getPendingApproval(request.request_id)!;
    await expect(
      getInteractiveApprovalHandler(approval.action)!(
        approval,
        {
          questionId: approval.approval_id,
          userId: 'alice',
          channelType: 'web',
          platformId: 'alice',
          threadId: null,
          value: 'approve',
        },
        'alice',
      ),
    ).rejects.toThrow('Review access');
    expect(mocks.grant).not.toHaveBeenCalled();
    expect(getApprovalWorkflow(request.request_id)?.stage).toBe('pending');
  });
  it.each(['static', 'oauth_app', 'mcp_oauth'] as const)(
    'grants a reviewed %s and notifies the original thread once',
    async (kind) => {
      connection.kind = kind;
      const request = await seed();
      const preview = await previewAccessRequest('alice', request.request_id, connection.id);
      expect(preview.matches).toBe(true);
      expect(preview.grantBreadth).toContain('future URL patterns');
      const result = await applyAccessRequest('alice', request.request_id, selection());
      expect(result.status).toBe('completed');
      expect(mocks.grant).toHaveBeenCalledWith('alice', connection.id, session.agent_group_id, { revision: rev });
      await notifyApprovalWorkflow(request.request_id);
      expect([...mocks.messages.keys()].filter((key) => key.startsWith('approval-result-'))).toHaveLength(1);
      expect(resultMessage(request.request_id)).toMatchObject({
        threadId: session.thread_id,
        idempotent: true,
      });
      await expect(applyAccessRequest('alice', request.request_id, selection())).rejects.toThrow('no longer pending');
    },
  );
  it.each(['bearer', 'basic', 'api-key', 'custom', 'passthrough'])(
    'uses the same approval path for %s injection',
    async (authType) => {
      connection.services[0].auth =
        authType === 'basic'
          ? { type: authType, username: 'USERNAME', password: 'PASSWORD' }
          : authType === 'api-key'
            ? { type: authType, key: 'API_KEY', header: 'X-Api-Key' }
            : authType === 'custom'
              ? { type: authType, headers: { 'X-Api-Key': '{{ API_KEY }}' } }
              : { type: authType, token: 'API_KEY' };
      if (authType === 'passthrough')
        connection.services[0].substitutions = [{ key: 'API_KEY', placeholder: '__API_KEY__', in: ['query'] }];
      const request = await seed();
      const result = await applyAccessRequest('alice', request.request_id, selection());
      expect(result.status).toBe('completed');
      expect(result.result?.message).toContain(authType);
      if (authType === 'passthrough') expect(result.result?.message).toContain('__API_KEY__');
    },
  );
  it('refuses mismatches, missing OAuth consent and stale credential/request revisions', async () => {
    const request = await seed();
    connection.status = 'draft';
    await expect(applyAccessRequest('alice', request.request_id, selection())).rejects.toThrow('Connect a compatible');
    connection.status = 'ready';
    connection.services[0].host = 'other.example.com';
    await expect(applyAccessRequest('alice', request.request_id, selection())).rejects.toThrow('Connect a compatible');
    connection.services[0].host = 'api.example.com';
    await expect(
      applyAccessRequest('alice', request.request_id, { ...selection(), connection_revision: '"old"' }),
    ).rejects.toThrow('changed');
    await expect(applyAccessRequest('alice', request.request_id, selection(0))).rejects.toThrow('changed');
    expect(mocks.grant).not.toHaveBeenCalled();
  });
  it('requires current destination administration and reapproves suspended grants', async () => {
    const request = await seed();
    getDb().prepare("DELETE FROM user_roles WHERE user_id='alice'").run();
    await expect(applyAccessRequest('alice', request.request_id, selection())).rejects.toThrow('administrator');
    expect(mocks.grant).not.toHaveBeenCalled();
    grantRole({
      user_id: 'alice',
      role: 'admin',
      agent_group_id: session.agent_group_id,
      granted_by: null,
      granted_at: 'now',
    });
    connection.grants = [{ vault: session.agent_group_id, status: 'suspended', services: ['api'] }];
    expect((await applyAccessRequest('alice', request.request_id, selection())).status).toBe('completed');
  });
  it('applies only the explicitly reviewed MCP selector and schedules a fresh session', async () => {
    connection.kind = 'mcp_oauth';
    const servers = {
      example: { type: 'http', url: input.resource_url, headers: { 'X-Keep': 'unchanged' } },
      other: {
        type: 'http',
        url: input.resource_url,
        authentication: { connection_id: 'other-account', account_alias: 'Work' },
        headers: { Authorization: 'Bearer av-access:BIND_OTHER' },
      },
    };
    getDb()
      .prepare('UPDATE container_configs SET mcp_servers=? WHERE agent_group_id=?')
      .run(JSON.stringify(servers), session.agent_group_id);
    const request = await seed();
    const preview = await previewAccessRequest('alice', request.request_id, connection.id);
    expect(preview.mcp.names).toEqual(['example', 'other']);
    const result = await applyAccessRequest('alice', request.request_id, {
      ...selection(),
      configure_mcp: true,
      config_revision: preview.mcp.revision,
      mcp_server: 'example',
      account_alias: 'Personal',
    });
    expect(result.status).toBe('completed');
    const config = getDb()
      .prepare('SELECT mcp_servers FROM container_configs WHERE agent_group_id=?')
      .get(session.agent_group_id) as { mcp_servers: string };
    expect(JSON.parse(config.mcp_servers)).toEqual({
      ...servers,
      example: {
        ...servers.example,
        headers: { 'X-Keep': 'unchanged' },
        authentication: { connection_id: connection.id, account_alias: 'Personal' },
      },
    });
    expect(resultMessage(request.request_id)).toMatchObject({ onWake: 1 });
    expect(result.result?.message).toContain('Only MCP server "example"');
    expect(result.result?.message).not.toContain('BIND_TESTHANDLE');
  });
  it('rejects stale MCP configuration before granting or restarting', async () => {
    connection.kind = 'mcp_oauth';
    getDb()
      .prepare('UPDATE container_configs SET mcp_servers=? WHERE agent_group_id=?')
      .run(JSON.stringify({ server: { type: 'http', url: input.resource_url } }), session.agent_group_id);
    const request = await seed();
    await expect(
      applyAccessRequest('alice', request.request_id, {
        ...selection(),
        configure_mcp: true,
        config_revision: 'stale',
      }),
    ).rejects.toThrow('Review one named');
    expect(mocks.grant).not.toHaveBeenCalled();
  });
  it('pins an access request to its named server and refuses an all-URL or different-server update', async () => {
    const servers = {
      personal: { type: 'http', url: input.resource_url },
      work: { type: 'http', url: input.resource_url },
    };
    getDb()
      .prepare('UPDATE container_configs SET mcp_servers=? WHERE agent_group_id=?')
      .run(JSON.stringify(servers), session.agent_group_id);
    const request = await requestAccess(session, { ...input, mcp_server: 'personal' });
    const preview = await previewAccessRequest('alice', request.request_id, connection.id);
    expect(preview.mcp.names).toEqual(['personal']);
    await expect(
      applyAccessRequest('alice', request.request_id, {
        ...selection(),
        configure_mcp: true,
        config_revision: preview.mcp.revision,
        mcp_server: 'work',
        account_alias: 'Work',
      }),
    ).rejects.toThrow('Review one named');
    await expect(
      applyAccessRequest('alice', request.request_id, {
        ...selection(),
        configure_mcp: true,
        config_revision: preview.mcp.revision,
      }),
    ).rejects.toThrow('Review one named');
    await expect(requestAccess(session, { ...input, mcp_server: 'missing' })).rejects.toThrow('no longer matches');
    expect(mocks.grant).not.toHaveBeenCalled();
  });
  it('keeps duplicate apply requests from executing concurrently', async () => {
    const request = await seed();
    const results = await Promise.allSettled([
      applyAccessRequest('alice', request.request_id, selection()),
      applyAccessRequest('alice', request.request_id, selection()),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(mocks.grant).toHaveBeenCalledTimes(1);
  });
  it('records failure without claiming successful application', async () => {
    const request = await seed();
    mocks.grant.mockRejectedValueOnce(new Error('gateway failed'));
    await expect(applyAccessRequest('alice', request.request_id, selection())).rejects.toThrow('gateway failed');
    expect(accessRequestStatus(request.request_id).status).toBe('failed');
    expect(accessRequestStatus(request.request_id).result?.message).toContain('Some changes may have applied');
  });
  it('persists the returned post-grant ETag separately from the exact reviewed revision', async () => {
    const request = await seed();
    const reviewed = selection();
    await applyAccessRequest('alice', request.request_id, reviewed);
    expect(connection.revision).not.toBe(reviewed.connection_revision);
    expect(JSON.parse(getApprovalWorkflow(request.request_id)!.data_json)).toMatchObject({
      reviewedConnectionRevision: reviewed.connection_revision,
      connectionRevision: connection.revision,
      grantApplied: true,
    });
  });
  it('fails closed on a concurrent policy change and permits fresh reviewed retry without replaying the grant', async () => {
    const request = await seed();
    mocks.grant.mockImplementationOnce(async () => {
      connection.grants = [{ vault: session.agent_group_id, services: ['api'], status: 'active' }];
      const receipt = { ...structuredClone(connection), revision: `"${'b'.repeat(64)}"` };
      connection.revision = `"${'c'.repeat(64)}"`;
      return receipt;
    });
    await expect(applyAccessRequest('alice', request.request_id, selection())).rejects.toThrow('could not be verified');
    const failed = accessRequestStatus(request.request_id);
    expect(failed.status).toBe('failed');
    expect(failed.result?.message).toContain('grant verification');
    const retry = retryAccessRequest('alice', request.request_id, { request_revision: failed.revision });
    expect(retry.status).toBe('pending');
    expect(retry.result).toBeNull();
    expect(mocks.grant).toHaveBeenCalledTimes(1);
    await expect(applyAccessRequest('alice', request.request_id, selection(1))).rejects.toThrow('changed');
    await applyAccessRequest('alice', request.request_id, selection(retry.revision));
    expect(accessRequestStatus(request.request_id).status).toBe('completed');
    expect(mocks.grant).toHaveBeenCalledTimes(1);
    expect(JSON.parse(getApprovalWorkflow(request.request_id)!.data_json).attempt_history).toHaveLength(1);
    expect([...mocks.messages.keys()].filter((key) => key.startsWith('approval-result-'))).toHaveLength(2);
    await notifyApprovalWorkflow(request.request_id);
    expect([...mocks.messages.keys()].filter((key) => key.startsWith('approval-result-'))).toHaveLength(2);
  });
  it('rejects unauthorized, stale, terminal and expired retries without reopening them', async () => {
    const request = await seed();
    expect(() => retryAccessRequest('alice', request.request_id, { request_revision: 1 })).toThrow('failed request');
    finishApprovalWorkflow(request.request_id, 'failed', 'test failure');
    const failed = accessRequestStatus(request.request_id);
    expect(() => retryAccessRequest('member', request.request_id, { request_revision: failed.revision })).toThrow();
    expect(() => retryAccessRequest('alice', request.request_id, { request_revision: 1 })).toThrow('failed request');
    getDb()
      .prepare('UPDATE pending_approvals SET expires_at=? WHERE approval_id=?')
      .run('2000-01-01', request.request_id);
    expect(() => retryAccessRequest('alice', request.request_id, { request_revision: failed.revision })).toThrow(
      'expired',
    );
    expect(getApprovalWorkflow(request.request_id)?.stage).toBe('failed');
    expect(mocks.grant).not.toHaveBeenCalled();
  });
  it('does not let an old failure notification acknowledge a newer retry outcome', async () => {
    const request = await seed();
    finishApprovalWorkflow(request.request_id, 'failed', 'test failure');
    mocks.wake.mockImplementationOnce(async () => {
      const failed = accessRequestStatus(request.request_id);
      retryAccessRequest('alice', request.request_id, { request_revision: failed.revision });
      finishApprovalWorkflow(request.request_id, 'completed', 'retry outcome');
    });
    await notifyApprovalWorkflow(request.request_id);
    expect(getApprovalWorkflow(request.request_id)?.notified).toBe(0);
    await notifyApprovalWorkflow(request.request_id);
    expect(getApprovalWorkflow(request.request_id)?.notified).toBe(1);
    expect([...mocks.messages.keys()].filter((key) => key.startsWith('approval-result-'))).toHaveLength(2);
  });
  it('deduplicates pre-upgrade notification receipts using their legacy message ID', async () => {
    const request = await seed();
    finishApprovalWorkflow(request.request_id, 'failed', 'legacy failure');
    getDb()
      .prepare('UPDATE approval_workflows SET result_json=? WHERE approval_id=?')
      .run(JSON.stringify({ message: 'legacy failure' }), request.request_id);
    await notifyApprovalWorkflow(request.request_id);
    expect(mocks.messages.has(`approval-result-${request.request_id}`)).toBe(true);
    await notifyApprovalWorkflow(request.request_id);
    expect([...mocks.messages.keys()].filter((key) => key.startsWith('approval-result-'))).toHaveLength(1);
  });
  it('guards session deletion during application and does not treat resolved workflows as pending', async () => {
    const request = await seed();
    mocks.grant.mockImplementationOnce(async () => {
      expect(() => deleteSession(session.id, true)).toThrow('being processed');
      connection.grants = [{ vault: session.agent_group_id, services: ['api'], status: 'active' }];
      return connection;
    });
    await applyAccessRequest('alice', request.request_id, selection());
    expect(deleteSession(session.id)).toBe(0);
    expect(getApprovalWorkflow(request.request_id)).toBeUndefined();
  });
  it('supports cancellation, rejection and expiry without changing grants', async () => {
    const cancelled = await seed('appr-access-cancel');
    await cancelAccessRequest(cancelled.request_id, session.id);
    expect(accessRequestStatus(cancelled.request_id).status).toBe('cancelled');
    mocks.origin.id = 'new-human-request';
    const rejected = await seed('appr-access-reject');
    const approval = getPendingApproval(rejected.request_id)!;
    await getInteractiveApprovalHandler(approval.action)!(
      approval,
      {
        questionId: approval.approval_id,
        userId: 'alice',
        channelType: 'web',
        platformId: 'alice',
        threadId: null,
        value: 'reject',
      },
      'alice',
    );
    expect(accessRequestStatus(rejected.request_id).status).toBe('rejected');
    expect((await seed('appr-access-reject-repeat')).request_id).toBe(rejected.request_id);
    mocks.origin.id = 'another-human-request';
    const expired = await seed('appr-access-expire');
    getDb()
      .prepare('UPDATE pending_approvals SET expires_at=? WHERE approval_id=?')
      .run('2000-01-01', expired.request_id);
    await recoverAccessRequests();
    expect(accessRequestStatus(expired.request_id).status).toBe('expired');
    expect(mocks.grant).not.toHaveBeenCalled();
  });
  it('recovers completed application after restart without replaying the grant', async () => {
    const request = await seed();
    claimApprovalWorkflow(request.request_id, 1, {
      userId: 'alice',
      connectionId: connection.id,
      connectionRevision: rev,
    });
    connection.grants = [{ vault: session.agent_group_id, services: ['api'], status: 'active' }];
    await recoverAccessRequests(true);
    expect(accessRequestStatus(request.request_id).status).toBe('completed');
    expect(mocks.grant).not.toHaveBeenCalled();
  });
  it('marks interrupted/ungranted application failed rather than replaying it', async () => {
    const request = await seed();
    claimApprovalWorkflow(request.request_id, 1, {
      userId: 'alice',
      connectionId: connection.id,
      connectionRevision: rev,
    });
    await recoverAccessRequests(true);
    expect(accessRequestStatus(request.request_id).status).toBe('failed');
    expect(mocks.grant).not.toHaveBeenCalled();
  });
  it('does not discard a durable result when waking fails', async () => {
    const request = await seed();
    mocks.wake.mockRejectedValueOnce(new Error('temporary wake failure'));
    await expect(applyAccessRequest('alice', request.request_id, selection())).rejects.toThrow(
      'temporary wake failure',
    );
    expect(getApprovalWorkflow(request.request_id)).toMatchObject({ stage: 'completed', notified: 0 });
    await recoverAccessRequests();
    expect(getApprovalWorkflow(request.request_id)?.notified).toBe(1);
    expect([...mocks.messages.keys()].filter((key) => key.startsWith('approval-result-'))).toHaveLength(1);
  });
});
