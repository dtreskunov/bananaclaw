import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  accessPath,
  appConfiguration,
  connectionPath,
  credentialRequest,
  credentialsPath,
  validateAppConfiguration,
  parseServices,
  providedValues,
  serviceKeys,
  SERVICE_PRESETS,
  type AppInfo,
} from './CredentialsApi';

afterEach(() => vi.unstubAllGlobals());

describe('personal credential wire contract', () => {
  it('uses only user-scoped connection routes and separate group access resources', () => {
    expect(credentialsPath()).toBe('/ui/chat/api/credentials');
    expect(connectionPath('a/b', '/start')).toBe('/ui/chat/api/credentials/connections/a%2Fb/start');
    expect(accessPath('g/id', 'a/b')).toBe('/ui/chat/api/groups/g%2Fid/admin/access/a%2Fb');
  });

  it('sends an opaque revision and only explicitly provided new values', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ revision: '"new"' })));
    vi.stubGlobal('fetch', fetch);
    const values = providedValues({ USERNAME: '', PASSWORD: 'new-password', UNUSED: 'not-sent' }, [
      'USERNAME',
      'PASSWORD',
    ]);
    await credentialRequest(connectionPath('pair'), 'PUT', { revision: '"original"', values });
    expect(fetch).toHaveBeenCalledWith(
      '/ui/chat/api/credentials/connections/pair',
      expect.objectContaining({
        method: 'PUT',
        credentials: 'same-origin',
        body: JSON.stringify({ revision: '"original"', values: { PASSWORD: 'new-password' } }),
      }),
    );
    expect(providedValues({}, ['USERNAME', 'PASSWORD'])).toEqual({});
  });

  it('reports server conflicts, gateway outages, network failures and malformed responses', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'stale_revision' }), { status: 412 }))
        .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'gateway_unreachable' }), { status: 503 }))
        .mockRejectedValueOnce(new TypeError('Network unavailable'))
        .mockResolvedValueOnce(new Response('<html>login</html>')),
    );
    await expect(credentialRequest(connectionPath('x'))).rejects.toMatchObject({
      status: 412,
      message: 'stale_revision',
    });
    await expect(credentialRequest(credentialsPath())).rejects.toThrow('gateway_unreachable');
    await expect(credentialRequest(credentialsPath())).rejects.toThrow('Network unavailable');
    await expect(credentialRequest(credentialsPath())).rejects.toThrow('invalid JSON');
  });

  it.each([
    [502, '<html>Bad Gateway</html>'],
    [503, 'Service unavailable'],
    [400, '{"error":'],
  ])('reports non-JSON HTTP %s failures without blaming JSON or displaying proxy content', async (status, body) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(body, { status })));
    await expect(credentialRequest(connectionPath('x'), 'DELETE', { revision: '"original"' })).rejects.toMatchObject({
      status,
      message: `The credentials request failed (HTTP ${status}). Refresh and try again.`,
    });
  });
});

describe('safe service and app editors', () => {
  it('supports real Basic pairs, multi-header templates and placeholder references', () => {
    for (const preset of SERVICE_PRESETS)
      expect(parseServices(JSON.stringify(preset.services))).toEqual(preset.services);
    expect(serviceKeys(SERVICE_PRESETS[2].services)).toEqual(['USERNAME', 'PASSWORD']);
    expect(serviceKeys(SERVICE_PRESETS[3].services)).toEqual(['API_KEY', 'API_SECRET']);
    expect(serviceKeys(SERVICE_PRESETS[4].services)).toEqual(['API_KEY']);
    const headers = parseServices(
      JSON.stringify([
        {
          name: 'custom',
          host: 'api.example.com',
          auth: {
            type: 'custom',
            headers: { Authorization: 'Bearer {{ API_TOKEN }}', 'X-Id': '{{ USER_ID }}:{{ API_TOKEN }}' },
          },
        },
      ]),
    );
    expect(serviceKeys(headers)).toEqual(['API_TOKEN', 'USER_ID']);
  });

  it('rejects invalid routing and literal values in credential-reference positions', () => {
    expect(() => parseServices('{}')).toThrow('JSON array');
    expect(() => parseServices('[{"name":"bad"}]')).toThrow('auth.type');
    expect(() =>
      parseServices(JSON.stringify([...SERVICE_PRESETS[0].services, ...SERVICE_PRESETS[0].services])),
    ).toThrow('Duplicate');
    expect(() => parseServices('[{"name":"bad","host":"a","auth":{"type":"bearer","token":"actual secret"}}]')).toThrow(
      'key NAME',
    );
    expect(() =>
      parseServices('[{"name":"bad","host":"a","auth":{"type":"custom","headers":{"X-Key":"literal-secret"}}}]'),
    ).toThrow('templates');
    expect(() => parseServices(JSON.stringify([{ ...SERVICE_PRESETS[0].services[0], enabled: 'false' }]))).toThrow(
      'true or false',
    );
  });

  it('keeps AppInfo metadata out of safe config and never prefills a secret', () => {
    const app: AppInfo = {
      id: 'private',
      source: 'user',
      label: 'Private app',
      issuer: 'https://issuer.example',
      client_id: 'public-client',
      client_secret_set: true,
      token_endpoint_auth_method: 'client_secret_post',
      api_hosts: ['api.example'],
      default_scopes: ['read'],
      identity: 'oidc',
      token_scope_separator: 'space',
    };
    const config = appConfiguration(app);
    expect(config).not.toHaveProperty('client_secret_set');
    expect(config).not.toHaveProperty('source');
    expect(config).not.toHaveProperty('id');
    expect(validateAppConfiguration(config)).toMatchObject({ client_id: 'public-client' });
    const unsafe = { ...config, client_secret: 'not-safe' };
    expect(() => validateAppConfiguration(unsafe)).toThrow('separate password');
    expect(() => validateAppConfiguration({ ...config, authorization_params: { client_secret: 'not-safe' } })).toThrow(
      'separate password',
    );
  });
});
