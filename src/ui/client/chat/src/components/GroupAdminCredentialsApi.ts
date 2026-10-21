// Wire contract for group settings → Credentials (R1). The host relays these
// routes to the credential gateway; credential values are write-only and never
// appear in any response.
//
//   GET    /credentials                        CredentialsOverviewDto
//   POST   /credentials/keys                   { key, label, value, destination }
//   PUT    /credentials/keys/:key              { value?, label?, destination? }
//   DELETE /credentials/keys/:key
//   POST   /credentials/accounts/start         AccountStartInput → AccountStartDto
//   GET    /credentials/accounts/start/:state  AccountProgressDto
//   DELETE /credentials/accounts/:key
//   PUT    /credentials/network                { unmatched, allowPrivate, allowHosts }
//
// When the gateway is down, every route answers 503 { error: 'gateway_unreachable' }.
import { apiPath } from './GroupAdminApi';

export function credPath(gid: string, sub = ''): string {
  return apiPath(gid, `/credentials${sub}`);
}

export type InjectionType = 'bearer' | 'basic' | 'api-key' | 'query' | 'custom';

/** How the gateway attaches a key; the key itself is implied by its owner. */
export interface InjectionDto {
  type: InjectionType;
  /** Header name for `api-key`, query parameter for `query`. */
  name?: string;
  prefix?: string;
  /** Header template for `custom`, e.g. `Basic {{ KEY }}`. */
  template?: string;
}

/** Where a key is sent: `host[:port][/path-glob]`, e.g. `api.linear.app` or `nextcloud.example.org/mcp/*`. */
export interface DestinationDto {
  match: string;
  injection: InjectionDto;
}

export interface KeyDto {
  key: string;
  label: string;
  status: 'set' | 'needs_value';
  updatedAt: string | null;
  lastUsedAt: string | null;
  destination: DestinationDto;
  /** MCP server in this group that uses this key, when known. */
  mcpServer?: string;
}

export interface AccountDto {
  key: string;
  kind: 'oauth_app' | 'mcp_oauth';
  provider: string;
  providerLabel: string;
  account: string | null;
  scopes: { id: string; label: string }[];
  status: 'connected' | 'needs_reconnect';
  connectedAt: string | null;
  lastUsedAt: string | null;
  mcpServer?: string;
  resource?: string;
}

export interface ScopeSetDto {
  id: string;
  label: string;
  hosts: string[];
}

export interface OAuthAppDto {
  id: string;
  label: string;
  configured: boolean;
  /** Shown when not configured. */
  envHint?: string;
  scopeSets: ScopeSetDto[];
}

export interface KeyPresetDto {
  id: string;
  label: string;
  key: string;
  destination: DestinationDto;
  obtainUrl?: string;
  hint?: string;
}

export interface McpAuthDto {
  server: string;
  url: string;
  auth: 'none' | 'key' | 'oauth';
  status: 'ok' | 'needs_sign_in' | 'needs_reconnect' | 'needs_value';
  key?: string;
  account?: string | null;
}

export interface NetworkDto {
  unmatched: 'tunnel' | 'deny';
  /** Hosts reachable without a key while unmatched requests are blocked. */
  allowHosts: string[];
  allowPrivate: string[];
  /** Operator-wide allowlist from `.env`; read-only here. */
  operatorAllowPrivate: string[];
}

export interface CredentialsOverviewDto {
  canEdit: boolean;
  keys: KeyDto[];
  accounts: AccountDto[];
  network: NetworkDto;
  oauthApps: OAuthAppDto[];
  presets: KeyPresetDto[];
  mcp: McpAuthDto[];
}

export type AccountStartInput = { provider: string; scopeSets: string[]; replaceKey?: string } | { mcpServer: string };

export interface AccountStartDto {
  state: string;
  authorizeUrl: string;
  label: string;
}

export interface AccountProgressDto {
  status: 'pending' | 'connected' | 'failed';
  error?: string;
  account?: string | null;
}

/** Posted by the host's `/oauth/callback` page to `window.opener`. */
export interface OAuthCompleteMessage {
  type: 'nanoclaw-oauth-complete';
  state: string;
  status: 'connected' | 'failed';
}

export const ERROR_GATEWAY_UNREACHABLE = 'gateway_unreachable';
