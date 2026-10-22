// In-page mock of the Credentials routes (and the few Agent Settings routes the
// MCP tab needs) for the credentials fixture. State lives in memory only.
import type {
  AccountDto,
  AccountProgressDto,
  AccountStartDto,
  AccountStartInput,
  CredentialsOverviewDto,
  DestinationDto,
  KeyDto,
  KeyPresetDto,
  McpAuthDto,
  OAuthAppDto,
  OAuthAppScope,
} from '../src/components/GroupAdminCredentialsApi';
import type { McpServerConfigDto } from '../src/components/GroupAdminMcp';

export const FIXTURE_GROUP = { id: 'assistant', name: 'Assistant' };

export interface FixtureOptions {
  scenario: 'typical' | 'empty';
  gatewayDown: boolean;
  latencyMs: number;
  failNextWrite: boolean;
  viewOnly: boolean;
  /** Owner or global admin, who may change install-wide OAuth apps. */
  owner: boolean;
}

export interface LoggedCall {
  at: number;
  method: string;
  path: string;
  status: number;
  body?: string;
}

interface PendingSignIn {
  input: AccountStartInput;
  status: AccountProgressDto['status'];
  account?: string | null;
  error?: string;
}

interface State {
  keys: KeyDto[];
  accounts: AccountDto[];
  apps: Record<string, { install: AppClient | null; group: AppClient | null }>;
  /** Which app each OAuth account or app-based MCP sign-in came through. */
  via: Record<string, { provider: string; scope: OAuthAppScope }>;
  /** Accounts other groups have through each install-wide app. */
  otherGroups: Record<string, number>;
  mcpServers: Record<string, McpServerConfigDto>;
  mcpAuth: Record<string, { auth: McpAuthDto['auth']; key?: string; status?: McpAuthDto['status']; account?: string | null }>;
  signIns: Map<string, PendingSignIn>;
  seq: number;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const iso = (msAgo: number): string => new Date(Date.now() - msAgo).toISOString();

const GOOGLE_SCOPES: Record<string, { label: string; hosts: string[] }> = {
  'gmail-read': { label: 'Gmail: read', hosts: ['gmail.googleapis.com'] },
  'gmail-send': { label: 'Gmail: send', hosts: ['gmail.googleapis.com'] },
  calendar: { label: 'Calendar', hosts: ['www.googleapis.com/calendar/*'] },
  'drive-read': { label: 'Drive: read', hosts: ['www.googleapis.com/drive/*'] },
  docs: { label: 'Docs', hosts: ['docs.googleapis.com'] },
};

const REDIRECT_URI = 'https://nanoclaw.example.com/oauth/callback';

const SCOPE_SETS: Record<string, Record<string, { label: string; hosts: string[] }>> = {
  google: GOOGLE_SCOPES,
  github: {
    repo: { label: 'Repositories', hosts: ['api.github.com/repos/*'] },
    issues: { label: 'Issues and pull requests', hosts: ['api.github.com/repos/*/issues/*', 'api.github.com/repos/*/pulls/*'] },
  },
  microsoft: {
    mail: { label: 'Outlook mail', hosts: ['graph.microsoft.com/v1.0/me/messages*'] },
    calendar: { label: 'Outlook calendar', hosts: ['graph.microsoft.com/v1.0/me/events*'] },
    files: { label: 'OneDrive: read', hosts: ['graph.microsoft.com/v1.0/me/drive/*'] },
  },
};

interface AppClient {
  clientId: string;
  updatedAt: string;
}

const APP_CATALOG: { id: string; label: string; consoleUrl: string; mcpServers?: string[] }[] = [
  { id: 'google', label: 'Google', consoleUrl: 'https://console.cloud.google.com/apis/credentials' },
  { id: 'github', label: 'GitHub', consoleUrl: 'https://github.com/settings/applications/new', mcpServers: ['github'] },
  { id: 'microsoft', label: 'Microsoft 365', consoleUrl: 'https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps' },
];

/** MCP servers whose authorization server needs a pre-registered app. */
const MCP_APP: Record<string, string> = { github: 'github' };

const GOOGLE_INSTALL: AppClient = { clientId: '604218840137-q7k2n9f1c8d3.apps.googleusercontent.com', updatedAt: iso(45 * DAY) };

function appReady(provider: string): AppClient | null {
  const a = state.apps[provider];
  return a?.group ?? a?.install ?? null;
}

function appDtos(): OAuthAppDto[] {
  return APP_CATALOG.map((c) => {
    const a = state.apps[c.id] ?? { install: null, group: null };
    const count = (scope: OAuthAppScope): number =>
      Object.values(state.via).filter((v) => v.provider === c.id && v.scope === scope).length;
    return {
      id: c.id,
      label: c.label,
      consoleUrl: c.consoleUrl,
      mcpServers: c.mcpServers,
      install: a.install ? { ...a.install, accounts: count('install'), accountsAllGroups: count('install') + (state.otherGroups[c.id] ?? 0) } : null,
      group: a.group ? { ...a.group, accounts: count('group') } : null,
      scopeSets: Object.entries(SCOPE_SETS[c.id] ?? {}).map(([sid, s]) => ({ id: sid, label: s.label, hosts: s.hosts })),
    };
  });
}

/** Drops this group's accounts that came through one app. */
function dropAccountsVia(provider: string, scope: OAuthAppScope): void {
  for (const [key, v] of Object.entries(state.via)) {
    if (v.provider !== provider || v.scope !== scope) continue;
    const account = state.accounts.find((a) => a.key === key);
    if (account?.mcpServer) state.mcpAuth[account.mcpServer] = { auth: 'oauth', status: 'needs_sign_in' };
    state.accounts = state.accounts.filter((a) => a.key !== key);
    delete state.via[key];
  }
}

function scopeLabel(provider: string, id: string): string {
  return SCOPE_SETS[provider]?.[id]?.label ?? id;
}

const PRESETS: KeyPresetDto[] = [
  { id: 'openrouter', label: 'OpenRouter', key: 'OPENROUTER_API_KEY', destination: { match: 'openrouter.ai', injection: { type: 'bearer' } }, obtainUrl: 'https://openrouter.ai/settings/keys' },
  { id: 'anthropic', label: 'Anthropic', key: 'ANTHROPIC_API_KEY', destination: { match: 'api.anthropic.com', injection: { type: 'api-key', name: 'x-api-key' } }, obtainUrl: 'https://console.anthropic.com/settings/keys' },
  { id: 'openai', label: 'OpenAI', key: 'OPENAI_API_KEY', destination: { match: 'api.openai.com', injection: { type: 'bearer' } }, obtainUrl: 'https://platform.openai.com/api-keys' },
  { id: 'github', label: 'GitHub', key: 'GITHUB_TOKEN', destination: { match: 'api.github.com', injection: { type: 'bearer' } }, hint: 'Use a fine-grained token limited to the repositories the agent needs.', obtainUrl: 'https://github.com/settings/personal-access-tokens/new' },
  { id: 'brave', label: 'Brave Search', key: 'BRAVE_API_KEY', destination: { match: 'api.search.brave.com', injection: { type: 'api-key', name: 'X-Subscription-Token' } }, obtainUrl: 'https://api-dashboard.search.brave.com/app/keys' },
  { id: 'tavily', label: 'Tavily (MCP)', key: 'TAVILY_API_KEY', destination: { match: 'mcp.tavily.com', injection: { type: 'query', name: '__TAVILY_API_KEY__' } }, hint: 'Use https://mcp.tavily.com/mcp/?tavilyApiKey=__TAVILY_API_KEY__ as the MCP server URL.' },
  { id: 'notion', label: 'Notion (API)', key: 'NOTION_TOKEN', destination: { match: 'api.notion.com', injection: { type: 'bearer' } } },
  { id: 'home-assistant', label: 'Home Assistant', key: 'HOME_ASSISTANT_TOKEN', destination: { match: 'homeassistant.local:8123', injection: { type: 'bearer' } }, hint: 'Create a long-lived access token on your Home Assistant profile page.' },
];

function key(k: string, label: string, destination: DestinationDto, extra: Partial<KeyDto> = {}): KeyDto {
  return { key: k, label, status: 'set', updatedAt: iso(20 * DAY), lastUsedAt: iso(3 * HOUR), destination, ...extra };
}

function typicalState(): State {
  return {
    keys: [
      key('OPENROUTER_API_KEY', 'OpenRouter', { match: 'openrouter.ai', injection: { type: 'bearer' } }, { updatedAt: iso(40 * DAY), lastUsedAt: iso(4 * MINUTE) }),
      key('TAVILY_API_KEY', 'Tavily', { match: 'mcp.tavily.com/mcp/*', injection: { type: 'query', name: '__TAVILY_API_KEY__' } }, { mcpServer: 'tavily', updatedAt: iso(12 * DAY), lastUsedAt: iso(2 * HOUR) }),
      key('NEXTCLOUD_MCP', 'Nextcloud', { match: 'nextcloud.example.org/mcp/*', injection: { type: 'custom', template: 'Basic {{ NEXTCLOUD_MCP }}' } }, { mcpServer: 'nextcloud', lastUsedAt: iso(1 * DAY) }),
      key('GITHUB_TOKEN', 'GitHub', { match: 'api.github.com', injection: { type: 'bearer' } }, { updatedAt: iso(3 * DAY), lastUsedAt: iso(5 * HOUR) }),
      key('SEATTLE_DATA_TOKEN', 'Seattle Open Data', { match: 'data.seattle.gov', injection: { type: 'api-key', name: 'X-App-Token' } }, { updatedAt: iso(70 * DAY), lastUsedAt: iso(9 * DAY) }),
      key('HOME_ASSISTANT_TOKEN', 'Home Assistant', { match: 'homeassistant.local:8123/api/mcp', injection: { type: 'bearer' } }, { mcpServer: 'home_assistant', status: 'needs_value', updatedAt: null, lastUsedAt: null }),
      key('MINIMAX_API_KEY', 'MiniMax', { match: 'api.minimax.io', injection: { type: 'custom', template: 'Bearer {{ MINIMAX_API_KEY }}' } }, { updatedAt: iso(55 * DAY), lastUsedAt: iso(30 * MINUTE) }),
    ],
    accounts: [
      {
        key: 'GOOGLE_ALEX', kind: 'oauth_app', provider: 'google', providerLabel: 'Google', account: 'alex@example.com',
        scopes: ['gmail-read', 'gmail-send', 'calendar'].map((id) => ({ id, label: GOOGLE_SCOPES[id]!.label })),
        status: 'connected', connectedAt: iso(30 * DAY), lastUsedAt: iso(25 * MINUTE),
      },
      {
        key: 'GOOGLE_SAM', kind: 'oauth_app', provider: 'google', providerLabel: 'Google', account: 'sam@example.com',
        scopes: [{ id: 'drive-read', label: GOOGLE_SCOPES['drive-read']!.label }],
        status: 'needs_reconnect', connectedAt: iso(90 * DAY), lastUsedAt: iso(8 * DAY),
      },
      {
        key: 'MCP_LINEAR', kind: 'mcp_oauth', provider: 'mcp', providerLabel: 'Linear', account: 'alex@example.com',
        scopes: [], status: 'connected', connectedAt: iso(6 * DAY), lastUsedAt: iso(3 * HOUR),
        mcpServer: 'linear', resource: 'https://mcp.linear.app/mcp', client: 'registered',
      },
    ],
    apps: { google: { install: GOOGLE_INSTALL, group: null } },
    via: { GOOGLE_ALEX: { provider: 'google', scope: 'install' }, GOOGLE_SAM: { provider: 'google', scope: 'install' } },
    otherGroups: { google: 4 },
    mcpServers: {
      tavily: { type: 'http', url: 'https://mcp.tavily.com/mcp/?tavilyApiKey=__TAVILY_API_KEY__' },
      nextcloud: { type: 'http', url: 'https://nextcloud.example.org/mcp/' },
      home_assistant: { type: 'http', url: 'http://homeassistant.local:8123/api/mcp' },
      linear: { type: 'http', url: 'https://mcp.linear.app/mcp' },
      github: { type: 'http', url: 'https://api.githubcopilot.com/mcp/' },
      notion: { type: 'http', url: 'https://mcp.notion.com/mcp' },
      minimax: { type: 'stdio', command: 'uvx', args: ['minimax-mcp', '-y'] },
    },
    mcpAuth: {
      tavily: { auth: 'key', key: 'TAVILY_API_KEY' },
      nextcloud: { auth: 'key', key: 'NEXTCLOUD_MCP' },
      home_assistant: { auth: 'key', key: 'HOME_ASSISTANT_TOKEN' },
      linear: { auth: 'oauth', status: 'ok', account: 'alex@example.com' },
      notion: { auth: 'oauth', status: 'needs_sign_in' },
      github: { auth: 'oauth', status: 'needs_sign_in' },
    },
    signIns: new Map(),
    seq: 1,
  };
}

function emptyState(): State {
  const state = typicalState();
  return {
    ...state,
    keys: [],
    accounts: [],
    apps: {},
    via: {},
    otherGroups: {},
    mcpServers: { notion: { type: 'http', url: 'https://mcp.notion.com/mcp' } },
    mcpAuth: { notion: { auth: 'oauth', status: 'needs_sign_in' } },
  };
}

let options: FixtureOptions = { scenario: 'typical', gatewayDown: false, latencyMs: 250, failNextWrite: false, viewOnly: false, owner: true };
let state: State = typicalState();
const listeners = new Set<() => void>();
export const callLog: LoggedCall[] = [];

export function getOptions(): FixtureOptions {
  return options;
}
export function setOptions(next: Partial<FixtureOptions>): void {
  const scenarioChanged = next.scenario && next.scenario !== options.scenario;
  options = { ...options, ...next };
  if (scenarioChanged) resetState();
  emit();
}
export function resetState(): void {
  state = options.scenario === 'empty' ? emptyState() : typicalState();
  callLog.length = 0;
  emit();
}
export function onMockChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
function emit(): void {
  for (const listener of listeners) listener();
}

function overview(): CredentialsOverviewDto {
  const mcp: McpAuthDto[] = Object.entries(state.mcpServers)
    .filter(([, server]) => server.type === 'http' || server.type === 'sse')
    .map(([name, server]) => {
      const auth = state.mcpAuth[name] ?? { auth: 'none' as const };
      const url = (server as { url: string }).url;
      if (auth.auth === 'key') {
        const k = state.keys.find((x) => x.key === auth.key);
        return { server: name, url, auth: 'key', key: auth.key, status: k?.status === 'set' ? 'ok' : 'needs_value' };
      }
      if (auth.auth === 'oauth') {
        const provider = MCP_APP[name];
        const needsApp = provider && !appReady(provider) && auth.status !== 'ok' ? provider : undefined;
        return { server: name, url, auth: 'oauth', status: auth.status ?? 'needs_sign_in', account: auth.account ?? null, needsApp };
      }
      return { server: name, url, auth: 'none', status: 'ok' };
    });
  return {
    canEdit: !options.viewOnly,
    canEditInstall: !options.viewOnly && options.owner,
    keys: state.keys,
    accounts: state.accounts,
    oauthApps: appDtos(),
    oauthRedirectUri: REDIRECT_URI,
    presets: PRESETS,
    mcp,
  };
}

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

function body<T>(init?: RequestInit): T {
  return (typeof init?.body === 'string' ? JSON.parse(init.body) : {}) as T;
}

function redact(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  try {
    return JSON.stringify(JSON.parse(raw), (k, v) => (
      (k === 'value' || k === 'clientSecret' || (k.length > 0 && /^[A-Z][A-Z0-9_]*$/.test(k))) && typeof v === 'string' && v ? '•••' : v
    ));
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    return raw;
  }
}

function settingsResponse(): Record<string, unknown> {
  return {
    id: FIXTURE_GROUP.id,
    name: FIXTURE_GROUP.name,
    folder: 'assistant',
    createdAt: iso(120 * DAY),
    updatedAt: iso(2 * DAY),
    config: {
      provider: 'native', upstream_provider: null, model: 'anthropic/claude-sonnet-4.5', small_model: null, effort: null,
      image_tag: null, assistant_name: 'Assistant', max_messages_per_prompt: null, cli_scope: 'group',
      voice_input_backend: null, voice_input_enabled: false,
    },
    voiceInput: { backend: 'disabled', ready: false, reason: 'Fixture' },
    modelParams: {},
    packages: { apt: [], npm: [], pip: [] },
    mcpServers: state.mcpServers,
    skills: 'all',
    disabledSkills: [],
    availableSkills: [],
    defaults: { provider: 'native', models: {}, image_tag: null, voice_input_backend: 'disabled' },
    validProviders: ['claude', 'native', 'opencode'],
    validCliScopes: ['disabled', 'group', 'global'],
    runningSessionCount: 0,
    selectedModelDetail: null,
    selectedImageDetail: null,
    actorIsElevated: true,
    providesAgentSurfaces: false,
    site: { available: false, baseDomain: null, slug: null, fqdn: null, url: null, enabled: false },
    email: { available: false, baseDomain: null, slug: null, address: null, enabled: false },
  };
}

function route(method: string, path: string, init?: RequestInit, search = ''): unknown {
  const prefix = `/ui/chat/api/groups/${FIXTURE_GROUP.id}/admin`;
  if (!path.startsWith(prefix)) throw new HttpError(404, `Fixture has no route for ${path}`);
  const sub = path.slice(prefix.length);

  if (sub === '/settings' && method === 'GET') return settingsResponse();
  if (sub === '/images' && method === 'GET') return { images: [] };
  if (sub === '/mcp-servers' && method === 'PATCH') {
    state.mcpServers = body<{ servers: Record<string, McpServerConfigDto> }>(init).servers;
    return { ok: true };
  }
  if (sub === '/mcp-servers/test' && method === 'POST') {
    const { name } = body<{ name: string }>(init);
    const auth = overview().mcp.find((m) => m.server === name);
    if (auth && auth.status !== 'ok') {
      return { ok: false, latencyMs: 180, phase: 'connect', error: auth.auth === 'oauth' ? 'HTTP 401: sign-in required' : `HTTP 401: ${auth.key} has no value` };
    }
    return { ok: true, latencyMs: 240, serverInfo: { name, version: '1.0.0' }, tools: ['search', 'fetch', 'list'] };
  }
  if (['/settings', '/model-params', '/packages', '/skills', '/disabled-skills'].includes(sub)) return { ok: true };
  if (!sub.startsWith('/credentials')) throw new HttpError(404, `Fixture has no route for ${method} ${sub}`);

  if (options.gatewayDown) throw new HttpError(503, 'gateway_unreachable');
  const cred = sub.slice('/credentials'.length);
  const write = method !== 'GET';
  if (write && options.viewOnly) throw new HttpError(403, 'You can’t change this group’s credentials');
  if (write && options.failNextWrite) {
    options = { ...options, failNextWrite: false };
    emit();
    throw new HttpError(502, 'The credential gateway rejected the change (simulated)');
  }
  const now = new Date().toISOString();
  let m: RegExpExecArray | null;

  if (cred === '' && method === 'GET') return overview();

  if (cred === '/keys' && method === 'POST') {
    const b = body<{ key: string; label: string; value: string; destination: DestinationDto }>(init);
    if (state.keys.some((k) => k.key === b.key)) throw new HttpError(409, `${b.key} already exists`);
    if (!b.value) throw new HttpError(400, 'A value is required');
    state.keys = [...state.keys, { key: b.key, label: b.label, status: 'set', updatedAt: now, lastUsedAt: null, destination: b.destination }];
    return { ok: true };
  }
  if ((m = /^\/keys\/([A-Z0-9_]+)$/.exec(cred))) {
    const name = m[1]!;
    const k = state.keys.find((x) => x.key === name);
    if (!k) throw new HttpError(404, 'Unknown key');
    if (method === 'PUT') {
      const b = body<{ value?: string; label?: string; destination?: DestinationDto }>(init);
      state.keys = state.keys.map((x) => (x.key !== name ? x : {
        ...x,
        ...(b.value ? { status: 'set' as const, updatedAt: now } : {}),
        ...(b.label ? { label: b.label } : {}),
        ...(b.destination ? { destination: b.destination } : {}),
      }));
      return { ok: true };
    }
    if (method === 'DELETE') {
      state.keys = state.keys.filter((x) => x.key !== name);
      return { ok: true };
    }
  }

  if (cred === '/accounts/start' && method === 'POST') {
    const input = body<AccountStartInput>(init);
    const stateId = `st-${state.seq++}-${Math.random().toString(36).slice(2, 8)}`;
    state.signIns.set(stateId, { input, status: 'pending' });
    const needed = 'mcpServer' in input ? MCP_APP[input.mcpServer] : input.provider;
    if (needed && !appReady(needed)) {
      throw new HttpError(409, 'mcpServer' in input ? 'registration_unsupported: set up the OAuth app for this server first' : 'Set up this provider’s OAuth app first');
    }
    const label = 'mcpServer' in input ? input.mcpServer : APP_CATALOG.find((a) => a.id === input.provider)?.label ?? input.provider;
    const scopes = 'mcpServer' in input ? '' : input.scopeSets.map((s) => scopeLabel(input.provider, s)).join('|');
    const query = new URLSearchParams({ consent: stateId, provider: label, scopes });
    return { state: stateId, label, authorizeUrl: `${location.pathname}?${query}` } satisfies AccountStartDto;
  }
  if ((m = /^\/accounts\/start\/([^/]+)$/.exec(cred)) && method === 'GET') {
    const signIn = state.signIns.get(decodeURIComponent(m[1]!));
    if (!signIn) throw new HttpError(404, 'Unknown sign-in');
    return { status: signIn.status, account: signIn.account, error: signIn.error } satisfies AccountProgressDto;
  }
  if ((m = /^\/accounts\/([^/]+)$/.exec(cred)) && method === 'DELETE') {
    const k = decodeURIComponent(m[1]!);
    const account = state.accounts.find((a) => a.key === k);
    state.accounts = state.accounts.filter((a) => a.key !== k);
    delete state.via[k];
    if (account?.mcpServer) state.mcpAuth[account.mcpServer] = { auth: 'oauth', status: 'needs_sign_in' };
    return { ok: true };
  }

  if ((m = /^\/oauth-apps\/([a-z0-9-]+)(\?scope=(group|install))?$/.exec(cred + search))) {
    const id = m[1]!;
    if (!APP_CATALOG.some((c) => c.id === id)) throw new HttpError(404, 'Unknown provider');
    const current = state.apps[id] ?? { install: null, group: null };
    if (method === 'PUT') {
      const b = body<{ scope: OAuthAppScope; clientId: string; clientSecret?: string }>(init);
      if (b.scope === 'install' && !options.owner) throw new HttpError(403, 'Only owners can change install-wide OAuth apps');
      const existing = current[b.scope];
      if (!b.clientId?.trim()) throw new HttpError(400, 'A client ID is required');
      if (!existing && !b.clientSecret) throw new HttpError(400, 'A client secret is required');
      if (existing && existing.clientId !== b.clientId.trim()) {
        dropAccountsVia(id, b.scope);
        if (b.scope === 'install') state.otherGroups[id] = 0;
      }
      state.apps[id] = { ...current, [b.scope]: { clientId: b.clientId.trim(), updatedAt: now } };
      return { ok: true };
    }
    if (method === 'DELETE') {
      const scope = (m[3] ?? 'group') as OAuthAppScope;
      if (scope === 'install' && !options.owner) throw new HttpError(403, 'Only owners can change install-wide OAuth apps');
      dropAccountsVia(id, scope);
      if (scope === 'install') state.otherGroups[id] = 0;
      state.apps[id] = { ...current, [scope]: null };
      return { ok: true };
    }
  }
  throw new HttpError(404, `Fixture has no route for ${method} ${sub}`);
}

/** Applies the fake provider's answer for a sign-in started from the fixture. */
export function completeSignIn(stateId: string, allow: boolean): void {
  const signIn = state.signIns.get(stateId);
  if (!signIn || signIn.status !== 'pending') return;
  if (!allow) {
    state.signIns.set(stateId, { ...signIn, status: 'failed', error: 'You declined access at the provider' });
    emit();
    return;
  }
  const now = new Date().toISOString();
  const input = signIn.input;
  let account: string;
  if ('mcpServer' in input) {
    account = 'alex@example.com';
    state.mcpAuth[input.mcpServer] = { auth: 'oauth', status: 'ok', account };
    const key = `MCP_${input.mcpServer.toUpperCase()}`;
    const existing = state.accounts.find((a) => a.key === key);
    const entry: AccountDto = {
      key, kind: 'mcp_oauth', provider: 'mcp', providerLabel: input.mcpServer, account, scopes: [], status: 'connected',
      connectedAt: now, lastUsedAt: existing?.lastUsedAt ?? null, mcpServer: input.mcpServer,
      resource: (state.mcpServers[input.mcpServer] as { url?: string } | undefined)?.url,
      client: MCP_APP[input.mcpServer] ? 'app' : 'registered',
    };
    const provider = MCP_APP[input.mcpServer];
    if (provider) state.via[key] = { provider, scope: state.apps[provider]?.group ? 'group' : 'install' };
    state.accounts = existing ? state.accounts.map((a) => (a.key === key ? entry : a)) : [...state.accounts, entry];
  } else {
    const replaced = input.replaceKey ? state.accounts.find((a) => a.key === input.replaceKey) : undefined;
    account = replaced?.account ?? `user${state.seq}@example.com`;
    // Signing in to an account this group already has adds to its access, as provider re-consent does.
    const existing = replaced ?? state.accounts.find((a) => a.provider === input.provider && a.account === account);
    const key = existing?.key ?? `${input.provider.toUpperCase()}_${account.split('@')[0]!.replace(/[^a-z0-9]/gi, '').toUpperCase()}`;
    const scopeIds = replaced ? input.scopeSets : [...new Set([...(existing?.scopes.map((s) => s.id) ?? []), ...input.scopeSets])];
    const entry: AccountDto = {
      key, kind: 'oauth_app', provider: input.provider, providerLabel: APP_CATALOG.find((a) => a.id === input.provider)?.label ?? input.provider,
      account, scopes: scopeIds.map((id) => ({ id, label: scopeLabel(input.provider, id) })),
      status: 'connected', connectedAt: now, lastUsedAt: existing?.lastUsedAt ?? null,
    };
    state.accounts = state.accounts.some((a) => a.key === key) ? state.accounts.map((a) => (a.key === key ? entry : a)) : [...state.accounts, entry];
    state.via[key] = { provider: input.provider, scope: state.apps[input.provider]?.group ? 'group' : 'install' };
  }
  state.signIns.set(stateId, { ...signIn, status: 'connected', account });
  emit();
}

export function installMockFetch(): void {
  const realOpen = window.open.bind(window);
  (window as { __fixturePopupBlocked?: boolean }).__fixturePopupBlocked = false;
  window.open = (url?: string | URL, target?: string, features?: string) =>
    ((window as { __fixturePopupBlocked?: boolean }).__fixturePopupBlocked ? null : realOpen(url, target, features));

  globalThis.fetch = async (input, init) => {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(raw, location.origin);
    const method = (init?.method ?? 'GET').toUpperCase();
    if (options.latencyMs) await new Promise((resolve) => setTimeout(resolve, options.latencyMs));
    let status = 200;
    let payload: unknown;
    try {
      payload = route(method, url.pathname, init, url.search);
    } catch (error) {
      if (!(error instanceof HttpError)) throw error;
      status = error.status;
      payload = { error: error.message };
    }
    callLog.unshift({ at: Date.now(), method, path: `${url.pathname.replace(/^\/ui\/chat\/api\/groups\/[^/]+\/admin/, '')}${url.search}`, status, body: redact(init?.body) });
    callLog.length = Math.min(callLog.length, 40);
    emit();
    return new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json' } });
  };
}
