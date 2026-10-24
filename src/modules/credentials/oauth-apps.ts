/**
 * OAuth apps (install-wide and per group) and provider accounts on the
 * Agent Vault gateway (fork change F11), in the shapes group settings →
 * Credentials uses. Shared by the settings routes and `ncl credentials`.
 *
 * Gateway API: Agent Vault fork `docs/guides/oauth-apps.mdx`.
 */
import {
  deleteApp,
  getApp,
  listProviderAccounts,
  listProviders,
  putApp,
  resourceId,
  type AppInfo,
  type McpAccountInfo,
  type ProviderInfo,
} from './gateway-credentials.js';

export class AppInputError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 403 | 404 = 400,
  ) {
    super(message);
  }
}

export type AppScope = 'group' | 'install';

/** Mirrors OAuthAppDto in src/ui/client/chat/src/components/GroupAdminCredentialsApi.ts. */
export interface OAuthAppDto {
  id: string;
  label: string;
  install: OAuthClientDto | null;
  group: OAuthClientDto | null;
  consoleUrl: string;
  scopeSets: { id: string; label: string; hosts: string[] }[];
  mcpServers?: string[];
}

export interface OAuthClientDto {
  clientId: string;
  updatedAt: string;
  accounts: number;
  accountsAllGroups?: number;
}

/** True for gateway errors meaning "this gateway build doesn't have the endpoint". */
function missingEndpoint(err: unknown): boolean {
  return (err as { status?: number }).status === 404 || (err as { status?: number }).status === 405;
}

/** The catalog, or [] on gateways that predate OAuth apps. */
export async function providersOrEmpty(): Promise<ProviderInfo[]> {
  try {
    return await listProviders();
  } catch (err) {
    if (missingEndpoint(err)) return [];
    throw err;
  }
}

/** Provider accounts, or [] on gateways that predate them. */
export async function providerAccountsOrEmpty(gid: string): Promise<McpAccountInfo[]> {
  try {
    return await listProviderAccounts(gid);
  } catch (err) {
    if (missingEndpoint(err)) return [];
    throw err;
  }
}

/** Accounts in this group that sign in through `provider`'s app: its provider accounts and MCP sign-ins on its servers. */
function accountsVia(provider: ProviderInfo, accounts: McpAccountInfo[]): number {
  const servers = new Set((provider.mcp_servers ?? []).map(resourceId));
  return accounts.filter(
    (a) =>
      (a.kind === 'oauth_app' && a.provider === provider.id) ||
      (a.client === 'app' && a.kind !== 'oauth_app' && servers.has(resourceId(a.resource_url))),
  ).length;
}

function toClient(app: AppInfo, accountsHere: number, all?: number): OAuthClientDto {
  const dto: OAuthClientDto = { clientId: app.client_id, updatedAt: app.updated_at, accounts: accountsHere };
  if (all !== undefined) dto.accountsAllGroups = all;
  return dto;
}

/**
 * Every catalog provider with the install-wide app, this group's own app and
 * how many accounts use each. `accounts` lists both MCP sign-ins and provider
 * accounts in the group; `groupServers` maps the group's MCP server names to URLs.
 */
export async function listApps(
  gid: string,
  providers: ProviderInfo[],
  accounts: McpAccountInfo[],
  groupServers: [string, string][],
): Promise<OAuthAppDto[]> {
  return Promise.all(
    providers.map(async (p): Promise<OAuthAppDto> => {
      const [install, group] = await Promise.all([getApp(null, p.id), getApp(gid, p.id)]);
      const here = accountsVia(p, accounts);
      const groupCount = group ? Math.min(group.accounts, here) : 0;
      const dto: OAuthAppDto = {
        id: p.id,
        label: p.label,
        install: install ? toClient(install, Math.max(0, here - groupCount), install.accounts_all_vaults) : null,
        group: group ? toClient(group, groupCount) : null,
        consoleUrl: p.console_url,
        scopeSets: p.scope_sets.map((s) => ({ id: s.id, label: s.label, hosts: s.hosts })),
      };
      const known = new Set((p.mcp_servers ?? []).map(resourceId));
      const names = groupServers.filter(([, url]) => known.has(resourceId(url))).map(([name]) => name);
      if (names.length) dto.mcpServers = names;
      return dto;
    }),
  );
}

const CLIENT_ID_RE = /^[\x21-\x7e]{1,256}$/;
const MAX_SECRET_BYTES = 4096;

export interface SaveAppInput {
  scope?: unknown;
  clientId?: unknown;
  clientSecret?: unknown;
}

/** Validates and stores an app; `canEditInstall` gates install-wide changes. */
export async function saveApp(
  gid: string,
  provider: string,
  input: SaveAppInput,
  canEditInstall: boolean,
): Promise<{ scope: AppScope; clientId: string; secretChanged: boolean }> {
  const scope = checkScope(input.scope, canEditInstall);
  if (!(await providersOrEmpty()).some((p) => p.id === provider))
    throw new AppInputError(`Unknown provider ${provider}`, 404);
  const clientId = typeof input.clientId === 'string' ? input.clientId.trim() : '';
  if (!CLIENT_ID_RE.test(clientId)) throw new AppInputError('Enter the client ID from the provider console');
  let clientSecret: string | undefined;
  if (input.clientSecret !== undefined && input.clientSecret !== '') {
    if (typeof input.clientSecret !== 'string' || /[\r\n\0]/.test(input.clientSecret)) {
      throw new AppInputError('Enter the client secret on one line');
    }
    if (Buffer.byteLength(input.clientSecret) > MAX_SECRET_BYTES)
      throw new AppInputError('The client secret is too long');
    clientSecret = input.clientSecret;
  }
  const target = scope === 'install' ? null : gid;
  const current = await getApp(target, provider);
  if (!clientSecret && (!current || current.client_id !== clientId)) {
    throw new AppInputError('A client secret is required for a new client ID');
  }
  await putApp(
    target,
    provider,
    clientSecret ? { client_id: clientId, client_secret: clientSecret } : { client_id: clientId },
  );
  return { scope, clientId, secretChanged: !!clientSecret };
}

export async function removeApp(
  gid: string,
  provider: string,
  rawScope: unknown,
  canEditInstall: boolean,
): Promise<AppScope> {
  const scope = checkScope(rawScope, canEditInstall);
  try {
    await deleteApp(scope === 'install' ? null : gid, provider);
  } catch (err) {
    if ((err as { status?: number }).status === 404)
      throw new AppInputError(`No ${scope === 'install' ? 'install-wide' : "group's own"} ${provider} app`, 404);
    throw err;
  }
  return scope;
}

function checkScope(raw: unknown, canEditInstall: boolean): AppScope {
  const scope = raw === undefined || raw === null || raw === '' ? 'group' : raw;
  if (scope !== 'group' && scope !== 'install') throw new AppInputError('scope must be "group" or "install"');
  if (scope === 'install' && !canEditInstall) {
    throw new AppInputError('Only owners and global admins can change install-wide OAuth apps', 403);
  }
  return scope;
}
