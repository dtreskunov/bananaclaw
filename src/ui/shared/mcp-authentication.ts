export interface McpAuthentication {
  connection_id: string;
  account_alias: string;
}
export class McpAuthenticationError extends Error {}

export function parseMcpAuthentication(value: unknown, resourceUrl?: string): McpAuthentication | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'object' || Array.isArray(value))
    throw new McpAuthenticationError('MCP authentication must be a connection reference.');
  const record = value as Record<string, unknown>;
  if (resourceUrl !== undefined) {
    const url = URL.parse(resourceUrl);
    if (!url || url.protocol !== 'https:' || url.username || url.password || url.search || url.hash)
      throw new McpAuthenticationError(
        'MCP connection references require an exact HTTPS URL without embedded credentials, query or fragment.',
      );
  }
  if (
    Object.keys(record).some((key) => key !== 'connection_id' && key !== 'account_alias') ||
    typeof record.connection_id !== 'string' ||
    !/^[A-Za-z0-9_-]{1,200}$/.test(record.connection_id) ||
    typeof record.account_alias !== 'string' ||
    !record.account_alias.trim() ||
    record.account_alias.length > 80 ||
    [...record.account_alias].some((char) => char.charCodeAt(0) < 32)
  )
    throw new McpAuthenticationError(
      'Choose a connection and a nonempty account alias (at most 80 characters). Never supply tokens or binding handles.',
    );
  return { connection_id: record.connection_id, account_alias: record.account_alias.trim() };
}

export interface McpAccessStatus {
  server: string;
  resource_url: string;
  account_alias: string;
  status: 'ready' | 'blocked';
  reason?: string;
}
