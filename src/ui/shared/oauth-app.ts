export interface OAuthAppConfiguration {
  label: string;
  issuer: string;
  client_id: string;
  authorization_endpoint?: string;
  token_endpoint?: string;
  token_endpoint_auth_method: 'none' | 'client_secret_post' | 'client_secret_basic';
  api_hosts: string[];
  default_scopes: string[];
  authorization_params?: Record<string, string>;
  revocation_endpoint?: string;
  identity: 'none' | 'oidc' | 'google' | 'github';
  jwks_uri?: string;
  token_scope_separator: 'space' | 'comma';
}

export type OAuthAppInput = Partial<OAuthAppConfiguration> & { client_secret?: string };

export interface OAuthScopeOptions {
  scopes: string[];
  source: 'resource' | 'authorization_server' | 'not_advertised';
  issuer?: string;
  oauth: boolean;
}

export function isOAuthScope(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    [...value].every((character) => character >= '!' && character <= '~' && character !== '"' && character !== '\\')
  );
}
