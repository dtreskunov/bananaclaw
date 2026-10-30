// Canonical revision-7 in-memory host API. No values are stored or logged.
import {
  type AccessGrant, type AppInfo, type Connection, type CredentialsOverview,
  type OAuthAppConfiguration, type SignInInput, type SignInProgress,
} from '../src/components/CredentialsApi';
import type { McpServerConfigDto } from '../src/components/GroupAdminMcp';

export const FIXTURE_GROUP = { id: 'assistant', name: 'Assistant' };
export interface FixtureOptions {
  scenario: 'typical' | 'empty'; gatewayDown: boolean; latencyMs: number;
  failNextWrite: boolean; owner: boolean; canAdmin: boolean;
}
export const callLog: { at: number; method: string; path: string; status: number }[] = [];
let options: FixtureOptions = { scenario: 'typical', gatewayDown: false, latencyMs: 0, failNextWrite: false, owner: true, canAdmin: true };
const listeners = new Set<() => void>();
const emit = (): void => { for (const listener of listeners) listener(); };
export function onMockChange(listener: () => void): () => void { listeners.add(listener); return () => { listeners.delete(listener); }; }
export function getOptions(): FixtureOptions { return options; }
export function setOptions(next: Partial<FixtureOptions>): void {
  const reset = next.scenario !== undefined && next.scenario !== options.scenario;
  options = { ...options, ...next };
  if (reset) resetState();
  emit();
}
const owner = { id: 'native-alex', label: 'Alex Morgan' };
const basic = { name: 'nextcloud', host: 'nextcloud.example.org', path: '/mcp/*', https_only: true, auth: { type: 'basic', username: 'USERNAME', password: 'PASSWORD' } };
const app: AppInfo = {
  id: 'example', source: 'install', label: 'Example provider', issuer: 'https://accounts.example.com',
  client_id: 'fixture-client', client_secret_set: true, token_endpoint_auth_method: 'client_secret_post',
  authorization_endpoint: 'https://accounts.example.com/authorize', token_endpoint: 'https://accounts.example.com/token',
  api_hosts: ['api.example.com'], default_scopes: ['read:documents'], identity: 'none', token_scope_separator: 'space',
};
let connections: Connection[];
let apps: AppInfo[];
let seq = 0;
const detachedForeign = new Set<string>();
const signIns = new Map<string, SignInProgress & { connection_id: string; input: SignInInput }>();
let mcpServers: Record<string, McpServerConfigDto>;
function connection(input: Partial<Connection> & Pick<Connection, 'id' | 'label' | 'kind'>): Connection {
  return { owner, revision: `r${++seq}`, status: 'ready', services: [], credentials: [], grants: [], ...input };
}
export function resetState(): void {
  seq = 0;
  connections = options.scenario === 'empty' ? [] : [
    connection({ id: 'basic-pair', label: 'Nextcloud pair', kind: 'static', services: [basic], credentials: ['USERNAME', 'PASSWORD'],
      grants: [{ vault: 'assistant', services: ['nextcloud'], status: 'active' }, { vault: 'research', services: ['nextcloud'], status: 'active' }] }),
    connection({ id: 'multi-header', label: 'Two-header service', kind: 'static',
      services: [{ name: 'data', host: 'data.example.com', https_only: true, auth: { type: 'custom', headers: { 'X-Api-Key': '{{ API_KEY }}', 'X-Api-Secret': '{{ API_SECRET }}' } } }],
      credentials: ['API_KEY', 'API_SECRET'] }),
    connection({ id: 'mcp-account', label: 'BananaBrowse', kind: 'mcp_oauth', resource_url: 'https://mcp.example.com/mcp',
      account: 'alex@example.com', requested_scopes: ['read', 'write'], granted_scopes: ['read', 'write'], scope_source: 'provider',
      services: [{ name: 'browser', host: 'mcp.example.com', https_only: true, auth: { type: 'bearer', token: 'OAUTH_ACCESS' } }],
      grants: [{ vault: 'assistant', services: ['browser'], status: 'active' }] }),
    connection({ id: 'reconnect-account', label: 'Documents', kind: 'oauth_app', app_id: 'example', status: 'needs_reconnect',
      account: 'alex@example.com', requested_scopes: ['read:documents'], granted_scopes: null, scope_source: 'unknown',
      services: [{ name: 'documents', host: 'api.example.com', https_only: true, auth: { type: 'bearer', token: 'OAUTH_ACCESS' } }],
      grants: [{ vault: 'research', services: ['documents'], status: 'suspended' }] }),
  ];
  apps = [structuredClone(app)];
  signIns.clear();
  detachedForeign.clear();
  mcpServers = {
    browser: { type: 'http', url: 'https://mcp.example.com/mcp' },
    nextcloud: { type: 'http', url: 'https://nextcloud.example.org/mcp/tools' },
    new_server: { type: 'http', url: 'https://new.example.com/mcp' },
  };
  callLog.length = 0;
  emit();
}
resetState();
class HttpError extends Error { constructor(public status: number, message: string) { super(message); } }
function body<T>(init?: RequestInit): T { return JSON.parse(String(init?.body ?? '{}')) as T; }
function bump(item: Connection): void { item.revision = `r${++seq}`; }
function current(id: string): Connection {
  const item = connections.find((candidate) => candidate.id === id);
  if (!item) throw new HttpError(404, 'Unknown personal connection');
  return item;
}
function revision(item: Connection, value: string): void {
  if (item.revision !== value) throw new HttpError(412, 'Connection changed. Reload and review the current revision.');
}
function overview(): CredentialsOverview {
  return { connections, apps, canEditInstall: options.owner, groups: [
    { ...FIXTURE_GROUP, canAdmin: options.canAdmin }, { id: 'research', name: 'Research', canAdmin: options.canAdmin },
  ] };
}
function grants(gid: string): AccessGrant[] {
  const shared = connections.flatMap((item) => item.grants.filter((grant) => grant.vault === gid).map((grant) => ({
    connection_id: item.id, label: item.label, owner: item.owner,
    services: item.services.filter((service) => grant.services.includes(service.name)),
    status: item.status !== 'ready' ? item.status : grant.status,
  })));
  if (options.scenario === 'typical' && gid === FIXTURE_GROUP.id) shared.push({
    connection_id: 'sam-owned', label: "Sam's service", owner: { id: 'native-sam', label: 'Sam' },
    services: [{ name: 'shared-data', host: 'sam.example.com', auth: { type: 'bearer', token: 'SAM_TOKEN' } }], status: 'active',
  });
  return shared;
}

export function fixtureRoute(method: string, url: URL, init?: RequestInit): unknown {
  const path = url.pathname;
  if (options.gatewayDown) throw new HttpError(503, 'gateway_unreachable');
  if (method !== 'GET' && path !== '/ui/chat/api/credentials/scopes' && options.failNextWrite) {
    options.failNextWrite = false;
    throw new HttpError(502, 'The gateway rejected this change (simulated)');
  }
  if (path === '/ui/chat/api/credentials' && method === 'GET') return overview();
  if (path === '/ui/chat/api/credentials/scopes' && method === 'POST') {
    const input = body<{ resource_url?: string; issuer?: string; app_id?: string }>(init);
    if (input.resource_url?.includes('no-scopes.example'))
      return { scopes: [], source: 'not_advertised', oauth: true, issuer: 'https://no-scopes.example' };
    if (input.resource_url)
      return { scopes: ['read', 'write'], source: 'resource', oauth: true, issuer: 'https://mcp.example.com' };
    const configured = apps.find(app => app.id === input.app_id);
    return { scopes: ['read:documents', 'write:documents'], source: 'authorization_server', oauth: true,
      issuer: input.issuer ?? configured?.issuer ?? 'https://accounts.example.com' };
  }
  if (path === '/ui/chat/api/credentials/connections' && method === 'POST') {
    const input = body<Partial<Connection> & { values?: Record<string, string>; scopes?: string[] }>(init);
    if (!input.label || !input.kind) throw new HttpError(400, 'Label and kind required');
    const created = connection({ id: `connection-${++seq}`, label: input.label, kind: input.kind,
      services: input.services ?? [], credentials: input.values ? Object.keys(input.values) : [],
      resource_url: input.resource_url, app_id: input.app_id, requested_scopes: input.scopes,
      status: input.kind === 'static' ? 'ready' : 'draft' });
    connections.push(created);
    return created;
  }
  let match = /^\/ui\/chat\/api\/credentials\/connections\/([^/]+)(.*)$/.exec(path);
  if (match) {
    const item = current(decodeURIComponent(match[1]));
    const sub = match[2];
    if (!sub) {
      if (method === 'GET') return item;
      const input = body<{ label?: string; enabled?: boolean; services?: Connection['services']; values?: Record<string, string>; revision: string }>(init);
      revision(item, input.revision);
      if (method === 'DELETE') {
        connections = connections.filter((candidate) => candidate !== item);
        return { success: true };
      }
      if (method === 'PUT') {
        if (input.label) item.label = input.label;
        if (input.enabled !== undefined) item.status = input.enabled ? 'ready' : 'disabled';
        if (input.services) {
          item.services = input.services;
          item.grants.forEach((grant) => { grant.services = item.services.map((service) => service.name); });
        }
        if (input.values) item.credentials = [...new Set([...item.credentials, ...Object.keys(input.values)])];
        bump(item);
        return item;
      }
    }
    if (sub === '/start' && method === 'POST') {
      const input = body<SignInInput>(init);
      const state = `sign-in-${++seq}`;
      signIns.set(state, { status: 'pending', connection_id: item.id, input });
      const query = new URLSearchParams({ consent: state, provider: item.label, scopes: (input.scopes ?? []).join('|') });
      return { state, label: item.label, authorizeUrl: `${url.origin}${location.pathname}?${query}` };
    }
    const grant = /^\/grants\/([^/]+)$/.exec(sub);
    if (grant) {
      const gid = decodeURIComponent(grant[1]);
      if (!options.canAdmin && method === 'PUT') throw new HttpError(403, 'Destination administration required');
      if (method === 'DELETE') {
        item.grants = item.grants.filter((existing) => existing.vault !== gid);
      } else if (method === 'PUT') {
        const input = body<{ revision: string; services?: unknown }>(init);
        revision(item, input.revision);
        if (input.services !== undefined) throw new HttpError(400, 'Grants cover the whole credential');
        item.grants = [...item.grants.filter((existing) => existing.vault !== gid), { vault: gid, services: item.services.map((service) => service.name), status: 'active' }];
      }
      bump(item);
      return { success: true };
    }
  }
  match = /^\/ui\/chat\/api\/credentials\/sign-ins\/([^/]+)$/.exec(path);
  if (match && method === 'GET') {
    const flow = signIns.get(decodeURIComponent(match[1]));
    if (!flow) throw new HttpError(404, 'Unknown sign-in');
    return flow;
  }
  match = /^\/ui\/chat\/api\/credentials\/oauth-apps\/([^/]+)$/.exec(path);
  if (match) {
    const id = decodeURIComponent(match[1]);
    const scope = url.searchParams.get('scope') === 'install' ? 'install' : 'user';
    if (scope === 'install' && !options.owner) throw new HttpError(403, 'Install administrator required');
    const existing = apps.find((candidate) => candidate.id === id && candidate.source === scope);
    apps = apps.filter((candidate) => candidate !== existing);
    if (method === 'PUT') {
      const input = body<{ config: OAuthAppConfiguration; clientSecret?: string }>(init);
      apps.push({ ...input.config, id, source: scope, client_secret_set: !!input.clientSecret || !!existing?.client_secret_set });
    }
    return { success: true };
  }
  match = /^\/ui\/chat\/api\/groups\/([^/]+)\/admin\/access(?:\/([^/]+))?$/.exec(path);
  if (match) {
    const gid = decodeURIComponent(match[1]);
    if (!match[2] && method === 'GET') return { grants: grants(gid).filter((grant) =>
      grant.owner.id === owner.id && !detachedForeign.has(`${gid}:${grant.connection_id}`)) };
    if (match[2] && method === 'DELETE') {
      if (!options.canAdmin) throw new HttpError(403, 'Group administration required');
      const id = decodeURIComponent(match[2]);
      if (id === 'sam-owned') detachedForeign.add(`${gid}:${id}`);
      else current(id).grants = current(id).grants.filter((grant) => grant.vault !== gid);
      return { success: true };
    }
  }
  const prefix = `/ui/chat/api/groups/${FIXTURE_GROUP.id}/admin`;
  if (path === `${prefix}/settings` && method === 'GET') return settingsResponse();
  if (path === `${prefix}/images`) return { images: [] };
  if (path === `${prefix}/mcp-servers` && method === 'PATCH') {
    mcpServers = body<{ servers: Record<string, McpServerConfigDto> }>(init).servers;
    return { ok: true };
  }
  if (path === `${prefix}/mcp-servers/test`) return { ok: true, latencyMs: 40, tools: ['search', 'fetch'] };
  if (path === '/ui/chat/api/models') return { models: [], providers: [] };
  throw new HttpError(404, `Fixture has no route for ${method} ${path}`);
}

function settingsResponse(): Record<string, unknown> {
  return {
    id: FIXTURE_GROUP.id, name: FIXTURE_GROUP.name, folder: 'assistant', createdAt: new Date().toISOString(), updatedAt: null,
    config: { provider: 'native', upstream_provider: null, model: null, small_model: null, effort: null,
      image_tag: null, assistant_name: 'Assistant', max_messages_per_prompt: null, cli_scope: 'group', voice_input_backend: null, voice_input_enabled: false },
    voiceInput: { backend: 'disabled', ready: false }, modelParams: {}, packages: { apt: [], npm: [], pip: [] },
    mcpServers, skills: 'all', disabledSkills: [], availableSkills: [],
    defaults: { provider: 'native', models: {}, image_tag: null, voice_input_backend: 'disabled' },
    validProviders: ['native'], validCliScopes: ['group'], runningSessionCount: 0,
    selectedModelDetail: null, selectedImageDetail: null, actorIsElevated: options.owner, providesAgentSurfaces: false,
    site: { available: false, baseDomain: null, slug: null, fqdn: null, url: null, enabled: false },
    email: { available: false, baseDomain: null, slug: null, address: null, enabled: false },
  };
}
export function completeSignIn(state: string, allow: boolean): void {
  const flow = signIns.get(state);
  if (!flow || flow.status !== 'pending') return;
  flow.status = allow ? 'connected' : 'failed';
  if (!allow) { flow.error = 'Access declined by the provider'; emit(); return; }
  const item = current(flow.connection_id);
  const previous = item.requested_scopes ?? [];
  if (flow.input.scopes?.some((scope) => !previous.includes(scope))) item.grants.forEach((grant) => { grant.status = 'suspended'; });
  Object.assign(item, { status: 'ready', account: 'alex@example.com', requested_scopes: flow.input.scopes ?? [],
    granted_scopes: flow.input.scopes ?? [], scope_source: 'provider', app_id: flow.input.app_id, resource_url: flow.input.resource_url });
  if (!item.services.length) {
    const host = flow.input.resource_url ? new URL(flow.input.resource_url).host : apps.find((candidate) => candidate.id === flow.input.app_id)?.api_hosts[0] ?? 'api.example.com';
    item.services = [{ name: 'api', host, https_only: true, auth: { type: 'bearer', token: 'OAUTH_ACCESS' } }];
  }
  bump(item);
  flow.account = item.account;
  emit();
}
export function installMockFetch(): void {
  const realOpen = window.open.bind(window);
  window.open = (url, target, features) =>
    ((window as { __fixturePopupBlocked?: boolean }).__fixturePopupBlocked ? null : realOpen(url, target, features));
  globalThis.fetch = async (input, init) => {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(raw, location.origin);
    const method = (init?.method ?? 'GET').toUpperCase();
    if (options.latencyMs) await new Promise((resolve) => setTimeout(resolve, options.latencyMs));
    let status = 200;
    let payload: unknown;
    try { payload = fixtureRoute(method, url, init); }
    catch (error) {
      if (!(error instanceof HttpError)) throw error;
      status = error.status; payload = { error: error.message };
    }
    callLog.unshift({ at: Date.now(), method, path: `${url.pathname}${url.search}`, status });
    callLog.length = Math.min(callLog.length, 60);
    emit();
    return new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json' } });
  };
}
