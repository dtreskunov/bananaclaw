/**
 * Shared OAuth transport and service metadata helpers.
 * Vault-local reads are retained only for source-migration inventory.
 */
import { AgentVaultError, gatewayJson, vaultName } from './agent-vault-client.js';
import type { OAuthAppConfiguration } from '../../ui/shared/oauth-app.js';

// ── gateway shapes ────────────────────────────────────────────────────────

export interface GatewayAuth {
  type: 'bearer' | 'basic' | 'api-key' | 'custom' | 'passthrough' | string;
  token?: string;
  username?: string;
  password?: string;
  key?: string;
  header?: string;
  prefix?: string;
  location?: 'header' | 'query';
  parameter?: string;
  headers?: Record<string, string>;
}

export interface GatewayService {
  name: string;
  /** Matcher pattern: `host[:port][/path-glob]`. */
  host: string;
  path?: string;
  enabled?: boolean;
  https_only?: boolean;
  auth: GatewayAuth;
  substitutions?: { key: string; placeholder: string; in?: string[] }[];
}

export interface CompleteResult {
  status: 'connected' | 'failed' | string;
  connection_id?: string;
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
  location?: 'header' | 'query';
}

export interface KeyDto {
  key: string;
  label: string;
  status: 'set' | 'needs_value';
  updatedAt: string | null;
  lastUsedAt: string | null;
  destination: { match: string; injection: InjectionDto };
  mcpServer?: string;
  sharedService?: string;
}

// ── reads ─────────────────────────────────────────────────────────────────

const enc = encodeURIComponent;

export async function listServices(agentGroupId: string): Promise<GatewayService[]> {
  const body = await gatewayJson<{ services?: GatewayService[] }>(
    'GET',
    `/v1/vaults/${enc(vaultName(agentGroupId))}/services`,
    'service list',
  );
  if (!Array.isArray(body.services)) throw new AgentVaultError('Invalid gateway service metadata', 502);
  return body.services;
}

export interface CredentialItem {
  key: string;
  type?: string;
  updated_at?: string;
  last_used_at?: string | null;
}

export async function listCredentials(agentGroupId: string): Promise<CredentialItem[]> {
  const body = await gatewayJson<{ credentials?: CredentialItem[]; keys?: string[] }>(
    'GET',
    `/v1/credentials?vault=${enc(vaultName(agentGroupId))}`,
    'credential list',
  );
  if (Array.isArray(body.credentials)) return body.credentials;
  if (Array.isArray(body.keys)) return body.keys.map((key) => ({ key }));
  throw new AgentVaultError('Invalid gateway credential metadata', 502);
}

/** Relays the provider's callback parameters; a 200 can still carry `status: "failed"`. */
export async function completeOAuth(input: {
  state: string;
  user_id: string;
  code?: string;
  iss?: string;
  error?: string;
}): Promise<CompleteResult> {
  const body: Record<string, string> = { state: input.state, user_id: input.user_id };
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

/** Credential keys the gateway manages for MCP sign-ins and provider accounts. */
export function isManagedKey(key: string): boolean {
  return key.startsWith('MCP_') || key.startsWith('OAUTH_');
}

/** Services the gateway generated for MCP sign-ins or provider accounts; managed as accounts, not keys. */
export function isMcpService(service: GatewayService): boolean {
  const keys = serviceKeys(service);
  return keys.length > 0 && keys.every(isManagedKey);
}

function injectionFor(service: GatewayService, key: string): InjectionDto {
  const a = service.auth ?? { type: '' };
  const sub = service.substitutions?.find((s) => s.key === key);
  if (sub)
    return {
      type: sub.in?.includes('query') ? 'query' : 'custom',
      name: sub.placeholder,
      template: sub.in?.includes('query') ? undefined : sub.placeholder,
    };
  if (a.type === 'bearer') return { type: 'bearer' };
  if (a.type === 'basic') return { type: 'basic' };
  if (a.type === 'api-key')
    return a.location === 'query'
      ? { type: 'api-key', location: 'query', name: a.parameter }
      : { type: 'api-key', name: a.header || 'Authorization', prefix: a.prefix };
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
        lastUsedAt: credential?.last_used_at ?? null,
        destination: { match: service.host, injection: injectionFor(service, key) },
        ...(serviceKeys(service).length > 1 ? { sharedService: service.name } : {}),
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

// ── building services from the UI's destination ──────────────────────────

export interface DestinationDto {
  match: string;
  injection: InjectionDto;
}

/** Gateway service names are 3-64 character slugs. */
export function serviceSlug(label: string): string {
  const slug = label
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
    .replace(/-+$/, '');
  return slug.length >= 3 ? slug : `key-${slug || 'service'}`.slice(0, 64);
}

/** A slug based on `label` that no other service uses. */
export function uniqueServiceName(label: string, services: GatewayService[], except?: string): string {
  const taken = new Set(services.map((s) => s.name).filter((n) => n !== except));
  const base = serviceSlug(label);
  if (!taken.has(base)) return base;
  for (let i = 2; ; i++) {
    const suffix = `-${i}`;
    const name = `${base.slice(0, 64 - suffix.length).replace(/-+$/, '')}${suffix}`;
    if (!taken.has(name)) return name;
  }
}

/** Default placeholder an agent puts in the URL for a query-string key. */
export function queryPlaceholder(key: string): string {
  return `__${key}__`;
}

/** The single service that sends `key` to `destination`. */
export function serviceFromDestination(name: string, key: string, destination: DestinationDto): GatewayService {
  const { injection } = destination;
  const host = destination.match.trim();
  switch (injection.type) {
    case 'bearer':
      return { name, host, auth: { type: 'bearer', token: key } };
    case 'basic':
      return { name, host, auth: { type: 'basic', username: key } };
    case 'api-key': {
      if (injection.location === 'query')
        return { name, host, auth: { type: 'api-key', key, location: 'query', parameter: injection.name?.trim() } };
      const auth: GatewayAuth = { type: 'api-key', key, header: injection.name?.trim() || 'Authorization' };
      if (injection.prefix) auth.prefix = injection.prefix;
      return { name, host, auth };
    }
    case 'query':
      return {
        name,
        host,
        auth: { type: 'passthrough' },
        substitutions: [{ key, placeholder: injection.name?.trim() || queryPlaceholder(key), in: ['query'] }],
      };
    case 'custom':
      return {
        name,
        host,
        auth: { type: 'custom', headers: { [injection.name?.trim() || 'Authorization']: injection.template ?? '' } },
      };
  }
}

/** Index of the non-MCP service that sends `key`, or -1. */
export function serviceIndexForKey(services: GatewayService[], key: string): number {
  return services.findIndex((s) => !isMcpService(s) && serviceKeys(s).includes(key));
}

/** True when two injections describe the same wire behaviour (ignoring unset optional fields). */
export function sameInjection(a: InjectionDto, b: InjectionDto): boolean {
  const header = (i: InjectionDto): string =>
    (i.type === 'api-key' && i.location !== 'query') || i.type === 'custom'
      ? (i.name || 'Authorization').toLowerCase()
      : i.name || '';
  const norm = (i: InjectionDto): string =>
    JSON.stringify([
      i.type,
      i.location ?? 'header',
      header(i),
      i.prefix || '',
      i.type === 'custom' ? i.template || '' : '',
    ]);
  return norm(a) === norm(b);
}

export { injectionFor };

// ── OAuth apps and provider accounts (F11) ───────────────────────────────

export interface AppInfo extends OAuthAppConfiguration {
  id: string;
  source: 'install' | 'user';
  overrides_install: boolean;
  client_secret_set: boolean;
  updated_at: string;
  accounts: number;
  accounts_all_vaults?: number;
}
