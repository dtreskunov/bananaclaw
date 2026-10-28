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
import {
  AgentVaultError,
  ensureVault,
  gatewayMessage,
  usesAgentVault,
} from '../../../modules/credentials/agent-vault-client.js';
import {
  disconnectMcp,
  disconnectProvider,
  forgetAllProbes,
  forgetProbes,
  startProviderSignIn,
  listCredentials,
  listMcpAccounts,
  listConfiguredApps,
  listProviderAccounts,
  listServices,
  probeMcp,
  resourceId,
  serviceForUrl,
  serviceKeys,
  servicesToKeys,
  getKeySet,
  putKeySet,
  deleteKeySet,
  startMcpSignIn,
  type KeyDto,
  type McpAccountInfo,
} from '../../../modules/credentials/gateway-credentials.js';
import {
  AppInputError,
  listApps,
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
import { checkSetRevision, checkSetService, checkSetValues } from '../../../modules/credentials/key-sets.js';
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
  needsApp?: boolean;
  issuer?: string;
  appId?: string;
  ambiguousApp?: boolean;
}

interface AccountDto {
  key: string;
  kind: 'mcp_oauth' | 'oauth_app';
  provider: string;
  providerLabel: string;
  appSource?: 'install' | 'vault';
  issuer?: string;
  apiHosts?: string[];
  requestedScopes?: string[] | null;
  grantedScopes?: string[] | null;
  scopeSource?: string;
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

function toProviderAccount(a: McpAccountInfo, apps: Awaited<ReturnType<typeof listApps>>): AccountDto {
  const app = apps.find((p) => p.id === a.app_id);
  return {
    key: a.key,
    kind: 'oauth_app',
    provider: a.app_id ?? 'unknown',
    providerLabel: app?.label ?? a.app_id ?? 'Account',
    appSource: a.app_source,
    issuer: a.issuer,
    apiHosts: a.api_hosts,
    requestedScopes: a.requested_scopes,
    grantedScopes: a.granted_scopes,
    scopeSource: a.scope_source,
    account: a.account,
    scopes: a.scopes.map((id) => ({ id, label: id })),
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
  const [services, credentials, accounts, providerAccounts] = await Promise.all([
    listServices(gid),
    listCredentials(gid),
    listMcpAccounts(gid),
    listProviderAccounts(gid),
  ]);
  const servers = httpServers(ctx.mcpServers);
  const oauthApps = await listApps(gid, [...accounts, ...providerAccounts], canEditInstall(ctx.actorUserId));
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
        needsApp: probe.code === 'registration_unsupported',
        ambiguousApp: probe.code === 'ambiguous_app',
        issuer: probe.issuer,
        appId: probe.app_id,
      };
    }),
  );

  return {
    canEdit: true,
    targetOnly: !usesAgentVault(gid),
    activeBackend: usesAgentVault(gid) ? 'agent-vault' : 'onecli',
    canEditInstall: canEditInstall(ctx.actorUserId),
    keysEditable: true,
    keys,
    accounts: [
      ...providerAccounts.map((a) => toProviderAccount(a, oauthApps)),
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
  body: { appId?: unknown; scopes?: unknown; replaceKey?: unknown },
): Promise<void> {
  const app = (await listConfiguredApps(ctx.gid)).find((p) => p.id === body.appId);
  if (!app) {
    ctx.writeJson(ctx.res, 404, { error: 'Unknown OAuth app' });
    return;
  }
  const scopes = body.scopes;
  if (
    scopes !== undefined &&
    (!Array.isArray(scopes) || !scopes.every((s): s is string => typeof s === 'string' && Boolean(s) && !/\s/.test(s)))
  ) {
    ctx.writeJson(ctx.res, 400, { error: 'scopes must be an array of nonempty OAuth scope strings' });
    return;
  }
  const replaceKey =
    typeof body.replaceKey === 'string' && body.replaceKey.startsWith('OAUTH_') ? body.replaceKey : undefined;
  const started = await startProviderSignIn(ctx.gid, {
    app_id: app.id,
    scopes,
    replace_key: replaceKey,
  });
  recordSignIn({ state: started.state, userId: ctx.actorUserId, agentGroupId: ctx.gid, label: app.label });
  recordAdminAction({
    actorUserId: ctx.actorUserId,
    action: 'group_oauth_account_start',
    targetKind: 'agent_group',
    targetId: ctx.gid,
    payload: { appId: app.id, scopes: body.scopes ?? app.default_scopes, replace: !!replaceKey },
  });
  ctx.writeJson(ctx.res, 200, { state: started.state, authorizeUrl: started.authorize_url, label: app.label });
}

async function startSignIn(ctx: CredentialsRouteContext): Promise<void> {
  const raw = await ctx.readJsonBody(ctx.req);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    ctx.writeJson(ctx.res, 400, { error: 'Sign-in input must be an object' });
    return;
  }
  const body = raw as {
    mcpServer?: unknown;
    appId?: unknown;
    scopes?: unknown;
    provider?: unknown;
    scopeSets?: unknown;
    replaceKey?: unknown;
  };
  if ('provider' in body || 'scopeSets' in body || 'scope_sets' in body) {
    ctx.writeJson(ctx.res, 400, { error: 'Use appId and actual OAuth scopes' });
    return;
  }
  if (typeof body.mcpServer !== 'string') return startProviderAccount(ctx, body);
  const url = httpServers(ctx.mcpServers).find(([name]) => name === body.mcpServer)?.[1];
  if (!url) {
    ctx.writeJson(ctx.res, 404, { error: `No HTTP MCP server named ${body.mcpServer}; save it first` });
    return;
  }
  const started = await startMcpSignIn(
    ctx.gid,
    url,
    clientNameFor(ctx.gid),
    typeof body.appId === 'string' ? body.appId : undefined,
  );
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
  ctx.writeJson(ctx.res, 200, { status: signIn.status, key: signIn.key, account: signIn.account, error: signIn.error });
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
  const targetOnly = new URL(ctx.req.url || '/', 'http://localhost').searchParams.get('target') === 'agent-vault';
  if (!usesAgentVault(ctx.gid) && !targetOnly && !(sub === '/target' && method === 'POST')) {
    ctx.writeJson(res, 409, { error: 'inactive_gateway_target', canPrepareTarget: true });
    return;
  }
  try {
    if (sub === '/target' && method === 'POST') {
      const state = await ensureVault(ctx.gid);
      recordAdminAction({
        actorUserId: ctx.actorUserId,
        action: 'group_credential_target_prepare',
        targetKind: 'agent_group',
        targetId: ctx.gid,
        payload: { state, backendChanged: false },
      });
      ctx.writeJson(res, 200, { state, backendChanged: false });
      return;
    }
    if (sub === '' && method === 'GET') {
      ctx.writeJson(res, 200, await overview(ctx));
      return;
    }
    if (sub === '/accounts/start' && method === 'POST') return await startSignIn(ctx);
    let m = /^\/key-sets\/([a-z0-9-]+)$/.exec(sub);
    if (
      (sub === '/key-sets' && method === 'POST') ||
      (m && (method === 'GET' || method === 'PUT' || method === 'DELETE'))
    ) {
      const name = m?.[1];
      if (method === 'GET') {
        ctx.writeJson(res, 200, await getKeySet(ctx.gid, name!));
        return;
      }
      const body: unknown = await ctx.readJsonBody(ctx.req);
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw new KeyInputError('Provide key-set JSON');
      const revision = method === 'POST' ? undefined : checkSetRevision('revision' in body ? body.revision : undefined);
      let result: unknown;
      if (method === 'DELETE') await deleteKeySet(ctx.gid, name!, revision!);
      else {
        const service = checkSetService('service' in body ? body.service : undefined);
        if (name && name !== service.name) throw new KeyInputError('Service name must match the key-set URL');
        const values = checkSetValues('values' in body ? body.values : {});
        result = await putKeySet(
          ctx.gid,
          service.name,
          service,
          values,
          method === 'POST' ? { createOnly: true } : { revision: revision! },
        );
      }
      forgetProbes(ctx.gid);
      recordAdminAction({
        actorUserId: ctx.actorUserId,
        action: `group_credential_set_${method.toLowerCase()}`,
        targetKind: 'agent_group',
        targetId: ctx.gid,
        payload: { service: name, backendChanged: false },
      });
      ctx.writeJson(res, 200, result ?? { ok: true });
      return;
    }
    m = /^\/accounts\/start\/([^/]+)$/.exec(sub);
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
    const status =
      err.status !== undefined && [404, 409, 412, 428].includes(err.status)
        ? err.status
        : err.status! >= 500
          ? 502
          : 400;
    ctx.writeJson(res, status, { error: gatewayMessage(err), code: err.code, issuer: err.issuer });
  }
}
