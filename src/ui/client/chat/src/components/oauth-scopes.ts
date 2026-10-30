import { isOAuthScope } from '../../../../shared/oauth-app';
import { CredentialsError } from './CredentialsApi';
import { oauthResourceUrl } from './credential-routing';

export function scopeValues(value: string): string[] {
  return [...new Set(value.split(/\s+/).filter(Boolean))].sort();
}

export function validScopeSelection(value: string, unspecified: boolean): boolean {
  const scopes = scopeValues(value);
  return (scopes.length > 0 || unspecified) && scopes.every(isOAuthScope);
}

export function scopeDiscoveryInput({
  resource,
  appId,
  issuer,
}: {
  resource?: string;
  appId?: string;
  issuer?: string;
}): { resource_url?: string; app_id?: string; issuer?: string } | null {
  if (resource !== undefined) {
    try {
      return { resource_url: oauthResourceUrl(resource), ...(appId ? { app_id: appId } : {}) };
    } catch (error) {
      if (!(error instanceof CredentialsError)) throw error;
      return null;
    }
  }
  if (issuer !== undefined) {
    const url = URL.parse(issuer.trim());
    if (!url || url.protocol !== 'https:' || url.username || url.password || url.hash) return null;
    return { issuer: issuer.trim() };
  }
  return appId ? { app_id: appId } : null;
}
