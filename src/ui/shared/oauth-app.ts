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
