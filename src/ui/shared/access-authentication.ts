import { serviceMatchesResource, type ServiceDestination } from './credential-matching.js';

export type AccessAuthenticationType = 'mcp_oauth' | 'oauth_app' | 'bearer' | 'api-key' | 'basic' | 'custom';
export const ACCESS_AUTHENTICATION_LABELS: Record<AccessAuthenticationType, string> = {
  mcp_oauth: 'MCP OAuth',
  oauth_app: 'OAuth app',
  bearer: 'Bearer token',
  'api-key': 'API-key header',
  basic: 'Username and password',
  custom: 'Custom headers',
};
export interface AccessAuthenticationHint {
  type: AccessAuthenticationType;
  app_id?: string;
  header?: string;
  prefix?: string;
  /** Header names only. Values must be entered privately by the user. */
  headers?: string[];
}
export interface AccessRequirements {
  resource_url: string;
  scopes?: string[];
  mcp_server?: string;
  authentication?: AccessAuthenticationHint;
}
export class AccessAuthenticationError extends Error {}

const HEADER = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,128}$/;
function validHeader(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    HEADER.test(value) &&
    !['proxy-authorization', 'x-agentvault-binding'].includes(value.toLowerCase())
  );
}

export function parseAccessAuthentication(value: unknown): AccessAuthenticationHint | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new AccessAuthenticationError('Authentication hints must describe a mechanism, never credential values.');
  const hint = value as Record<string, unknown>;
  if (
    Object.keys(hint).some((key) => !['type', 'app_id', 'header', 'prefix', 'headers'].includes(key)) ||
    !['mcp_oauth', 'oauth_app', 'bearer', 'api-key', 'basic', 'custom'].includes(String(hint.type))
  )
    throw new AccessAuthenticationError(
      'Choose MCP OAuth, OAuth app, bearer, api-key, basic or custom authentication. Never include secrets.',
    );
  const type = hint.type as AccessAuthenticationType;
  const oauth = type === 'mcp_oauth' || type === 'oauth_app';
  if (
    hint.app_id !== undefined &&
    (!oauth || typeof hint.app_id !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(hint.app_id))
  )
    throw new AccessAuthenticationError(
      'An OAuth app suggestion must be a configured app identifier, not a credential or client secret.',
    );
  if ((hint.header !== undefined && type !== 'api-key') || (type === 'api-key' && !validHeader(hint.header)))
    throw new AccessAuthenticationError('API-key authentication requires a valid header name.');
  if (
    hint.prefix !== undefined &&
    (type !== 'api-key' ||
      typeof hint.prefix !== 'string' ||
      hint.prefix.length > 128 ||
      [...hint.prefix].some((char) => char < ' ' || char > '~'))
  )
    throw new AccessAuthenticationError('Provide only a public API-key header prefix without control characters.');
  if (
    (hint.headers !== undefined && type !== 'custom') ||
    (type === 'custom' &&
      (!Array.isArray(hint.headers) ||
        !hint.headers.length ||
        hint.headers.length > 16 ||
        !hint.headers.every(validHeader) ||
        new Set(hint.headers.map((header) => header.toLowerCase())).size !== hint.headers.length))
  )
    throw new AccessAuthenticationError(
      'Custom authentication requires distinct header names only, never header values.',
    );
  return {
    type,
    ...(hint.app_id === undefined ? {} : { app_id: hint.app_id as string }),
    ...(hint.header === undefined ? {} : { header: hint.header as string }),
    ...(hint.prefix === undefined ? {} : { prefix: hint.prefix as string }),
    ...(hint.headers === undefined ? {} : { headers: [...(hint.headers as string[])] }),
  };
}

interface AccessService extends ServiceDestination {
  auth: { type: string; header?: string; prefix?: string; headers?: Record<string, string> };
}
interface AccessConnection {
  kind: 'static' | 'mcp_oauth' | 'oauth_app';
  status: string;
  services: AccessService[];
  resource_url?: string;
  app_id?: string;
  requested_scopes?: string[] | null;
  granted_scopes?: string[] | null;
  scope_source?: string;
}

/** Conservative compatibility only; ownership, grants and provider acceptance are checked separately. */
export function connectionMatchesAccess(connection: AccessConnection, request: AccessRequirements): boolean {
  const destination = URL.parse(request.resource_url);
  if (!destination || destination.protocol !== 'https:') return false;
  const hint = request.authentication;
  const oauthHint = hint?.type === 'mcp_oauth' || hint?.type === 'oauth_app';
  if (oauthHint && connection.kind !== hint.type) return false;
  if (hint?.app_id && connection.app_id !== hint.app_id) return false;
  if (request.scopes?.length) {
    if (connection.kind === 'static') return false;
    const scopes =
      connection.status === 'ready'
        ? connection.scope_source === 'provider'
          ? connection.granted_scopes
          : null
        : connection.requested_scopes;
    if (!scopes || request.scopes.some((scope) => !scopes.includes(scope))) return false;
  }
  const services = connection.services.filter((service) => serviceMatchesResource(service, request.resource_url));
  if (!services.length) {
    return (
      connection.kind === 'mcp_oauth' &&
      connection.status !== 'ready' &&
      (!hint || oauthHint || hint.type === 'bearer') &&
      URL.parse(connection.resource_url ?? '')?.href === destination.href
    );
  }
  if (!hint || oauthHint) return true;
  return services.some((service) => {
    if (service.auth.type !== hint.type) return false;
    if (hint.type === 'api-key')
      return (
        service.auth.header?.toLowerCase() === hint.header?.toLowerCase() &&
        (hint.prefix === undefined || (service.auth.prefix ?? '') === hint.prefix)
      );
    if (hint.type === 'custom') {
      const headers = Object.keys(service.auth.headers ?? {}).map((header) => header.toLowerCase());
      return hint.headers?.every((header) => headers.includes(header.toLowerCase())) ?? false;
    }
    return true;
  });
}
