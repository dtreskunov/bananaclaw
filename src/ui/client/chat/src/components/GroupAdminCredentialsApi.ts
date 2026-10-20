// Wire contract for group settings → Credentials. The host relays these
// routes to the credential gateway; credential values are write-only and never
// appear in any response.
//
//   GET    /credentials                        CredentialsOverviewDto
//   GET    /credentials/peers                  { groups: PeerGroupDto[] }
//   POST   /credentials/keys                   { key, label, value, rule?, alsoGroups? }
//   PUT    /credentials/keys/:key              { value, alsoGroups? }
//   DELETE /credentials/keys/:key
//   POST   /credentials/keys/copy              { fromGroup, keys }   (copied inside the gateway)
//   POST   /credentials/keys/:key/share        { toGroups }          (copied inside the gateway)
//   POST   /credentials/rules                  RuleInput
//   PUT    /credentials/rules/:name            RuleInput
//   DELETE /credentials/rules/:name
//   POST   /credentials/accounts/start         AccountStartInput → AccountStartDto
//   GET    /credentials/accounts/start/:state  AccountProgressDto
//   DELETE /credentials/accounts/:key
//   POST   /credentials/requests/:id/approve   { values, copyFrom }
//   POST   /credentials/requests/:id/reject
//   GET    /credentials/activity?before=&filter=all|keys|problems  ActivityPageDto
//   PUT    /credentials/network                { unmatched, allowPrivate }
//
// When the gateway is down, every route answers 503 { error: 'gateway_unreachable' }.
import { apiPath } from './GroupAdminApi';

export function credPath(gid: string, sub = ''): string {
  return apiPath(gid, `/credentials${sub}`);
}

export type InjectionType = 'bearer' | 'basic' | 'api-key' | 'query' | 'custom' | 'passthrough';
export type ApprovalMode = 'allow' | 'ask-writes' | 'ask' | 'custom';

export interface AskRuleDto {
  method: string;
  path: string;
}

export interface RuleDto {
  name: string;
  /** `host[:port][/path-glob]`, e.g. `api.linear.app` or `nextcloud.example.org/mcp/*`. */
  match: string;
  injection: {
    type: InjectionType;
    key?: string;
    /** Header name for `api-key`, query parameter for `query`. */
    name?: string;
    prefix?: string;
    /** Header template for `custom`, e.g. `Basic {{ KEY }}`. */
    template?: string;
  };
  approval: ApprovalMode;
  askRules: AskRuleDto[];
  enabled: boolean;
  /** MCP server in this group that this rule serves, when known. */
  mcpServer?: string;
}

export type RuleInput = Omit<RuleDto, 'name'> & { name?: string };

export interface GroupRefDto {
  groupId: string;
  groupName: string;
  /** Whether the viewer may change this group's credentials. */
  canEdit: boolean;
}

export interface KeyDto {
  key: string;
  label: string;
  status: 'set' | 'needs_value';
  updatedAt: string | null;
  lastUsedAt: string | null;
  copiedFrom: { groupId: string; groupName: string; at: string; stale: boolean } | null;
  /** Other groups holding a key with the same name. */
  alsoIn: (GroupRefDto & { stale: boolean })[];
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

export interface RequestSlotDto {
  key: string;
  label: string;
  description: string;
  obtainUrl?: string;
  obtainInstructions?: string;
  /** The agent supplied the value (e.g. a token it generated); the admin confirms it. */
  agentProvided?: boolean;
  /** Groups the viewer can copy an existing value from. */
  copyableFrom: GroupRefDto[];
}

export interface RequestDto {
  id: string;
  createdAt: string;
  expiresAt: string;
  thread: string | null;
  message: string;
  slots: RequestSlotDto[];
  rules: RuleInput[];
  account?: { provider: string; providerLabel: string; scopes: { id: string; label: string }[] };
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
  match: string;
  injection: RuleDto['injection'];
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
  allowPrivate: string[];
  /** Operator-wide allowlist from `.env`; read-only here. */
  operatorAllowPrivate: string[];
}

export interface CredentialsOverviewDto {
  canEdit: boolean;
  keys: KeyDto[];
  accounts: AccountDto[];
  rules: RuleDto[];
  requests: RequestDto[];
  network: NetworkDto;
  oauthApps: OAuthAppDto[];
  presets: KeyPresetDto[];
  mcp: McpAuthDto[];
}

/** Another group the viewer can edit, with the key names it holds (never values). */
export interface PeerGroupDto extends GroupRefDto {
  keys: { key: string; label: string; status: KeyDto['status'] }[];
}

export type ActivityDecision = 'injected' | 'approved' | 'denied' | 'expired' | 'tunnel' | 'blocked';

export interface ActivityDto {
  id: string;
  at: string;
  thread: string | null;
  method: string;
  host: string;
  path: string;
  status: number | null;
  decision: ActivityDecision;
  key?: string;
  rule?: string;
}

export interface ActivityPageDto {
  items: ActivityDto[];
  nextBefore: string | null;
}

export type AccountStartInput =
  | { provider: string; scopeSets: string[]; replaceKey?: string; requestId?: string }
  | { mcpServer: string };

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
