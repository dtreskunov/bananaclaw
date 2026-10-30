import { getAgentGroup } from '../../db/agent-groups.js';
import { hasAdminPrivilege, isGlobalAdmin, isOwner } from '../permissions/db/user-roles.js';
import { getUser } from '../permissions/db/users.js';
import { getBranding } from '../../ui/server/branding.js';
import { isOAuthScope, type OAuthScopeOptions } from '../../ui/shared/oauth-app.js';
import { AgentVaultError, gatewayJson, type GatewayRequestOptions } from './agent-vault-client.js';
import { synchronizeManagedUser } from './managed-users.js';
import type { GatewayService, AppInfo } from './gateway-credentials.js';
import { recordSignIn } from './sign-ins.js';

export interface ConnectionGrant {
  vault: string;
  services: string[];
  status: 'active' | 'suspended';
}

export interface SharedConnection {
  id: string;
  label: string;
  kind: 'static' | 'mcp_oauth' | 'oauth_app';
  status: 'ready' | 'draft' | 'needs_reconnect' | 'disabled';
  revision: string;
  owner: { id: string; label?: string };
  services: GatewayService[];
  credentials: string[];
  grants: ConnectionGrant[];
  resource_url?: string;
  app_id?: string;
  requested_scopes?: string[] | null;
  granted_scopes?: string[] | null;
  scope_source?: string;
  account?: string | null;
}

export interface SharedAccessGrant {
  connection_id: string;
  label: string;
  owner: { id: string; label?: string };
  services: GatewayService[];
  status: string;
}

export interface ConnectionApp extends Omit<AppInfo, 'source'> {
  source: 'install' | 'user';
}

export class ConnectionInputError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

function requireUser(userId: string) {
  const user = getUser(userId);
  if (!user) throw new ConnectionInputError('Unknown credential owner', 403);
  return user;
}

export function requireGroupAdmin(userId: string, groupId: string): void {
  requireUser(userId);
  if (!getAgentGroup(groupId)) throw new ConnectionInputError('Agent group not found', 404);
  if (!hasAdminPrivilege(userId, groupId)) throw new ConnectionInputError('Group administrator required', 403);
}

function id(value: string): string {
  if (!value || value.length > 200 || [...value].some((char) => char.charCodeAt(0) < 32))
    throw new ConnectionInputError('Invalid connection identifier');
  return encodeURIComponent(value);
}

export function connectionRevision(value: unknown): string {
  if (typeof value !== 'string' || !/^"[a-f0-9]{64}"$/.test(value))
    throw new ConnectionInputError('Refresh connection metadata and supply its exact revision');
  return value;
}

export function objectBody(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new ConnectionInputError('Provide a JSON object');
  return value as Record<string, unknown>;
}

function fields(body: Record<string, unknown>, allowed: string[]): void {
  if (Object.keys(body).some((key) => !allowed.includes(key)))
    throw new ConnectionInputError('Unsupported credential field');
}

function safeValues(value: unknown): void {
  if (value === undefined) return;
  const values = objectBody(value);
  if (!Object.keys(values).length || Object.keys(values).length > 64)
    throw new ConnectionInputError('Supply between 1 and 64 credential values');
  for (const [key, secret] of Object.entries(values)) {
    if (
      !/^[A-Z][A-Z0-9_]*$/.test(key) ||
      typeof secret !== 'string' ||
      !secret ||
      Buffer.byteLength(secret) > 16384 ||
      ['\r', '\n', '\0'].some((char) => secret.includes(char))
    )
      throw new ConnectionInputError('Invalid credential name or value');
  }
}

function safeServices(value: unknown): void {
  if (value === undefined) return;
  if (!Array.isArray(value) || !value.length || value.length > 32)
    throw new ConnectionInputError('Provide between 1 and 32 connection services');
  for (const service of value) {
    const row = objectBody(service);
    if (typeof row.name !== 'string' || typeof row.host !== 'string' || !row.auth)
      throw new ConnectionInputError('Each service needs a name, destination and authentication recipe');
  }
}

function scopeList(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || !value.every(isOAuthScope))
    throw new ConnectionInputError('Scopes must be individual nonempty OAuth scope strings');
  return [...new Set(value)].sort();
}

async function userRequest<T>(
  userId: string,
  method: string,
  suffix: string,
  opts: GatewayRequestOptions = {},
): Promise<{ data: T; ownerId: string }> {
  requireUser(userId);
  const user = await synchronizeManagedUser(userId);
  requireUser(userId);
  const data = await gatewayJson<T>(
    method,
    `/v1/managed-users/${id(user.id)}${suffix}`,
    'shared credential operation',
    opts,
  );
  return { data, ownerId: user.id };
}

function connectionResult(connection: SharedConnection, ownerId: string): SharedConnection {
  if (
    !connection ||
    typeof connection.id !== 'string' ||
    typeof connection.label !== 'string' ||
    !['static', 'mcp_oauth', 'oauth_app'].includes(connection.kind) ||
    !['ready', 'draft', 'needs_reconnect', 'disabled'].includes(connection.status) ||
    typeof connection.revision !== 'string' ||
    !connection.owner ||
    typeof connection.owner.id !== 'string' ||
    !Array.isArray(connection.services) ||
    !Array.isArray(connection.credentials) ||
    !Array.isArray(connection.grants)
  )
    throw new AgentVaultError('Gateway returned invalid connection metadata', 502);
  if (connection.owner.id !== ownerId)
    throw new AgentVaultError(
      'Gateway returned a connection outside your personal library',
      502,
      'connection_owner_mismatch',
    );
  return {
    id: connection.id,
    label: connection.label,
    kind: connection.kind,
    status: connection.status,
    revision: connection.revision,
    owner: connection.owner,
    services: connection.services,
    credentials: connection.credentials,
    grants: connection.grants,
    ...(connection.resource_url === undefined ? {} : { resource_url: connection.resource_url }),
    ...(connection.app_id === undefined ? {} : { app_id: connection.app_id }),
    ...(connection.requested_scopes === undefined ? {} : { requested_scopes: connection.requested_scopes }),
    ...(connection.granted_scopes === undefined ? {} : { granted_scopes: connection.granted_scopes }),
    ...(connection.scope_source === undefined ? {} : { scope_source: connection.scope_source }),
    ...(connection.account === undefined ? {} : { account: connection.account }),
  };
}

export async function listConnections(userId: string): Promise<SharedConnection[]> {
  const { data, ownerId } = await userRequest<{ connections: SharedConnection[] }>(userId, 'GET', '/connections');
  if (!Array.isArray(data?.connections)) throw new AgentVaultError('Gateway returned invalid connection list', 502);
  return data.connections.map((connection) => connectionResult(connection, ownerId));
}

export function getConnection(userId: string, connectionId: string): Promise<SharedConnection> {
  return userRequest<SharedConnection>(userId, 'GET', `/connections/${id(connectionId)}`).then(({ data, ownerId }) =>
    connectionResult(data, ownerId),
  );
}

export function createConnection(userId: string, raw: unknown): Promise<SharedConnection> {
  const body = objectBody(raw);
  fields(body, ['label', 'kind', 'services', 'values', 'resource_url', 'app_id', 'scopes']);
  if (typeof body.label !== 'string' || !body.label.trim() || body.label.length > 120)
    throw new ConnectionInputError('Provide a connection label of at most 120 characters');
  if (!['static', 'mcp_oauth', 'oauth_app'].includes(String(body.kind)))
    throw new ConnectionInputError('Unsupported connection kind');
  safeValues(body.values);
  safeServices(body.services);
  if (body.scopes !== undefined) body.scopes = scopeList(body.scopes);
  if (body.kind === 'static' && (!body.services || !body.values))
    throw new ConnectionInputError('A static connection needs services and credential values');
  return userRequest<SharedConnection>(userId, 'POST', '/connections', { body }).then(({ data, ownerId }) =>
    connectionResult(data, ownerId),
  );
}

export function updateConnection(userId: string, connectionId: string, raw: unknown): Promise<SharedConnection> {
  const body = objectBody(raw);
  fields(body, ['label', 'enabled', 'services', 'values', 'revision']);
  const { revision, ...update } = body;
  if (
    update.label !== undefined &&
    (typeof update.label !== 'string' || !update.label.trim() || update.label.length > 120)
  )
    throw new ConnectionInputError('Invalid connection label');
  if (update.enabled !== undefined && typeof update.enabled !== 'boolean')
    throw new ConnectionInputError('Enabled must be a boolean');
  safeValues(update.values);
  safeServices(update.services);
  return userRequest<SharedConnection>(userId, 'PUT', `/connections/${id(connectionId)}`, {
    body: update,
    ifMatch: connectionRevision(revision),
  }).then(({ data, ownerId }) => connectionResult(data, ownerId));
}

export async function deleteConnection(userId: string, connectionId: string, revision: unknown): Promise<void> {
  await userRequest(userId, 'DELETE', `/connections/${id(connectionId)}`, {
    ifMatch: connectionRevision(revision),
    timeoutMs: 30000,
  });
}

export async function grantConnection(
  userId: string,
  connectionId: string,
  groupId: string,
  raw: unknown,
): Promise<unknown> {
  requireGroupAdmin(userId, groupId);
  const body = objectBody(raw);
  fields(body, ['services', 'revision']);
  if (
    !Array.isArray(body.services) ||
    !body.services.length ||
    !body.services.every((service) => typeof service === 'string' && service.length > 0) ||
    new Set(body.services).size !== body.services.length
  )
    throw new ConnectionInputError('Select distinct connection services');
  return userRequest<SharedConnection>(userId, 'PUT', `/connections/${id(connectionId)}/grants/${id(groupId)}`, {
    body: { services: body.services },
    ...(body.revision === undefined ? { ifNoneMatch: '*' as const } : { ifMatch: connectionRevision(body.revision) }),
  }).then(({ data, ownerId }) => connectionResult(data, ownerId));
}

export async function detachConnection(userId: string, connectionId: string, groupId: string): Promise<void> {
  requireGroupAdmin(userId, groupId);
  await userRequest(userId, 'DELETE', `/vaults/${id(groupId)}/access/${id(connectionId)}`);
}

export async function revokeConnectionGrant(userId: string, connectionId: string, groupId: string): Promise<void> {
  await userRequest(userId, 'DELETE', `/connections/${id(connectionId)}/grants/${id(groupId)}`);
}

export async function groupConnectionAccess(userId: string, groupId: string): Promise<SharedAccessGrant[]> {
  requireGroupAdmin(userId, groupId);
  const { data, ownerId } = await userRequest<{ grants: SharedAccessGrant[] }>(
    userId,
    'GET',
    `/vaults/${id(groupId)}/access`,
  );
  if (!Array.isArray(data?.grants) || data.grants.some((grant) => !grant || typeof grant.owner?.id !== 'string'))
    throw new AgentVaultError('Gateway returned invalid connection access metadata', 502);
  return data.grants.filter((grant) => grant.owner.id === ownerId);
}

export async function startConnectionSignIn(userId: string, connectionId: string, raw: unknown) {
  const body = objectBody(raw);
  fields(body, ['resource_url', 'app_id', 'scopes']);
  if (body.scopes !== undefined) body.scopes = scopeList(body.scopes);
  const user = await synchronizeManagedUser(userId);
  const connection = await getConnection(userId, connectionId);
  if (connection.kind === 'static') throw new ConnectionInputError('Static connections do not use OAuth sign-in');
  const profile = requireUser(userId);
  const brand = getBranding().name.trim();
  const name = profile.display_name?.trim();
  const clientName = name ? `${brand} (${name})` : brand;
  if (!brand || [...clientName].length > 100 || /\p{Cc}/u.test(clientName))
    throw new ConnectionInputError(
      'The app and profile display names must form an OAuth client name of at most 100 characters without control characters',
    );
  const result = await gatewayJson<{ state: string; authorize_url: string }>(
    'POST',
    `/v1/managed-users/${id(user.id)}/connections/${id(connectionId)}/oauth/start`,
    'connection sign-in',
    { body: { ...body, client_name: clientName }, timeoutMs: 30000 },
  );
  const authorize = URL.parse(result.authorize_url);
  if (!authorize || authorize.protocol !== 'https:' || authorize.username || authorize.password)
    throw new ConnectionInputError('Gateway returned an invalid authorization URL', 502);
  recordSignIn({
    state: result.state,
    userId,
    managedUserId: user.id,
    connectionId: connection.id,
    label: connection.label,
  });
  return { state: result.state, authorizeUrl: result.authorize_url, label: connection.label };
}

export async function discoverConnectionScopes(userId: string, raw: unknown): Promise<OAuthScopeOptions> {
  const body = objectBody(raw);
  fields(body, ['resource_url', 'app_id', 'issuer']);
  if (
    (!body.resource_url && !body.app_id && !body.issuer) ||
    (body.resource_url !== undefined &&
      (typeof body.resource_url !== 'string' || !body.resource_url.trim() || body.resource_url.length > 4096)) ||
    (body.app_id !== undefined &&
      (typeof body.app_id !== 'string' || !body.app_id.trim() || body.app_id.length > 200)) ||
    (body.issuer !== undefined &&
      (typeof body.issuer !== 'string' || !body.issuer.trim() || body.issuer.length > 4096)) ||
    (body.issuer && (body.resource_url || body.app_id))
  )
    throw new ConnectionInputError('Provide an MCP resource URL, OAuth app or a separate issuer');
  const { data } = await userRequest<OAuthScopeOptions>(userId, 'POST', '/oauth/scopes', { body, timeoutMs: 30000 });
  if (
    !data ||
    !Array.isArray(data.scopes) ||
    !data.scopes.every(isOAuthScope) ||
    !['resource', 'authorization_server', 'not_advertised'].includes(data.source) ||
    typeof data.oauth !== 'boolean' ||
    (data.issuer !== undefined && typeof data.issuer !== 'string')
  )
    throw new AgentVaultError('Gateway returned invalid scope metadata', 502);
  return {
    scopes: data.scopes,
    source: data.source,
    oauth: data.oauth,
    ...(data.issuer ? { issuer: data.issuer } : {}),
  };
}

export async function listConnectionApps(userId: string): Promise<ConnectionApp[]> {
  return (await userRequest<{ items: ConnectionApp[] }>(userId, 'GET', '/oauth-apps')).data.items;
}

export async function changeConnectionApp(
  userId: string,
  appId: string,
  method: 'PUT' | 'DELETE',
  scope: string,
  raw?: unknown,
): Promise<unknown> {
  requireUser(userId);
  if (!['user', 'install'].includes(scope)) throw new ConnectionInputError('App scope must be user or install');
  if (scope === 'install' && !isOwner(userId) && !isGlobalAdmin(userId))
    throw new ConnectionInputError('Instance administrator required', 403);
  let body: Record<string, unknown> | undefined;
  if (method === 'PUT') {
    const input = objectBody(raw);
    fields(input, ['config', 'clientSecret']);
    body = { ...objectBody(input.config) };
    if ('client_secret' in body || 'owner' in body || 'user_id' in body)
      throw new ConnectionInputError('Use the separate write-only client secret field');
    if (input.clientSecret !== undefined && input.clientSecret !== '') {
      if (
        typeof input.clientSecret !== 'string' ||
        input.clientSecret.length > 4096 ||
        ['\r', '\n', '\0'].some((char) => String(input.clientSecret).includes(char))
      )
        throw new ConnectionInputError('Invalid client secret');
      body.client_secret = input.clientSecret;
    }
  }
  return (await userRequest(userId, method, `/oauth-apps/${id(appId)}?scope=${scope}`, { body })).data;
}
