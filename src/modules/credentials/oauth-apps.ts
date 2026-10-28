import { deleteApp, listConfiguredApps, putApp, type AppInfo, type McpAccountInfo } from './gateway-credentials.js';
import type { OAuthAppConfiguration, OAuthAppInput } from '../../ui/shared/oauth-app.js';

export class AppInputError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 403 | 404 = 400,
  ) {
    super(message);
  }
}

export type AppScope = 'group' | 'install';

export interface OAuthClientDto {
  clientId: string;
  clientSecretSet: boolean;
  config: OAuthAppConfiguration;
  updatedAt: string;
  accounts: number;
  accountsAllGroups?: number;
}

export interface OAuthAppDto {
  id: string;
  label: string;
  install: OAuthClientDto | null;
  group: OAuthClientDto | null;
  overridesInstall: boolean;
}

function toClient(app: AppInfo, accounts: McpAccountInfo[], includeAll: boolean): OAuthClientDto {
  const {
    id,
    source,
    overrides_install,
    client_secret_set,
    updated_at,
    accounts: _count,
    accounts_all_vaults,
    ...config
  } = app;
  return {
    clientId: app.client_id,
    clientSecretSet: client_secret_set,
    config,
    updatedAt: updated_at,
    accounts: accounts.filter((a) => a.app_id === id && a.app_source === source).length,
    ...(includeAll && accounts_all_vaults !== undefined ? { accountsAllGroups: accounts_all_vaults } : {}),
  };
}

export async function listApps(
  gid: string,
  accounts: McpAccountInfo[],
  canEditInstall: boolean,
): Promise<OAuthAppDto[]> {
  const [effective, installed] = await Promise.all([
    listConfiguredApps(gid),
    canEditInstall ? listConfiguredApps(null) : Promise.resolve([]),
  ]);
  const byId = new Map<string, OAuthAppDto>();
  for (const app of installed) {
    byId.set(app.id, {
      id: app.id,
      label: app.label,
      install: toClient(app, accounts, true),
      group: null,
      overridesInstall: false,
    });
  }
  for (const app of effective) {
    const item = byId.get(app.id) ?? {
      id: app.id,
      label: app.label,
      install: null,
      group: null,
      overridesInstall: app.overrides_install,
    };
    item.label = app.label;
    item.overridesInstall = app.overrides_install;
    if (app.source === 'vault') item.group = toClient(app, accounts, false);
    else if (!item.install) item.install = toClient(app, accounts, false);
    byId.set(app.id, item);
  }
  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
}

export interface SaveAppInput {
  scope?: unknown;
  config?: unknown;
  clientSecret?: unknown;
}

const APP_FIELDS = new Set([
  'label',
  'issuer',
  'client_id',
  'authorization_endpoint',
  'token_endpoint',
  'token_endpoint_auth_method',
  'api_hosts',
  'default_scopes',
  'authorization_params',
  'revocation_endpoint',
  'identity',
  'jwks_uri',
  'token_scope_separator',
]);

export async function saveApp(
  gid: string,
  appId: string,
  input: SaveAppInput,
  canEditInstall: boolean,
): Promise<{ scope: AppScope; clientId: string; secretChanged: boolean }> {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new AppInputError('App input must be an object');
  const scope = checkScope(input.scope, canEditInstall);
  if (!/^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/.test(appId)) {
    throw new AppInputError('App ID must be a canonical 3–64 character slug');
  }
  if (!input.config || typeof input.config !== 'object' || Array.isArray(input.config)) {
    throw new AppInputError('OAuth configuration must be a JSON object');
  }
  for (const key of Object.keys(input.config)) {
    if (!APP_FIELDS.has(key)) throw new AppInputError(`Unsupported OAuth configuration field: ${key}`);
  }
  const config: OAuthAppInput = { ...input.config };
  if (input.clientSecret !== undefined && input.clientSecret !== '') {
    if (
      typeof input.clientSecret !== 'string' ||
      /[\r\n\0]/.test(input.clientSecret) ||
      Buffer.byteLength(input.clientSecret) > 4096
    ) {
      throw new AppInputError('Enter a client secret on one line, up to 4096 bytes');
    }
    config.client_secret = input.clientSecret;
  }
  const saved = await putApp(scope === 'install' ? null : gid, appId, config);
  return { scope, clientId: saved.client_id, secretChanged: config.client_secret !== undefined };
}

export async function removeApp(
  gid: string,
  appId: string,
  rawScope: unknown,
  canEditInstall: boolean,
): Promise<AppScope> {
  const scope = checkScope(rawScope, canEditInstall);
  await deleteApp(scope === 'install' ? null : gid, appId);
  return scope;
}

function checkScope(raw: unknown, canEditInstall: boolean): AppScope {
  const scope = raw === undefined ? 'group' : raw;
  if (scope !== 'group' && scope !== 'install') throw new AppInputError('scope must be "group" or "install"');
  if (scope === 'install' && !canEditInstall)
    throw new AppInputError('Only owners and global admins can change install-wide OAuth apps', 403);
  return scope;
}
