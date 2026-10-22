/**
 * Group settings → Credentials routes (`…/admin/credentials/*`), backed by
 * the Agent Vault gateway. Mounted by group-admin.ts behind its admin gate.
 *
 * R1 P2 scope: MCP sign-in with per-group dynamic registration, plus a
 * read-only view of the group's keys. Key edits and OAuth apps answer 501
 * until their phases land. Values never appear in any response.
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
  forgetProbes,
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
  kind: 'mcp_oauth';
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

async function overview(ctx: CredentialsRouteContext): Promise<unknown> {
  const { gid } = ctx;
  const [services, credentials, accounts] = await Promise.all([
    listServices(gid),
    listCredentials(gid),
    listMcpAccounts(gid),
  ]);
  const servers = httpServers(ctx.mcpServers);
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
    canEditInstall: isOwner(ctx.actorUserId) || isGlobalAdmin(ctx.actorUserId),
    keysEditable: false,
    keys,
    accounts: accounts.map((a) => toAccount(a, servers)),
    oauthApps: [],
    oauthRedirectUri: oauthRedirectUri(),
    presets: [],
    mcp,
  };
}

const MAX_CLIENT_NAME = 100;

/** The group's name as the OAuth client name, within the gateway's limits. */
export function clientNameFor(gid: string): string | undefined {
  // eslint-disable-next-line no-control-regex
  const name = (getAgentGroup(gid)?.name ?? '').replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').trim();
  return name ? [...name].slice(0, MAX_CLIENT_NAME).join('') : undefined;
}

async function startSignIn(ctx: CredentialsRouteContext): Promise<void> {
  const body = (await ctx.readJsonBody(ctx.req)) as { mcpServer?: unknown; provider?: unknown };
  if (typeof body.mcpServer !== 'string') {
    ctx.writeJson(ctx.res, 501, { error: 'Connecting provider accounts arrives with OAuth apps in a later update' });
    return;
  }
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
  if (!key.startsWith('MCP_')) {
    ctx.writeJson(ctx.res, 501, { error: 'Only MCP sign-ins can be disconnected here for now' });
    return;
  }
  await disconnectMcp(ctx.gid, key);
  forgetProbes(ctx.gid);
  recordAdminAction({
    actorUserId: ctx.actorUserId,
    action: 'group_mcp_sign_in_disconnect',
    targetKind: 'agent_group',
    targetId: ctx.gid,
    payload: { key },
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
    if (/^\/keys(\/|$)/.test(sub) || /^\/oauth-apps(\/|$)/.test(sub)) {
      ctx.writeJson(res, 501, { error: 'Changing this here arrives in a later update' });
      return;
    }
    ctx.writeJson(res, 404, { error: 'not_found' });
  } catch (err) {
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
