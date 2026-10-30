import { describe, expect, it } from 'vitest';
import {
  authentication,
  accessCreationDefaults,
  compileRoutes,
  credentialFields,
  hostnameFromPattern,
  oauthResourceUrl,
  parseUrlPattern,
  routingDrafts,
} from './credential-routing';
import type { Service } from './CredentialsApi';

describe('credential URL pattern form', () => {
  it('prefills MCP OAuth and exact requested scopes without broadening destinations', () => {
    const request = {
      resource_url: 'https://gmailmcp.example.com/mcp/v1',
      mcp_server: 'google-gmail',
      authentication: { type: 'mcp_oauth' as const, app_id: 'google' },
      scopes: ['mail.read'],
    };
    const defaults = accessCreationDefaults(request, [
      { id: 'google', api_hosts: ['gmail.example.com'], default_scopes: ['broad.default'] },
    ]);
    expect(defaults.kind).toBe('mcp_oauth');
    expect(defaults.appId).toBe('google');
    expect(defaults.scopes).toEqual(['mail.read']);
    expect(defaults.routes[0].pattern).toBe(request.resource_url);
    expect(accessCreationDefaults({ resource_url: request.resource_url, mcp_server: 'google-gmail' }, []).kind).toBe(
      'mcp_oauth',
    );
  });
  it('prefills only public static authentication recipes, leaving secret inputs empty', () => {
    const request = { resource_url: 'https://api.example.com/v1/items' };
    const header = accessCreationDefaults(
      { ...request, authentication: { type: 'api-key', header: 'X-Research-Key', prefix: 'Token ' } },
      [],
    );
    expect(header.kind).toBe('static');
    expect(compileRoutes(header.routes)[0]).toMatchObject({
      host: 'api.example.com/v1/items',
      auth: { type: 'api-key', key: 'API_KEY', header: 'X-Research-Key', prefix: 'Token ' },
    });
    const custom = accessCreationDefaults(
      { ...request, authentication: { type: 'custom', headers: ['X-Key', 'X-Signature'] } },
      [],
    );
    expect(custom.routes[0].service.auth.headers).toEqual({
      'X-Key': '{{ HEADER_VALUE_1 }}',
      'X-Signature': '{{ HEADER_VALUE_2 }}',
    });
    expect(credentialFields(custom.routes.map((route) => route.service))).toHaveLength(2);
  });
  it('uses concrete HTTPS URLs for OAuth, retaining resource query strings', () => {
    expect(oauthResourceUrl('mcp.example.com/mcp?version=1')).toBe('https://mcp.example.com/mcp?version=1');
    expect(hostnameFromPattern('https://mcp.example.com/mcp?version=1')).toBe('mcp.example.com');
    expect(() => oauthResourceUrl('https://mcp.example.com/*')).toThrow('wildcards');
    expect(() => oauthResourceUrl('http://mcp.example.com/mcp')).toThrow('HTTPS');
  });
  it('extracts the host, preserves path patterns and ports and defaults to HTTPS', () => {
    expect(parseUrlPattern('api.example.com/v1/*')).toEqual({
      host: 'api.example.com/v1/*',
      hostname: 'api.example.com',
    });
    expect(parseUrlPattern('https://*.example.com:8443/path/*')).toEqual({
      host: '*.example.com:8443/path/*',
      hostname: '*.example.com',
    });
    expect(parseUrlPattern('https://api.example.com/')).toEqual({
      host: 'api.example.com/',
      hostname: 'api.example.com',
    });
    expect(hostnameFromPattern('https://API.example.com/v1/*')).toBe('api.example.com');
    expect(hostnameFromPattern('https://')).toBe('');
  });
  it.each([
    'http://api.example.com/*',
    'file:///tmp/value',
    'https://user:password@example.com/*',
    'https://api.example.com/?key=secret',
    'https://api.example.com/#fragment',
  ])('rejects unsafe or non-HTTPS patterns: %s', (pattern) => expect(() => parseUrlPattern(pattern)).toThrow('HTTPS'));
  it('makes HTTPS non-overridable and keeps internal service IDs out of form fields', () => {
    const service: Service = {
      name: 'internal-id',
      host: 'api.example.com',
      path: '/v1/*',
      https_only: false,
      auth: { type: 'bearer', token: 'KEY' },
    };
    const drafts = routingDrafts([service]);
    expect(drafts[0].pattern).toBe('https://api.example.com/v1/*');
    expect(compileRoutes(drafts)[0]).toMatchObject({
      name: 'internal-id',
      host: 'api.example.com/v1/*',
      https_only: true,
    });
    expect(service.https_only).toBe(false);
  });
  it('does not show the default HTTPS port in existing URL patterns', () => {
    const service: Service = {
      name: 'api',
      host: 'api.example.com:443',
      path: '/api/*',
      auth: { type: 'bearer', token: 'KEY' },
    };
    expect(routingDrafts([service])[0].pattern).toBe('https://api.example.com/api/*');
    expect(service.host).toBe('api.example.com:443');
  });
  it('retains shared and compound custom-header value references', () => {
    const service: Service = {
      name: 'api',
      host: 'api.example.com',
      auth: {
        type: 'custom',
        headers: { Authorization: 'Token {{ TOKEN }}', 'X-Account': '{{ USERNAME }}:{{ TOKEN }}' },
      },
    };
    expect(compileRoutes(routingDrafts([service]))[0].auth).toEqual(service.auth);
    expect(credentialFields([service])).toEqual([
      { key: 'TOKEN', label: 'Authorization value' },
      { key: 'USERNAME', label: 'X-Account value' },
    ]);
  });
  it('preserves explicit placeholder surfaces and validates their boundaries', () => {
    const service: Service = {
      name: 'api',
      host: 'api.example.com',
      auth: { type: 'passthrough' },
      substitutions: [{ key: 'VALUE', placeholder: '__VALUE__', in: ['query'] }],
    };
    expect(compileRoutes(routingDrafts([service]))[0].substitutions).toEqual(service.substitutions);
    expect(
      compileRoutes(routingDrafts([{ ...service, substitutions: [{ key: 'VALUE', placeholder: '__VALUE__' }] }]))[0]
        .substitutions?.[0].in,
    ).toBeUndefined();
    expect(() =>
      compileRoutes(
        routingDrafts([{ ...service, substitutions: [{ key: 'VALUE', placeholder: 'x', in: ['query'] }] }]),
      ),
    ).toThrow('placeholders');
    expect(() =>
      compileRoutes(
        routingDrafts([{ ...service, substitutions: [{ key: 'VALUE', placeholder: '__VALUE__', in: [] }] }]),
      ),
    ).toThrow('where');
  });
  it('preserves existing non-uppercase header references', () => {
    expect(
      credentialFields([
        {
          name: 'api',
          host: 'api.example.com',
          auth: {
            type: 'custom',
            headers: { 'X-Api-Key': '{{ api.key-id }}' },
          },
        },
      ]),
    ).toEqual([{ key: 'api.key-id', label: 'X-Api-Key value' }]);
  });
  it('generates value references rather than asking users to enter key names', () => {
    expect(authentication('api-key', { type: 'bearer', token: 'KEY' }, ['API_KEY'])).toEqual({
      type: 'api-key',
      key: 'API_KEY_2',
      header: 'X-Api-Key',
    });
    expect(authentication('basic', { type: 'bearer', token: 'KEY' }, [])).toEqual({
      type: 'basic',
      username: 'USERNAME',
      password: 'PASSWORD',
    });
  });
});
