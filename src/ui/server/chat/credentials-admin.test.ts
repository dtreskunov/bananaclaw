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
import { forgetProbes, serviceKeys, type GatewayService } from '../../../modules/credentials/gateway-credentials.js';
import { grantRole } from '../../../modules/permissions/db/user-roles.js';
import { handleClientMetadata, handleOAuthCallback, resetClientMetadataCache } from '../oauth-callback.js';
import { handle } from './routes.js';
import { dispatch } from '../../../cli/dispatch.js';
import '../../../cli/commands/credentials.js';
import '../../../cli/resources/groups.js';

const NOW = (): string => new Date().toISOString();
const GID = 'ag-gw';
const TOKEN = 'host-token-123';
const LINEAR = 'https://mcp.linear.app/mcp';
const LINEAR_ISSUER = 'https://mcp.linear.app';
const APP_CONFIGS: Record<string, Record<string, unknown>> = {
  google: {
    label: 'Google',
    issuer: 'https://accounts.google.com',
    authorization_endpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
    token_endpoint: 'https://oauth2.googleapis.com/token',
    api_hosts: ['gmail.googleapis.com', 'www.googleapis.com'],
    default_scopes: ['https://www.googleapis.com/auth/gmail.readonly'],
  },
  github: {
    label: 'GitHub',
    issuer: 'https://github.com/login/oauth',
    authorization_endpoint: 'https://github.com/login/oauth/authorize',
    token_endpoint: 'https://github.com/login/oauth/access_token',
    api_hosts: ['api.github.com'],
    default_scopes: ['repo'],
  },
};
const appConfig = (id: string, clientId: string) => ({ ...APP_CONFIGS[id], client_id: clientId });
interface TestApp {
  client_id: string;
  secret: string;
  config: Record<string, unknown>;
}

// ── fake gateway ───────────────────────────────────────────────────────────

interface Recorded {
  method: string;
  url: string;
  auth: string | undefined;
  body: unknown;
  ifMatch?: string;
  ifNoneMatch?: string;
}

const gw = {
  server: null as http.Server | null,
  url: '',
  requests: [] as Recorded[],
  accounts: [] as Record<string, unknown>[],
  services: [] as Record<string, unknown>[],
  credentials: new Map<string, string>(),
  failServicePut: false,
  failKeyPut: false,
  apps: {
    install: new Map<string, TestApp>(),
    vault: new Map<string, TestApp>(),
  },
  providerAccounts: [] as Record<string, unknown>[],
  completionKey: 'OAUTH_G1',
  verifiedAccount: null as string | null,
  vaults: new Set<string>(),
  down: false,
  missingApps: false,
  ambiguousApp: false,
  setVersion: 1,
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
  gw.requests.push({
    method: req.method!,
    url: `${url.pathname}${url.search}`,
    auth: req.headers.authorization,
    body,
    ifMatch: req.headers['if-match'] as string | undefined,
    ifNoneMatch: req.headers['if-none-match'] as string | undefined,
  });
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
  const setRoute = new RegExp(`^${vault}/key-sets/([a-z0-9-]+)$`).exec(url.pathname);
  if (setRoute) {
    const name = setRoute[1]!;
    const existing = gw.services.find((s) => s.name === name);
    const revision = () => `"${gw.setVersion.toString(16).padStart(64, '0')}"`;
    const metadata = (service: GatewayService) => ({
      service,
      keys: serviceKeys(service).sort(),
      revision: revision(),
    });
    if (req.method === 'GET')
      return existing
        ? send(200, metadata(existing as unknown as GatewayService))
        : send(404, { error: 'Key set not found' });
    const creating = req.headers['if-none-match'] === '*';
    if (creating ? existing : req.headers['if-match'] !== revision())
      return send(412, { error: 'credential set revision does not match' });
    if (req.method === 'DELETE') {
      if (!existing) return send(404, { error: 'Key set not found' });
      for (const key of serviceKeys(existing as unknown as GatewayService)) gw.credentials.delete(key);
      gw.services = gw.services.filter((s) => s.name !== name);
      gw.setVersion++;
      return send(204);
    }
    const service = body?.service as GatewayService;
    const values = body?.values as Record<string, string>;
    if (creating && serviceKeys(service).some((key) => gw.credentials.has(key)))
      return send(412, { error: 'existing key' });
    gw.services = [...gw.services.filter((s) => s.name !== name), { ...service, https_only: true }];
    for (const [key, value] of Object.entries(values)) gw.credentials.set(key, value);
    gw.setVersion++;
    return send(200, metadata(service));
  }
  const keyRoute = new RegExp(`^${vault}/keys/([A-Z][A-Z0-9_]*)$`).exec(url.pathname);
  if (keyRoute && req.method === 'PUT') {
    const key = keyRoute[1]!;
    const service = body?.service as GatewayService | undefined;
    if (gw.failKeyPut) return send(409, { error: 'service name already used by another key' });
    if (!service || /^(mcp|oauth)-/.test(service.name)) {
      return send(409, { error: 'managed OAuth services and credentials must be changed through account endpoints' });
    }
    const refs = serviceKeys(service);
    if (refs.length !== 1 || refs[0] !== key) return send(400, { error: 'service must reference only the path key' });
    if (!gw.credentials.has(key) && typeof body?.value !== 'string') return send(400, { error: 'value is required' });
    const onlyThisKey = (s: Record<string, unknown>): boolean => {
      const k = serviceKeys(s as unknown as GatewayService);
      return k.length === 1 && k[0] === key;
    };
    if (gw.services.some((s) => s.name === service.name && !onlyThisKey(s))) {
      return send(409, { error: 'service name collides' });
    }
    gw.services = [...gw.services.filter((s) => !onlyThisKey(s)), service as unknown as Record<string, unknown>];
    if (typeof body?.value === 'string') gw.credentials.set(key, body.value);
    return send(200, { key });
  }
  if (keyRoute && req.method === 'DELETE') {
    const key = keyRoute[1]!;
    const before = gw.services.length;
    gw.services = gw.services.filter((s) => !serviceKeys(s as unknown as GatewayService).includes(key));
    const had = gw.credentials.delete(key);
    if (!had && gw.services.length === before) return send(404, { error: 'Key not found' });
    return send(204);
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
    if (resource.includes('githubcopilot')) {
      if (gw.ambiguousApp)
        return send(409, { code: 'ambiguous_app', error: 'Multiple configured apps match the issuer' });
      if (gw.apps.vault.has('github') || gw.apps.install.has('github')) {
        return send(200, { oauth: true, issuer: 'https://github.com/login/oauth', client: 'app' });
      }
      return send(200, {
        oauth: true,
        issuer: 'https://github.com/login/oauth',
        code: 'registration_unsupported',
      });
    }
    return send(200, { oauth: false });
  }
  if (req.method === 'POST' && url.pathname === `${vault}/mcp-oauth/start`) {
    if (body?.resource_url !== LINEAR)
      return send(400, { code: 'oauth_not_required', error: 'MCP resource did not request OAuth authentication' });
    return send(200, { state: 'mcp_oast_s1', authorize_url: 'https://linear.app/oauth/authorize?state=mcp_oast_s1' });
  }
  const appView = (id: string, a: TestApp, source: 'install' | 'vault', global = false): Record<string, unknown> => ({
    label: id,
    issuer: `https://${id}.example`,
    token_endpoint_auth_method: 'client_secret_post',
    api_hosts: [],
    default_scopes: [],
    identity: 'none',
    token_scope_separator: 'space',
    ...a.config,
    id,
    client_id: a.client_id,
    source,
    client_secret_set: Boolean(a.secret),
    overrides_install: source === 'vault' && gw.apps.install.has(id),
    updated_at: NOW(),
    accounts: gw.providerAccounts.filter((item) => item.app_id === id && item.app_source === source).length,
    ...(global ? { accounts_all_vaults: 4 } : {}),
  });
  if (req.method === 'GET' && (url.pathname === '/v1/oauth-apps' || url.pathname === `${vault}/oauth-apps`)) {
    if (gw.missingApps) return send(404, { error: 'Apps endpoint missing' });
    const global = url.pathname === '/v1/oauth-apps';
    const effective = new Map(gw.apps.install);
    if (!global) for (const [id, app] of gw.apps.vault) effective.set(id, app);
    return send(200, {
      items: [...effective].map(([id, app]) =>
        appView(id, app, !global && gw.apps.vault.has(id) ? 'vault' : 'install', global),
      ),
    });
  }
  if (req.method === 'POST' && url.pathname === '/v1/vaults') {
    const name = String(body?.name);
    if (gw.vaults.has(name)) return send(409, { error: `Vault "${name}" already exists` });
    gw.vaults.add(name);
    return send(201, { name });
  }
  const vaultDel = /^\/v1\/vaults\/([^/]+)$/.exec(url.pathname);
  if (req.method === 'DELETE' && vaultDel) {
    return gw.vaults.delete(decodeURIComponent(vaultDel[1]!)) ? send(204) : send(404, { error: 'Vault not found' });
  }
  const installApp = /^\/v1\/oauth-apps\/([a-z0-9-]+)$/.exec(url.pathname);
  const vaultApp = new RegExp(`^${vault}/oauth-apps/([a-z0-9-]+)$`).exec(url.pathname);
  if (installApp || vaultApp) {
    const provider = (installApp ?? vaultApp)![1]!;
    const store = vaultApp ? gw.apps.vault : gw.apps.install;
    const view = (a: TestApp): Record<string, unknown> =>
      appView(provider, a, vaultApp ? 'vault' : 'install', !vaultApp);
    if (req.method === 'GET') {
      const a = store.get(provider) ?? (vaultApp ? gw.apps.install.get(provider) : undefined);
      return a ? send(200, view(a)) : send(404, { error: 'OAuth app not configured' });
    }
    if (req.method === 'PUT') {
      const current = store.get(provider);
      const secret = body?.client_secret as string | undefined;
      const config = { ...current?.config, ...body };
      delete config.client_secret;
      if (!config.issuer || !config.client_id || /\s/.test(String(config.client_id)))
        return send(400, { error: 'Invalid issuer or client ID' });
      if (
        config.token_endpoint_auth_method !== 'none' &&
        !secret &&
        (!current || current.client_id !== config.client_id)
      ) {
        return send(400, { error: 'client secret required' });
      }
      store.set(provider, { client_id: String(config.client_id), secret: secret ?? current?.secret ?? '', config });
      return send(200, view(store.get(provider)!));
    }
    if (req.method === 'DELETE') {
      if (!store.delete(provider)) return send(404, { error: 'OAuth app not configured' });
      gw.providerAccounts = gw.providerAccounts.filter(
        (a) => a.app_id !== provider || a.app_source !== (vaultApp ? 'vault' : 'install'),
      );
      return send(204);
    }
  }
  if (req.method === 'GET' && url.pathname === `${vault}/oauth-accounts`) return send(200, gw.providerAccounts);
  if (req.method === 'POST' && url.pathname === `${vault}/oauth-accounts/start`) {
    const provider = String(body?.app_id);
    if (!gw.apps.vault.has(provider) && !gw.apps.install.has(provider)) {
      return send(400, { code: 'app_not_configured', error: 'OAuth app not configured' });
    }
    return send(200, { state: 'mcp_oast_p1', authorize_url: `https://accounts.example/${provider}?state=mcp_oast_p1` });
  }
  const pdel = new RegExp(`^${vault}/oauth-accounts/([^/]+)$`).exec(url.pathname);
  if (req.method === 'DELETE' && pdel) {
    const before = gw.providerAccounts.length;
    gw.providerAccounts = gw.providerAccounts.filter((a) => a.key !== decodeURIComponent(pdel[1]!));
    return gw.providerAccounts.length < before ? send(204) : send(404, { error: 'account not found' });
  }
  if (req.method === 'POST' && url.pathname === '/v1/oauth/complete' && body?.state === 'mcp_oast_p1') {
    if (body.error) return send(200, { status: 'failed', vault: GID, code: 'declined', error: 'Access denied' });
    const existing = gw.providerAccounts.find((a) => a.key === gw.completionKey);
    const connected = {
      kind: 'oauth_app',
      app_id: 'google',
      app_source: 'vault',
      issuer: 'https://accounts.google.com',
      api_hosts: ['gmail.googleapis.com'],
      requested_scopes: ['https://www.googleapis.com/auth/gmail.readonly'],
      granted_scopes: null,
      scope_source: 'requested',
      key: gw.completionKey,
      resource_url: '',
      account: gw.verifiedAccount,
      connected_at: NOW(),
      last_used_at: null,
      updated_at: NOW(),
      status: 'connected',
      client: 'app',
      scopes: ['https://www.googleapis.com/auth/gmail.readonly'],
      ...existing,
    };
    gw.providerAccounts = [...gw.providerAccounts.filter((a) => a.key !== connected.key), connected];
    return send(200, { status: 'connected', vault: GID, key: connected.key, account: connected.account });
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
      account: gw.verifiedAccount,
      connected_at: NOW(),
      last_used_at: null,
      updated_at: NOW(),
      status: 'connected',
      client: 'registered',
      scopes: ['read', 'write'],
    });
    return send(200, { status: 'connected', vault: GID, key: 'MCP_ABC', account: gw.verifiedAccount });
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
  gw.failKeyPut = false;
  gw.apps = { install: new Map(), vault: new Map() };
  gw.providerAccounts = [];
  gw.completionKey = 'OAUTH_G1';
  gw.verifiedAccount = null;
  gw.vaults = new Set([GID]);
  gw.down = false;
  gw.missingApps = false;
  gw.ambiguousApp = false;
  gw.setVersion = 1;
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
    expect(mcp.linear!.needsApp).toBe(false);
    expect(mcp.github).toMatchObject({
      auth: 'oauth',
      status: 'needs_sign_in',
      needsApp: true,
      issuer: 'https://github.com/login/oauth',
    });
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

  it('uses the atomic key API and leaves nothing behind when the gateway refuses', async () => {
    gw.failKeyPut = true;
    const res = await addKey({ key: 'B_KEY', value: 'v', destination: bearer('b.example') });
    expect(res.status()).toBe(409);
    expect(gw.credentials.has('B_KEY')).toBe(false);
    expect(gw.requests.some((r) => r.url === '/v1/credentials' && r.method === 'POST')).toBe(false);
    expect(gw.requests.some((r) => r.method === 'PUT' && r.url.endsWith('/services'))).toBe(false);
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
    expect(gw.requests.some((r) => r.method === 'DELETE' && r.url === `/v1/vaults/${GID}/keys/TAVILY_API_KEY`)).toBe(
      true,
    );
    expect(gw.requests.some((r) => r.method === 'PUT' && r.url.endsWith('/services'))).toBe(false);
    expect(gw.accounts).toHaveLength(1);
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

  describe('inactive target and conditional key sets', () => {
    const service: GatewayService = {
      name: 'combined-test',
      host: 'combined.example.com',
      auth: { type: 'custom', headers: { Authorization: 'Bearer {{ FIRST_KEY }}', 'x-api-key': '{{ SECOND_KEY }}' } },
    };
    const values = { FIRST_KEY: 'synthetic-first', SECOND_KEY: 'synthetic-second' };
    const cli = (command: string, args: Record<string, unknown>) =>
      dispatch({ id: 'keyset', command, args }, { caller: 'host' });

    it('prepares an inactive target through UI or CLI without changing its backend', async () => {
      vi.stubEnv('NANOCLAW_AGENT_VAULT_GROUPS', '');
      expect((await api('GET', '')).body()).toMatchObject({ error: 'inactive_gateway_target' });
      expect((await api('POST', '/target', {})).status()).toBe(200);
      expect((await cli('credentials-target-prepare', { group: GID })).ok).toBe(true);
      expect((await api('GET', '?target=agent-vault')).body()).toMatchObject({
        targetOnly: true,
        activeBackend: 'onecli',
      });
      expect(
        getDb().prepare('SELECT credential_backend FROM container_configs WHERE agent_group_id=?').get(GID),
      ).toEqual({ credential_backend: null });
      expect(
        (await cli('credentials-backend-set', { group: GID, backend: 'agent-vault', 'target-only': true })).ok,
      ).toBe(false);
      expect((await api('POST', '/key-sets', { service, values })).status()).toBe(409);
      const created = await api('POST', '/key-sets?target=agent-vault', { service, values });
      expect(created.status()).toBe(200);
      expect(gw.credentials.get('FIRST_KEY')).toBe(values.FIRST_KEY);
      expect(await cli('credentials-backend-get', { group: GID })).toMatchObject({ ok: true, data: 'onecli' });
    });

    it('preserves create/update/delete preconditions and exposes shared-service metadata, never values', async () => {
      const created = await api('POST', '/key-sets', { service, values });
      expect(created.status()).toBe(200);
      const info = created.body() as { revision: string };
      expect(created.text()).not.toContain('synthetic-');
      expect(gw.requests.at(-1)).toMatchObject({ ifNoneMatch: '*' });
      expect((await api('POST', '/key-sets', { service, values })).status()).toBe(412);
      const overview = await api('GET', '');
      expect(overview.text()).not.toContain('synthetic-');
      expect((overview.body() as { keys: unknown[] }).keys).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ key: 'FIRST_KEY', sharedService: service.name }),
          expect.objectContaining({ key: 'SECOND_KEY', sharedService: service.name }),
        ]),
      );
      const edited = await api('PUT', `/key-sets/${service.name}`, {
        service,
        values: { SECOND_KEY: 'synthetic-new' },
        revision: info.revision,
      });
      expect(edited.status()).toBe(200);
      expect(gw.requests.at(-1)?.ifMatch).toBe(info.revision);
      expect(gw.credentials.get('FIRST_KEY')).toBe(values.FIRST_KEY);
      expect(gw.credentials.get('SECOND_KEY')).toBe('synthetic-new');
      expect((await api('DELETE', `/key-sets/${service.name}`, { revision: info.revision })).status()).toBe(412);
      expect((await api('DELETE', `/key-sets/${service.name}`, edited.body())).status()).toBe(200);
      expect(gw.credentials.has('FIRST_KEY')).toBe(false);
    });

    it('requires safe values stdin and exact revisions for CLI key-set operations', async () => {
      const args = { group: GID, name: service.name, service: JSON.stringify(service), value: JSON.stringify(values) };
      expect((await cli('credentials-key-set-create', args)).ok).toBe(false);
      const created = await cli('credentials-key-set-create', { ...args, 'values-stdin': true });
      expect(created.ok).toBe(true);
      expect(JSON.stringify(created)).not.toContain('synthetic-');
      expect((await cli('credentials-key-set-update', { ...args, 'values-stdin': true })).ok).toBe(false);
      const bad = await cli('credentials-key-set-create', {
        ...args,
        'values-stdin': true,
        value: '{"FIRST_KEY":"synthetic-private',
      });
      expect(bad.ok).toBe(false);
      expect(JSON.stringify(bad)).not.toContain('synthetic-private');
    });

    it('retains the group admin and host-only gates in target mode', async () => {
      mockUserId = null;
      expect((await api('POST', '/target', {})).status()).toBe(401);
      mockUserId = 'web:scoped';
      const denied = makeRes();
      await handle(makeReq('POST', '/ui/chat/api/groups/ag-onecli/admin/credentials/target', {}), denied.res);
      expect(denied.status()).toBe(403);
      const count = gw.requests.length;
      for (const command of ['credentials-target-prepare', 'credentials-key-set-create']) {
        const result = await dispatch(
          { id: 'agent', command, args: { group: GID, 'target-only': true } },
          { caller: 'agent', agentGroupId: GID, sessionId: 's', messagingGroupId: 'm' },
        );
        expect(result.ok).toBe(false);
      }
      expect(gw.requests).toHaveLength(count);
    });
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

  it('sets and removes OAuth apps with the secret from stdin', async () => {
    let resp = await run('credentials-oauth-app-set', {
      group: GID,
      app: 'github',
      config: JSON.stringify(appConfig('github', 'Iv-cli')),
      'secret-stdin': true,
      secret: 'cli-secret',
      install: true,
    });
    expect(resp.ok).toBe(true);
    expect(gw.apps.install.get('github')).toMatchObject({ client_id: 'Iv-cli', secret: 'cli-secret' });
    const inline = await run('credentials-oauth-app-set', {
      group: GID,
      app: 'google',
      config: JSON.stringify(appConfig('google', 'g')),
      secret: 'x',
    });
    expect(inline.ok).toBe(false);
    if (!inline.ok) expect(inline.error.message).toContain('--secret-stdin');
    resp = await run('credentials-list', { group: GID });
    expect(resp.ok && JSON.stringify(resp.data)).toContain('Iv-cli');
    expect(resp.ok && JSON.stringify(resp.data)).not.toContain('cli-secret');
    resp = await run('credentials-oauth-app-remove', { group: GID, app: 'github', install: true });
    expect(resp.ok).toBe(true);
    expect(gw.apps.install.size).toBe(0);
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

describe('OAuth apps and provider accounts', () => {
  type App = {
    id: string;
    install: Record<string, unknown> | null;
    group: Record<string, unknown> | null;
    mcpServers?: string[];
  };
  const apps = async (): Promise<App[]> => ((await api('GET', '')).body() as { oauthApps: App[] }).oauthApps;

  it('enumerates only configured generic apps without querying a provider catalog', async () => {
    expect(await apps()).toEqual([]);
    await api('PUT', '/oauth-apps/custom-app', {
      config: {
        issuer: 'https://auth.example.com',
        client_id: 'custom-client',
        token_endpoint_auth_method: 'none',
        label: 'Custom',
      },
    });
    const list = await apps();
    expect(list.map((a) => a.id)).toEqual(['custom-app']);
    expect(list[0]).toMatchObject({
      install: null,
      group: { clientId: 'custom-client', config: { issuer: 'https://auth.example.com' }, clientSecretSet: false },
    });
    expect(gw.requests.some((r) => r.url === '/v1/oauth/providers')).toBe(false);
    expect(gw.requests.some((r) => r.url === '/v1/oauth-apps')).toBe(false);
  });

  it('does not silently hide apps when the required app collection is missing', async () => {
    gw.missingApps = true;
    expect((await api('GET', '')).status()).not.toBe(200);
  });

  it('surfaces ambiguous MCP app selection instead of reporting no authentication', async () => {
    gw.ambiguousApp = true;
    expect((await api('GET', '')).body()).toMatchObject({
      mcp: expect.arrayContaining([expect.objectContaining({ server: 'github', auth: 'oauth', ambiguousApp: true })]),
    });
  });

  it('keeps install and override metadata distinct and hides global counts from scoped admins', async () => {
    mockUserId = 'web:owner';
    await api('PUT', '/oauth-apps/github', {
      scope: 'install',
      config: appConfig('github', 'install'),
      clientSecret: 's1',
    });
    await api('PUT', '/oauth-apps/github', {
      scope: 'group',
      config: appConfig('github', 'override'),
      clientSecret: 's2',
    });
    const owner = (await apps())[0]!;
    expect(owner).toMatchObject({
      overridesInstall: true,
      install: { clientId: 'install', accountsAllGroups: 4 },
      group: { clientId: 'override' },
    });
    mockUserId = 'web:scoped';
    const scoped = (await apps())[0]!;
    expect(scoped).toMatchObject({ overridesInstall: true, install: null, group: { clientId: 'override' } });
    expect(JSON.stringify(scoped)).not.toContain('accountsAllGroups');
    await api('DELETE', '/oauth-apps/github');
    expect((await apps())[0]).toMatchObject({ install: { clientId: 'install' }, group: null });
  });

  it("lets scoped admins set the group's own app but not the install-wide one", async () => {
    const install = await api('PUT', '/oauth-apps/github', {
      scope: 'install',
      config: appConfig('github', 'Iv1'),
      clientSecret: 'gh-secret',
    });
    expect(install.status()).toBe(403);
    expect(gw.apps.install.size).toBe(0);
    const own = await api('PUT', '/oauth-apps/github', {
      scope: 'group',
      config: appConfig('github', 'Iv1'),
      clientSecret: 'gh-secret',
    });
    expect(own.status()).toBe(200);
    expect(gw.apps.vault.get('github')).toMatchObject({ client_id: 'Iv1', secret: 'gh-secret' });
    expect((await api('DELETE', '/oauth-apps/github?scope=install')).status()).toBe(403);
  });

  it('lets owners set the install-wide app, which clears the "needs an app" state', async () => {
    let mcp = ((await api('GET', '')).body() as { mcp: Record<string, unknown>[] }).mcp;
    expect(mcp.find((m) => m.server === 'github')).toMatchObject({ needsApp: true });
    mockUserId = 'web:owner';
    const res = await api('PUT', '/oauth-apps/github', {
      scope: 'install',
      config: appConfig('github', 'Iv-install'),
      clientSecret: 's',
    });
    expect(res.status()).toBe(200);
    const github = (await apps()).find((a) => a.id === 'github')!;
    expect(github.install).toMatchObject({ clientId: 'Iv-install', accounts: 0, accountsAllGroups: 4 });
    mcp = ((await api('GET', '')).body() as { mcp: Record<string, unknown>[] }).mcp;
    expect(mcp.find((m) => m.server === 'github')!.needsApp).toBe(false);
  });

  it('requires a secret for a new client ID but keeps it when only other fields change', async () => {
    expect((await api('PUT', '/oauth-apps/google', { config: appConfig('google', 'g-1') })).status()).toBe(400);
    expect(
      (await api('PUT', '/oauth-apps/google', { config: appConfig('google', 'g-1'), clientSecret: 'first' })).status(),
    ).toBe(200);
    expect((await api('PUT', '/oauth-apps/google', { config: { label: 'Personal Google' } })).status()).toBe(200);
    expect(gw.apps.vault.get('google')).toMatchObject({ client_id: 'g-1', secret: 'first' });
    expect(
      (
        await api('PUT', '/oauth-apps/google', { config: appConfig('google', 'has space'), clientSecret: 'x' })
      ).status(),
    ).toBe(400);
    expect(
      (
        await api('PUT', '/oauth-apps/custom-app', {
          config: { issuer: 'https://issuer.example', client_id: 'x' },
          clientSecret: 'x',
        })
      ).status(),
    ).toBe(200);
    expect((await api('PUT', '/oauth-apps/custom-app', { config: { client_secret: 'unsafe' } })).status()).toBe(400);
    expect((await api('PUT', '/oauth-apps/custom-app', { config: [] })).status()).toBe(400);
  });

  it('connects a provider account through the callback, then disconnects it', async () => {
    await api('PUT', '/oauth-apps/google', { config: appConfig('google', 'g-1'), clientSecret: 'first' });
    const started = await api('POST', '/accounts/start', {
      appId: 'google',
      scopes: ['https://www.googleapis.com/auth/gmail.readonly'],
    });
    expect(started.status()).toBe(200);
    expect(started.body()).toMatchObject({ state: 'mcp_oast_p1', label: 'Google' });
    expect(gw.requests.at(-1)).toMatchObject({
      url: `/v1/vaults/${GID}/oauth-accounts/start`,
      body: { app_id: 'google', scopes: ['https://www.googleapis.com/auth/gmail.readonly'] },
    });
    const page = await callback('state=mcp_oast_p1&code=c0de');
    expect(page.text()).toContain('"status":"connected"');
    expect((await api('GET', '/accounts/start/mcp_oast_p1')).body()).toMatchObject({
      status: 'connected',
      key: 'OAUTH_G1',
      account: null,
    });
    const overview = (await api('GET', '')).body() as { accounts: Record<string, unknown>[]; oauthApps: App[] };
    expect(overview.accounts[0]).toMatchObject({
      key: 'OAUTH_G1',
      kind: 'oauth_app',
      provider: 'google',
      providerLabel: 'Google',
      scopes: [
        {
          id: 'https://www.googleapis.com/auth/gmail.readonly',
          label: 'https://www.googleapis.com/auth/gmail.readonly',
        },
      ],
      grantedScopes: null,
      scopeSource: 'requested',
      apiHosts: ['gmail.googleapis.com'],
      client: 'app',
    });
    expect(overview.oauthApps[0]!.group).toMatchObject({ clientId: 'g-1', accounts: 1 });
    expect((await api('DELETE', '/accounts/OAUTH_G1')).status()).toBe(200);
    expect(gw.providerAccounts).toEqual([]);
  });

  it('uses the returned existing provider key and reloaded labels/scopes without exposing internal subjects', async () => {
    await api('PUT', '/oauth-apps/google', { config: appConfig('google', 'g-1'), clientSecret: 'first' });
    gw.completionKey = 'OAUTH_EXISTING';
    gw.providerAccounts = [
      {
        key: 'OAUTH_EXISTING',
        kind: 'oauth_app',
        app_id: 'google',
        app_source: 'vault',
        account: 'verified@example.com',
        subject: 'internal-provider-subject',
        scopes: ['gmail.readonly', 'calendar'],
        granted_scopes: ['gmail.readonly', 'calendar'],
        scope_source: 'provider',
        status: 'connected',
      },
    ];
    await api('POST', '/accounts/start', { appId: 'google', scopes: ['calendar'] });
    await callback('state=mcp_oast_p1&code=c0de');
    expect((await api('GET', '/accounts/start/mcp_oast_p1')).body()).toEqual({
      status: 'connected',
      key: 'OAUTH_EXISTING',
      account: 'verified@example.com',
    });
    const overview = (await api('GET', '')).body() as { accounts: Record<string, unknown>[] };
    expect(overview.accounts).toHaveLength(1);
    expect(overview.accounts[0]).toMatchObject({
      key: 'OAUTH_EXISTING',
      account: 'verified@example.com',
      scopes: [
        { id: 'gmail.readonly', label: 'gmail.readonly' },
        { id: 'calendar', label: 'calendar' },
      ],
    });
    expect(JSON.stringify(overview)).not.toContain('internal-provider-subject');
    expect((await api('DELETE', '/accounts/OAUTH_EXISTING')).status()).toBe(200);
  });

  it('passes verified MCP account labels through completion and the refreshed overview', async () => {
    gw.verifiedAccount = 'Verified Linear user';
    await api('POST', '/accounts/start', { mcpServer: 'linear' });
    await callback(`state=mcp_oast_s1&code=c0de&iss=${encodeURIComponent(LINEAR_ISSUER)}`);
    expect((await api('GET', '/accounts/start/mcp_oast_s1')).body()).toEqual({
      status: 'connected',
      key: 'MCP_ABC',
      account: 'Verified Linear user',
    });
    expect((await api('GET', '')).body()).toMatchObject({
      accounts: [expect.objectContaining({ key: 'MCP_ABC', account: 'Verified Linear user' })],
      mcp: expect.arrayContaining([expect.objectContaining({ server: 'linear', account: 'Verified Linear user' })]),
    });
  });

  it('rejects legacy payloads, unknown apps and malformed scopes before starting a flow', async () => {
    const before = gw.requests.filter((r) => r.url.endsWith('/oauth-accounts/start')).length;
    expect((await api('POST', '/accounts/start', { appId: 'nope', scopes: ['x'] })).status()).toBe(404);
    expect((await api('POST', '/accounts/start', { provider: 'google', scopeSets: ['bogus'] })).status()).toBe(400);
    expect((await api('POST', '/accounts/start', { provider: 'google', scopeSets: [] })).status()).toBe(400);
    expect(gw.requests.filter((r) => r.url.endsWith('/oauth-accounts/start')).length).toBe(before);
  });

  it('distinguishes omitted default scopes from an explicitly empty scope request', async () => {
    await api('PUT', '/oauth-apps/google', { config: appConfig('google', 'g-1'), clientSecret: 's' });
    expect((await api('POST', '/accounts/start', { appId: 'google' })).status()).toBe(200);
    expect(gw.requests.at(-1)?.body).toEqual({ app_id: 'google' });
    expect((await api('POST', '/accounts/start', { appId: 'google', scopes: [] })).status()).toBe(200);
    expect(gw.requests.at(-1)?.body).toEqual({ app_id: 'google', scopes: [] });
    expect((await api('POST', '/accounts/start', { appId: 'google', scopes: ['custom:capability'] })).status()).toBe(
      200,
    );
    expect(gw.requests.at(-1)?.body).toEqual({ app_id: 'google', scopes: ['custom:capability'] });
    expect((await api('POST', '/accounts/start', { appId: 'google', scopes: [5] })).status()).toBe(400);
    expect((await api('POST', '/accounts/start', { appId: 'google', scopes: ['contains whitespace'] })).status()).toBe(
      400,
    );
  });

  it('relays declined generic account consent without a code or account mutation', async () => {
    await api('PUT', '/oauth-apps/google', { config: appConfig('google', 'g-1'), clientSecret: 's' });
    await api('POST', '/accounts/start', { appId: 'google', scopes: [] });
    await callback('state=mcp_oast_p1&error=access_denied');
    expect(gw.requests.at(-1)?.body).toEqual({ state: 'mcp_oast_p1', error: 'access_denied' });
    expect((await api('GET', '/accounts/start/mcp_oast_p1')).body()).toMatchObject({ status: 'failed' });
    expect(gw.providerAccounts).toEqual([]);
  });

  it('passes an explicitly selected generic app to MCP start without API scopes', async () => {
    const response = await api('POST', '/accounts/start', { mcpServer: 'linear', appId: 'custom-client' });
    expect(response.status()).toBe(200);
    expect(gw.requests.at(-1)).toMatchObject({
      url: `/v1/vaults/${GID}/mcp-oauth/start`,
      body: { resource_url: LINEAR, client_name: 'Gateway Group', app_id: 'custom-client' },
    });
  });

  it('never returns client secrets', async () => {
    mockUserId = 'web:owner';
    await api('PUT', '/oauth-apps/github', {
      scope: 'install',
      config: appConfig('github', 'Iv-install'),
      clientSecret: 'very-secret-value',
    });
    expect((await api('GET', '')).text()).not.toContain('very-secret-value');
  });
});

describe('credential backend switch', () => {
  const host = { caller: 'host' as const };
  const cli = (command: string, args: Record<string, unknown>) => dispatch({ id: '1', command, args }, host);

  it('moves a group onto the gateway, creating its vault, and back', async () => {
    expect((await cli('credentials-backend-get', { group: 'ag-onecli' })).ok && 'onecli').toBe('onecli');
    let resp = await cli('credentials-backend-set', { group: 'ag-onecli', backend: 'agent-vault' });
    expect(resp.ok).toBe(true);
    if (resp.ok) expect(String(resp.data)).toContain('vault created');
    expect(gw.vaults.has('ag-onecli')).toBe(true);
    resp = await cli('credentials-backend-get', { group: 'ag-onecli' });
    expect(resp.ok && resp.data).toBe('agent-vault');
    mockUserId = 'web:owner';
    expect((await run(handle, 'GET', '/ui/chat/api/groups/ag-onecli/admin/credentials')).status()).not.toBe(409);
    resp = await cli('credentials-backend-set', { group: 'ag-onecli', backend: 'agent-vault' });
    expect(resp.ok && String(resp.data)).not.toContain('vault created');
    resp = await cli('credentials-backend-set', { group: 'ag-onecli', backend: 'onecli' });
    expect(resp.ok).toBe(true);
    expect(gw.vaults.has('ag-onecli')).toBe(true);
    expect((await cli('credentials-backend-get', { group: 'ag-onecli' })).ok).toBe(true);
    expect((await run(handle, 'GET', '/ui/chat/api/groups/ag-onecli/admin/credentials')).status()).toBe(409);
  });

  it('rejects unknown backends and groups', async () => {
    expect((await cli('credentials-backend-set', { group: 'ag-onecli', backend: 'vault' })).ok).toBe(false);
    expect((await cli('credentials-backend-set', { group: 'ag-missing', backend: 'onecli' })).ok).toBe(false);
  });

  it('is refused from agent containers', async () => {
    const resp = await dispatch(
      { id: '1', command: 'credentials-backend-set', args: { group: GID, backend: 'onecli' } },
      { caller: 'agent', sessionId: 's', agentGroupId: GID, messagingGroupId: 'mg' },
    );
    expect(resp.ok).toBe(false);
    if (!resp.ok) expect(resp.error.code).toBe('forbidden');
  });

  it('deletes the vault when a gateway group is deleted', async () => {
    await cli('credentials-backend-set', { group: 'ag-onecli', backend: 'agent-vault' });
    expect(gw.vaults.has('ag-onecli')).toBe(true);
    const resp = await cli('groups-delete', { id: 'ag-onecli' });
    expect(resp.ok).toBe(true);
    expect(gw.vaults.has('ag-onecli')).toBe(false);
  });
});
