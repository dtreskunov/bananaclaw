import type { McpServerConfig } from './container-config.js';
import { getContainerConfig, updateContainerConfigJson } from './db/container-configs.js';
import { parseMcpAuthentication } from './ui/shared/mcp-authentication.js';

export class McpServerConfigError extends Error {}

function parseJson(value: string, flag: string): unknown {
  try {
    return JSON.parse(value);
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    throw new McpServerConfigError(`${flag} must contain valid JSON`);
  }
}

function stringMap(value: unknown, flag: string): Record<string, string> {
  const parsed = typeof value === 'string' ? parseJson(value, flag) : value;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    throw new McpServerConfigError(`${flag} must be a JSON object of strings`);
  return Object.fromEntries(
    Object.entries(parsed).map(([key, item]) => {
      if (typeof item !== 'string') throw new McpServerConfigError(`${flag} values must be strings`);
      return [key, item];
    }),
  );
}

function commandArgs(value: unknown): string[] {
  const parsed = typeof value === 'string' ? parseJson(value, '--args') : value;
  if (!Array.isArray(parsed) || !parsed.every((item): item is string => typeof item === 'string'))
    throw new McpServerConfigError('--args must be a JSON array of strings');
  return parsed;
}

export function parseMcpServerConfig(args: Record<string, unknown>, previous?: McpServerConfig): McpServerConfig {
  if (args.type !== undefined && args.transport !== undefined && args.type !== args.transport)
    throw new McpServerConfigError('--type and --transport must agree');
  const type = args.type ?? args.transport ?? 'stdio';
  if (type !== 'stdio' && type !== 'http' && type !== 'sse')
    throw new McpServerConfigError('--type must be stdio, http, or sse');
  if (args.instructions !== undefined && typeof args.instructions !== 'string')
    throw new McpServerConfigError('--instructions must be text');
  if (args.timeout !== undefined && typeof args.timeout !== 'string' && typeof args.timeout !== 'number')
    throw new McpServerConfigError('--timeout must be milliseconds');
  const timeout = args.timeout === undefined ? undefined : Number(args.timeout);
  if (timeout !== undefined && (!Number.isInteger(timeout) || timeout < 1000 || timeout > 600000))
    throw new McpServerConfigError('--timeout must be an integer between 1000 and 600000 milliseconds');
  const metadata = {
    ...(args.instructions === undefined ? {} : { instructions: args.instructions }),
    ...(timeout === undefined ? {} : { timeout }),
  };
  if (type === 'http' || type === 'sse') {
    if (args.command !== undefined || args.args !== undefined || args.env !== undefined)
      throw new McpServerConfigError('--command, --args, and --env are only valid for stdio');
    if (typeof args.url !== 'string' || !args.url.trim())
      throw new McpServerConfigError('--url is required for http or sse');
    const url = args.url.trim();
    const parsed = URL.parse(url);
    if (!parsed || !['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.hash)
      throw new McpServerConfigError('--url must be an HTTP(S) URL without credentials or a fragment');
    const keep = previous && 'url' in previous ? previous : undefined;
    const connection = args.connection === undefined ? keep?.authentication?.connection_id : args.connection;
    if (connection === undefined && args.account_alias !== undefined)
      throw new McpServerConfigError('--account-alias requires --connection or an existing pinned connection.');
    const authentication =
      args.authentication != null
        ? parseMcpAuthentication(args.authentication, url)
        : connection === '' || connection === undefined
          ? undefined
          : parseMcpAuthentication(
              { connection_id: connection, account_alias: args.account_alias ?? keep?.authentication?.account_alias },
              url,
            );
    const headers =
      args.headers === undefined
        ? keep?.url === url
          ? keep.headers
          : undefined
        : stringMap(args.headers, '--headers');
    return { ...keep, type, url, headers, authentication, ...metadata };
  }
  if (args.connection !== undefined || args.account_alias !== undefined || args.authentication !== undefined)
    throw new McpServerConfigError('Connection references require HTTP/SSE transport.');
  if (args.url !== undefined || args.headers !== undefined)
    throw new McpServerConfigError('--url and --headers require --type http or sse');
  if (typeof args.command !== 'string' || !args.command.trim()) throw new McpServerConfigError('--command is required');
  const keep = previous && !('url' in previous) ? previous : undefined;
  return {
    ...keep,
    command: args.command,
    args: args.args === undefined ? (keep?.args ?? []) : commandArgs(args.args),
    env: args.env === undefined ? (keep?.env ?? {}) : stringMap(args.env, '--env'),
    ...metadata,
  };
}

export function addMcpServerConfig(groupId: string, args: Record<string, unknown>) {
  if (typeof args.name !== 'string' || !args.name.trim()) throw new McpServerConfigError('--name is required');
  const row = getContainerConfig(groupId);
  if (!row) throw new McpServerConfigError(`No container config for group: ${groupId}`);
  const previous = JSON.parse(row.mcp_servers) as Record<string, McpServerConfig>;
  const servers = { ...previous, [args.name]: parseMcpServerConfig(args, previous[args.name]) };
  updateContainerConfigJson(groupId, 'mcp_servers', servers);
  return { added: args.name, servers };
}
