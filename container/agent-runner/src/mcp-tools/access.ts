import { randomUUID } from 'node:crypto';
import { writeMessageOut } from '../db/messages-out.js';
import { registerTools } from './tool-registry.js';
import type { McpToolDefinition } from './types.js';

export const requestAccess: McpToolDefinition = {
  tool: {
    name: 'request_access',
    description: 'Request user-assisted access to an HTTPS service through Credentials (OAuth or static key). The user privately chooses a connection and grants this agent access. No secrets, owner IDs, credential IDs or admin commands. Returns immediately; wait for the host completion message rather than probing token endpoints, searching for credentials or creating a poller. Requested scopes are suggestions requiring user review.',
    inputSchema: {
      type: 'object',
      properties: {
        resource_url: { type: 'string', description: 'Exact HTTPS destination without credentials, query, fragment or wildcards.' },
        reason: { type: 'string', description: 'Why access is needed for the current request. Never include secret values.' },
        scopes: { type: 'array', items: { type: 'string' }, description: 'Optional scope suggestions, not automatically selected or granted.' },
        mcp_server: { type: 'string', description: 'Exact configured MCP server name when requesting its account connection. Never select all servers by URL.' },
        authentication: { type: 'object', additionalProperties: false,
          description: 'Optional researched authentication requirements, reviewed by the user. No tokens, passwords, client secrets, owner IDs or connection IDs. OAuth permissions go in scopes.',
          properties: {
            type: { type: 'string', enum: ['mcp_oauth', 'oauth_app', 'bearer', 'api-key', 'basic', 'custom'] },
            app_id: { type: 'string', description: 'OAuth only: optional configured app identifier, if known.' },
            header: { type: 'string', description: 'api-key only: documented header name, for example X-Api-Key.' },
            prefix: { type: 'string', description: 'api-key only: documented public prefix, for example "Token ". Never a credential value.' },
            headers: { type: 'array', items: { type: 'string' }, description: 'custom only: header names, never values.' },
          }, required: ['type'] },
      },
      required: ['resource_url', 'reason'],
      additionalProperties: false,
    },
  },
  async handler(args) {
    const hint = args.authentication;
    if (hint !== undefined && (!hint || typeof hint !== 'object' || Array.isArray(hint) ||
      Object.keys(hint).some(key => !['type', 'app_id', 'header', 'prefix', 'headers'].includes(key)) ||
      ('headers' in hint && (!Array.isArray(hint.headers) || hint.headers.some(header => typeof header !== 'string'))))) {
      return { isError: true, content: [{ type: 'text', text: 'Authentication suggestions may contain only mechanism, OAuth app ID, header names and a public prefix. Never supply credential values.' }] };
    }
    const url = typeof args.resource_url === 'string' ? URL.parse(args.resource_url) : null;
    if (!url || url.protocol !== 'https:' || url.username || url.password || url.search || url.hash ||
      typeof args.reason !== 'string' || !args.reason.trim() || args.reason.length > 1000 ||
      Object.keys(args).some(key => !['resource_url', 'reason', 'scopes', 'mcp_server', 'authentication'].includes(key))) {
      return { isError: true, content: [{ type: 'text', text: 'Provide an exact HTTPS destination and reason; never include secrets or owner/credential identifiers.' }] };
    }
    const requestId = `appr-access-${randomUUID()}`;
    writeMessageOut({
      id: requestId, kind: 'system',
      content: JSON.stringify({ action: 'request_access', requestId, ...args }),
    });
    return { content: [{ type: 'text', text: JSON.stringify({ request_id: requestId, status: 'submitted', message: 'User review requested. Wait for the host result; no access has been granted.' }) }] };
  },
};

registerTools([requestAccess]);
