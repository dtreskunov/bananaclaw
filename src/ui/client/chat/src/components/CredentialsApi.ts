import { isOAuthScope, type OAuthAppConfiguration } from '../../../../shared/oauth-app';
export type { OAuthAppConfiguration, OAuthScopeOptions } from '../../../../shared/oauth-app';

export interface Service {
  name: string;
  host: string;
  path?: string;
  https_only?: boolean;
  enabled?: boolean;
  auth: {
    type: string;
    token?: string;
    username?: string;
    password?: string;
    key?: string;
    header?: string;
    prefix?: string;
    headers?: Record<string, string>;
  };
  substitutions?: { key: string; placeholder: string; in?: string[] }[];
}

export interface Connection {
  id: string;
  label: string;
  kind: 'static' | 'mcp_oauth' | 'oauth_app';
  status: 'ready' | 'draft' | 'needs_reconnect' | 'disabled';
  revision: string;
  owner: { id: string; label?: string };
  services: Service[];
  credentials: string[];
  grants: { vault: string; services: string[]; status: 'active' | 'suspended' }[];
  resource_url?: string;
  app_id?: string;
  requested_scopes?: string[] | null;
  granted_scopes?: string[] | null;
  scope_source?: string;
  account?: string | null;
}

export type OAuthAppScope = 'user' | 'install';
export interface AppInfo extends OAuthAppConfiguration {
  id: string;
  source: OAuthAppScope;
  client_secret_set: boolean;
  accounts?: number;
  accounts_all_vaults?: number;
}
export interface CredentialGroup {
  id: string;
  name: string;
  canAdmin: boolean;
}
export interface CredentialsOverview {
  connections: Connection[];
  groups: CredentialGroup[];
  apps: AppInfo[];
  canEditInstall: boolean;
}
export interface AccessGrant {
  connection_id: string;
  label: string;
  owner: { id: string; label?: string };
  services: Service[];
  status: string;
}
export interface SignInInput {
  resource_url?: string;
  app_id?: string;
  scopes?: string[];
}
export interface SignInStart {
  state: string;
  authorizeUrl: string;
  label: string;
}
export interface SignInProgress {
  status: 'pending' | 'connected' | 'failed';
  connection_id?: string;
  account?: string | null;
  error?: string;
}
export interface OAuthCompleteMessage {
  type: 'nanoclaw-oauth-complete';
  state: string;
  status: 'connected' | 'failed';
}

export function credentialsPath(sub = ''): string {
  return `/ui/chat/api/credentials${sub}`;
}
export function connectionPath(id: string, sub = ''): string {
  return credentialsPath(`/connections/${encodeURIComponent(id)}${sub}`);
}
export function accessPath(gid: string, connectionId?: string): string {
  return `/ui/chat/api/groups/${encodeURIComponent(gid)}/admin/access${connectionId ? `/${encodeURIComponent(connectionId)}` : ''}`;
}

export class CredentialsError extends Error {
  constructor(
    message: string,
    public readonly status = 0,
  ) {
    super(message);
  }
}

/** Boundary errors are displayed verbatim, but request bodies/secret values are never logged. */
export async function credentialRequest<T>(
  url: string,
  method = 'GET',
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetch(url, {
    method,
    credentials: 'same-origin',
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal,
  });
  const text = await response.text();
  let data: unknown;
  try {
    data = text ? JSON.parse(text) : null;
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    throw new CredentialsError(
      response.ok
        ? `The credentials server returned invalid JSON (HTTP ${response.status}).`
        : `The credentials request failed (HTTP ${response.status}). Refresh and try again.`,
      response.status,
    );
  }
  if (!response.ok) {
    const message = isRecord(data) && typeof data.error === 'string' ? data.error : `HTTP ${response.status}`;
    throw new CredentialsError(message, response.status);
  }
  return data as T;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Unexpected credentials error. Please refresh and try again.';
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
const KEY = /^[A-Za-z_][A-Za-z0-9_.-]*$/;

/** The JSON editor accepts references only; real values belong in password fields. */
export function parseServices(text: string): Service[] {
  const parsed: unknown = JSON.parse(text);
  if (!Array.isArray(parsed) || !parsed.length)
    throw new CredentialsError('Provide at least one service in a JSON array.');
  const names = new Set<string>();
  for (const service of parsed) {
    if (
      !isRecord(service) ||
      typeof service.name !== 'string' ||
      !service.name.trim() ||
      typeof service.host !== 'string' ||
      !service.host.trim() ||
      !isRecord(service.auth) ||
      typeof service.auth.type !== 'string'
    )
      throw new CredentialsError('Every service needs a name, host and auth.type.');
    if (names.has(service.name)) throw new CredentialsError(`Duplicate service name: ${service.name}`);
    names.add(service.name);
    if (service.path !== undefined && typeof service.path !== 'string')
      throw new CredentialsError('Service path must be a string.');
    for (const field of ['enabled', 'https_only']) {
      if (service[field] !== undefined && typeof service[field] !== 'boolean')
        throw new CredentialsError(`${field} must be true or false.`);
    }
    for (const field of ['header', 'prefix']) {
      if (service.auth[field] !== undefined && typeof service.auth[field] !== 'string')
        throw new CredentialsError(`auth.${field} must be a string.`);
    }
    for (const field of ['token', 'username', 'password', 'key']) {
      const ref = service.auth[field];
      if (ref !== undefined && (typeof ref !== 'string' || !KEY.test(ref)))
        throw new CredentialsError(`auth.${field} must be a key NAME, not a value or template.`);
    }
    if (
      service.auth.headers !== undefined &&
      (!isRecord(service.auth.headers) ||
        Object.values(service.auth.headers).some(
          (ref) => typeof ref !== 'string' || !/\{\{\s*[\w.-]+\s*\}\}/.test(ref),
        ))
    )
      throw new CredentialsError(
        'auth.headers values must be templates referencing key names, for example Bearer {{ API_TOKEN }}.',
      );
    if (
      service.substitutions !== undefined &&
      (!Array.isArray(service.substitutions) ||
        service.substitutions.some(
          (sub) =>
            !isRecord(sub) ||
            typeof sub.key !== 'string' ||
            !KEY.test(sub.key) ||
            typeof sub.placeholder !== 'string' ||
            !sub.placeholder ||
            (sub.in !== undefined && (!Array.isArray(sub.in) || sub.in.some((value) => typeof value !== 'string'))),
        ))
    )
      throw new CredentialsError('Every substitution needs a key NAME and placeholder.');
  }
  return parsed as Service[];
}

export function serviceKeys(services: Service[]): string[] {
  return [
    ...new Set(
      services
        .flatMap((service) => [
          service.auth.token,
          service.auth.username,
          service.auth.password,
          service.auth.key,
          ...Object.values(service.auth.headers ?? {}).flatMap((template) =>
            [...template.matchAll(/\{\{\s*([\w.-]+)\s*\}\}/g)].map((match) => match[1]),
          ),
          ...(service.substitutions ?? []).map((sub) => sub.key),
        ])
        .filter((value): value is string => !!value),
    ),
  ];
}

export function providedValues(values: Record<string, string>, names: string[]): Record<string, string> {
  return Object.fromEntries(
    names.filter((name) => values[name] !== undefined && values[name] !== '').map((name) => [name, values[name]]),
  );
}

export const SERVICE_PRESETS: { label: string; services: Service[] }[] = [
  {
    label: 'Bearer token',
    services: [
      { name: 'api', host: 'api.example.com', https_only: true, auth: { type: 'bearer', token: 'API_TOKEN' } },
    ],
  },
  {
    label: 'Named API key header',
    services: [
      {
        name: 'api',
        host: 'api.example.com',
        https_only: true,
        auth: { type: 'api-key', header: 'X-Api-Key', key: 'API_KEY' },
      },
    ],
  },
  {
    label: 'Basic username + password',
    services: [
      {
        name: 'api',
        host: 'api.example.com',
        https_only: true,
        auth: { type: 'basic', username: 'USERNAME', password: 'PASSWORD' },
      },
    ],
  },
  {
    label: 'Multiple headers',
    services: [
      {
        name: 'api',
        host: 'api.example.com',
        https_only: true,
        auth: { type: 'custom', headers: { 'X-Api-Key': '{{ API_KEY }}', 'X-Api-Secret': '{{ API_SECRET }}' } },
      },
    ],
  },
  {
    label: 'Query placeholder',
    services: [
      {
        name: 'api',
        host: 'api.example.com',
        https_only: true,
        auth: { type: 'passthrough' },
        substitutions: [{ key: 'API_KEY', placeholder: '__API_KEY__', in: ['query'] }],
      },
    ],
  },
];

export function appConfiguration(app: AppInfo): OAuthAppConfiguration {
  return {
    label: app.label,
    issuer: app.issuer,
    client_id: app.client_id,
    authorization_endpoint: app.authorization_endpoint,
    token_endpoint: app.token_endpoint,
    token_endpoint_auth_method: app.token_endpoint_auth_method,
    api_hosts: app.api_hosts,
    default_scopes: app.default_scopes,
    authorization_params: app.authorization_params,
    revocation_endpoint: app.revocation_endpoint,
    identity: app.identity,
    jwks_uri: app.jwks_uri,
    token_scope_separator: app.token_scope_separator,
  };
}

export function validateAppConfiguration(config: OAuthAppConfiguration): OAuthAppConfiguration {
  if (
    !isRecord(config) ||
    typeof config.label !== 'string' ||
    !config.label.trim() ||
    typeof config.client_id !== 'string' ||
    !config.client_id.trim() ||
    typeof config.issuer !== 'string' ||
    !config.issuer.trim() ||
    !Array.isArray(config.api_hosts) ||
    !config.api_hosts.length ||
    config.api_hosts.some((v) => typeof v !== 'string') ||
    !Array.isArray(config.default_scopes) ||
    config.default_scopes.some((v) => typeof v !== 'string')
  )
    throw new CredentialsError('Enter an app name, issuer URL, client ID and at least one API host.');
  if (!config.default_scopes.every(isOAuthScope))
    throw new CredentialsError('Enter valid individual OAuth scope values without quotes or backslashes.');
  if (
    !['none', 'client_secret_post', 'client_secret_basic'].includes(String(config.token_endpoint_auth_method)) ||
    !['none', 'oidc', 'google', 'github'].includes(String(config.identity)) ||
    !['space', 'comma'].includes(String(config.token_scope_separator))
  )
    throw new CredentialsError(
      'Choose a supported client authentication method, identity verifier and scope separator.',
    );
  for (const field of ['authorization_endpoint', 'token_endpoint', 'revocation_endpoint', 'jwks_uri']) {
    if (config[field] !== undefined && typeof config[field] !== 'string')
      throw new CredentialsError(`${field} must be a URL string.`);
  }
  if (
    config.authorization_params !== undefined &&
    (!isRecord(config.authorization_params) ||
      Object.values(config.authorization_params).some((value) => typeof value !== 'string'))
  )
    throw new CredentialsError('authorization_params must map parameter names to string values.');
  const secretFields = (value: unknown): boolean =>
    isRecord(value) &&
    Object.entries(value).some(
      ([key, child]) => /secret|password|access_token|refresh_token/i.test(key) || secretFields(child),
    );
  if (secretFields(config)) throw new CredentialsError('Put the client secret only in the separate password field.');
  return config;
}
