/**
 * Group settings → Credentials routes (`…/admin/credentials/*`), backed by
 * the Agent Vault gateway. Mounted by group-admin.ts behind its admin gate.
 *
 * R1: MCP sign-in with per-group dynamic registration (P2), static keys
 * (P3), and OAuth apps with provider accounts (P4). Values and client
 * secrets never appear in any response or log.
 *
 * Wire contract: src/ui/client/chat/src/components/GroupAdminCredentialsApi.ts.
 */
import http from 'http';

import type { McpServerConfig } from '../../../container-config.js';
import { getAgentGroup } from '../../../db/agent-groups.js';
import { log } from '../../../log.js';
import { AgentVaultError, gatewayMessage, usesAgentVault } from '../../../modules/credentials/agent-vault-client.js';
import {
  disconnectMcp,
  disconnectProvider,
  forgetAllProbes,
  forgetProbes,
  startProviderSignIn,
  type ProviderInfo,
  listCredentials,
  listMcpAccounts,
  listServices,
  probeMcp,
  resourceId,
  serviceForUrl,
  serviceKeys,
  servicesToKeys,
  startMcpSignIn,
  type KeyDto,
  type McpAccountInfo,
} from '../../../modules/credentials/gateway-credentials.js';
import {
  AppInputError,
  listApps,
  providerAccountsOrEmpty,
  providersOrEmpty,
  removeApp,
  saveApp,
  type SaveAppInput,
} from '../../../modules/credentials/oauth-apps.js';
import {
  addKey,
  deleteKey,
  KEY_PRESETS,
  KeyInputError,
  updateKey,
  type AddKeyInput,
  type UpdateKeyInput,
} from '../../../modules/credentials/keys.js';
import { getSignIn, recordSignIn } from '../../../modules/credentials/sign-ins.js';
import { isGlobalAdmin, isOwner } from '../../../modules/permissions/db/user-roles.js';
import { uiBaseUrl } from '../server.js';
import { recordAdminAction } from './audit.js';

export interface CredentialsRouteContext {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  method: string;
  /** Path after `/credentials`, e.g. `''` or `/accounts/start`. */
  sub: string;
  actorUserId: string;
  gid: string;
  mcpServers: Record<string, McpServerConfig>;
  readJsonBody: (req: http.IncomingMessage) => Promise<unknown>;
  writeJson: (res: http.ServerResponse, status: number, body: unknown) => void;
}

interface McpAuthDto {
  server: string;
  url: string;
  auth: 'none' | 'key' | 'oauth';
  status: 'ok' | 'needs_sign_in' | 'needs_reconnect' | 'needs_value';
  key?: string;
  account?: string | null;
  needsApp?: string;
}

interface AccountDto {
  key: string;
  kind: 'mcp_oauth' | 'oauth_app';
  provider: string;
  providerLabel: string;
  account: string | null;
  scopes: { id: string; label: string }[];
  status: 'connected' | 'needs_reconnect';
  connectedAt: string | null;
  lastUsedAt: string | null;
  mcpServer?: string;
  resource?: string;
  client?: 'registered' | 'metadata' | 'app';
}

export function oauthRedirectUri(): string {
  return `${uiBaseUrl()}/oauth/callback`;
}

function httpServers(servers: Record<string, McpServerConfig>): [string, string][] {
  const out: [string, string][] = [];
  for (const [name, cfg] of Object.entries(servers)) {
    const url = (cfg as { url?: unknown }).url;
    if ((cfg.type === 'http' || cfg.type === 'sse') && typeof url === 'string') out.push([name, url]);
  }
  return out;
}

function serverFor(servers: [string, string][], resourceUrl: string): string | undefined {
  const id = resourceId(resourceUrl);
  return servers.find(([, url]) => resourceId(url) === id)?.[0];
}

function toAccount(a: McpAccountInfo, servers: [string, string][]): AccountDto {
  const server = serverFor(servers, a.resource_url);
  const host = URL.canParse(a.resource_url) ? new URL(a.resource_url).host : a.resource_url;
  return {
    key: a.key,
    kind: 'mcp_oauth',
    provider: 'mcp',
    providerLabel: server ?? host,
    account: a.account,
    scopes: (a.scopes ?? []).map((s) => ({ id: s, label: s })),
    status: a.status,
    connectedAt: a.connected_at,
    lastUsedAt: a.last_used_at,
    mcpServer: server,
    resource: a.resource_url,
    client: a.client,
  };
}

function toProviderAccount(a: McpAccountInfo, providers: ProviderInfo[]): AccountDto {
  const provider = providers.find((p) => p.id === a.provider);
  const sets = a.scope_sets ?? [];
  return {
    key: a.key,
    kind: 'oauth_app',
    provider: a.provider ?? 'unknown',
    providerLabel: provider?.label ?? a.provider ?? 'Account',
    account: a.account,
    scopes: sets.map((id) => ({ id, label: provider?.scope_sets.find((s) => s.id === id)?.label ?? id })),
    status: a.status,
    connectedAt: a.connected_at,
    lastUsedAt: a.last_used_at,
    client: 'app',
  };
}

function canEditInstall(userId: string): boolean {
  return isOwner(userId) || isGlobalAdmin(userId);
}

async function overview(ctx: CredentialsRouteContext): Promise<unknown> {
  const { gid } = ctx;
  const [services, credentials, accounts, providerAccounts, providers] = await Promise.all([
    listServices(gid),
    listCredentials(gid),
    listMcpAccounts(gid),
    providerAccountsOrEmpty(gid),
    providersOrEmpty(),
  ]);
  const servers = httpServers(ctx.mcpServers);
  const oauthApps = await listApps(gid, providers, [...accounts, ...providerAccounts], servers);
  const keys: KeyDto[] = servicesToKeys(services, credentials);
  const credentialKeys = new Set(credentials.map((c) => c.key));

  const mcp: McpAuthDto[] = await Promise.all(
    servers.map(async ([server, url]): Promise<McpAuthDto> => {
      const account = accounts.find((a) => resourceId(a.resource_url) === resourceId(url));
      if (account) {
        return {
          server,
          url,
          auth: 'oauth',
          status: account.status === 'connected' ? 'ok' : 'needs_reconnect',
          account: account.account,
        };
      }
      const service = serviceForUrl(services, url);
      if (service) {
        const key = serviceKeys(service)[0];
        const match = keys.find((k) => k.key === key);
        if (match && !match.mcpServer) match.mcpServer = server;
        return { server, url, auth: 'key', key, status: key && credentialKeys.has(key) ? 'ok' : 'needs_value' };
      }
      const probe = await probeMcp(gid, url);
      if (!probe?.oauth) return { server, url, auth: 'none', status: 'ok' };
      return {
        server,
        url,
        auth: 'oauth',
        status: 'needs_sign_in',
        needsApp: probe.code === 'registration_unsupported' ? probe.provider : undefined,
      };
    }),
  );

  return {
    canEdit: true,
    canEditInstall: canEditInstall(ctx.actorUserId),
    keysEditable: true,
    keys,
    accounts: [
      ...providerAccounts.map((a) => toProviderAccount(a, providers)),
      ...accounts.map((a) => toAccount(a, servers)),
    ],
    oauthApps,
    oauthRedirectUri: oauthRedirectUri(),
    presets: KEY_PRESETS,
    mcp,
  };
}

// ── keys (P3) ──────────────────────────────────────────────────────────────

async function addKeyRoute(ctx: CredentialsRouteContext): Promise<void> {
  const body = (await ctx.readJsonBody(ctx.req)) as AddKeyInput;
  const { key, destination } = await addKey(ctx.gid, body);
  recordAdminAction({
    actorUserId: ctx.actorUserId,
    action: 'group_credential_add',
    targetKind: 'agent_group',
    targetId: ctx.gid,
    payload: { key, match: destination.match, injection: destination.injection.type },
  });
  ctx.writeJson(ctx.res, 200, { ok: true });
}

async function updateKeyRoute(ctx: CredentialsRouteContext, key: string): Promise<void> {
  const body = (await ctx.readJsonBody(ctx.req)) as UpdateKeyInput;
  const changed = await updateKey(ctx.gid, key, body);
  recordAdminAction({
    actorUserId: ctx.actorUserId,
    action: 'group_credential_update',
    targetKind: 'agent_group',
    targetId: ctx.gid,
    payload: { key, changed },
  });
  ctx.writeJson(ctx.res, 200, { ok: true });
}

async function deleteKeyRoute(ctx: CredentialsRouteContext, key: string): Promise<void> {
  await deleteKey(ctx.gid, key);
  recordAdminAction({
    actorUserId: ctx.actorUserId,
    action: 'group_credential_delete',
    targetKind: 'agent_group',
    targetId: ctx.gid,
    payload: { key },
  });
  ctx.writeJson(ctx.res, 200, { ok: true });
}

const MAX_CLIENT_NAME = 100;

/** The group's name as the OAuth client name, within the gateway's limits. */
export function clientNameFor(gid: string): string | undefined {
  // eslint-disable-next-line no-control-regex
  const name = (getAgentGroup(gid)?.name ?? '').replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').trim();
  return name ? [...name].slice(0, MAX_CLIENT_NAME).join('') : undefined;
}

async function startProviderAccount(
  ctx: CredentialsRouteContext,
  body: { provider?: unknown; scopeSets?: unknown; replaceKey?: unknown },
): Promise<void> {
  const provider = (await providersOrEmpty()).find((p) => p.id === body.provider);
  if (!provider) {
    ctx.writeJson(ctx.res, 404, { error: 'Unknown provider' });
    return;
  }
  const sets = Array.isArray(body.scopeSets) ? body.scopeSets.filter((s): s is string => typeof s === 'string') : [];
  if (!sets.length || sets.some((s) => !provider.scope_sets.some((p) => p.id === s))) {
    ctx.writeJson(ctx.res, 400, { error: 'Choose what the agent may use' });
    return;
  }
  const replaceKey =
    typeof body.replaceKey === 'string' && body.replaceKey.startsWith('OAUTH_') ? body.replaceKey : undefined;
  const started = await startProviderSignIn(ctx.gid, {
    provider: provider.id,
    scope_sets: sets,
    replace_key: replaceKey,
  });
  recordSignIn({ state: started.state, userId: ctx.actorUserId, agentGroupId: ctx.gid, label: provider.label });
  recordAdminAction({
    actorUserId: ctx.actorUserId,
    action: 'group_oauth_account_start',
    targetKind: 'agent_group',
    targetId: ctx.gid,
    payload: { provider: provider.id, scopeSets: sets, replace: !!replaceKey },
  });
  ctx.writeJson(ctx.res, 200, { state: started.state, authorizeUrl: started.authorize_url, label: provider.label });
}

async function startSignIn(ctx: CredentialsRouteContext): Promise<void> {
  const body = (await ctx.readJsonBody(ctx.req)) as {
    mcpServer?: unknown;
    provider?: unknown;
    scopeSets?: unknown;
    replaceKey?: unknown;
  };
  if (typeof body.mcpServer !== 'string') return startProviderAccount(ctx, body);
  const url = httpServers(ctx.mcpServers).find(([name]) => name === body.mcpServer)?.[1];
  if (!url) {
    ctx.writeJson(ctx.res, 404, { error: `No HTTP MCP server named ${body.mcpServer}; save it first` });
    return;
  }
  const started = await startMcpSignIn(ctx.gid, url, clientNameFor(ctx.gid));
  recordSignIn({
    state: started.state,
    userId: ctx.actorUserId,
    agentGroupId: ctx.gid,
    label: body.mcpServer,
    mcpServer: body.mcpServer,
  });
  recordAdminAction({
    actorUserId: ctx.actorUserId,
    action: 'group_mcp_sign_in_start',
    targetKind: 'agent_group',
    targetId: ctx.gid,
    payload: { server: body.mcpServer },
  });
  ctx.writeJson(ctx.res, 200, { state: started.state, authorizeUrl: started.authorize_url, label: body.mcpServer });
}

function signInProgress(ctx: CredentialsRouteContext, state: string): void {
  const signIn = getSignIn(state);
  if (!signIn || signIn.agentGroupId !== ctx.gid || signIn.userId !== ctx.actorUserId) {
    ctx.writeJson(ctx.res, 404, { error: 'Unknown or expired sign-in' });
    return;
  }
  ctx.writeJson(ctx.res, 200, { status: signIn.status, account: signIn.account, error: signIn.error });
}

async function disconnect(ctx: CredentialsRouteContext, key: string): Promise<void> {
  if (key.startsWith('OAUTH_')) await disconnectProvider(ctx.gid, key);
  else if (key.startsWith('MCP_')) await disconnectMcp(ctx.gid, key);
  else {
    ctx.writeJson(ctx.res, 400, { error: 'Not an account key; delete keys under Keys' });
    return;
  }
  forgetProbes(ctx.gid);
  recordAdminAction({
    actorUserId: ctx.actorUserId,
    action: key.startsWith('OAUTH_') ? 'group_oauth_account_disconnect' : 'group_mcp_sign_in_disconnect',
    targetKind: 'agent_group',
    targetId: ctx.gid,
    payload: { key },
  });
  ctx.writeJson(ctx.res, 200, { ok: true });
}

// ── OAuth apps (P4) ────────────────────────────────────────────────────────

async function saveAppRoute(ctx: CredentialsRouteContext, provider: string): Promise<void> {
  const body = (await ctx.readJsonBody(ctx.req)) as SaveAppInput;
  const saved = await saveApp(ctx.gid, provider, body, canEditInstall(ctx.actorUserId));
  if (saved.scope === 'install') forgetAllProbes();
  else forgetProbes(ctx.gid);
  recordAdminAction({
    actorUserId: ctx.actorUserId,
    action: 'group_oauth_app_save',
    targetKind: 'agent_group',
    targetId: ctx.gid,
    payload: { provider, scope: saved.scope, clientId: saved.clientId, secretChanged: saved.secretChanged },
  });
  ctx.writeJson(ctx.res, 200, { ok: true });
}

async function removeAppRoute(ctx: CredentialsRouteContext, provider: string): Promise<void> {
  const scope = new URL(ctx.req.url || '/', 'http://localhost').searchParams.get('scope') ?? 'group';
  const removed = await removeApp(ctx.gid, provider, scope, canEditInstall(ctx.actorUserId));
  if (removed === 'install') forgetAllProbes();
  else forgetProbes(ctx.gid);
  recordAdminAction({
    actorUserId: ctx.actorUserId,
    action: 'group_oauth_app_remove',
    targetKind: 'agent_group',
    targetId: ctx.gid,
    payload: { provider, scope: removed },
  });
  ctx.writeJson(ctx.res, 200, { ok: true });
}

/** Handles `…/admin/credentials*`; always writes a response. */
export async function handleCredentialsRoute(ctx: CredentialsRouteContext): Promise<void> {
  const { method, sub, res } = ctx;
  if (!usesAgentVault(ctx.gid)) {
    ctx.writeJson(res, 409, { error: "This group doesn't use the credential gateway" });
    return;
  }
  try {
    if (sub === '' && method === 'GET') {
      ctx.writeJson(res, 200, await overview(ctx));
      return;
    }
    if (sub === '/accounts/start' && method === 'POST') return await startSignIn(ctx);
    let m = /^\/accounts\/start\/([^/]+)$/.exec(sub);
    if (m && method === 'GET') return signInProgress(ctx, decodeURIComponent(m[1]!));
    m = /^\/accounts\/([^/]+)$/.exec(sub);
    if (m && method === 'DELETE') return await disconnect(ctx, decodeURIComponent(m[1]!));
    if (sub === '/keys' && method === 'POST') return await addKeyRoute(ctx);
    m = /^\/keys\/([^/]+)$/.exec(sub);
    if (m && method === 'PUT') return await updateKeyRoute(ctx, decodeURIComponent(m[1]!));
    if (m && method === 'DELETE') return await deleteKeyRoute(ctx, decodeURIComponent(m[1]!));
    m = /^\/oauth-apps\/([a-z0-9-]+)$/.exec(sub);
    if (m && method === 'PUT') return await saveAppRoute(ctx, m[1]!);
    if (m && method === 'DELETE') return await removeAppRoute(ctx, m[1]!);
    ctx.writeJson(res, 404, { error: 'not_found' });
  } catch (err) {
    if (err instanceof AppInputError) {
      ctx.writeJson(res, err.status, { error: err.message });
      return;
    }
    if (err instanceof KeyInputError) {
      ctx.writeJson(res, err.status, { error: err.message });
      return;
    }
    if (!(err instanceof AgentVaultError)) throw err;
    if (err.unreachable) {
      log.warn('Credential gateway unreachable', { gid: ctx.gid, err: err.message });
      ctx.writeJson(res, 503, { error: 'gateway_unreachable' });
      return;
    }
    const status = err.status === 409 || err.status === 404 ? err.status : err.status! >= 500 ? 502 : 400;
    ctx.writeJson(res, status, { error: gatewayMessage(err), code: err.code, provider: err.provider });
  }
}
