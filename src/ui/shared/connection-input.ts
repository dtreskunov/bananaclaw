import { isOAuthScope } from './oauth-app.js';
import { AccessAuthenticationError, parseAccessAuthentication } from './access-authentication.js';
import type { AccountRequirements } from './approval.js';

export class ConnectionInputError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

export function objectBody(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new ConnectionInputError('Provide a JSON object');
  return value as Record<string, unknown>;
}

export function accessRequestInput(raw: unknown): AccountRequirements {
  const body = objectBody(raw);
  if (
    Object.keys(body).some((key) => !['resource_url', 'reason', 'scopes', 'mcp_server', 'authentication'].includes(key))
  )
    throw new ConnectionInputError(
      'Access requests accept only resource_url, reason, optional scopes and an optional mcp_server name. Never supply secrets.',
    );
  const url = typeof body.resource_url === 'string' ? URL.parse(body.resource_url) : null;
  let authentication;
  try {
    authentication = parseAccessAuthentication(body.authentication);
  } catch (error) {
    if (!(error instanceof AccessAuthenticationError)) throw error;
    throw new ConnectionInputError(error.message);
  }
  if (
    body.mcp_server !== undefined &&
    (typeof body.mcp_server !== 'string' || !/^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/.test(body.mcp_server))
  )
    throw new ConnectionInputError('Select an existing named MCP server.');
  if (
    !url ||
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.href.length > 2048 ||
    [...String(body.resource_url)].some((char) => char.charCodeAt(0) <= 32 || char === '*')
  )
    throw new ConnectionInputError(
      'Provide an exact HTTPS destination without credentials, query, fragment or wildcard.',
    );
  if (
    typeof body.reason !== 'string' ||
    !body.reason.trim() ||
    body.reason.length > 1000 ||
    [...body.reason].some((char) => char.charCodeAt(0) < 32 && !['\t', '\n', '\r'].includes(char))
  )
    throw new ConnectionInputError('Explain the access needed in at most 1000 characters; do not include credentials.');
  if (
    body.scopes !== undefined &&
    (!Array.isArray(body.scopes) ||
      body.scopes.length > 64 ||
      !body.scopes.every((scope) => isOAuthScope(scope) && scope.length <= 2048))
  )
    throw new ConnectionInputError('Provide valid scope suggestions, never tokens.');
  if (
    Array.isArray(body.scopes) &&
    body.scopes.length &&
    authentication &&
    !['mcp_oauth', 'oauth_app', 'bearer'].includes(authentication.type)
  )
    throw new ConnectionInputError('OAuth scope suggestions require an OAuth or bearer authentication request.');
  return {
    resource_url: url.href,
    reason: body.reason.trim(),
    ...(authentication ? { authentication } : {}),
    ...(body.mcp_server === undefined ? {} : { mcp_server: body.mcp_server as string }),
    ...(body.scopes === undefined ? {} : { scopes: [...new Set(body.scopes as string[])].sort() }),
  };
}
