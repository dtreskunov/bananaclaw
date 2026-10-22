/**
 * Group credentials on the Agent Vault gateway, in the shapes the group
 * settings → Credentials tab uses: static keys (a credential plus the service
 * that sends it) and MCP OAuth sign-ins with per-vault dynamic registration.
 *
 * Gateway API: Agent Vault fork `docs/guides/mcp-oauth.mdx`.
 */
import { gatewayJson, vaultName } from './agent-vault-client.js';

// ── gateway shapes ────────────────────────────────────────────────────────

export interface GatewayAuth {
  type: 'bearer' | 'basic' | 'api-key' | 'custom' | 'passthrough' | string;
  token?: string;
  username?: string;
  password?: string;
  key?: string;
  header?: string;
  prefix?: string;
  headers?: Record<string, string>;
}

export interface GatewayService {
  name: string;
  /** Matcher pattern: `host[:port][/path-glob]`. */
  host: string;
  enabled?: boolean;
  auth: GatewayAuth;
  substitutions?: { key: string; placeholder: string; in?: string[] }[];
}

export interface McpAccountInfo {
  key: string;
  resource_url: string;
  account: string | null;
  connected_at: string | null;
  last_used_at: string | null;
  updated_at: string;
  status: 'connected' | 'needs_reconnect';
  client: 'registered' | 'app' | 'metadata';
  scopes: string[];
}

export interface McpProbeInfo {
  oauth: boolean;
  issuer?: string;
  client?: string;
  code?: string;
  provider?: string;
}

export interface CompleteResult {
  status: 'connected' | 'failed' | string;
  vault: string;
  key?: string;
  account?: string | null;
  code?: string;
  error?: string;
}

// ── DTOs (mirror src/ui/client/chat/src/components/GroupAdminCredentialsApi.ts) ─

export interface InjectionDto {
  type: 'bearer' | 'basic' | 'api-key' | 'query' | 'custom';
  name?: string;
  prefix?: string;
  template?: string;
}

export interface KeyDto {
  key: string;
  label: string;
  status: 'set' | 'needs_value';
  updatedAt: string | null;
  lastUsedAt: string | null;
  destination: { match: string; injection: InjectionDto };
  mcpServer?: string;
}

// ── reads ─────────────────────────────────────────────────────────────────

const enc = encodeURIComponent;

export async function listServices(agentGroupId: string): Promise<GatewayService[]> {
  const body = await gatewayJson<{ services?: GatewayService[] }>(
    'GET',
    `/v1/vaults/${enc(vaultName(agentGroupId))}/services`,
    'service list',
  );
  return body.services ?? [];
}

export interface CredentialItem {
  key: string;
  type?: string;
  updated_at?: string;
}

export async function listCredentials(agentGroupId: string): Promise<CredentialItem[]> {
  const body = await gatewayJson<{ credentials?: CredentialItem[]; keys?: string[] }>(
    'GET',
    `/v1/credentials?vault=${enc(vaultName(agentGroupId))}`,
    'credential list',
  );
  return body.credentials ?? (body.keys ?? []).map((key) => ({ key }));
}

export async function listMcpAccounts(agentGroupId: string): Promise<McpAccountInfo[]> {
  return (
    (await gatewayJson<McpAccountInfo[] | null>(
      'GET',
      `/v1/vaults/${enc(vaultName(agentGroupId))}/mcp-oauth`,
      'MCP sign-in list',
    )) ?? []
  );
}

// Probing is a network round trip to the MCP server and its authorization
// server, so results are cached; a sign-in or a changed URL probes again.
const PROBE_TTL_MS = 10 * 60_000;
const PROBE_ERROR_TTL_MS = 60_000;
const probeCache = new Map<string, { at: number; info: McpProbeInfo | null }>();

/** OAuth requirements for an MCP URL, or null when the probe failed (treated as "no sign-in known"). */
export async function probeMcp(
  agentGroupId: string,
  resourceUrl: string,
  now = Date.now(),
): Promise<McpProbeInfo | null> {
  const cacheKey = `${agentGroupId}\n${resourceUrl}`;
  const hit = probeCache.get(cacheKey);
  if (hit && now - hit.at < (hit.info ? PROBE_TTL_MS : PROBE_ERROR_TTL_MS)) return hit.info;
  let info: McpProbeInfo | null;
  try {
    info = await gatewayJson<McpProbeInfo>(
      'POST',
      `/v1/vaults/${enc(vaultName(agentGroupId))}/mcp-oauth/probe`,
      'MCP probe',
      { body: { resource_url: resourceUrl }, timeoutMs: 25_000 },
    );
  } catch (err) {
    if ((err as { unreachable?: boolean }).unreachable) throw err;
    info = null;
  }
  probeCache.set(cacheKey, { at: now, info });
  return info;
}

export function forgetProbes(agentGroupId: string): void {
  for (const key of probeCache.keys()) if (key.startsWith(`${agentGroupId}\n`)) probeCache.delete(key);
}

// ── writes ────────────────────────────────────────────────────────────────

export async function startMcpSignIn(
  agentGroupId: string,
  resourceUrl: string,
): Promise<{ state: string; authorize_url: string }> {
  return gatewayJson('POST', `/v1/vaults/${enc(vaultName(agentGroupId))}/mcp-oauth/start`, 'MCP sign-in start', {
    body: { resource_url: resourceUrl },
    timeoutMs: 30_000,
  });
}

export async function disconnectMcp(agentGroupId: string, key: string): Promise<void> {
  await gatewayJson('DELETE', `/v1/vaults/${enc(vaultName(agentGroupId))}/mcp-oauth/${enc(key)}`, 'MCP disconnect', {
    timeoutMs: 30_000,
  });
}

/** Relays the provider's callback parameters; a 200 can still carry `status: "failed"`. */
export async function completeOAuth(input: {
  state: string;
  code?: string;
  iss?: string;
  error?: string;
}): Promise<CompleteResult> {
  const body: Record<string, string> = { state: input.state };
  if (input.code) body.code = input.code;
  if (input.iss) body.iss = input.iss;
  if (input.error) body.error = input.error;
  return gatewayJson('POST', '/v1/oauth/complete', 'OAuth completion', { body, timeoutMs: 30_000 });
}

export async function clientMetadata(): Promise<Record<string, unknown>> {
  return gatewayJson('GET', '/v1/oauth/client-metadata', 'client metadata', { auth: false });
}

// ── mapping ───────────────────────────────────────────────────────────────

const TEMPLATE_KEY_RE = /\{\{\s*([A-Z][A-Z0-9_]*)\s*\}\}/g;

/** Credential keys a service sends. */
export function serviceKeys(service: GatewayService): string[] {
  const a = service.auth ?? { type: '' };
  const keys: string[] = [];
  if (a.type === 'bearer' && a.token) keys.push(a.token);
  if (a.type === 'basic') for (const k of [a.username, a.password]) if (k) keys.push(k);
  if (a.type === 'api-key' && a.key) keys.push(a.key);
  if (a.type === 'custom') {
    for (const v of Object.values(a.headers ?? {})) for (const m of v.matchAll(TEMPLATE_KEY_RE)) keys.push(m[1]!);
  }
  for (const s of service.substitutions ?? []) keys.push(s.key);
  return [...new Set(keys)];
}

/** Services the gateway generated for MCP sign-ins; managed as accounts, not keys. */
export function isMcpService(service: GatewayService): boolean {
  const keys = serviceKeys(service);
  return keys.length > 0 && keys.every((k) => k.startsWith('MCP_'));
}

function injectionFor(service: GatewayService, key: string): InjectionDto {
  const a = service.auth ?? { type: '' };
  const sub = service.substitutions?.find((s) => s.key === key);
  if (sub) return { type: sub.in?.includes('query') ? 'query' : 'custom', name: sub.placeholder };
  if (a.type === 'bearer') return { type: 'bearer' };
  if (a.type === 'basic') return { type: 'basic' };
  if (a.type === 'api-key') return { type: 'api-key', name: a.header || 'Authorization', prefix: a.prefix };
  const header = Object.entries(a.headers ?? {}).find(([, v]) => v.includes(key));
  return { type: 'custom', name: header?.[0], template: header?.[1] };
}

/** One key per credential a non-MCP service sends, in service order. */
export function servicesToKeys(services: GatewayService[], credentials: CredentialItem[]): KeyDto[] {
  const known = new Map(credentials.map((c) => [c.key, c]));
  const keys: KeyDto[] = [];
  const seen = new Set<string>();
  for (const service of services) {
    if (isMcpService(service)) continue;
    for (const key of serviceKeys(service)) {
      if (seen.has(key)) continue;
      seen.add(key);
      const credential = known.get(key);
      keys.push({
        key,
        label: service.name,
        status: credential ? 'set' : 'needs_value',
        updatedAt: credential?.updated_at ?? null,
        lastUsedAt: null,
        destination: { match: service.host, injection: injectionFor(service, key) },
      });
    }
  }
  return keys;
}

/** `host[:port][/path]` of a URL, without query, fragment or trailing slash. */
export function resourceId(url: string): string {
  if (!URL.canParse(url)) return url.toLowerCase();
  const u = new URL(url);
  return `${u.host}${u.pathname.replace(/\/+$/, '')}`.toLowerCase();
}

function globToRegExp(glob: string): RegExp {
  return new RegExp(
    `^${glob
      .split('*')
      .map((p) => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
      .join('.*')}$`,
    'i',
  );
}

/** The non-MCP service whose matcher covers this URL, if any. */
export function serviceForUrl(services: GatewayService[], url: string): GatewayService | undefined {
  if (!URL.canParse(url)) return undefined;
  const u = new URL(url);
  const target = `${u.host}${u.pathname}`;
  return services.find((s) => {
    if (isMcpService(s) || s.enabled === false) return false;
    const pattern = s.host.includes('/') ? s.host : `${s.host}/*`;
    return globToRegExp(pattern).test(target) || globToRegExp(s.host).test(u.host);
  });
}
