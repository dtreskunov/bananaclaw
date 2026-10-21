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
  NetworkDto,
  OAuthAppDto,
} from '../src/components/GroupAdminCredentialsApi';
import type { McpServerConfigDto } from '../src/components/GroupAdminMcp';

export const FIXTURE_GROUP = { id: 'assistant', name: 'Assistant' };

export interface FixtureOptions {
  scenario: 'typical' | 'empty';
  gatewayDown: boolean;
  latencyMs: number;
  failNextWrite: boolean;
  viewOnly: boolean;
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
  network: NetworkDto;
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

const OAUTH_APPS: OAuthAppDto[] = [
  {
    id: 'google',
    label: 'Google',
    configured: true,
    scopeSets: Object.entries(GOOGLE_SCOPES).map(([id, s]) => ({ id, label: s.label, hosts: s.hosts })),
  },
  {
    id: 'github',
    label: 'GitHub',
    configured: false,
    envHint: 'AGENT_VAULT_OAUTH_APPS=github with AGENT_VAULT_OAUTH_GITHUB_CLIENT_ID and …_CLIENT_SECRET_FILE',
    scopeSets: [],
  },
  {
    id: 'microsoft',
    label: 'Microsoft 365',
    configured: false,
    envHint: 'AGENT_VAULT_OAUTH_APPS=microsoft with its client ID and secret file',
    scopeSets: [],
  },
];

const PRESETS: KeyPresetDto[] = [
  { id: 'openrouter', label: 'OpenRouter', key: 'OPENROUTER_API_KEY', destination: { match: 'openrouter.ai', injection: { type: 'bearer' } }, obtainUrl: 'https://openrouter.ai/settings/keys' },
  { id: 'anthropic', label: 'Anthropic', key: 'ANTHROPIC_API_KEY', destination: { match: 'api.anthropic.com', injection: { type: 'api-key', name: 'x-api-key' } }, obtainUrl: 'https://console.anthropic.com/settings/keys' },
  { id: 'openai', label: 'OpenAI', key: 'OPENAI_API_KEY', destination: { match: 'api.openai.com', injection: { type: 'bearer' } }, obtainUrl: 'https://platform.openai.com/api-keys' },
  { id: 'github', label: 'GitHub', key: 'GITHUB_TOKEN', destination: { match: 'api.github.com', injection: { type: 'bearer' } }, hint: 'Use a fine-grained token limited to the repositories the agent needs.', obtainUrl: 'https://github.com/settings/personal-access-tokens/new' },
  { id: 'brave', label: 'Brave Search', key: 'BRAVE_API_KEY', destination: { match: 'api.search.brave.com', injection: { type: 'api-key', name: 'X-Subscription-Token' } }, obtainUrl: 'https://api-dashboard.search.brave.com/app/keys' },
  { id: 'tavily', label: 'Tavily (MCP)', key: 'TAVILY_API_KEY', destination: { match: 'mcp.tavily.com/mcp/*', injection: { type: 'query', name: 'tavilyApiKey' } } },
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
      key('TAVILY_API_KEY', 'Tavily', { match: 'mcp.tavily.com/mcp/*', injection: { type: 'query', name: 'tavilyApiKey' } }, { mcpServer: 'tavily', updatedAt: iso(12 * DAY), lastUsedAt: iso(2 * HOUR) }),
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
        mcpServer: 'linear', resource: 'https://mcp.linear.app/mcp',
      },
    ],
    network: { unmatched: 'tunnel', allowHosts: ['pypi.org', 'registry.npmjs.org'], allowPrivate: ['homeassistant.local:8123'], operatorAllowPrivate: ['10.0.1.105/32'] },
    mcpServers: {
      tavily: { type: 'http', url: 'https://mcp.tavily.com/mcp/?tavilyApiKey=__TAVILY_API_KEY__' },
      nextcloud: { type: 'http', url: 'https://nextcloud.example.org/mcp/' },
      home_assistant: { type: 'http', url: 'http://homeassistant.local:8123/api/mcp' },
      linear: { type: 'http', url: 'https://mcp.linear.app/mcp' },
      notion: { type: 'http', url: 'https://mcp.notion.com/mcp' },
      minimax: { type: 'stdio', command: 'uvx', args: ['minimax-mcp', '-y'] },
    },
    mcpAuth: {
      tavily: { auth: 'key', key: 'TAVILY_API_KEY' },
      nextcloud: { auth: 'key', key: 'NEXTCLOUD_MCP' },
      home_assistant: { auth: 'key', key: 'HOME_ASSISTANT_TOKEN' },
      linear: { auth: 'oauth', status: 'ok', account: 'alex@example.com' },
      notion: { auth: 'oauth', status: 'needs_sign_in' },
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
    network: { unmatched: 'tunnel', allowHosts: [], allowPrivate: [], operatorAllowPrivate: [] },
    mcpServers: { notion: { type: 'http', url: 'https://mcp.notion.com/mcp' } },
    mcpAuth: { notion: { auth: 'oauth', status: 'needs_sign_in' } },
  };
}

let options: FixtureOptions = { scenario: 'typical', gatewayDown: false, latencyMs: 250, failNextWrite: false, viewOnly: false };
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
      if (auth.auth === 'oauth') return { server: name, url, auth: 'oauth', status: auth.status ?? 'needs_sign_in', account: auth.account ?? null };
      return { server: name, url, auth: 'none', status: 'ok' };
    });
  return {
    canEdit: !options.viewOnly,
    keys: state.keys,
    accounts: state.accounts,
    network: state.network,
    oauthApps: OAUTH_APPS,
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
      (k === 'value' || (k.length > 0 && /^[A-Z][A-Z0-9_]*$/.test(k))) && typeof v === 'string' && v ? '•••' : v
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

function route(method: string, path: string, init?: RequestInit): unknown {
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
    const label = 'mcpServer' in input ? input.mcpServer : OAUTH_APPS.find((a) => a.id === input.provider)?.label ?? input.provider;
    const scopes = 'mcpServer' in input ? '' : input.scopeSets.map((s) => GOOGLE_SCOPES[s]?.label ?? s).join('|');
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
    if (account?.mcpServer) state.mcpAuth[account.mcpServer] = { auth: 'oauth', status: 'needs_sign_in' };
    return { ok: true };
  }

  if (cred === '/network' && method === 'PUT') {
    const b = body<{ unmatched: NetworkDto['unmatched']; allowHosts: string[]; allowPrivate: string[] }>(init);
    state.network = { ...state.network, unmatched: b.unmatched, allowHosts: b.allowHosts, allowPrivate: b.allowPrivate };
    return { ok: true };
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
    };
    state.accounts = existing ? state.accounts.map((a) => (a.key === key ? entry : a)) : [...state.accounts, entry];
  } else {
    const replaced = input.replaceKey ? state.accounts.find((a) => a.key === input.replaceKey) : undefined;
    account = replaced?.account ?? `user${state.seq}@example.com`;
    // Signing in to an account this group already has adds to its access, as provider re-consent does.
    const existing = replaced ?? state.accounts.find((a) => a.provider === input.provider && a.account === account);
    const key = existing?.key ?? `GOOGLE_${account.split('@')[0]!.replace(/[^a-z0-9]/gi, '').toUpperCase()}`;
    const scopeIds = replaced ? input.scopeSets : [...new Set([...(existing?.scopes.map((s) => s.id) ?? []), ...input.scopeSets])];
    const entry: AccountDto = {
      key, kind: 'oauth_app', provider: input.provider, providerLabel: OAUTH_APPS.find((a) => a.id === input.provider)?.label ?? input.provider,
      account, scopes: scopeIds.map((id) => ({ id, label: GOOGLE_SCOPES[id]?.label ?? id })),
      status: 'connected', connectedAt: now, lastUsedAt: existing?.lastUsedAt ?? null,
    };
    state.accounts = state.accounts.some((a) => a.key === key) ? state.accounts.map((a) => (a.key === key ? entry : a)) : [...state.accounts, entry];
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
      payload = route(method, url.pathname, init);
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
