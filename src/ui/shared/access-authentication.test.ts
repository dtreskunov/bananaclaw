import { describe, expect, it } from 'vitest';
import {
  connectionMatchesAccess,
  parseAccessAuthentication,
  type AccessAuthenticationHint,
} from './access-authentication.js';
const url = 'https://gmailmcp.example.com/mcp/v1';
const oauth = {
  kind: 'mcp_oauth' as const,
  status: 'ready',
  resource_url: url,
  app_id: 'google',
  services: [{ host: 'gmailmcp.example.com:443/mcp/v1', auth: { type: 'bearer' } }],
  requested_scopes: ['read', 'write'],
  granted_scopes: ['read'],
  scope_source: 'provider',
};

describe('access request authentication compatibility', () => {
  it('distinguishes an MCP resource from REST API accounts and other mechanisms', () => {
    const request = { resource_url: url, authentication: { type: 'mcp_oauth' as const }, scopes: ['read'] };
    expect(connectionMatchesAccess(oauth, request)).toBe(true);
    expect(connectionMatchesAccess({ ...oauth, kind: 'oauth_app' }, request)).toBe(false);
    expect(
      connectionMatchesAccess(
        { ...oauth, services: [{ host: 'gmail.example.com', auth: { type: 'bearer' } }] },
        request,
      ),
    ).toBe(false);
    expect(connectionMatchesAccess(oauth, { ...request, authentication: { type: 'mcp_oauth', app_id: 'other' } })).toBe(
      false,
    );
    expect(connectionMatchesAccess(oauth, { ...request, authentication: { type: 'basic' } })).toBe(false);
  });
  it('requires exact provider-reported scopes for ready OAuth credentials', () => {
    expect(connectionMatchesAccess(oauth, { resource_url: url, scopes: ['read', 'write'] })).toBe(false);
    expect(
      connectionMatchesAccess({ ...oauth, scope_source: 'requested' }, { resource_url: url, scopes: ['read'] }),
    ).toBe(false);
    expect(
      connectionMatchesAccess({ ...oauth, granted_scopes: ['read,write'] }, { resource_url: url, scopes: ['read'] }),
    ).toBe(false);
    expect(
      connectionMatchesAccess(
        { ...oauth, granted_scopes: ['read,write'] },
        { resource_url: url, scopes: ['read,write'] },
      ),
    ).toBe(true);
  });
  it('shows compatible MCP drafts for consent without treating creation as authorization', () => {
    expect(
      connectionMatchesAccess(
        { ...oauth, status: 'draft', services: [] },
        {
          resource_url: url,
          authentication: { type: 'mcp_oauth' },
          scopes: ['write'],
        },
      ),
    ).toBe(true);
    expect(
      connectionMatchesAccess(
        { ...oauth, status: 'draft', services: [], resource_url: 'https://other.example/mcp' },
        { resource_url: url },
      ),
    ).toBe(false);
    expect(
      connectionMatchesAccess(
        { ...oauth, status: 'draft', services: [], resource_url: '' },
        { resource_url: 'invalid' },
      ),
    ).toBe(false);
  });
  it('checks header names case-insensitively and public prefixes exactly', () => {
    const key = {
      kind: 'static' as const,
      status: 'ready',
      services: [{ host: 'gmailmcp.example.com', auth: { type: 'api-key', header: 'X-API-Key', prefix: 'Token ' } }],
    };
    const authentication: AccessAuthenticationHint = { type: 'api-key', header: 'x-api-key', prefix: 'Token ' };
    expect(connectionMatchesAccess(key, { resource_url: url, authentication })).toBe(true);
    expect(
      connectionMatchesAccess(key, {
        resource_url: url,
        authentication: { ...authentication, header: 'Authorization' },
      }),
    ).toBe(false);
    expect(connectionMatchesAccess(key, { resource_url: url, authentication: { ...authentication, prefix: '' } })).toBe(
      false,
    );
    expect(connectionMatchesAccess(key, { resource_url: url, scopes: ['read'] })).toBe(false);
    const custom = {
      ...key,
      services: [
        {
          host: 'gmailmcp.example.com',
          auth: { type: 'custom', headers: { 'X-Api-Key': '{{ KEY }}', 'X-Client-Secret': '{{ SECRET }}' } },
        },
      ],
    };
    expect(
      connectionMatchesAccess(custom, {
        resource_url: url,
        authentication: { type: 'custom', headers: ['x-api-key', 'X-CLIENT-SECRET'] },
      }),
    ).toBe(true);
    expect(
      connectionMatchesAccess(custom, { resource_url: url, authentication: { type: 'custom', headers: ['X-Other'] } }),
    ).toBe(false);
  });
  it.each([
    { type: 'mcp_oauth', client_secret: 'secret' },
    { type: 'bearer', token: 'secret' },
    { type: 'oauth_app', connection_id: 'private' },
    { type: 'basic', password: 'secret' },
    { type: 'custom', headers: { 'X-Key': 'secret' } },
    { type: 'custom', headers: ['X-Key', 'x-key'] },
    { type: 'api-key', header: 'Authorization\r\nInjected: true' },
    { type: 'api-key', header: 'Proxy-Authorization' },
    { type: 'api-key', header: 'X-AgentVault-Binding' },
    { type: 'api-key', header: 'X-Key', prefix: 'bad\nprefix' },
    { type: 'unknown' },
  ])('rejects secret-valued or unsafe hints: %j', (hint) => expect(() => parseAccessAuthentication(hint)).toThrow());
});
