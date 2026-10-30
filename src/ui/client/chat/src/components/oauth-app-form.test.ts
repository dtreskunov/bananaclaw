import { describe, expect, it } from 'vitest';
import type { AppInfo } from './CredentialsApi';
import { compileOAuthApp, oauthAppDraft } from './oauth-app-form';

const app: AppInfo = {
  id: 'provider',
  source: 'user',
  label: 'Provider',
  issuer: 'https://accounts.example.com',
  client_id: 'public-id',
  client_secret_set: true,
  token_endpoint_auth_method: 'client_secret_post',
  api_hosts: ['api.example.com:443', 'files.example.com:8443'],
  default_scopes: ['read:documents', 'read:profile'],
  authorization_endpoint: 'https://accounts.example.com/authorize',
  token_endpoint: 'https://accounts.example.com/token',
  revocation_endpoint: 'https://accounts.example.com/revoke',
  jwks_uri: 'https://accounts.example.com/keys',
  identity: 'oidc',
  token_scope_separator: 'comma',
  authorization_params: { access_type: 'offline', include_granted_scopes: 'false' },
};

describe('OAuth app form', () => {
  it('starts with placeholders, not example provider settings or a secret', () => {
    const draft = oauthAppDraft();
    expect(draft.issuer).toBe('');
    expect(draft.apiHosts).toBe('');
    expect(draft.client_id).toBe('');
    expect(draft).not.toHaveProperty('client_secret');
  });
  it('round-trips every app setting without exposing metadata or configured secret material', () => {
    const draft = oauthAppDraft(app);
    expect(draft.apiHosts).toBe('api.example.com\nfiles.example.com:8443');
    const config = compileOAuthApp(draft);
    expect(config).toEqual({
      label: app.label,
      issuer: app.issuer,
      client_id: app.client_id,
      token_endpoint_auth_method: app.token_endpoint_auth_method,
      api_hosts: ['api.example.com', 'files.example.com:8443'],
      default_scopes: app.default_scopes,
      authorization_endpoint: app.authorization_endpoint,
      token_endpoint: app.token_endpoint,
      revocation_endpoint: app.revocation_endpoint,
      jwks_uri: app.jwks_uri,
      identity: app.identity,
      token_scope_separator: app.token_scope_separator,
      authorization_params: app.authorization_params,
    });
    expect(config).not.toHaveProperty('client_secret_set');
    expect(config).not.toHaveProperty('source');
    expect(config).not.toHaveProperty('id');
  });
  it('sends explicit clears so gateway merging does not retain removed endpoints or parameters', () => {
    const config = compileOAuthApp({
      ...oauthAppDraft(app),
      authorization_endpoint: '',
      token_endpoint: '',
      revocation_endpoint: '',
      jwks_uri: '',
      identity: 'none',
      parameters: [],
    });
    expect(config).toMatchObject({
      authorization_endpoint: '',
      token_endpoint: '',
      revocation_endpoint: '',
      jwks_uri: '',
      authorization_params: {},
    });
  });
  it('rejects duplicate parameters instead of silently overwriting one', () => {
    expect(() =>
      compileOAuthApp({
        ...oauthAppDraft(app),
        parameters: [
          { name: 'prompt', value: 'select_account' },
          { name: 'prompt', value: 'consent' },
        ],
      }),
    ).toThrow('Duplicate');
  });
  it.each(['client_secret', 'redirect_uri', 'STATE', 'scope', 'resource', 'access_token'])(
    'does not allow parameter %s to override OAuth security fields',
    (name) =>
      expect(() => compileOAuthApp({ ...oauthAppDraft(app), parameters: [{ name, value: 'value' }] })).toThrow('OAuth'),
  );
  it.each([
    '*.example.com',
    'https://api.example.com',
    'api.example.com/path',
    'api.example.com?key=value',
    'api.example.com:0',
  ])('validates API host restrictions: %s', (apiHosts) =>
    expect(() => compileOAuthApp({ ...oauthAppDraft(app), apiHosts })).toThrow('API host'),
  );
  it('validates discovery overrides and signing keys without discarding existing fields', () => {
    expect(() => compileOAuthApp({ ...oauthAppDraft(app), token_endpoint: '' })).toThrow('both');
    expect(() => compileOAuthApp({ ...oauthAppDraft(app), jwks_uri: '' })).toThrow('signing keys');
    expect(() => compileOAuthApp({ ...oauthAppDraft(app), issuer: 'http://accounts.example.com' })).toThrow('HTTPS');
  });
});
