import fs from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  wake: vi.fn().mockResolvedValue(undefined),
  messages: new Map<string, unknown>(),
  get: vi.fn(),
  grant: vi.fn(),
  directory: `${process.cwd()}/.test-tmp/nanoclaw-access-${process.pid}`,
  origin: {
    id: 'human-request',
    sender_user_id: 'alice',
    channel_type: 'web',
    platform_id: 'room',
    thread_id: 'original-thread',
    source_session_id: null,
  },
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
import { createSession, deleteSession } from '../../db/sessions.js';
import { getApproval } from '../../db/approvals.js';
import { grantRole } from '../permissions/db/user-roles.js';
import { getInteractiveApprovalHandler } from '../approvals/primitive.js';
import {
  getApprovalWorkflow,
  claimApprovalWorkflow,
  finishApprovalWorkflow,
  notifyApprovalWorkflow,
  recoverableApprovalWorkflows,
} from '../approvals/workflows.js';
import {
  accessRequestInput,
  getAccountRequest,
  applyAccessRequest,
  completeAccountRequest,
  prepareAccountRequest,
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
  mocks.origin = {
    id: 'human-request',
    sender_user_id: 'alice',
    channel_type: 'web',
    platform_id: 'room',
    thread_id: 'original-thread',
    source_session_id: null,
  };
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
  return mocks.messages.get(`approval-result-${id}-r${getApprovalWorkflow(id)!.revision}`);
}

describe('assisted access approvals', () => {
  it('keeps new requests pending without a deadline or an expiry timer', async () => {
    vi.useFakeTimers();
    try {
      const request = await seed();
      expect(request.expiresAt).toBeNull();
      expect(recoverableApprovalWorkflows()).toEqual([]);
      expect(vi.getTimerCount()).toBe(0);
      vi.setSystemTime(Date.now() + 7 * 24 * 60 * 60_000);
      expect(getAccountRequest(request.id).status).toBe('pending');
      expect(getApproval(request.id)?.status).toBe('pending');
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not resurrect or mutate a legacy expired request while projecting it', async () => {
    const request = await seed();
    getDb().prepare('UPDATE interactions SET expires_at=? WHERE id=?').run('2000-01-01', request.id);
    const before = getApprovalWorkflow(request.id);
    expect(getAccountRequest(request.id).status).toBe('expired');
    expect(getAccountRequest(request.id).status).toBe('expired');
    expect(getApprovalWorkflow(request.id)).toEqual(before);
    expect(recoverableApprovalWorkflows()).toEqual([]);
    await recoverAccessRequests(true);
    expect(getApprovalWorkflow(request.id)).toEqual(before);
    expect(mocks.grant).not.toHaveBeenCalled();
  });

  it('requires the requested permissions in confirmed account grants before access can be approved', async () => {
    connection.kind = 'mcp_oauth';
    connection.requested_scopes = ['read', 'write'];
    connection.granted_scopes = ['read'];
    connection.scope_source = 'provider';
    const request = await requestAccess(
      session,
      {
        ...input,
        authentication: { type: 'mcp_oauth' },
        scopes: ['write'],
      },
      'appr-access-scoped',
    );
    expect(request.requirements.scopes).toEqual(['write']);
    expect((await previewAccessRequest('alice', request.id, connection.id)).matches).toBe(false);
    await expect(applyAccessRequest('alice', request.id, selection(request.revision))).rejects.toMatchObject({
      status: 409,
    });
    expect(mocks.grant).not.toHaveBeenCalled();
    connection.granted_scopes = ['read', 'write'];
    expect((await previewAccessRequest('alice', request.id, connection.id)).matches).toBe(true);
    expect(mocks.grant).not.toHaveBeenCalled();
  });
  it('completes account setup with metadata only and permits a separate access request', async () => {
    const request = await seed();
    const setup = prepareAccountRequest('alice', request.id, { request_revision: request.revision });
    expect(setup.kind).toBe('account_setup');
    expect(setup.revision).toBe(request.revision + 1);
    await expect(applyAccessRequest('alice', setup.id, selection(setup.revision))).rejects.toMatchObject({
      status: 409,
    });
    const configBefore = getDb().prepare('SELECT mcp_servers FROM container_configs').pluck().get();
    await completeAccountRequest('alice', setup.id, {
      ...selection(setup.revision),
      message: 'Check setup before requesting access.',
    });
    expect(getAccountRequest(setup.id)).toMatchObject({ kind: 'account_setup', status: 'completed' });
    expect(mocks.grant).not.toHaveBeenCalled();
    expect(connection.grants).toEqual([]);
    expect(getDb().prepare('SELECT mcp_servers FROM container_configs').pluck().get()).toBe(configBefore);
    const content = JSON.parse((resultMessage(setup.id) as { content: string }).content);
    expect(content.text).toContain('No agent access was granted');
    expect(content.text).toContain('authenticated operations require a separate request_access');
    expect(content.text).not.toContain('API_KEY');
    expect(content.text).not.toContain('BIND_');
    expect(content.approvalResponse.message).toBe('Check setup before requesting access.');
    expect(mocks.wake).toHaveBeenCalled();
    await notifyApprovalWorkflow(setup.id);
    expect([...mocks.messages.keys()].filter((id) => id.startsWith('approval-result-'))).toHaveLength(1);
    const access = await requestAccess(session, input, 'appr-access-after-setup');
    expect(access).toMatchObject({ id: 'appr-access-after-setup', kind: 'access_grant', status: 'pending' });
    await applyAccessRequest('alice', access.id, selection(access.revision));
    expect(mocks.grant).toHaveBeenCalledOnce();
  });
  it('keeps a ready account with suspended agent access on the access-approval path', async () => {
    connection.grants = [{ vault: session.agent_group_id, services: ['api'], status: 'suspended' }];
    const request = await seed();
    expect(request.kind).toBe('access_grant');
    expect(mocks.grant).not.toHaveBeenCalled();
    await applyAccessRequest('alice', request.id, selection());
    expect(mocks.grant).toHaveBeenCalledOnce();
  });
  it('rejects stale, unready, cross-owner and grant-shaped account setup confirmations', async () => {
    const request = await seed();
    const setup = prepareAccountRequest('alice', request.id, { request_revision: request.revision });
    await expect(completeAccountRequest('alice', setup.id, selection(request.revision))).rejects.toMatchObject({
      status: 409,
    });
    await expect(completeAccountRequest('bob', setup.id, selection(setup.revision))).rejects.toMatchObject({
      status: 403,
    });
    connection.status = 'disabled';
    await expect(completeAccountRequest('alice', setup.id, selection(setup.revision))).rejects.toMatchObject({
      status: 409,
    });
    connection.status = 'ready';
    await expect(
      completeAccountRequest('alice', setup.id, {
        ...selection(setup.revision),
        configure_mcp: true,
      }),
    ).rejects.toMatchObject({ status: 400 });
    expect(mocks.grant).not.toHaveBeenCalled();
    expect(getAccountRequest(setup.id).status).toBe('pending');
  });
  it('rejects account setup without silently provisioning or granting access', async () => {
    const request = await seed();
    prepareAccountRequest('alice', request.id, { request_revision: request.revision });
    const approval = getApproval(request.id)!;
    await getInteractiveApprovalHandler(approval.input.action)!(
      approval,
      {
        questionId: approval.id,
        userId: 'alice',
        channelType: 'web',
        platformId: 'admin',
        threadId: null,
        value: 'reject',
      },
      'alice',
    );
    expect(getAccountRequest(request.id)).toMatchObject({ kind: 'account_setup', status: 'rejected' });
    expect(mocks.grant).not.toHaveBeenCalled();
    expect(JSON.parse((resultMessage(request.id) as { content: string }).content).text).toContain(
      'Your account setup request was rejected.',
    );
  });
  it('includes an access approval message in its single existing outcome notification', async () => {
    const request = await seed();
    await applyAccessRequest('alice', request.id, { ...selection(), message: '  Use read-only operations.  ' });
    expect([...mocks.messages.keys()].filter((id) => id.startsWith('approval-result-'))).toHaveLength(1);
    const content = JSON.parse((resultMessage(request.id) as { content: string }).content);
    expect(content.text).toContain('Access granted for');
    expect(content.text).toContain('User message from "alice":\nUse read-only operations.');
    expect(content.approvalResponse).toEqual({ userId: 'alice', message: 'Use read-only operations.' });
    expect(mocks.grant).toHaveBeenCalledWith('alice', connection.id, session.agent_group_id, { revision: rev });
    await notifyApprovalWorkflow(request.id);
    expect([...mocks.messages.keys()].filter((id) => id.startsWith('approval-result-'))).toHaveLength(1);
  });

  it('includes a decline message without granting access or changing the decision', async () => {
    const request = await seed();
    const approval = getApproval(request.id)!;
    await getInteractiveApprovalHandler(approval.input.action)!(
      approval,
      {
        questionId: approval.id,
        userId: 'alice',
        channelType: 'web',
        platformId: 'admin',
        threadId: null,
        value: 'reject',
        message: 'Already finished elsewhere; do not retry.',
      },
      'alice',
    );
    expect(mocks.grant).not.toHaveBeenCalled();
    expect(getAccountRequest(request.id).status).toBe('rejected');
    const content = JSON.parse((resultMessage(request.id) as { content: string }).content);
    expect(content.text).toContain('Your access request was rejected.');
    expect(content.text).toContain('Already finished elsewhere; do not retry.');
    expect(content.approvalResponse.userId).toBe('alice');
  });

  it.each([42, null, 'x'.repeat(4001)])(
    'rejects malformed or oversized approval messages before applying access',
    async (message) => {
      const request = await seed();
      await expect(applyAccessRequest('alice', request.id, { ...selection(), message })).rejects.toMatchObject({
        status: 400,
      });
      expect(getAccountRequest(request.id).status).toBe('pending');
      expect(mocks.grant).not.toHaveBeenCalled();
    },
  );

  it('retains the response message in a failed application outcome', async () => {
    const request = await seed();
    mocks.grant.mockRejectedValueOnce(new Error('gateway failed'));
    await expect(
      applyAccessRequest('alice', request.id, {
        ...selection(),
        message: 'Report the error instead of retrying.',
      }),
    ).rejects.toThrow('gateway failed');
    expect(getAccountRequest(request.id).status).toBe('failed');
    const content = JSON.parse((resultMessage(request.id) as { content: string }).content);
    expect(content.text).toContain('Access approval failed');
    expect(content.text).toContain('Report the error instead of retrying.');
    expect(content.approvalResponse.userId).toBe('alice');
  });

  it('recovers the exact responding user and message from a persisted access application', async () => {
    const request = await seed();
    connection.grants = [{ vault: session.agent_group_id, services: ['api'], status: 'active' }];
    claimApprovalWorkflow(request.id, 1, {
      userId: 'alice',
      connectionId: connection.id,
      connectionRevision: connection.revision,
      responseMessage: { userId: 'alice', message: 'Continue the original report.' },
    });
    await recoverAccessRequests(true);
    expect(getAccountRequest(request.id).status).toBe('completed');
    const content = JSON.parse((resultMessage(request.id) as { content: string }).content);
    expect(content.text).toContain('Continue the original report.');
    expect(content.approvalResponse).toEqual({ userId: 'alice', message: 'Continue the original report.' });
    expect(mocks.grant).not.toHaveBeenCalled();
  });
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
      data: {
        status: 'pending',
        requirements: { authentication: { type: 'api-key', header: 'X-Research-Key', prefix: 'Token ' } },
      },
    });
    expect(mocks.grant).not.toHaveBeenCalled();
  });
  it('persists researched mechanism/scope hints and rejects incompatible direct grant attempts', async () => {
    const request = await requestAccess(session, {
      ...input,
      authentication: { type: 'mcp_oauth', app_id: 'google' },
      scopes: ['read'],
    });
    expect(getAccountRequest(request.id)).toMatchObject({
      requirements: { authentication: { type: 'mcp_oauth', app_id: 'google' }, scopes: ['read'] },
    });
    expect((await previewAccessRequest('alice', request.id, connection.id)).matches).toBe(false);
    await expect(applyAccessRequest('alice', request.id, selection())).rejects.toThrow('Connect a compatible');
    connection.kind = 'mcp_oauth';
    connection.app_id = 'google';
    connection.scope_source = 'provider';
    connection.granted_scopes = ['other'];
    await expect(applyAccessRequest('alice', request.id, selection())).rejects.toThrow('Connect a compatible');
    connection.granted_scopes = ['read'];
    expect((await applyAccessRequest('alice', request.id, selection())).status).toBe('completed');
  });
  it('accepts the real MCP transport envelope and provides session-scoped ncl parity', async () => {
    await getDeliveryAction('request_access')!(
      { action: 'request_access', requestId: 'appr-access-envelope', timelinePosition: 123, ...input },
      session,
      getDb(),
    );
    expect(getAccountRequest('appr-access-envelope', session.id).status).toBe('pending');
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
    expect(requested).toMatchObject({ ok: true, data: { id: 'appr-access-envelope', status: 'pending' } });
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
    expect(first.id).toBe(duplicate.id);
    expect(getAccountRequest('appr-access-duplicate', session.id).id).toBe(first.id);
    expect(first.status).toBe('pending');
    expect(getApproval(first.id)?.input.action).toBe('request_access');
    expect(getDb().prepare('SELECT COUNT(*) n FROM interactions').get()).toEqual({ n: 1 });
    expect(mocks.grant).not.toHaveBeenCalled();
    expect(getDb().pragma('foreign_key_check')).toEqual([]);
  });
  it('matches a named query-key MCP endpoint without the credential query and deduplicates trailing slashes', async () => {
    getDb()
      .prepare('UPDATE container_configs SET mcp_servers=? WHERE agent_group_id=?')
      .run(
        JSON.stringify({
          tavily: { type: 'http', url: 'https://mcp.tavily.com/mcp/?tavilyApiKey=__TAVILY_API_KEY__' },
        }),
        session.agent_group_id,
      );
    const request = {
      resource_url: 'https://mcp.tavily.com/mcp',
      reason: 'Research BedJet 3.',
      mcp_server: 'tavily',
      authentication: { type: 'api-key', location: 'query', parameter: 'tavilyApiKey' },
    };
    for (const [index, resource_url] of [request.resource_url, `${request.resource_url}/`].entries()) {
      await getDeliveryAction('request_access')!(
        { action: 'request_access', requestId: `appr-access-tavily-${index}`, ...request, resource_url },
        session,
        getDb(),
      );
    }
    expect(getAccountRequest('appr-access-tavily-0')).toMatchObject({
      status: 'pending',
      requirements: { resource_url: 'https://mcp.tavily.com/mcp/' },
    });
    expect(getAccountRequest('appr-access-tavily-1').id).toBe('appr-access-tavily-0');
    expect([...mocks.messages.values()]).toEqual([
      expect.objectContaining({ content: expect.stringContaining('review the pending approval') }),
    ]);
    expect(mocks.grant).not.toHaveBeenCalled();
    connection.services = [
      {
        name: 'tavily',
        host: 'mcp.tavily.com:443',
        path: '/mcp/*',
        https_only: true,
        auth: { type: 'api-key', location: 'query', parameter: 'tavilyApiKey', key: 'TAVILY_API_KEY' },
      },
    ];
    await applyAccessRequest('alice', 'appr-access-tavily-0', {
      ...selection(),
      configure_mcp: true,
      mcp_server: 'tavily',
      account_alias: 'Research',
      config_revision: (await previewAccessRequest('alice', 'appr-access-tavily-0', connection.id)).mcp.revision,
    });
    const config = getDb()
      .prepare('SELECT mcp_servers FROM container_configs WHERE agent_group_id=?')
      .get(session.agent_group_id) as { mcp_servers: string };
    expect(JSON.parse(config.mcp_servers).tavily).toMatchObject({
      url: 'https://mcp.tavily.com/mcp/',
      authentication: { connection_id: connection.id, account_alias: 'Research' },
    });
  });
  it.each(['https://other.example.com/mcp/', 'https://mcp.tavily.com/other/', 'https://mcp.tavily.com/MCP/'])(
    'rejects a genuinely different named MCP endpoint: %s',
    async (resource_url) => {
      getDb()
        .prepare('UPDATE container_configs SET mcp_servers=? WHERE agent_group_id=?')
        .run(
          JSON.stringify({
            tavily: { type: 'http', url: 'https://mcp.tavily.com/mcp/?tavilyApiKey=__TAVILY_API_KEY__' },
          }),
          session.agent_group_id,
        );
      await expect(
        requestAccess(session, {
          resource_url,
          reason: 'Research.',
          mcp_server: 'tavily',
        }),
      ).rejects.toThrow('no longer matches');
      expect(getDb().prepare('SELECT COUNT(*) n FROM interactions').get()).toEqual({ n: 0 });
      expect(mocks.grant).not.toHaveBeenCalled();
    },
  );
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
    expect(() => getAccountRequest(request.id, 'other-session')).toThrow('not found');
    expect(() => reviewAccessRequest('member', request.id)).toThrow();
    await expect(previewAccessRequest('bob', request.id, connection.id)).rejects.toThrow('Not your connection');
    expect(JSON.stringify(getAccountRequest(request.id, session.id))).not.toContain('private-connection');
  });
  it('requires private review; generic approve does not execute credentials', async () => {
    const request = await seed();
    const approval = getApproval(request.id)!;
    await expect(
      getInteractiveApprovalHandler(approval.input.action)!(
        approval,
        {
          questionId: approval.id,
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
    expect(getApprovalWorkflow(request.id)?.status).toBe('pending');
  });
  it.each(['static', 'oauth_app', 'mcp_oauth'] as const)(
    'grants a reviewed %s and notifies the original thread once',
    async (kind) => {
      connection.kind = kind;
      const request = await seed();
      const preview = await previewAccessRequest('alice', request.id, connection.id);
      expect(preview.matches).toBe(true);
      expect(preview.grantBreadth).toContain('future URL patterns');
      const result = await applyAccessRequest('alice', request.id, selection());
      expect(result.status).toBe('completed');
      expect(mocks.grant).toHaveBeenCalledWith('alice', connection.id, session.agent_group_id, { revision: rev });
      await notifyApprovalWorkflow(request.id);
      expect([...mocks.messages.keys()].filter((key) => key.startsWith('approval-result-'))).toHaveLength(1);
      expect(resultMessage(request.id)).toMatchObject({
        threadId: session.thread_id,
        idempotent: true,
      });
      await expect(applyAccessRequest('alice', request.id, selection())).rejects.toThrow('no longer pending');
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
      const result = await applyAccessRequest('alice', request.id, selection());
      expect(result.status).toBe('completed');
      expect(result.outcomeMessage).toContain(authType);
      if (authType === 'passthrough') expect(result.outcomeMessage).toContain('__API_KEY__');
    },
  );
  it('refuses mismatches, missing OAuth consent and stale credential/request revisions', async () => {
    const request = await seed();
    connection.status = 'draft';
    await expect(applyAccessRequest('alice', request.id, selection())).rejects.toThrow('Connect a compatible');
    connection.status = 'ready';
    connection.services[0].host = 'other.example.com';
    await expect(applyAccessRequest('alice', request.id, selection())).rejects.toThrow('Connect a compatible');
    connection.services[0].host = 'api.example.com';
    await expect(
      applyAccessRequest('alice', request.id, { ...selection(), connection_revision: '"old"' }),
    ).rejects.toThrow('changed');
    await expect(applyAccessRequest('alice', request.id, selection(0))).rejects.toThrow('changed');
    expect(mocks.grant).not.toHaveBeenCalled();
  });
  it('requires current destination administration and reapproves suspended grants', async () => {
    const request = await seed();
    getDb().prepare("DELETE FROM user_roles WHERE user_id='alice'").run();
    await expect(applyAccessRequest('alice', request.id, selection())).rejects.toThrow('administrator');
    expect(mocks.grant).not.toHaveBeenCalled();
    grantRole({
      user_id: 'alice',
      role: 'admin',
      agent_group_id: session.agent_group_id,
      granted_by: null,
      granted_at: 'now',
    });
    connection.grants = [{ vault: session.agent_group_id, status: 'suspended', services: ['api'] }];
    expect((await applyAccessRequest('alice', request.id, selection())).status).toBe('completed');
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
    const preview = await previewAccessRequest('alice', request.id, connection.id);
    expect(preview.mcp.names).toEqual(['example', 'other']);
    const result = await applyAccessRequest('alice', request.id, {
      ...selection(),
      configure_mcp: true,
      config_revision: preview.mcp.revision,
      mcp_server: 'example',
      account_alias: 'Personal',
      message: 'Keep this account separate.',
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
    expect(resultMessage(request.id)).toMatchObject({
      channelType: 'web',
      platformId: 'room',
      threadId: 'original-thread',
    });
    const outcome = resultMessage(request.id) as { id: string; content: string; onWake?: number };
    expect(outcome.onWake).toBeUndefined();
    expect(JSON.parse(outcome.content).inputHandling).toEqual({ mode: 'steer' });
    expect(mocks.messages.get(`${outcome.id}-restart`)).toMatchObject({ onWake: 1 });
    expect(JSON.parse(outcome.content).approvalResponse).toEqual({
      userId: 'alice',
      message: 'Keep this account separate.',
    });
    expect(
      JSON.parse((mocks.messages.get(`${outcome.id}-restart`) as { content: string }).content).approvalResponse,
    ).toBeUndefined();
    expect(result.outcomeMessage).toContain('Only MCP server "example"');
    expect(result.outcomeMessage).not.toContain('BIND_TESTHANDLE');
  });
  it('rejects stale MCP configuration before granting or restarting', async () => {
    connection.kind = 'mcp_oauth';
    getDb()
      .prepare('UPDATE container_configs SET mcp_servers=? WHERE agent_group_id=?')
      .run(JSON.stringify({ server: { type: 'http', url: input.resource_url } }), session.agent_group_id);
    const request = await seed();
    await expect(
      applyAccessRequest('alice', request.id, {
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
    const preview = await previewAccessRequest('alice', request.id, connection.id);
    expect(preview.mcp.names).toEqual(['personal']);
    await expect(
      applyAccessRequest('alice', request.id, {
        ...selection(),
        configure_mcp: true,
        config_revision: preview.mcp.revision,
        mcp_server: 'work',
        account_alias: 'Work',
      }),
    ).rejects.toThrow('Review one named');
    await expect(
      applyAccessRequest('alice', request.id, {
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
      applyAccessRequest('alice', request.id, selection()),
      applyAccessRequest('alice', request.id, selection()),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(mocks.grant).toHaveBeenCalledTimes(1);
  });
  it('records failure without claiming successful application', async () => {
    const request = await seed();
    mocks.grant.mockRejectedValueOnce(new Error('gateway failed'));
    await expect(applyAccessRequest('alice', request.id, selection())).rejects.toThrow('gateway failed');
    expect(getAccountRequest(request.id).status).toBe('failed');
    expect(getAccountRequest(request.id).outcomeMessage).toContain('Some changes may have applied');
  });
  it('persists the returned post-grant ETag separately from the exact reviewed revision', async () => {
    const request = await seed();
    const reviewed = selection();
    await applyAccessRequest('alice', request.id, reviewed);
    expect(connection.revision).not.toBe(reviewed.connection_revision);
    expect(JSON.parse(getApprovalWorkflow(request.id)!.data_json)).toMatchObject({
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
    await expect(applyAccessRequest('alice', request.id, selection())).rejects.toThrow('could not be verified');
    const failed = getAccountRequest(request.id);
    expect(failed.status).toBe('failed');
    expect(failed.outcomeMessage).toContain('grant verification');
    const retry = retryAccessRequest('alice', request.id, { request_revision: failed.revision });
    expect(retry.status).toBe('pending');
    expect(retry.outcomeMessage).toBeNull();
    expect(mocks.grant).toHaveBeenCalledTimes(1);
    await expect(applyAccessRequest('alice', request.id, selection(1))).rejects.toThrow('changed');
    await applyAccessRequest('alice', request.id, selection(retry.revision));
    expect(getAccountRequest(request.id).status).toBe('completed');
    expect(mocks.grant).toHaveBeenCalledTimes(1);
    expect(JSON.parse(getApprovalWorkflow(request.id)!.data_json).attempt_history).toHaveLength(1);
    expect([...mocks.messages.keys()].filter((key) => key.startsWith('approval-result-'))).toHaveLength(2);
    await notifyApprovalWorkflow(request.id);
    expect([...mocks.messages.keys()].filter((key) => key.startsWith('approval-result-'))).toHaveLength(2);
  });
  it('rejects unauthorized, stale, terminal and expired retries without reopening them', async () => {
    const request = await seed();
    expect(() => retryAccessRequest('alice', request.id, { request_revision: 1 })).toThrow('failed request');
    finishApprovalWorkflow(request.id, 'failed', 'test failure');
    const failed = getAccountRequest(request.id);
    expect(() => retryAccessRequest('member', request.id, { request_revision: failed.revision })).toThrow();
    expect(() => retryAccessRequest('alice', request.id, { request_revision: 1 })).toThrow('failed request');
    getDb().prepare('UPDATE interactions SET expires_at=? WHERE id=?').run('2000-01-01', request.id);
    expect(() => retryAccessRequest('alice', request.id, { request_revision: failed.revision })).toThrow('expired');
    expect(getApprovalWorkflow(request.id)?.status).toBe('failed');
    expect(mocks.grant).not.toHaveBeenCalled();
  });
  it('does not let an old failure notification acknowledge a newer retry outcome', async () => {
    const request = await seed();
    finishApprovalWorkflow(request.id, 'failed', 'test failure');
    mocks.wake.mockImplementationOnce(async () => {
      const failed = getAccountRequest(request.id);
      retryAccessRequest('alice', request.id, { request_revision: failed.revision });
      finishApprovalWorkflow(request.id, 'completed', 'retry outcome');
    });
    await notifyApprovalWorkflow(request.id);
    expect(getApprovalWorkflow(request.id)?.notified).toBe(0);
    await notifyApprovalWorkflow(request.id);
    expect(getApprovalWorkflow(request.id)?.notified).toBe(1);
    expect([...mocks.messages.keys()].filter((key) => key.startsWith('approval-result-'))).toHaveLength(2);
  });
  it('guards session deletion during application and does not treat resolved workflows as pending', async () => {
    const request = await seed();
    mocks.grant.mockImplementationOnce(async () => {
      expect(() => deleteSession(session.id, true)).toThrow('being processed');
      connection.grants = [{ vault: session.agent_group_id, services: ['api'], status: 'active' }];
      return connection;
    });
    await applyAccessRequest('alice', request.id, selection());
    expect(deleteSession(session.id)).toBe(0);
    expect(getApprovalWorkflow(request.id)).toBeUndefined();
  });
  it('supports cancellation, rejection and expiry without changing grants', async () => {
    const cancelled = await seed('appr-access-cancel');
    await cancelAccessRequest(cancelled.id, session.id);
    expect(getAccountRequest(cancelled.id).status).toBe('cancelled');
    mocks.origin.id = 'new-human-request';
    const rejected = await seed('appr-access-reject');
    const approval = getApproval(rejected.id)!;
    await getInteractiveApprovalHandler(approval.input.action)!(
      approval,
      {
        questionId: approval.id,
        userId: 'alice',
        channelType: 'web',
        platformId: 'alice',
        threadId: null,
        value: 'reject',
      },
      'alice',
    );
    expect(getAccountRequest(rejected.id).status).toBe('rejected');
    expect((await seed('appr-access-reject-repeat')).id).toBe(rejected.id);
    mocks.origin.id = 'another-human-request';
    const expired = await seed('appr-access-expire');
    getDb().prepare('UPDATE interactions SET expires_at=? WHERE id=?').run('2000-01-01', expired.id);
    await recoverAccessRequests();
    expect(getAccountRequest(expired.id).status).toBe('expired');
    expect(mocks.grant).not.toHaveBeenCalled();
  });
  it('recovers completed application after restart without replaying the grant', async () => {
    const request = await seed();
    claimApprovalWorkflow(request.id, 1, {
      userId: 'alice',
      connectionId: connection.id,
      connectionRevision: rev,
    });
    connection.grants = [{ vault: session.agent_group_id, services: ['api'], status: 'active' }];
    await recoverAccessRequests(true);
    expect(getAccountRequest(request.id).status).toBe('completed');
    expect(mocks.grant).not.toHaveBeenCalled();
  });
  it('marks interrupted/ungranted application failed rather than replaying it', async () => {
    const request = await seed();
    claimApprovalWorkflow(request.id, 1, {
      userId: 'alice',
      connectionId: connection.id,
      connectionRevision: rev,
    });
    await recoverAccessRequests(true);
    expect(getAccountRequest(request.id).status).toBe('failed');
    expect(mocks.grant).not.toHaveBeenCalled();
  });
  it('does not discard a durable result when waking fails', async () => {
    const request = await seed();
    mocks.wake.mockRejectedValueOnce(new Error('temporary wake failure'));
    await expect(applyAccessRequest('alice', request.id, selection())).rejects.toThrow('temporary wake failure');
    expect(getApprovalWorkflow(request.id)).toMatchObject({ status: 'completed', notified: 0 });
    await recoverAccessRequests();
    expect(getApprovalWorkflow(request.id)?.notified).toBe(1);
    expect([...mocks.messages.keys()].filter((key) => key.startsWith('approval-result-'))).toHaveLength(1);
  });
});
