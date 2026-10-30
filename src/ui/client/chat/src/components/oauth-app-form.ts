import {
  appConfiguration,
  CredentialsError,
  validateAppConfiguration,
  type AppInfo,
  type OAuthAppConfiguration,
} from './CredentialsApi';
import { displayDestination } from './credential-presentation';

export interface OAuthAppDraft extends Omit<
  OAuthAppConfiguration,
  'api_hosts' | 'default_scopes' | 'authorization_params'
> {
  apiHosts: string;
  scopes: string;
  parameters: { name: string; value: string }[];
}

export function oauthAppDraft(app?: AppInfo): OAuthAppDraft {
  const config: OAuthAppConfiguration = app
    ? appConfiguration(app)
    : {
        label: '',
        issuer: '',
        client_id: '',
        token_endpoint_auth_method: 'none',
        api_hosts: [],
        default_scopes: [],
        identity: 'none',
        token_scope_separator: 'space',
      };
  const { api_hosts, default_scopes, authorization_params, ...fields } = config;
  return {
    ...fields,
    apiHosts: api_hosts.map(displayDestination).join('\n'),
    scopes: default_scopes.join('\n'),
    parameters: Object.entries(authorization_params ?? {}).map(([name, value]) => ({ name, value })),
  };
}

export function compileOAuthApp(draft: OAuthAppDraft): OAuthAppConfiguration {
  const { apiHosts, scopes, parameters, ...fields } = draft;
  const names = new Set<string>();
  const reserved = new Set([
    'state',
    'client_id',
    'client_secret',
    'redirect_uri',
    'response_type',
    'scope',
    'nonce',
    'code_challenge',
    'code_challenge_method',
    'resource',
    'request',
    'request_uri',
    'access_token',
    'refresh_token',
    'id_token',
  ]);
  const authorization_params = Object.fromEntries(
    parameters.map(({ name, value }) => {
      if (!name.trim() || /\p{Cc}/u.test(name + value))
        throw new CredentialsError('Enter authorization parameter names and values without control characters.');
      const key = name.trim();
      if (names.has(key)) throw new CredentialsError(`Duplicate authorization parameter: ${key}`);
      if (reserved.has(key.toLowerCase()))
        throw new CredentialsError('Authorization parameters cannot override OAuth bindings or contain credentials.');
      names.add(key);
      return [key, value];
    }),
  );
  const api_hosts = [
    ...new Set(
      apiHosts
        .split(/\r?\n/)
        .map((host) => host.trim())
        .filter(Boolean)
        .map((host) => {
          const url = URL.parse(`https://${host}`);
          if (!url || /[/\\*?#@\s]/.test(host) || !url.hostname || (url.port && Number(url.port) < 1))
            throw new CredentialsError('Enter exact API hostnames, with an optional port, without paths or wildcards.');
          return url.host;
        }),
    ),
  ];
  const config = validateAppConfiguration({
    ...fields,
    label: fields.label.trim(),
    issuer: fields.issuer.trim(),
    client_id: fields.client_id.trim(),
    api_hosts,
    default_scopes: [...new Set(scopes.split(/\s+/).filter(Boolean))],
    authorization_params,
    authorization_endpoint: fields.authorization_endpoint?.trim() ?? '',
    token_endpoint: fields.token_endpoint?.trim() ?? '',
    revocation_endpoint: fields.revocation_endpoint?.trim() ?? '',
    jwks_uri: fields.jwks_uri?.trim() ?? '',
  });
  for (const [label, value] of [
    ['Issuer', config.issuer],
    ['Authorization endpoint', config.authorization_endpoint],
    ['Token endpoint', config.token_endpoint],
    ['Revocation endpoint', config.revocation_endpoint],
    ['Signing keys', config.jwks_uri],
  ]) {
    if (!value) continue;
    const url = URL.parse(value);
    if (!url || url.protocol !== 'https:' || url.username || url.password || url.hash)
      throw new CredentialsError(`${label} must be an HTTPS URL without embedded credentials or a fragment.`);
  }
  if (!!config.authorization_endpoint !== !!config.token_endpoint)
    throw new CredentialsError('Configure both authorization and token endpoints, or leave both blank for discovery.');
  if (config.identity === 'oidc' && !config.jwks_uri)
    throw new CredentialsError('Enter the signing keys URL for OpenID Connect identity verification.');
  return config;
}
