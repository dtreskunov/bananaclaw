// In-page mock of the Credentials routes (and the few Agent Settings routes the
// MCP tab needs) for the credentials fixture. State lives in memory only.
import type {
  AccountDto,
  AccountProgressDto,
  AccountStartDto,
  AccountStartInput,
  ActivityDecision,
  ActivityDto,
  CredentialsOverviewDto,
  GroupRefDto,
  KeyDto,
  KeyPresetDto,
  McpAuthDto,
  NetworkDto,
  OAuthAppDto,
  PeerGroupDto,
  RequestDto,
  RuleDto,
  RuleInput,
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

interface StoredKey {
  key: string;
  label: string;
  status: KeyDto['status'];
  updatedAt: string | null;
  lastUsedAt: string | null;
  copiedFrom: { groupId: string; at: string } | null;
  /** Where the key is sent; used when copying between groups. */
  match?: string;
}

interface Peer {
  groupId: string;
  groupName: string;
  canEdit: boolean;
  keys: StoredKey[];
}

interface PendingSignIn {
  input: AccountStartInput;
  status: AccountProgressDto['status'];
  account?: string | null;
  error?: string;
}

interface State {
  keys: StoredKey[];
  rules: RuleDto[];
  accounts: AccountDto[];
  requests: RequestDto[];
  network: NetworkDto;
  mcpServers: Record<string, McpServerConfigDto>;
  mcpAuth: Record<string, { auth: McpAuthDto['auth']; key?: string; status?: McpAuthDto['status']; account?: string | null }>;
  peers: Peer[];
  signIns: Map<string, PendingSignIn>;
  activity: ActivityDto[];
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
  { id: 'openrouter', label: 'OpenRouter', key: 'OPENROUTER_API_KEY', match: 'openrouter.ai', injection: { type: 'bearer' }, obtainUrl: 'https://openrouter.ai/settings/keys' },
  { id: 'anthropic', label: 'Anthropic', key: 'ANTHROPIC_API_KEY', match: 'api.anthropic.com', injection: { type: 'api-key', name: 'x-api-key' }, obtainUrl: 'https://console.anthropic.com/settings/keys' },
  { id: 'openai', label: 'OpenAI', key: 'OPENAI_API_KEY', match: 'api.openai.com', injection: { type: 'bearer' }, obtainUrl: 'https://platform.openai.com/api-keys' },
  { id: 'github', label: 'GitHub', key: 'GITHUB_TOKEN', match: 'api.github.com', injection: { type: 'bearer' }, hint: 'Use a fine-grained token limited to the repositories the agent needs.', obtainUrl: 'https://github.com/settings/personal-access-tokens/new' },
  { id: 'brave', label: 'Brave Search', key: 'BRAVE_API_KEY', match: 'api.search.brave.com', injection: { type: 'api-key', name: 'X-Subscription-Token' }, obtainUrl: 'https://api-dashboard.search.brave.com/app/keys' },
  { id: 'tavily', label: 'Tavily (MCP)', key: 'TAVILY_API_KEY', match: 'mcp.tavily.com/mcp/*', injection: { type: 'query', name: 'tavilyApiKey' } },
  { id: 'notion', label: 'Notion (API)', key: 'NOTION_TOKEN', match: 'api.notion.com', injection: { type: 'bearer' } },
  { id: 'home-assistant', label: 'Home Assistant', key: 'HOME_ASSISTANT_TOKEN', match: 'homeassistant.local:8123', injection: { type: 'bearer' }, hint: 'Create a long-lived access token on your Home Assistant profile page.' },
];

function rule(name: string, match: string, injection: RuleDto['injection'], extra: Partial<RuleDto> = {}): RuleDto {
  return { name, match, injection, approval: 'allow', askRules: [], enabled: true, ...extra };
}

function typicalState(): State {
  const keys: StoredKey[] = [
    { key: 'OPENROUTER_API_KEY', label: 'OpenRouter', status: 'set', updatedAt: iso(40 * DAY), lastUsedAt: iso(4 * MINUTE), copiedFrom: null, match: 'openrouter.ai' },
    { key: 'TAVILY_API_KEY', label: 'Tavily', status: 'set', updatedAt: iso(12 * DAY), lastUsedAt: iso(2 * HOUR), copiedFrom: null, match: 'mcp.tavily.com/mcp/*' },
    { key: 'NEXTCLOUD_MCP', label: 'Nextcloud', status: 'set', updatedAt: iso(20 * DAY), lastUsedAt: iso(1 * DAY), copiedFrom: { groupId: 'research', at: iso(20 * DAY) }, match: 'nextcloud.example.org/mcp/*' },
    { key: 'GITHUB_TOKEN', label: 'GitHub', status: 'set', updatedAt: iso(3 * DAY), lastUsedAt: iso(5 * HOUR), copiedFrom: null, match: 'api.github.com' },
    { key: 'SEATTLE_DATA_TOKEN', label: 'Seattle Open Data', status: 'set', updatedAt: iso(70 * DAY), lastUsedAt: iso(9 * DAY), copiedFrom: null, match: 'data.seattle.gov' },
    { key: 'HOME_ASSISTANT_TOKEN', label: 'Home Assistant', status: 'needs_value', updatedAt: null, lastUsedAt: null, copiedFrom: null, match: 'homeassistant.local:8123' },
    { key: 'MINIMAX_API_KEY', label: 'MiniMax', status: 'set', updatedAt: iso(55 * DAY), lastUsedAt: null, copiedFrom: null },
  ];
  const rules: RuleDto[] = [
    rule('openrouter', 'openrouter.ai', { type: 'bearer', key: 'OPENROUTER_API_KEY' }),
    rule('tavily', 'mcp.tavily.com/mcp/*', { type: 'query', key: 'TAVILY_API_KEY', name: 'tavilyApiKey' }, { mcpServer: 'tavily' }),
    rule('nextcloud', 'nextcloud.example.org/mcp/*', { type: 'custom', key: 'NEXTCLOUD_MCP', template: 'Basic {{ NEXTCLOUD_MCP }}' }, { mcpServer: 'nextcloud' }),
    rule('github', 'api.github.com', { type: 'bearer', key: 'GITHUB_TOKEN' }, { approval: 'ask-writes' }),
    rule('seattle-data', 'data.seattle.gov', { type: 'api-key', key: 'SEATTLE_DATA_TOKEN', name: 'X-App-Token' }),
    rule('home-assistant', 'homeassistant.local:8123/api/mcp', { type: 'bearer', key: 'HOME_ASSISTANT_TOKEN' }, { mcpServer: 'home_assistant' }),
    rule('gmail', 'gmail.googleapis.com', { type: 'bearer', key: 'GOOGLE_ALEX' }, {
      approval: 'custom',
      askRules: [{ method: 'POST', path: '/gmail/v1/users/*/messages/send' }],
    }),
    rule('google-calendar', 'www.googleapis.com/calendar/*', { type: 'bearer', key: 'GOOGLE_ALEX' }),
    rule('google-drive', 'www.googleapis.com/drive/*', { type: 'bearer', key: 'GOOGLE_SAM' }, { enabled: false }),
    rule('pypi', 'pypi.org', { type: 'passthrough' }),
  ];
  const accounts: AccountDto[] = [
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
  ];
  const requests: RequestDto[] = [
    {
      id: 'req-weather', createdAt: iso(18 * MINUTE), expiresAt: new Date(Date.now() + 7 * DAY - 18 * MINUTE).toISOString(),
      thread: 'Weekend trip planning',
      message: 'I need a weather API to check the forecast for Saturday’s hike. WeatherAPI.com has a free tier.',
      slots: [{
        key: 'WEATHER_API_KEY', label: 'WeatherAPI.com', description: 'Free-tier API key for forecasts.',
        obtainUrl: 'https://www.weatherapi.com/signup.aspx', obtainInstructions: 'Sign up, then copy the key from your dashboard.',
        copyableFrom: [],
      }],
      rules: [{ match: 'api.weatherapi.com', injection: { type: 'query', key: 'WEATHER_API_KEY', name: 'key' }, approval: 'allow', askRules: [], enabled: true }],
    },
    {
      id: 'req-brave', createdAt: iso(2 * HOUR), expiresAt: new Date(Date.now() + 6 * DAY).toISOString(),
      thread: 'Funko research',
      message: 'Web search through Brave would let me check current prices. Research already has a Brave key.',
      slots: [{
        key: 'BRAVE_API_KEY', label: 'Brave Search', description: 'Brave Search API subscription token.',
        obtainUrl: 'https://api-dashboard.search.brave.com/app/keys',
        copyableFrom: [{ groupId: 'research', groupName: 'Research', canEdit: true }],
      }],
      rules: [{ match: 'api.search.brave.com', injection: { type: 'api-key', key: 'BRAVE_API_KEY', name: 'X-Subscription-Token' }, approval: 'allow', askRules: [], enabled: true }],
    },
    {
      id: 'req-calendar', createdAt: iso(1 * DAY), expiresAt: new Date(Date.now() + 5 * HOUR).toISOString(),
      thread: 'Family schedule',
      message: 'To add the school events, I need access to Sam’s Google Calendar.',
      slots: [],
      rules: [],
      account: { provider: 'google', providerLabel: 'Google', scopes: [{ id: 'calendar', label: GOOGLE_SCOPES.calendar!.label }] },
    },
  ];
  const peers: Peer[] = [
    {
      groupId: 'research', groupName: 'Research', canEdit: true, keys: [
        { key: 'OPENROUTER_API_KEY', label: 'OpenRouter', status: 'set', updatedAt: iso(40 * DAY), lastUsedAt: null, copiedFrom: null, match: 'openrouter.ai' },
        { key: 'NEXTCLOUD_MCP', label: 'Nextcloud', status: 'set', updatedAt: iso(2 * DAY), lastUsedAt: null, copiedFrom: null, match: 'nextcloud.example.org/mcp/*' },
        { key: 'BRAVE_API_KEY', label: 'Brave Search', status: 'set', updatedAt: iso(15 * DAY), lastUsedAt: null, copiedFrom: null, match: 'api.search.brave.com' },
      ],
    },
    {
      groupId: 'travel', groupName: 'Travel', canEdit: true, keys: [
        { key: 'GOOGLE_MAPS_KEY', label: 'Google Maps', status: 'set', updatedAt: iso(9 * DAY), lastUsedAt: null, copiedFrom: null, match: 'maps.googleapis.com' },
        { key: 'AMADEUS_API_KEY', label: 'Amadeus', status: 'needs_value', updatedAt: null, lastUsedAt: null, copiedFrom: null },
      ],
    },
    {
      groupId: 'family', groupName: 'Family', canEdit: false, keys: [
        { key: 'OPENROUTER_API_KEY', label: 'OpenRouter', status: 'set', updatedAt: iso(80 * DAY), lastUsedAt: null, copiedFrom: null, match: 'openrouter.ai' },
      ],
    },
  ];
  return {
    keys,
    rules,
    accounts,
    requests,
    network: { unmatched: 'tunnel', allowPrivate: ['homeassistant.local:8123'], operatorAllowPrivate: ['10.0.1.105/32'] },
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
    peers,
    signIns: new Map(),
    activity: makeActivity(),
    seq: 1,
  };
}

function emptyState(): State {
  const state = typicalState();
  return {
    ...state,
    keys: [],
    rules: [],
    accounts: [],
    requests: [],
    activity: [],
    network: { unmatched: 'tunnel', allowPrivate: [], operatorAllowPrivate: [] },
    mcpServers: { notion: { type: 'http', url: 'https://mcp.notion.com/mcp' } },
    mcpAuth: { notion: { auth: 'oauth', status: 'needs_sign_in' } },
  };
}

function makeActivity(): ActivityDto[] {
  const rows: [string, string, string, ActivityDecision, number | null, string?][] = [
    ['POST', 'openrouter.ai', '/api/v1/chat/completions', 'injected', 200, 'OPENROUTER_API_KEY'],
    ['GET', 'mcp.tavily.com', '/mcp/', 'injected', 200, 'TAVILY_API_KEY'],
    ['POST', 'gmail.googleapis.com', '/gmail/v1/users/me/messages/send', 'approved', 200, 'GOOGLE_ALEX'],
    ['GET', 'pypi.org', '/simple/requests/', 'tunnel', null],
    ['POST', 'api.github.com', '/repos/alex/notes/issues', 'denied', 403, 'GITHUB_TOKEN'],
    ['GET', 'api.github.com', '/repos/alex/notes/issues', 'injected', 200, 'GITHUB_TOKEN'],
    ['GET', 'www.googleapis.com', '/drive/v3/files', 'blocked', 403, 'GOOGLE_SAM'],
    ['POST', 'http://homeassistant.local:8123', '/api/mcp', 'injected', 401, 'HOME_ASSISTANT_TOKEN'],
    ['GET', '169.254.169.254', '/latest/meta-data/', 'blocked', null],
    ['POST', 'gmail.googleapis.com', '/gmail/v1/users/me/messages/send', 'expired', 403, 'GOOGLE_ALEX'],
    ['GET', 'registry.npmjs.org', '/marked', 'tunnel', null],
    ['GET', 'data.seattle.gov', '/resource/kzjm-xkqj.json', 'injected', 200, 'SEATTLE_DATA_TOKEN'],
  ];
  const threads = ['Funko research', 'Weekend trip planning', 'Inbox triage', null];
  return Array.from({ length: 64 }, (_, i) => {
    const [method, host, path, decision, status, key] = rows[i % rows.length]!;
    return {
      id: `act-${i}`, at: iso(i * 47 * MINUTE + 3 * MINUTE), thread: threads[i % threads.length] ?? null,
      method, host, path, status, decision, key,
    };
  });
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

function peerRef(peer: Peer): GroupRefDto {
  return { groupId: peer.groupId, groupName: peer.groupName, canEdit: peer.canEdit && !options.viewOnly };
}

function overview(): CredentialsOverviewDto {
  const keys: KeyDto[] = state.keys.map((k) => {
    const source = k.copiedFrom ? state.peers.find((p) => p.groupId === k.copiedFrom!.groupId) : undefined;
    const sourceKey = source?.keys.find((x) => x.key === k.key);
    return {
      key: k.key,
      label: k.label,
      status: k.status,
      updatedAt: k.updatedAt,
      lastUsedAt: k.lastUsedAt,
      copiedFrom: k.copiedFrom && source
        ? { groupId: source.groupId, groupName: source.groupName, at: k.copiedFrom.at,
          stale: !!sourceKey?.updatedAt && Date.parse(sourceKey.updatedAt) > Date.parse(k.copiedFrom.at) }
        : null,
      alsoIn: state.peers
        .filter((p) => p.keys.some((x) => x.key === k.key))
        .map((p) => {
          const theirs = p.keys.find((x) => x.key === k.key)!;
          return { ...peerRef(p), stale: !!k.updatedAt && !!theirs.updatedAt && Date.parse(theirs.updatedAt) < Date.parse(k.updatedAt) - DAY };
        }),
    };
  });
  const mcp: McpAuthDto[] = Object.entries(state.mcpServers)
    .filter(([, server]) => server.type === 'http' || server.type === 'sse')
    .map(([name, server]) => {
      const auth = state.mcpAuth[name] ?? { auth: 'none' as const };
      const url = (server as { url: string }).url;
      if (auth.auth === 'key') {
        const key = state.keys.find((k) => k.key === auth.key);
        return { server: name, url, auth: 'key', key: auth.key, status: key?.status === 'set' ? 'ok' : 'needs_value' };
      }
      if (auth.auth === 'oauth') return { server: name, url, auth: 'oauth', status: auth.status ?? 'needs_sign_in', account: auth.account ?? null };
      return { server: name, url, auth: 'none', status: 'ok' };
    });
  return {
    canEdit: !options.viewOnly,
    keys,
    accounts: state.accounts,
    rules: state.rules,
    requests: state.requests,
    network: state.network,
    oauthApps: OAUTH_APPS,
    presets: PRESETS,
    mcp,
  };
}

function peers(): PeerGroupDto[] {
  return state.peers.map((p) => ({
    ...peerRef(p),
    keys: p.keys.map((k) => ({ key: k.key, label: k.label, status: k.status })),
  }));
}

function nextName(base: string): string {
  const slug = base.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'rule';
  let name = slug;
  for (let i = 2; state.rules.some((r) => r.name === name); i++) name = `${slug}-${i}`;
  return name;
}

function addRule(input: RuleInput): RuleDto {
  const created: RuleDto = { ...input, name: input.name ?? nextName(input.match) };
  state.rules = [...state.rules, created];
  return created;
}

function putPeerKey(groupId: string, key: StoredKey): void {
  const peer = state.peers.find((p) => p.groupId === groupId);
  if (!peer) throw new Error(`Unknown group ${groupId}`);
  peer.keys = [...peer.keys.filter((k) => k.key !== key.key), key];
}

function upsertKey(key: StoredKey): void {
  state.keys = state.keys.some((k) => k.key === key.key)
    ? state.keys.map((k) => (k.key === key.key ? { ...k, ...key } : k))
    : [...state.keys, key];
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

function route(method: string, path: string, init?: RequestInit, search?: URLSearchParams): unknown {
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
  if (cred === '/peers' && method === 'GET') return { groups: peers() };

  if (cred === '/keys' && method === 'POST') {
    const b = body<{ key: string; label: string; value: string; rule?: RuleInput; alsoGroups?: string[] }>(init);
    if (state.keys.some((k) => k.key === b.key)) throw new HttpError(409, `${b.key} already exists`);
    upsertKey({ key: b.key, label: b.label, status: 'set', updatedAt: now, lastUsedAt: null, copiedFrom: null, match: b.rule?.match });
    if (b.rule) addRule(b.rule);
    for (const g of b.alsoGroups ?? []) putPeerKey(g, { key: b.key, label: b.label, status: 'set', updatedAt: now, lastUsedAt: null, copiedFrom: null, match: b.rule?.match });
    return { ok: true };
  }
  if (cred === '/keys/copy' && method === 'POST') {
    const b = body<{ fromGroup: string; keys: string[] }>(init);
    const source = state.peers.find((p) => p.groupId === b.fromGroup);
    if (!source) throw new HttpError(404, 'Unknown group');
    for (const name of b.keys) {
      const k = source.keys.find((x) => x.key === name);
      if (!k || k.status !== 'set') throw new HttpError(409, `${name} has no value in ${source.groupName}`);
      upsertKey({ key: k.key, label: k.label, status: 'set', updatedAt: now, lastUsedAt: null, copiedFrom: { groupId: source.groupId, at: now }, match: k.match });
      if (k.match && !state.rules.some((r) => r.injection.key === k.key)) {
        addRule({ match: k.match, injection: { type: 'bearer', key: k.key }, approval: 'allow', askRules: [], enabled: true });
      }
    }
    return { ok: true };
  }
  if ((m = /^\/keys\/([A-Z0-9_]+)\/share$/.exec(cred)) && method === 'POST') {
    const k = state.keys.find((x) => x.key === m![1]);
    if (!k) throw new HttpError(404, 'Unknown key');
    for (const g of body<{ toGroups: string[] }>(init).toGroups) {
      putPeerKey(g, { ...k, updatedAt: now, lastUsedAt: null, copiedFrom: { groupId: FIXTURE_GROUP.id, at: now } });
    }
    return { ok: true };
  }
  if ((m = /^\/keys\/([A-Z0-9_]+)$/.exec(cred))) {
    const name = m[1]!;
    const k = state.keys.find((x) => x.key === name);
    if (!k) throw new HttpError(404, 'Unknown key');
    if (method === 'PUT') {
      const b = body<{ value: string; alsoGroups?: string[] }>(init);
      if (!b.value) throw new HttpError(400, 'A value is required');
      upsertKey({ ...k, status: 'set', updatedAt: now, copiedFrom: null });
      for (const g of b.alsoGroups ?? []) {
        const peer = state.peers.find((p) => p.groupId === g)!;
        const theirs = peer.keys.find((x) => x.key === name);
        putPeerKey(g, { ...(theirs ?? k), status: 'set', updatedAt: now });
      }
      return { ok: true };
    }
    if (method === 'DELETE') {
      state.keys = state.keys.filter((x) => x.key !== name);
      state.rules = state.rules.filter((r) => r.injection.key !== name && !(r.injection.template ?? '').includes(`{{ ${name} }}`));
      return { ok: true };
    }
  }

  if (cred === '/rules' && method === 'POST') return addRule(body<RuleInput>(init));
  if ((m = /^\/rules\/([^/]+)$/.exec(cred))) {
    const name = decodeURIComponent(m[1]!);
    if (!state.rules.some((r) => r.name === name)) throw new HttpError(404, 'Unknown rule');
    if (method === 'PUT') {
      state.rules = state.rules.map((r) => (r.name === name ? { ...body<RuleInput>(init), name } : r));
      return { ok: true };
    }
    if (method === 'DELETE') {
      state.rules = state.rules.filter((r) => r.name !== name);
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
    const key = decodeURIComponent(m[1]!);
    const account = state.accounts.find((a) => a.key === key);
    state.accounts = state.accounts.filter((a) => a.key !== key);
    if (account?.mcpServer) state.mcpAuth[account.mcpServer] = { auth: 'oauth', status: 'needs_sign_in' };
    return { ok: true };
  }

  if ((m = /^\/requests\/([^/]+)\/(approve|reject)$/.exec(cred)) && method === 'POST') {
    const request = state.requests.find((r) => r.id === m![1]);
    if (!request) throw new HttpError(404, 'This request has expired');
    if (m[2] === 'approve') {
      const b = body<{ values: Record<string, string>; copyFrom: Record<string, string> }>(init);
      for (const slot of request.slots) {
        const from = b.copyFrom[slot.key];
        if (!from && !slot.agentProvided && !b.values[slot.key]) throw new HttpError(400, `${slot.key} needs a value`);
        upsertKey({
          key: slot.key, label: slot.label, status: 'set', updatedAt: now, lastUsedAt: null,
          copiedFrom: from ? { groupId: from, at: now } : null, match: request.rules[0]?.match,
        });
      }
      for (const r of request.rules) addRule(r);
    }
    state.requests = state.requests.filter((r) => r.id !== request.id);
    return { ok: true };
  }

  if (cred === '/activity' && method === 'GET') {
    const filter = search?.get('filter') ?? 'all';
    const before = search?.get('before');
    const items = state.activity.filter((a) => (filter === 'keys' ? a.decision === 'injected' || a.decision === 'approved'
      : filter === 'problems' ? ['denied', 'blocked', 'expired'].includes(a.decision) : true));
    const start = before ? items.findIndex((a) => a.id === before) + 1 : 0;
    const page = items.slice(start, start + 20);
    return { items: page, nextBefore: start + 20 < items.length ? page[page.length - 1]!.id : null };
  }
  if (cred === '/network' && method === 'PUT') {
    const b = body<{ unmatched: NetworkDto['unmatched']; allowPrivate: string[] }>(init);
    state.network = { ...state.network, unmatched: b.unmatched, allowPrivate: b.allowPrivate };
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
    account = replaced?.account ?? (input.requestId ? 'sam@example.com' : `user${state.seq}@example.com`);
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
    for (const id of scopeIds) {
      for (const host of GOOGLE_SCOPES[id]?.hosts ?? []) {
        if (!state.rules.some((r) => r.match === host && r.injection.key === key)) {
          addRule({ match: host, injection: { type: 'bearer', key }, approval: 'allow', askRules: [], enabled: true });
        }
      }
    }
    if (input.requestId) state.requests = state.requests.filter((r) => r.id !== input.requestId);
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
      payload = route(method, url.pathname, init, url.searchParams);
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
