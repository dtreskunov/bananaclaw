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
//   PUT    /credentials/oauth-apps/:id         { scope, clientId, clientSecret? }  (secret required the first time)
//   DELETE /credentials/oauth-apps/:id?scope=group|install
//
// `scope: 'install'` changes the install-wide app every group uses by default;
// only owners and global admins may (`canEditInstall`).
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
  /**
   * How the gateway identifies itself to an MCP server's authorization server:
   * a client registered dynamically for this group (RFC 7591), or the install's
   * published client metadata document.
   */
  client?: 'registered' | 'metadata' | 'app';
}

export interface ScopeSetDto {
  id: string;
  label: string;
  hosts: string[];
}

export type OAuthAppScope = 'group' | 'install';

/** One configured client; the secret is write-only. */
export interface OAuthClientDto {
  clientId: string;
  updatedAt: string;
  /** Accounts and MCP sign-ins using this client: in this group, and (install only) across all groups. */
  accounts: number;
  accountsAllGroups?: number;
}

/**
 * An OAuth client for a provider without dynamic registration (e.g. Google,
 * GitHub). The install-wide app is used by every group unless the group sets
 * its own.
 */
export interface OAuthAppDto {
  id: string;
  label: string;
  install: OAuthClientDto | null;
  group: OAuthClientDto | null;
  /** Where to create the client in the provider's console. */
  consoleUrl: string;
  /** Scope sets for connecting accounts; empty when the app is only used for MCP sign-in. */
  scopeSets: ScopeSetDto[];
  /** MCP servers known to sign in through this provider, e.g. GitHub's. */
  mcpServers?: string[];
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
  /**
   * The server's authorization server doesn't support dynamic registration, so
   * sign-in needs this OAuth app (provider id); set when that app isn't set up.
   */
  needsApp?: string;
}

export interface CredentialsOverviewDto {
  canEdit: boolean;
  /** May set install-wide OAuth apps (owner or global admin). */
  canEditInstall: boolean;
  /** False while keys can only be viewed here (the gateway answers key edits with 501). */
  keysEditable?: boolean;
  keys: KeyDto[];
  accounts: AccountDto[];
  oauthApps: OAuthAppDto[];
  /** The install's OAuth redirect URI, entered in a provider's console when creating an OAuth app. */
  oauthRedirectUri: string;
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
  /** `registration_unsupported`: the MCP server allows neither dynamic registration nor a client metadata document. */
  code?: 'declined' | 'registration_unsupported';
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
