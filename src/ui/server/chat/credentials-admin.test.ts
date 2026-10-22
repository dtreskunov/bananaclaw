/**
 * Group settings → Credentials routes and the OAuth callback relay, against
 * an in-process fake of the Agent Vault gateway's REST API.
 */
import fs from 'fs';
import http from 'http';
import type { AddressInfo } from 'net';
import path from 'path';
import { Writable } from 'stream';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const TEST_ROOT = '/tmp/nanoclaw-test-ui-credentials';

vi.mock('../../../config.js', async () => {
  const actual = await vi.importActual<typeof import('../../../config.js')>('../../../config.js');
  return {
    ...actual,
    GROUPS_DIR: '/tmp/nanoclaw-test-ui-credentials/groups',
    DATA_DIR: '/tmp/nanoclaw-test-ui-credentials/data',
  };
});

vi.mock('../../../container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(undefined),
  isContainerRunning: vi.fn().mockReturnValue(false),
  getActiveContainerCount: vi.fn().mockReturnValue(0),
  killContainer: vi.fn(),
  buildAgentGroupImage: vi.fn().mockResolvedValue(undefined),
  runMcpProbeContainer: vi.fn(),
}));

let mockUserId: string | null = null;
vi.mock('../auth.js', () => ({
  authenticate: () => (mockUserId ? { userId: mockUserId } : null),
  recordAccess: vi.fn(),
}));

import { initTestDb, closeDb, runMigrations, getDb } from '../../../db/index.js';
import { clearSignIns } from '../../../modules/credentials/sign-ins.js';
import { forgetProbes } from '../../../modules/credentials/gateway-credentials.js';
import { grantRole } from '../../../modules/permissions/db/user-roles.js';
import { handleClientMetadata, handleOAuthCallback, resetClientMetadataCache } from '../oauth-callback.js';
import { handle } from './routes.js';
import { dispatch } from '../../../cli/dispatch.js';
import '../../../cli/commands/credentials.js';

const NOW = (): string => new Date().toISOString();
const GID = 'ag-gw';
const TOKEN = 'host-token-123';
const LINEAR = 'https://mcp.linear.app/mcp';
const LINEAR_ISSUER = 'https://mcp.linear.app';

// ── fake gateway ───────────────────────────────────────────────────────────

interface Recorded {
  method: string;
  url: string;
  auth: string | undefined;
  body: unknown;
}

const gw = {
  server: null as http.Server | null,
  url: '',
  requests: [] as Recorded[],
  accounts: [] as Record<string, unknown>[],
  services: [] as Record<string, unknown>[],
  credentials: new Map<string, string>(),
  failServicePut: false,
  down: false,
};

function initialServices(): Record<string, unknown>[] {
  return [
    {
      name: 'tavily',
      host: 'mcp.tavily.com',
      auth: { type: 'passthrough' },
      substitutions: [{ key: 'TAVILY_API_KEY', placeholder: '__T__', in: ['query'] }],
    },
    { name: 'openrouter', host: 'openrouter.ai', auth: { type: 'bearer', token: 'OPENROUTER_API_KEY' } },
    {
      name: 'minimax',
      host: 'api.minimax.io',
      auth: {
        type: 'custom',
        headers: { Authorization: 'Bearer {{ MINIMAX_API_KEY }}', 'x-api-key': '{{ MINIMAX_API_KEY }}' },
      },
    },
  ];
}

function fakeGateway(req: http.IncomingMessage, res: http.ServerResponse, raw: string): void {
  const url = new URL(req.url || '/', 'http://gw');
  const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : undefined;
  gw.requests.push({ method: req.method!, url: `${url.pathname}${url.search}`, auth: req.headers.authorization, body });
  const send = (status: number, payload?: unknown): void => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(payload === undefined ? undefined : JSON.stringify(payload));
  };
  if (url.pathname === '/v1/oauth/client-metadata') {
    return send(200, { client_id: 'https://nanoclaw.example.com/oauth/client-metadata.json', redirect_uris: ['x'] });
  }
  if (req.headers.authorization !== `Bearer ${TOKEN}`) return send(401, { error: 'unauthorized' });
  const vault = `/v1/vaults/${GID}`;
  if (req.method === 'GET' && url.pathname === `${vault}/services`) {
    return send(200, {
      services: [
        ...gw.services,
        ...gw.accounts.map((a) => ({
          name: 'mcp-x',
          host: 'mcp.linear.app/mcp',
          auth: { type: 'bearer', token: a.key },
        })),
      ],
    });
  }
  if (req.method === 'PUT' && url.pathname === `${vault}/services`) {
    if (gw.failServicePut) return send(400, { error: 'service 2: name is required' });
    gw.services = ((body?.services ?? []) as Record<string, unknown>[]).filter(
      (s) => !String(s.name).startsWith('mcp-'),
    );
    return send(200, { ok: true });
  }
  if (req.method === 'GET' && url.pathname === '/v1/credentials' && url.searchParams.get('vault') === GID) {
    return send(200, {
      credentials: [
        ...[...gw.credentials.keys()].map((key) => ({ key, type: 'static' })),
        ...gw.accounts.map((a) => ({ key: a.key, type: 'mcp_oauth' })),
      ],
    });
  }
  if (req.method === 'POST' && url.pathname === '/v1/credentials' && body?.vault === GID) {
    for (const [k, v] of Object.entries(body.credentials as Record<string, string>)) gw.credentials.set(k, v);
    return send(200, { ok: true });
  }
  if (req.method === 'DELETE' && url.pathname === '/v1/credentials' && body?.vault === GID) {
    const deleted = (body.keys as string[]).filter((k) => gw.credentials.delete(k));
    return send(200, { deleted });
  }
  if (req.method === 'GET' && url.pathname === `${vault}/mcp-oauth`) return send(200, gw.accounts);
  if (req.method === 'POST' && url.pathname === `${vault}/mcp-oauth/probe`) {
    const resource = String(body?.resource_url);
    if (resource === LINEAR) return send(200, { oauth: true, issuer: LINEAR_ISSUER, client: 'registered' });
    if (resource.includes('githubcopilot'))
      return send(200, {
        oauth: true,
        issuer: 'https://github.com/login/oauth',
        code: 'registration_unsupported',
        provider: 'github',
      });
    return send(200, { oauth: false });
  }
  if (req.method === 'POST' && url.pathname === `${vault}/mcp-oauth/start`) {
    if (body?.resource_url !== LINEAR)
      return send(400, { code: 'oauth_not_required', error: 'MCP resource did not request OAuth authentication' });
    return send(200, { state: 'mcp_oast_s1', authorize_url: 'https://linear.app/oauth/authorize?state=mcp_oast_s1' });
  }
  if (req.method === 'POST' && url.pathname === '/v1/oauth/complete') {
    if (body?.state !== 'mcp_oast_s1')
      return send(400, { code: 'invalid_state', error: 'Invalid or expired OAuth state' });
    if (body.error) return send(200, { status: 'failed', vault: GID, code: 'access_denied', error: 'Access denied' });
    if (body.iss !== LINEAR_ISSUER)
      return send(200, { status: 'failed', vault: GID, code: 'issuer_mismatch', error: 'Issuer mismatch' });
    gw.accounts.push({
      key: 'MCP_ABC',
      resource_url: LINEAR,
      account: null,
      connected_at: NOW(),
      last_used_at: null,
      updated_at: NOW(),
      status: 'connected',
      client: 'registered',
      scopes: ['read', 'write'],
    });
    return send(200, { status: 'connected', vault: GID, key: 'MCP_ABC', account: null });
  }
  const del = new RegExp(`^${vault}/mcp-oauth/([^/]+)$`).exec(url.pathname);
  if (req.method === 'DELETE' && del) {
    const before = gw.accounts.length;
    gw.accounts = gw.accounts.filter((a) => a.key !== decodeURIComponent(del[1]!));
    return gw.accounts.length < before ? send(204) : send(404, { error: 'MCP OAuth account not found' });
  }
  send(404, { error: `fake gateway: no route ${req.method} ${url.pathname}` });
}

beforeAll(async () => {
  gw.server = http.createServer((req, res) => {
    if (gw.down) {
      req.socket.destroy();
      return;
    }
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => fakeGateway(req, res, raw));
  });
  await new Promise<void>((resolve) => gw.server!.listen(0, '127.0.0.1', resolve));
  gw.url = `http://127.0.0.1:${(gw.server!.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => gw.server!.close(() => resolve()));
});

// ── request harness (as in group-admin.test.ts) ────────────────────────────

interface CapturedRes {
  done: Promise<void>;
  res: http.ServerResponse;
  status(): number;
  headers(): Record<string, string>;
  text(): string;
  body(): unknown;
}

function makeRes(): CapturedRes {
  let status = 0;
  let headers: Record<string, string> = {};
  const chunks: Buffer[] = [];
  let resolve!: () => void;
  const done = new Promise<void>((r) => {
    resolve = r;
  });
  const w = new Writable({
    write(chunk, _enc, cb): void {
      chunks.push(Buffer.from(chunk));
      cb();
    },
  });
  const res = w as unknown as http.ServerResponse;
  res.writeHead = ((s: number, h?: Record<string, string>) => {
    status = s;
    headers = h ?? {};
    return res;
  }) as http.ServerResponse['writeHead'];
  w.on('finish', resolve);
  const text = (): string => Buffer.concat(chunks).toString('utf-8');
  return {
    done,
    res,
    status: () => status,
    headers: () => headers,
    text,
    body: () => {
      try {
        return JSON.parse(text()) as unknown;
      } catch {
        return text();
      }
    },
  };
}

function makeReq(method: string, url: string, body?: unknown): http.IncomingMessage {
  const buf = body !== undefined ? Buffer.from(JSON.stringify(body)) : Buffer.alloc(0);
  let pulled = false;
  return {
    method,
    url,
    headers: { host: 'localhost', 'content-type': 'application/json' },
    socket: { remoteAddress: '127.0.0.1' },
    [Symbol.asyncIterator]() {
      return {
        next: () => {
          if (pulled || buf.length === 0) return Promise.resolve({ value: undefined, done: true });
          pulled = true;
          return Promise.resolve({ value: buf, done: false });
        },
      };
    },
  } as unknown as http.IncomingMessage;
}

async function run(
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => Promise<unknown>,
  method: string,
  url: string,
  body?: unknown,
): Promise<CapturedRes> {
  const cap = makeRes();
  await handler(makeReq(method, url, body), cap.res);
  try {
    cap.res.end();
  } catch {
    /* already ended */
  }
  await cap.done;
  return cap;
}

const api = (method: string, sub: string, body?: unknown): Promise<CapturedRes> =>
  run(handle, method, `/ui/chat/api/groups/${GID}/admin/credentials${sub}`, body);
const callback = (query: string): Promise<CapturedRes> =>
  run(handleOAuthCallback, 'GET', `/ui/oauth/callback?${query}`);

function seedUser(id: string, role?: { role: 'owner' | 'admin'; agent_group_id: string | null }): void {
  getDb().prepare(`INSERT INTO users (id, kind, display_name, created_at) VALUES (?, 'web', ?, ?)`).run(id, id, NOW());
  if (role) grantRole({ user_id: id, ...role, granted_by: id, granted_at: NOW() });
}

function seedGroup(id: string, mcpServers: Record<string, unknown>): void {
  getDb()
    .prepare(`INSERT INTO agent_groups (id, name, folder, agent_provider, created_at) VALUES (?, ?, ?, NULL, ?)`)
    .run(id, id === GID ? 'Gateway Group' : id, id, NOW());
  getDb()
    .prepare(`INSERT INTO container_configs (agent_group_id, mcp_servers, updated_at) VALUES (?, ?, ?)`)
    .run(id, JSON.stringify(mcpServers), NOW());
}

beforeEach(() => {
  if (fs.existsSync(TEST_ROOT)) fs.rmSync(TEST_ROOT, { recursive: true });
  fs.mkdirSync(path.join(TEST_ROOT, 'data'), { recursive: true });
  fs.writeFileSync(path.join(TEST_ROOT, 'host-token'), `${TOKEN}\n`, { mode: 0o600 });
  vi.stubEnv('NANOCLAW_AGENT_VAULT_URL', gw.url);
  vi.stubEnv('AGENT_VAULT_BOOTSTRAP_TOKEN_FILE', path.join(TEST_ROOT, 'host-token'));
  vi.stubEnv('NANOCLAW_AGENT_VAULT_GROUPS', GID);
  vi.stubEnv('UI_BASE_URL', 'https://nanoclaw.example.com/ui');
  runMigrations(initTestDb());
  gw.requests = [];
  gw.accounts = [];
  gw.services = initialServices();
  gw.credentials = new Map([
    ['TAVILY_API_KEY', 'tvly-secret'],
    ['MINIMAX_API_KEY', 'mm-secret'],
  ]);
  gw.failServicePut = false;
  gw.down = false;
  clearSignIns();
  forgetProbes(GID);
  resetClientMetadataCache();
  seedGroup(GID, {
    linear: { type: 'http', url: LINEAR },
    tavily: { type: 'http', url: 'https://mcp.tavily.com/mcp/?tavilyApiKey=__T__' },
    github: { type: 'http', url: 'https://api.githubcopilot.com/mcp/' },
    plain: { type: 'http', url: 'https://example.com/mcp' },
    local: { type: 'stdio', command: 'uvx', args: ['x'] },
  });
  seedGroup('ag-onecli', {});
  seedUser('web:owner', { role: 'owner', agent_group_id: null });
  seedUser('web:scoped', { role: 'admin', agent_group_id: GID });
  seedUser('web:other', { role: 'admin', agent_group_id: GID });
  mockUserId = 'web:scoped';
});

afterEach(() => {
  closeDb();
  vi.unstubAllEnvs();
  if (fs.existsSync(TEST_ROOT)) fs.rmSync(TEST_ROOT, { recursive: true });
});

// ── tests ──────────────────────────────────────────────────────────────────

describe('GET …/credentials', () => {
  it('combines keys, MCP sign-in status and accounts from the gateway with the host token', async () => {
    const res = await api('GET', '');
    expect(res.status()).toBe(200);
    const body = res.body() as Record<string, unknown> & {
      mcp: Record<string, unknown>[];
      keys: Record<string, unknown>[];
    };
    expect(body).toMatchObject({
      canEdit: true,
      canEditInstall: false,
      keysEditable: true,
      oauthApps: [],
      accounts: [],
    });
    expect(body.oauthRedirectUri).toBe('https://nanoclaw.example.com/ui/oauth/callback');
    expect(body.keys.map((k) => [k.key, k.status, k.mcpServer])).toEqual([
      ['TAVILY_API_KEY', 'set', 'tavily'],
      ['OPENROUTER_API_KEY', 'needs_value', undefined],
      ['MINIMAX_API_KEY', 'set', undefined],
    ]);
    expect(JSON.stringify(body)).not.toContain('secret');
    const mcp = Object.fromEntries(body.mcp.map((m) => [m.server, m]));
    expect(Object.keys(mcp).sort()).toEqual(['github', 'linear', 'plain', 'tavily']);
    expect(mcp.linear).toMatchObject({ auth: 'oauth', status: 'needs_sign_in' });
    expect(mcp.linear!.needsApp).toBeUndefined();
    expect(mcp.github).toMatchObject({ auth: 'oauth', status: 'needs_sign_in', needsApp: 'github' });
    expect(mcp.tavily).toMatchObject({ auth: 'key', key: 'TAVILY_API_KEY', status: 'ok' });
    expect(mcp.plain).toMatchObject({ auth: 'none', status: 'ok' });
    expect(gw.requests.every((r) => r.auth === `Bearer ${TOKEN}`)).toBe(true);
  });

  it('caches probes between loads', async () => {
    await api('GET', '');
    const probes = gw.requests.filter((r) => r.url.endsWith('/probe')).length;
    await api('GET', '');
    expect(gw.requests.filter((r) => r.url.endsWith('/probe')).length).toBe(probes);
  });

  it('tells owners they may change install-wide apps', async () => {
    mockUserId = 'web:owner';
    expect(((await api('GET', '')).body() as { canEditInstall: boolean }).canEditInstall).toBe(true);
  });

  it('answers 503 gateway_unreachable when the gateway is down', async () => {
    gw.down = true;
    const res = await api('GET', '');
    expect(res.status()).toBe(503);
    expect(res.body()).toEqual({ error: 'gateway_unreachable' });
  });

  it('refuses groups that are not on the gateway', async () => {
    const res = await run(handle, 'GET', '/ui/chat/api/groups/ag-onecli/admin/credentials');
    expect(res.status()).toBe(403);
    mockUserId = 'web:owner';
    const owner = await run(handle, 'GET', '/ui/chat/api/groups/ag-onecli/admin/credentials');
    expect(owner.status()).toBe(409);
  });

  it('answers 501 for OAuth apps until P4', async () => {
    const res = await api('PUT', '/oauth-apps/google', { scope: 'group', clientId: 'x', clientSecret: 'secret' });
    expect(res.status()).toBe(501);
    expect(gw.requests.some((r) => JSON.stringify(r.body ?? '').includes('secret'))).toBe(false);
  });
});

describe('MCP sign-in', () => {
  async function start(): Promise<{ state: string; authorizeUrl: string }> {
    const res = await api('POST', '/accounts/start', { mcpServer: 'linear' });
    expect(res.status()).toBe(200);
    return res.body() as { state: string; authorizeUrl: string };
  }

  it('starts on the gateway, relays the callback with iss, and reports progress', async () => {
    const started = await start();
    expect(started).toMatchObject({ state: 'mcp_oast_s1', authorizeUrl: expect.stringContaining('linear.app') });
    expect(gw.requests.at(-1)).toMatchObject({
      url: `/v1/vaults/${GID}/mcp-oauth/start`,
      body: { resource_url: LINEAR, client_name: 'Gateway Group' },
    });
    expect((await api('GET', '/accounts/start/mcp_oast_s1')).body()).toMatchObject({ status: 'pending' });

    const page = await callback(`state=mcp_oast_s1&code=c0de&iss=${encodeURIComponent(LINEAR_ISSUER)}`);
    expect(page.status()).toBe(200);
    expect(page.text()).toContain('nanoclaw-oauth-complete');
    expect(page.text()).toContain('"status":"connected"');
    expect(page.headers()['Referrer-Policy']).toBe('no-referrer');
    expect(page.headers()['Content-Security-Policy']).toMatch(/script-src 'nonce-/);
    expect(gw.requests.at(-1)).toMatchObject({
      url: '/v1/oauth/complete',
      body: { state: 'mcp_oast_s1', code: 'c0de', iss: LINEAR_ISSUER },
    });

    expect((await api('GET', '/accounts/start/mcp_oast_s1')).body()).toMatchObject({ status: 'connected' });
    const overview = (await api('GET', '')).body() as {
      accounts: Record<string, unknown>[];
      mcp: Record<string, unknown>[];
    };
    expect(overview.accounts).toEqual([
      expect.objectContaining({
        key: 'MCP_ABC',
        kind: 'mcp_oauth',
        mcpServer: 'linear',
        providerLabel: 'linear',
        account: null,
        client: 'registered',
        status: 'connected',
        scopes: [
          { id: 'read', label: 'read' },
          { id: 'write', label: 'write' },
        ],
      }),
    ]);
    expect(overview.mcp.find((m) => m.server === 'linear')).toMatchObject({ auth: 'oauth', status: 'ok' });
  });

  it('only completes for the user who started the sign-in', async () => {
    await start();
    mockUserId = 'web:other';
    const page = await callback('state=mcp_oast_s1&code=c0de');
    expect(page.status()).toBe(400);
    expect(gw.requests.some((r) => r.url === '/v1/oauth/complete')).toBe(false);
    expect((await api('GET', '/accounts/start/mcp_oast_s1')).status()).toBe(404);
  });

  it('sends a signed-out browser to log in and back', async () => {
    await start();
    mockUserId = null;
    const page = await callback('state=mcp_oast_s1&code=c0de');
    expect(page.status()).toBe(303);
    expect(page.headers().Location).toBe(
      `/ui/login?next=${encodeURIComponent('/ui/oauth/callback?state=mcp_oast_s1&code=c0de')}`,
    );
    expect(gw.requests.some((r) => r.url === '/v1/oauth/complete')).toBe(false);
  });

  it('reports an issuer mismatch as a failed sign-in', async () => {
    await start();
    const page = await callback('state=mcp_oast_s1&code=c0de&iss=https%3A%2F%2Fevil.example');
    expect(page.text()).toContain('"status":"failed"');
    expect((await api('GET', '/accounts/start/mcp_oast_s1')).body()).toMatchObject({
      status: 'failed',
      error: 'Issuer mismatch',
    });
  });

  it('forwards a declined consent as an error', async () => {
    await start();
    const page = await callback('state=mcp_oast_s1&error=access_denied');
    expect(page.text()).toContain('You declined access');
    expect(gw.requests.at(-1)).toMatchObject({
      url: '/v1/oauth/complete',
      body: { state: 'mcp_oast_s1', error: 'access_denied' },
    });
  });

  it('surfaces gateway refusals with their code', async () => {
    const res = await api('POST', '/accounts/start', { mcpServer: 'plain' });
    expect(res.status()).toBe(400);
    expect(res.body()).toMatchObject({ code: 'oauth_not_required' });
    expect((await api('POST', '/accounts/start', { mcpServer: 'missing' })).status()).toBe(404);
  });

  it('disconnects through the gateway', async () => {
    await start();
    await callback(`state=mcp_oast_s1&code=c0de&iss=${encodeURIComponent(LINEAR_ISSUER)}`);
    expect((await api('DELETE', '/accounts/MCP_ABC')).status()).toBe(200);
    expect(gw.accounts).toEqual([]);
    expect((await api('DELETE', '/accounts/MCP_ABC')).status()).toBe(404);
  });
});

describe('GET /oauth/client-metadata.json', () => {
  it('publishes the gateway document without the host token and caches it', async () => {
    const res = await run(handleClientMetadata, 'GET', '/oauth/client-metadata.json');
    expect(res.status()).toBe(200);
    expect(res.body()).toMatchObject({ client_id: 'https://nanoclaw.example.com/oauth/client-metadata.json' });
    expect(gw.requests.at(-1)!.auth).toBeUndefined();
    await run(handleClientMetadata, 'GET', '/oauth/client-metadata.json');
    expect(gw.requests.filter((r) => r.url === '/v1/oauth/client-metadata')).toHaveLength(1);
  });
});

describe('keys', () => {
  const bearer = (match: string) => ({ match, injection: { type: 'bearer' } });
  const addKey = (body: Record<string, unknown>) => api('POST', '/keys', body);

  it('adds a key as a credential plus one service', async () => {
    const res = await addKey({
      key: 'BRAVE_API_KEY',
      label: 'Brave Search',
      value: 'brv-1',
      destination: { match: 'api.search.brave.com', injection: { type: 'api-key', name: 'X-Subscription-Token' } },
    });
    expect(res.status()).toBe(200);
    expect(gw.credentials.get('BRAVE_API_KEY')).toBe('brv-1');
    expect(gw.services.at(-1)).toEqual({
      name: 'brave-search',
      host: 'api.search.brave.com',
      auth: { type: 'api-key', key: 'BRAVE_API_KEY', header: 'X-Subscription-Token' },
    });
    const keys = ((await api('GET', '')).body() as { keys: Record<string, unknown>[] }).keys;
    expect(keys.find((k) => k.key === 'BRAVE_API_KEY')).toMatchObject({ status: 'set', label: 'brave-search' });
  });

  it('maps query keys to a URL placeholder and custom headers to a template', async () => {
    await addKey({
      key: 'WEATHER_KEY',
      label: 'Weather',
      value: 'w',
      destination: { match: 'api.weather.example', injection: { type: 'query' } },
    });
    expect(gw.services.at(-1)).toMatchObject({
      auth: { type: 'passthrough' },
      substitutions: [{ key: 'WEATHER_KEY', placeholder: '__WEATHER_KEY__', in: ['query'] }],
    });
    await addKey({
      key: 'NC_KEY',
      label: 'nc',
      value: 'x',
      destination: { match: 'nc.example.org/mcp/*', injection: { type: 'custom', template: 'Basic {{ NC_KEY }}' } },
    });
    expect(gw.services.at(-1)).toMatchObject({
      name: 'key-nc',
      host: 'nc.example.org/mcp/*',
      auth: { type: 'custom', headers: { Authorization: 'Basic {{ NC_KEY }}' } },
    });
  });

  it('rejects invalid input and reserved names without calling the gateway', async () => {
    const before = gw.requests.length;
    expect((await addKey({ key: 'lower', value: 'v', destination: bearer('a.example') })).status()).toBe(400);
    expect((await addKey({ key: 'MCP_X', value: 'v', destination: bearer('a.example') })).status()).toBe(400);
    expect((await addKey({ key: 'A_KEY', value: '', destination: bearer('a.example') })).status()).toBe(400);
    expect((await addKey({ key: 'A_KEY', value: 'v', destination: bearer('not a host') })).status()).toBe(400);
    const wrongTemplate = { match: 'a.example', injection: { type: 'custom', template: 'Basic {{ OTHER }}' } };
    expect((await addKey({ key: 'A_KEY', value: 'v', destination: wrongTemplate })).status()).toBe(400);
    expect(gw.requests.length).toBe(before);
  });

  it('refuses a key that already exists', async () => {
    const dup = await addKey({ key: 'OPENROUTER_API_KEY', value: 'v', destination: bearer('openrouter.ai') });
    expect(dup.status()).toBe(409);
    expect(gw.credentials.has('OPENROUTER_API_KEY')).toBe(false);
  });

  it('removes the credential again when the service update fails', async () => {
    gw.failServicePut = true;
    const res = await addKey({ key: 'B_KEY', value: 'v', destination: bearer('b.example') });
    expect(res.status()).toBe(400);
    expect(gw.credentials.has('B_KEY')).toBe(false);
  });

  it('sets a missing value, renames and re-targets a key', async () => {
    expect((await api('PUT', '/keys/OPENROUTER_API_KEY', { value: 'or-1' })).status()).toBe(200);
    expect(gw.credentials.get('OPENROUTER_API_KEY')).toBe('or-1');
    const res = await api('PUT', '/keys/OPENROUTER_API_KEY', {
      label: 'OpenRouter API',
      destination: bearer('openrouter.ai/api/*'),
    });
    expect(res.status()).toBe(200);
    expect(gw.services.find((s) => s.host === 'openrouter.ai/api/*')).toEqual({
      name: 'openrouter-api',
      host: 'openrouter.ai/api/*',
      auth: { type: 'bearer', token: 'OPENROUTER_API_KEY' },
    });
  });

  it('keeps auth details the form cannot express when only the host changes', async () => {
    const keys = ((await api('GET', '')).body() as { keys: { key: string; destination: { injection: unknown } }[] })
      .keys;
    const injection = keys.find((k) => k.key === 'MINIMAX_API_KEY')!.destination.injection;
    expect(
      (await api('PUT', '/keys/MINIMAX_API_KEY', { destination: { match: 'api.minimaxi.com', injection } })).status(),
    ).toBe(200);
    expect(gw.services.find((s) => s.name === 'minimax')).toMatchObject({
      host: 'api.minimaxi.com',
      auth: { headers: { Authorization: 'Bearer {{ MINIMAX_API_KEY }}', 'x-api-key': '{{ MINIMAX_API_KEY }}' } },
    });
  });

  it('deletes the key and its service but never MCP sign-in services', async () => {
    gw.accounts.push({
      key: 'MCP_ABC',
      resource_url: LINEAR,
      account: null,
      connected_at: NOW(),
      last_used_at: null,
      updated_at: NOW(),
      status: 'connected',
      client: 'registered',
      scopes: [],
    });
    expect((await api('DELETE', '/keys/TAVILY_API_KEY')).status()).toBe(200);
    expect(gw.credentials.has('TAVILY_API_KEY')).toBe(false);
    expect(gw.services.map((s) => s.name)).toEqual(['openrouter', 'minimax']);
    const put = gw.requests.filter((r) => r.method === 'PUT' && r.url.endsWith('/services')).at(-1)!;
    expect((put.body as { services: { name: string }[] }).services.map((s) => s.name)).toContain('mcp-x');
    expect((await api('DELETE', '/keys/TAVILY_API_KEY')).status()).toBe(404);
    expect((await api('DELETE', '/keys/MCP_ABC')).status()).toBe(400);
  });

  it('serializes concurrent key writes per group', async () => {
    await Promise.all([
      addKey({ key: 'C1_KEY', value: 'v', destination: bearer('c1.example') }),
      addKey({ key: 'C2_KEY', value: 'v', destination: bearer('c2.example') }),
    ]);
    expect(gw.services.map((s) => s.host)).toEqual(expect.arrayContaining(['c1.example', 'c2.example']));
  });

  it('never returns values', async () => {
    const res = await addKey({ key: 'S_KEY', value: 'super-secret-value', destination: bearer('s.example') });
    expect(res.text()).not.toContain('super-secret-value');
    expect((await api('GET', '')).text()).not.toContain('super-secret-value');
  });
});

describe('ncl credentials (host)', () => {
  const host = { caller: 'host' as const };
  const run = (command: string, args: Record<string, unknown>) => dispatch({ id: '1', command, args }, host);

  it('lists keys and sign-ins without values', async () => {
    const resp = await run('credentials-list', { group: GID });
    expect(resp.ok).toBe(true);
    if (!resp.ok) return;
    expect(resp.data).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'key', key: 'TAVILY_API_KEY', status: 'set', how: 'query' }),
        expect.objectContaining({ kind: 'key', key: 'OPENROUTER_API_KEY', status: 'needs_value' }),
      ]),
    );
    expect(JSON.stringify(resp.data)).not.toContain('secret');
  });

  it('adds a key from stdin, then replaces its value and deletes it', async () => {
    let resp = await run('credentials-set', {
      group: GID,
      key: 'CLI_KEY',
      'value-stdin': true,
      value: 'v1',
      match: 'cli.example',
    });
    expect(resp.ok).toBe(true);
    expect(gw.credentials.get('CLI_KEY')).toBe('v1');
    expect(gw.services.at(-1)).toMatchObject({ host: 'cli.example', auth: { type: 'bearer', token: 'CLI_KEY' } });
    resp = await run('credentials-set', { group: GID, key: 'CLI_KEY', 'value-stdin': true, value: 'v2' });
    expect(resp.ok).toBe(true);
    expect(gw.credentials.get('CLI_KEY')).toBe('v2');
    resp = await run('credentials-delete', { group: GID, key: 'CLI_KEY' });
    expect(resp.ok).toBe(true);
    expect(gw.credentials.has('CLI_KEY')).toBe(false);
  });

  it('refuses values passed on the command line and groups off the gateway', async () => {
    const inline = await run('credentials-set', { group: GID, key: 'CLI_KEY', value: 'oops', match: 'cli.example' });
    expect(inline.ok).toBe(false);
    if (!inline.ok) expect(inline.error.message).toContain('--value-stdin');
    expect(gw.credentials.has('CLI_KEY')).toBe(false);
    const off = await run('credentials-list', { group: 'ag-onecli' });
    expect(off.ok).toBe(false);
  });
});
