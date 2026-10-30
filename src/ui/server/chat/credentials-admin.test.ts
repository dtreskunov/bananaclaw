import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { Writable } from 'node:stream';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const ROOT = vi.hoisted(() => `/tmp/nanoclaw-shared-credentials-${process.pid}-${Math.random().toString(36).slice(2)}`);
vi.mock('../../../config.js', async () => ({
  ...(await vi.importActual<typeof import('../../../config.js')>('../../../config.js')),
  DATA_DIR: `${ROOT}/data`,
  GROUPS_DIR: `${ROOT}/groups`,
}));
vi.mock('../../../container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(undefined),
  isContainerRunning: vi.fn().mockReturnValue(false),
  getActiveContainerCount: vi.fn().mockReturnValue(0),
  killContainer: vi.fn(),
  buildAgentGroupImage: vi.fn(),
  runMcpProbeContainer: vi.fn(),
}));
let user: string | null = null;
vi.mock('../auth.js', () => ({
  authenticate: () => (user ? { userId: user, sessionHash: 'test-session' } : null),
  recordAccess: vi.fn(),
}));

import { closeDb, getDb, initDb, initTestDb, runMigrations } from '../../../db/index.js';
import { flushManagedUsers, credentialInstallationId } from '../../../modules/credentials/managed-users.js';
import { clearSignIns, getSignIn } from '../../../modules/credentials/sign-ins.js';
import { grantRole } from '../../../modules/permissions/db/user-roles.js';
import { handle } from './routes.js';
import { handleOAuthCallback } from '../oauth-callback.js';
import { _resetBrandingCache } from '../branding.js';
import { dispatch } from '../../../cli/dispatch.js';
import type { SharedAccessGrant } from '../../../modules/credentials/shared-connections.js';
import '../../../cli/commands/credentials.js';
import '../../../cli/commands/access.js';
import { createSession } from '../../../db/sessions.js';
import { initSessionFolder } from '../../../session-manager.js';
import { ensureContainerConfig } from '../../../db/container-configs.js';
import { requestAccess } from '../../../modules/credentials/access-requests.js';
import { finishApprovalWorkflow, getApprovalWorkflow } from '../../../modules/approvals/workflows.js';

const GROUP = 'ag-shared';
const REVISION = `"${'a'.repeat(64)}"`;
const service = { name: 'search', host: 'api.example.test/search', auth: { type: 'bearer', token: 'SEARCH_KEY' } };
type Recorded = { method: string; path: string; body: Record<string, unknown>; revision?: string; create?: string };
const requests: Recorded[] = [];
let gateway: http.Server;
let sequence = 0;
let wrongCompletion = false;
let gatewayStatus = 200;
let connectionKind = 'static';
let duringProvision: (() => void) | null = null;
let returnedOwner: string | null = null;
let extraConnections: ReturnType<typeof connection>[] = [];
let accessGrants: SharedAccessGrant[] = [];
let scopeOptions: unknown;
let workflowGrant = false;
let workflowGranted = false;

function connection(ownerId = 'native-alice') {
  return {
    id: 'connection-one',
    label: 'Search',
    kind: connectionKind,
    status: 'ready',
    revision: workflowGranted ? `"${'b'.repeat(64)}"` : REVISION,
    owner: { id: returnedOwner ?? ownerId },
    services: [service],
    credentials: ['SEARCH_KEY'],
    grants: workflowGranted ? [{ vault: GROUP, services: ['search'], status: 'active' }] : [],
  };
}

beforeAll(async () => {
  fs.mkdirSync(`${ROOT}/data/agent-vault`, { recursive: true, mode: 0o700 });
  fs.writeFileSync(`${ROOT}/data/agent-vault/host-token`, 'test-host-token', { mode: 0o600 });
  gateway = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk.toString();
    const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    const url = new URL(req.url!, 'http://gateway');
    requests.push({
      method: req.method!,
      path: `${url.pathname}${url.search}`,
      body,
      revision: req.headers['if-match'] as string | undefined,
      create: req.headers['if-none-match'] as string | undefined,
    });
    const send = (status: number, value: unknown): void => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(value));
    };
    if (req.headers.authorization !== 'Bearer test-host-token') return send(401, { error: 'wrong token' });
    if (gatewayStatus !== 200) return send(gatewayStatus, { error: 'rejected', code: 'test_rejection' });
    if (url.pathname === '/v1/managed-users') {
      const change = duringProvision;
      duringProvision = null;
      change?.();
      return send(200, { id: `native-${body.subject}`, library_vault: `library-${body.subject}` });
    }
    if (url.pathname === '/v1/oauth/complete')
      return send(200, { status: 'connected', connection_id: wrongCompletion ? 'wrong-connection' : 'connection-one' });
    if (url.pathname.endsWith('/oauth-apps')) return send(200, { items: [] });
    if (url.pathname.endsWith('/oauth/scopes')) return send(200, scopeOptions);
    if (url.pathname.endsWith('/oauth/start'))
      return send(200, { state: `sign-in-${++sequence}`, authorize_url: 'https://auth.example.test/authorize' });
    const effectiveOwner = /^\/v1\/managed-users\/([^/]+)\//.exec(url.pathname)?.[1] ?? 'native-alice';
    if (url.pathname.endsWith('/access')) return send(200, { grants: accessGrants });
    if (url.pathname.endsWith('/connections')) {
      if (req.method === 'GET') return send(200, { connections: [connection(effectiveOwner), ...extraConnections] });
      return send(201, connection(effectiveOwner));
    }
    if (req.method === 'DELETE') {
      res.writeHead(204);
      res.end();
      return;
    }
    if (workflowGrant && req.method === 'PUT' && url.pathname.includes('/grants/')) workflowGranted = true;
    send(200, connection(effectiveOwner));
  });
  await new Promise<void>((resolve) => gateway.listen(0, '127.0.0.1', resolve));
  process.env.NANOCLAW_AGENT_VAULT_URL = `http://127.0.0.1:${(gateway.address() as AddressInfo).port}`;
});

afterAll(async () => {
  closeDb();
  await new Promise<void>((resolve) => gateway.close(() => resolve()));
  delete process.env.NANOCLAW_AGENT_VAULT_URL;
  fs.rmSync(ROOT, { recursive: true, force: true });
});
afterEach(() => {
  vi.unstubAllEnvs();
  _resetBrandingCache();
});

beforeEach(() => {
  closeDb();
  runMigrations(initTestDb());
  const db = getDb(),
    now = new Date().toISOString();
  for (const id of ['alice', 'bob', 'member'])
    db.prepare('INSERT INTO users(id,kind,display_name,created_at) VALUES(?,?,?,?)').run(id, 'test', id, now);
  db.prepare('INSERT INTO agent_groups(id,name,folder,created_at) VALUES(?,?,?,?)').run(
    GROUP,
    'Shared test',
    'shared-test',
    now,
  );
  grantRole({ user_id: 'alice', role: 'owner', agent_group_id: null, granted_by: null, granted_at: now });
  grantRole({ user_id: 'bob', role: 'admin', agent_group_id: GROUP, granted_by: 'alice', granted_at: now });
  db.prepare('INSERT INTO agent_group_members(user_id,agent_group_id,added_at) VALUES(?,?,?)').run(
    'member',
    GROUP,
    now,
  );
  user = 'alice';
  requests.length = 0;
  wrongCompletion = false;
  gatewayStatus = 200;
  clearSignIns();
  connectionKind = 'static';
  duringProvision = null;
  returnedOwner = null;
  extraConnections = [];
  accessGrants = [];
  scopeOptions = { scopes: ['read', 'write'], source: 'resource', oauth: true, issuer: 'https://issuer.example.test' };
  workflowGrant = false;
  workflowGranted = false;
});

async function call(method: string, url: string, body?: unknown, headers: Record<string, string> = {}) {
  const raw = body === undefined ? '' : typeof body === 'string' ? body : JSON.stringify(body);
  const req = {
    method,
    url,
    headers: { host: 'localhost', 'content-type': 'application/json', ...headers },
    socket: { remoteAddress: '127.0.0.1' },
    async *[Symbol.asyncIterator]() {
      if (raw) yield Buffer.from(raw);
    },
  } as http.IncomingMessage;
  let status = 0;
  const chunks: Buffer[] = [];
  const writable = new Writable({
    write(chunk, _encoding, done) {
      chunks.push(Buffer.from(chunk));
      done();
    },
  });
  const response = writable as unknown as http.ServerResponse;
  response.writeHead = ((value: number) => {
    status = value;
    return response;
  }) as http.ServerResponse['writeHead'];
  const finished = new Promise<void>((resolve) => writable.once('finish', resolve));
  if (url.startsWith('/ui/oauth/')) await handleOAuthCallback(req, response);
  else await handle(req, response);
  await finished;
  const text = Buffer.concat(chunks).toString();
  let value: unknown = text;
  try {
    value = JSON.parse(text);
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
  }
  return { status, value, text };
}

describe('user-owned Credentials API', () => {
  it('reopens partial failures only after authenticated review and reuses an existing grant', async () => {
    ensureContainerConfig(GROUP);
    const session = {
      id: 'sess-access-retry-http',
      agent_group_id: GROUP,
      messaging_group_id: null,
      thread_id: 'access-thread',
      agent_provider: null,
      status: 'active' as const,
      container_status: 'stopped' as const,
      created_at: 'before',
      last_active: 'before',
    };
    createSession(session);
    initSessionFolder(GROUP, session.id);
    const request = await requestAccess(session, {
      resource_url: 'https://api.example.test/search',
      reason: 'Read results.',
    });
    workflowGranted = true;
    finishApprovalWorkflow(request.request_id, 'failed', 'Partial application');
    const revision = getApprovalWorkflow(request.request_id)!.revision;
    const path = `/ui/chat/api/credentials/access-requests/${request.request_id}`;
    user = 'member';
    expect((await call('POST', path + '/retry', { request_revision: revision })).status).toBe(403);
    user = 'alice';
    expect(
      (await call('POST', path + '/retry', { request_revision: revision }, { origin: 'https://evil.example' })).status,
    ).toBe(403);
    expect((await call('POST', path + '/retry', {})).status).toBe(400);
    expect((await call('POST', path + '/retry', { request_revision: 0 })).status).toBe(409);
    const retry = await call('POST', path + '/retry', { request_revision: revision });
    expect(retry.status).toBe(200);
    expect(retry.value).toMatchObject({ status: 'pending', revision: revision + 1, result: null });
    expect(requests.some((r) => r.method === 'PUT' && r.path.includes('/grants/'))).toBe(false);
    const applied = await call('POST', path + '/apply', {
      connection_id: 'connection-one',
      connection_revision: connection().revision,
      request_revision: revision + 1,
    });
    expect(applied.status).toBe(200);
    expect(applied.value).toMatchObject({ status: 'completed' });
    expect(requests.some((r) => r.method === 'PUT' && r.path.includes('/grants/'))).toBe(false);
    expect((await call('POST', path + '/retry', { request_revision: revision + 1 })).status).toBe(409);
  });

  it('reviews and applies an access approval through the authenticated owner API', async () => {
    ensureContainerConfig(GROUP);
    const session = {
      id: 'sess-access-http',
      agent_group_id: GROUP,
      messaging_group_id: null,
      thread_id: 'access-thread',
      agent_provider: null,
      status: 'active' as const,
      container_status: 'stopped' as const,
      created_at: 'before',
      last_active: 'before',
    };
    createSession(session);
    initSessionFolder(GROUP, session.id);
    const request = await requestAccess(session, {
      resource_url: 'https://api.example.test/search',
      reason: 'Read search results.',
      authentication: { type: 'bearer' },
    });
    const path = `/ui/chat/api/credentials/access-requests/${request.request_id}`;
    user = 'member';
    expect((await call('GET', path)).status).toBe(403);
    user = 'alice';
    const review = await call('GET', path);
    expect(review.status).toBe(200);
    expect(review.value).toMatchObject({ authentication: { type: 'bearer' } });
    const preview = await call('POST', path + '/preview', { connection_id: 'connection-one' });
    expect(preview.status).toBe(200);
    expect(preview.value).toMatchObject({ matches: true, connection: { owner: { id: 'native-alice' } } });
    expect(requests.some((r) => r.method === 'PUT' && r.path.includes('/grants/'))).toBe(false);
    expect(
      (
        await call(
          'POST',
          path + '/apply',
          {
            connection_id: 'connection-one',
            connection_revision: REVISION,
            request_revision: request.revision,
          },
          { origin: 'https://evil.example' },
        )
      ).status,
    ).toBe(403);
    workflowGrant = true;
    const result = await call('POST', path + '/apply', {
      connection_id: 'connection-one',
      connection_revision: REVISION,
      request_revision: request.revision,
    });
    expect(result.status).toBe(200);
    expect(result.value).toMatchObject({ status: 'completed' });
    expect(requests.filter((r) => r.method === 'PUT' && r.path.includes('/grants/'))).toHaveLength(1);
    expect(
      (
        await call('POST', path + '/apply', {
          connection_id: 'connection-one',
          connection_revision: REVISION,
          request_revision: request.revision,
        })
      ).status,
    ).toBe(409);
  });

  it('discovers scopes as the signed-in native user without starting OAuth', async () => {
    user = 'bob';
    const response = await call('POST', '/ui/chat/api/credentials/scopes', {
      resource_url: 'https://mcp.example.test/mcp',
    });
    expect(response.status).toBe(200);
    expect(response.value).toEqual(scopeOptions);
    expect(requests.at(-1)?.path).toBe('/v1/managed-users/native-bob/oauth/scopes');
    expect(requests.some((entry) => entry.path.endsWith('/oauth/start') || entry.path.endsWith('/connections'))).toBe(
      false,
    );
  });
  it('allows issuer inspection for an unsaved app but rejects mixed authorities and owner overrides', async () => {
    expect(
      (await call('POST', '/ui/chat/api/credentials/scopes', { issuer: 'https://issuer.example.test' })).status,
    ).toBe(200);
    for (const body of [
      {},
      { issuer: 'https://issuer.example.test', app_id: 'private' },
      { resource_url: 'https://mcp.example.test/mcp', owner: 'other' },
    ])
      expect((await call('POST', '/ui/chat/api/credentials/scopes', body)).status).toBe(400);
  });
  it('rejects malformed scope metadata instead of presenting it as an empty successful list', async () => {
    scopeOptions = { scopes: ['invalid scope'], source: 'resource', oauth: true };
    expect((await call('POST', '/ui/chat/api/credentials/scopes', { app_id: 'private' })).status).toBe(502);
  });
  it('requires a signed-in user before provisioning or listing', async () => {
    user = null;
    expect((await call('GET', '/ui/chat/api/credentials')).status).toBe(401);
    expect(requests).toHaveLength(0);
  });

  it('maps stable users to native principals without using email or granting scoped admins instance ownership', async () => {
    user = 'bob';
    const result = await call('GET', '/ui/chat/api/credentials');
    expect(result.status).toBe(200);
    const provision = requests.find((entry) => entry.path === '/v1/managed-users')!;
    expect(provision.body).toMatchObject({
      installation_id: credentialInstallationId(),
      subject: 'bob',
      active: true,
      role: 'no-access',
      vault_grants: [{ vault: GROUP, role: 'admin' }],
    });
    expect(provision.body).not.toHaveProperty('email');
    expect(provision.body).not.toHaveProperty('password');
    expect(
      requests
        .filter((entry) => entry.path.includes('/connections'))
        .every((entry) => entry.path.startsWith('/v1/managed-users/native-bob/')),
    ).toBe(true);
    expect(result.value).toMatchObject({ groups: [{ id: GROUP, canAdmin: true }] });
    expect(result.value).toMatchObject({ connections: [{ owner: { id: 'native-bob' } }] });
  });

  it.each(['alice', 'bob'])(
    'never exposes other owners through group access, even to administrator %s',
    async (actor) => {
      user = actor;
      accessGrants = ['alice', 'bob', 'member'].map((owner) => ({
        connection_id: `${owner}-connection`,
        label: `${owner} private connection`,
        owner: { id: `native-${owner}` },
        services: [service],
        status: 'active',
      }));
      const response = await call('GET', `/ui/chat/api/groups/${GROUP}/admin/access?owner=someone-else`);
      expect(response.status).toBe(200);
      expect(response.value).toMatchObject({ grants: [{ connection_id: `${actor}-connection` }] });
      expect((response.value as { grants: unknown[] }).grants).toHaveLength(1);
      for (const owner of ['alice', 'bob', 'member'].filter((owner) => owner !== actor))
        expect(response.text).not.toContain(`${owner} private connection`);
    },
  );

  it.each(['alice', 'bob'])('fails closed if the personal list for %s contains foreign metadata', async (actor) => {
    user = actor;
    extraConnections = [{ ...connection('native-foreign'), id: 'foreign-connection', label: 'Hidden private label' }];
    const response = await call('GET', '/ui/chat/api/credentials');
    expect(response.status).toBe(502);
    expect(response.value).toMatchObject({ code: 'connection_owner_mismatch' });
    expect(response.text).not.toContain('Hidden private label');
    expect(response.text).not.toContain('native-foreign');
  });

  it.each([
    ['GET', '/connections/connection-one', undefined],
    [
      'POST',
      '/connections',
      { label: 'Search', kind: 'static', services: [service], values: { SEARCH_KEY: 'test-key' } },
    ],
    ['PUT', '/connections/connection-one', { label: 'Renamed', revision: REVISION }],
    ['PUT', `/connections/connection-one/grants/${GROUP}`, {}],
  ])('does not forward a foreign-owner %s result from %s', async (method, endpoint, body) => {
    returnedOwner = 'native-foreign';
    const response = await call(String(method), `/ui/chat/api/credentials${endpoint}`, body);
    expect(response.status).toBe(502);
    expect(response.value).toMatchObject({ code: 'connection_owner_mismatch' });
    expect(response.text).not.toContain('native-foreign');
    expect(response.text).not.toContain('SEARCH_KEY');
  });

  it('does not start OAuth for a connection whose owner does not match the session', async () => {
    connectionKind = 'mcp_oauth';
    returnedOwner = 'native-foreign';
    const response = await call('POST', '/ui/chat/api/credentials/connections/connection-one/start', {});
    expect(response.status).toBe(502);
    expect(requests.some((entry) => entry.path.endsWith('/oauth/start'))).toBe(false);
  });

  it('allows ordinary users to manage their own library without granting agent administration', async () => {
    user = 'member';
    expect((await call('GET', '/ui/chat/api/credentials')).value).toMatchObject({
      canEditInstall: false,
      groups: [{ id: GROUP, canAdmin: false }],
    });
    expect((await call('PUT', `/ui/chat/api/credentials/connections/connection-one/grants/${GROUP}`, {})).status).toBe(
      403,
    );
  });

  it('creates a static connection without returning its values', async () => {
    const result = await call('POST', '/ui/chat/api/credentials/connections', {
      label: 'Search',
      kind: 'static',
      services: [service],
      values: { SEARCH_KEY: 'test-key-not-returned' },
    });
    expect(result.status).toBe(201);
    expect(result.text).not.toContain('test-key-not-returned');
    expect(requests.find((entry) => entry.path.endsWith('/connections'))?.body.values).toEqual({
      SEARCH_KEY: 'test-key-not-returned',
    });
  });

  it('rejects browser-supplied ownership and unsupported kinds', async () => {
    for (const extra of [{ owner: 'bob' }, { user_id: 'bob' }, { kind: 'copied' }]) {
      const result = await call('POST', '/ui/chat/api/credentials/connections', {
        label: 'Search',
        kind: 'static',
        services: [service],
        values: { SEARCH_KEY: 'test-key' },
        ...extra,
      });
      expect(result.status).toBe(400);
    }
    expect(requests).toHaveLength(0);
  });

  it('requires exact update revisions and sends values only through a write body', async () => {
    expect(
      (await call('PUT', '/ui/chat/api/credentials/connections/connection-one', { label: 'Changed' })).status,
    ).toBe(400);
    const result = await call('PUT', '/ui/chat/api/credentials/connections/connection-one', {
      revision: REVISION,
      values: { SEARCH_KEY: 'rotated-test-key' },
    });
    expect(result.status).toBe(200);
    expect(requests.find((entry) => entry.method === 'PUT' && entry.path.endsWith('/connection-one'))).toMatchObject({
      revision: REVISION,
      body: { values: { SEARCH_KEY: 'rotated-test-key' } },
    });
    expect(result.text).not.toContain('rotated-test-key');
  });

  it('grants a whole credential create-only without copying credentials', async () => {
    user = 'bob';
    expect((await call('PUT', `/ui/chat/api/credentials/connections/connection-one/grants/${GROUP}`, {})).status).toBe(
      200,
    );
    const request = requests.find((entry) => entry.path.endsWith(`/grants/${GROUP}`))!;
    expect(request).toMatchObject({ create: '*', body: {} });
    expect(request.body).not.toHaveProperty('values');
  });

  it('rejects obsolete service-selection grant requests rather than implying partial access', async () => {
    const response = await call('PUT', `/ui/chat/api/credentials/connections/connection-one/grants/${GROUP}`, {
      services: ['search'],
    });
    expect(response.status).toBe(400);
    expect(requests).toHaveLength(0);
  });

  it('grants the whole credential through the CLI and rejects obsolete --services', async () => {
    const args = { user: 'alice', id: 'connection-one', group: GROUP };
    const granted = await dispatch({ id: 'grant', command: 'credentials-grant', args }, { caller: 'host' });
    expect(granted.ok).toBe(true);
    expect(requests.find((entry) => entry.path.endsWith(`/grants/${GROUP}`))).toMatchObject({
      create: '*',
      body: {},
    });
    requests.length = 0;
    const rejected = await dispatch(
      { id: 'partial', command: 'credentials-grant', args: { ...args, services: '["search"]' } },
      { caller: 'host' },
    );
    expect(rejected.ok).toBe(false);
    expect(requests).toHaveLength(0);
  });

  it('detaches a group through Access, never the upstream connection-delete endpoint', async () => {
    user = 'bob';
    expect((await call('DELETE', `/ui/chat/api/groups/${GROUP}/admin/access/connection-one`)).status).toBe(200);
    expect(requests.at(-1)?.path).toBe(`/v1/managed-users/native-bob/vaults/${GROUP}/access/connection-one`);
    expect(requests.some((entry) => entry.path.endsWith('/oauth/complete'))).toBe(false);
  });

  it('keeps global app mutations restricted to instance administrators', async () => {
    user = 'bob';
    expect((await call('PUT', '/ui/chat/api/credentials/oauth-apps/google?scope=install', { config: {} })).status).toBe(
      403,
    );
    expect(requests).toHaveLength(0);
    expect(
      (
        await call('PUT', '/ui/chat/api/credentials/oauth-apps/google?scope=user', {
          config: { issuer: 'https://auth.example.test', client_id: 'client' },
          clientSecret: 'test-client-secret',
        })
      ).status,
    ).toBe(200);
    expect(requests.at(-1)?.body.client_secret).toBe('test-client-secret');
  });

  it('rejects cross-origin writes and malformed secret JSON without reflecting it', async () => {
    const response = await call('POST', '/ui/chat/api/credentials/connections', '{"secret":"never-reflect-this"', {
      origin: 'https://foreign.example',
    });
    expect(response.status).toBe(403);
    const malformed = await call('POST', '/ui/chat/api/credentials/connections', '{"secret":"never-reflect-this"');
    expect(malformed.status).toBe(400);
    expect(malformed.text).not.toContain('never-reflect-this');
    expect(requests).toHaveLength(0);
  });

  it('surfaces gateway failures instead of returning empty success', async () => {
    gatewayStatus = 503;
    const response = await call('GET', '/ui/chat/api/credentials');
    expect(response.status).toBe(503);
    expect(response.value).toMatchObject({ code: 'test_rejection' });
  });

  it('removes the superseded group-owned management route and CLI command', async () => {
    expect((await call('GET', `/ui/chat/api/groups/${GROUP}/admin/credentials`)).status).toBe(404);
    const result = await dispatch({ id: 'test', command: 'credentials-set', args: {} }, { caller: 'host' });
    expect(result.ok).toBe(false);
  });
});

describe('connection-bound OAuth consent', () => {
  async function start() {
    connectionKind = 'mcp_oauth';
    const response = await call('POST', '/ui/chat/api/credentials/connections/connection-one/start', {});
    expect(response.status).toBe(200);
    return (response.value as { state: string }).state;
  }

  it.each([
    ['Denis Treskunov', 'BananaClaw (Denis Treskunov)'],
    ['  Denis Treskunov  ', 'BananaClaw (Denis Treskunov)'],
    ['', 'BananaClaw'],
  ])('derives the registration name from trusted branding and profile "%s"', async (displayName, expected) => {
    vi.stubEnv('UI_BRAND_NAME', 'BananaClaw');
    _resetBrandingCache();
    getDb().prepare('UPDATE users SET display_name=? WHERE id=?').run(displayName, 'alice');
    await start();
    expect(requests.find((entry) => entry.path.endsWith('/oauth/start'))?.body.client_name).toBe(expected);
  });

  it('does not allow the browser to impersonate another registration display name', async () => {
    connectionKind = 'mcp_oauth';
    const response = await call('POST', '/ui/chat/api/credentials/connections/connection-one/start', {
      client_name: 'BananaClaw (Another user)',
    });
    expect(response.status).toBe(400);
    expect(requests).toHaveLength(0);
  });

  it('reports an invalid combined display name instead of sending a generated user ID', async () => {
    vi.stubEnv('UI_BRAND_NAME', 'BananaClaw');
    _resetBrandingCache();
    getDb().prepare('UPDATE users SET display_name=? WHERE id=?').run('x'.repeat(100), 'alice');
    connectionKind = 'mcp_oauth';
    const response = await call('POST', '/ui/chat/api/credentials/connections/connection-one/start', {});
    expect(response.status).toBe(400);
    expect(requests.some((entry) => entry.path.endsWith('/oauth/start'))).toBe(false);
  });

  it('binds completion to the initiating user and authoritative connection', async () => {
    const state = await start();
    expect(getSignIn(state)).toMatchObject({
      userId: 'alice',
      managedUserId: 'native-alice',
      connectionId: 'connection-one',
    });
    expect((await call('GET', `/ui/oauth/callback?state=${state}&code=test-code`)).text).toContain('Signed in');
    expect(getSignIn(state)).toMatchObject({ status: 'connected', connection_id: 'connection-one' });
    expect(requests.find((entry) => entry.path === '/v1/oauth/complete')?.body.user_id).toBe('native-alice');
  });

  it('never sends another user’s callback to the gateway', async () => {
    const state = await start();
    requests.length = 0;
    user = 'bob';
    expect((await call('GET', `/ui/oauth/callback?state=${state}&code=test-code`)).status).toBe(400);
    expect(requests).toHaveLength(0);
  });

  it('does not turn a mismatched completion into successful access', async () => {
    const state = await start();
    wrongCompletion = true;
    expect((await call('GET', `/ui/oauth/callback?state=${state}&code=test-code`)).text).toContain('Sign-in failed');
    expect(getSignIn(state)?.status).toBe('failed');
  });

  it('does not expose another user’s sign-in progress', async () => {
    const state = await start();
    user = 'bob';
    expect((await call('GET', `/ui/chat/api/credentials/sign-ins/${state}`)).status).toBe(404);
  });
});

describe('managed identity reconciliation', () => {
  it('preserves the installation identity when its database is restored at another path', async () => {
    const installation = credentialInstallationId();
    const relocated = `${ROOT}/relocated.db`;
    await getDb().backup(relocated);
    fs.chmodSync(relocated, 0o600);
    closeDb();
    runMigrations(initDb(relocated));
    expect(credentialInstallationId()).toBe(installation);
  });

  it('drains more than one batch before startup reconciliation completes', async () => {
    const db = getDb(),
      now = new Date().toISOString();
    for (let index = 0; index < 40; index++)
      db.prepare('INSERT INTO users(id,kind,display_name,created_at) VALUES(?,?,?,?)').run(
        `bulk-${index}`,
        'test',
        'Bulk user',
        now,
      );
    await flushManagedUsers();
    expect(db.prepare('SELECT count(*) AS n FROM credential_gateway_sync').get()).toEqual({ n: 0 });
    expect(requests.filter((entry) => entry.path === '/v1/managed-users')).toHaveLength(43);
  });

  it('resynchronizes permissions changed while a native identity request is in flight', async () => {
    user = 'bob';
    duringProvision = () => {
      getDb().prepare('DELETE FROM user_roles WHERE user_id=?').run('bob');
    };
    expect((await call('GET', '/ui/chat/api/credentials')).status).toBe(200);
    const snapshots = requests.filter((entry) => entry.path === '/v1/managed-users');
    expect(snapshots.length).toBeGreaterThanOrEqual(2);
    expect(snapshots.at(-1)?.body.vault_grants).toEqual([]);
    expect(snapshots.at(-1)?.body.role).toBe('no-access');
  });

  it('retains the installation UUID and queues role changes and deleted-user tombstones', async () => {
    const installation = credentialInstallationId();
    await flushManagedUsers();
    expect(getDb().prepare('SELECT count(*) AS n FROM credential_gateway_sync').get()).toEqual({ n: 0 });
    getDb().prepare('DELETE FROM user_roles WHERE user_id=?').run('bob');
    getDb().prepare('DELETE FROM agent_group_members WHERE user_id=?').run('member');
    getDb().prepare('DELETE FROM users WHERE id=?').run('member');
    requests.length = 0;
    await flushManagedUsers();
    expect(credentialInstallationId()).toBe(installation);
    expect(requests.some((entry) => entry.body.subject === 'member' && entry.body.active === false)).toBe(true);
    expect(requests.find((entry) => entry.body.subject === 'bob')?.body.vault_grants).toEqual([]);
  });
});
