import { describe, expect, it } from 'vitest';

import { isMcpService, resourceId, serviceForUrl, servicesToKeys, type GatewayService } from './gateway-credentials.js';

// The live canary vault's services, plus one the gateway generated for an MCP sign-in.
const SERVICES: GatewayService[] = [
  {
    name: 'minimax',
    host: 'api.minimax.io',
    auth: {
      type: 'custom',
      headers: { Authorization: 'Bearer {{ MINIMAX_API_KEY }}', 'x-api-key': '{{ MINIMAX_API_KEY }}' },
    },
  },
  {
    name: 'tavily',
    host: 'mcp.tavily.com',
    auth: { type: 'passthrough' },
    substitutions: [{ key: 'TAVILY_API_KEY', placeholder: '__TAVILY_API_KEY__', in: ['query'] }],
  },
  {
    name: 'nextcloud-mcp',
    host: 'nextcloud-mcp.example.org',
    auth: { type: 'custom', headers: { Authorization: 'Basic {{ NEXTCLOUD_MCP }}' } },
  },
  { name: 'bananabrowse', host: 'domagent.example.org/mcp/*', auth: { type: 'bearer', token: 'DOMAGENT_TOKEN' } },
  {
    name: 'brave',
    host: 'api.search.brave.com',
    auth: { type: 'api-key', key: 'BRAVE_API_KEY', header: 'X-Subscription-Token' },
  },
  { name: 'mcp-abc123', host: 'mcp.linear.app/mcp', auth: { type: 'bearer', token: 'MCP_ABC123' } },
  { name: 'mcp-abc123-children', host: 'mcp.linear.app/mcp/*', auth: { type: 'bearer', token: 'MCP_ABC123' } },
];

describe('servicesToKeys', () => {
  const keys = servicesToKeys(SERVICES, [
    { key: 'MINIMAX_API_KEY', type: 'static', updated_at: '2026-10-01T00:00:00Z' },
    { key: 'TAVILY_API_KEY' },
    { key: 'NEXTCLOUD_MCP' },
    { key: 'DOMAGENT_TOKEN' },
    { key: 'MCP_ABC123', type: 'mcp_oauth' },
  ]);

  it('lists one key per static credential and skips MCP sign-in services', () => {
    expect(keys.map((k) => k.key)).toEqual([
      'MINIMAX_API_KEY',
      'TAVILY_API_KEY',
      'NEXTCLOUD_MCP',
      'DOMAGENT_TOKEN',
      'BRAVE_API_KEY',
    ]);
  });

  it('maps each auth type to the UI injection', () => {
    const by = Object.fromEntries(keys.map((k) => [k.key, k]));
    expect(by.MINIMAX_API_KEY!.destination).toEqual({
      match: 'api.minimax.io',
      injection: { type: 'custom', name: 'Authorization', template: 'Bearer {{ MINIMAX_API_KEY }}' },
    });
    expect(by.TAVILY_API_KEY!.destination.injection).toEqual({ type: 'query', name: '__TAVILY_API_KEY__' });
    expect(by.DOMAGENT_TOKEN!.destination).toEqual({
      match: 'domagent.example.org/mcp/*',
      injection: { type: 'bearer' },
    });
    expect(by.BRAVE_API_KEY!.destination.injection).toEqual({
      type: 'api-key',
      name: 'X-Subscription-Token',
      prefix: undefined,
    });
  });

  it('marks keys without a stored value', () => {
    const by = Object.fromEntries(keys.map((k) => [k.key, k]));
    expect(by.MINIMAX_API_KEY).toMatchObject({ status: 'set', updatedAt: '2026-10-01T00:00:00Z', label: 'minimax' });
    expect(by.BRAVE_API_KEY!.status).toBe('needs_value');
  });
});

describe('isMcpService', () => {
  it('is true only when every key is a gateway-managed MCP key', () => {
    expect(isMcpService(SERVICES[5]!)).toBe(true);
    expect(isMcpService(SERVICES[0]!)).toBe(false);
    expect(isMcpService({ name: 'open', host: 'pypi.org', auth: { type: 'passthrough' } })).toBe(false);
  });
});

describe('serviceForUrl', () => {
  it('matches by host, and by path glob when the service has one', () => {
    expect(serviceForUrl(SERVICES, 'https://mcp.tavily.com/mcp/?tavilyApiKey=__TAVILY_API_KEY__')?.name).toBe('tavily');
    expect(serviceForUrl(SERVICES, 'https://domagent.example.org/mcp/bananaclawz')?.name).toBe('bananabrowse');
    expect(serviceForUrl(SERVICES, 'https://domagent.example.org/other')).toBeUndefined();
  });

  it('ignores MCP sign-in services', () => {
    expect(serviceForUrl(SERVICES, 'https://mcp.linear.app/mcp')).toBeUndefined();
  });
});

describe('resourceId', () => {
  it('ignores query, fragment, trailing slash and case', () => {
    expect(resourceId('https://MCP.linear.app/mcp/?x=1#y')).toBe(resourceId('https://mcp.linear.app/mcp'));
    expect(resourceId('https://mcp.linear.app/mcp')).not.toBe(resourceId('https://mcp.linear.app/mcp2'));
  });
});
