import { describe, expect, it } from 'vitest';
import { scopeDiscoveryInput, scopeValues, validScopeSelection } from './oauth-scopes';

describe('OAuth scope selections', () => {
  it('deduplicates and sorts opaque values without splitting comma-containing scopes', () => {
    expect(scopeValues('write\nread\nrepo,read:user\nread')).toEqual(['read', 'repo,read:user', 'write']);
  });
  it('requires either an explicit scope selection or an explicit unspecified request', () => {
    expect(validScopeSelection('', false)).toBe(false);
    expect(validScopeSelection('', true)).toBe(true);
    expect(validScopeSelection('read', false)).toBe(true);
    expect(validScopeSelection('bad"scope', false)).toBe(false);
  });
  it('builds scope-inspection requests without inventing credential ownership or registrations', () => {
    expect(scopeDiscoveryInput({ resource: 'mcp.example.com/mcp', appId: 'private' })).toEqual({
      resource_url: 'https://mcp.example.com/mcp',
      app_id: 'private',
    });
    expect(scopeDiscoveryInput({ appId: 'google' })).toEqual({ app_id: 'google' });
    expect(scopeDiscoveryInput({ issuer: 'https://accounts.example.com' })).toEqual({
      issuer: 'https://accounts.example.com',
    });
    expect(scopeDiscoveryInput({ resource: '', appId: 'private' })).toBeNull();
    expect(scopeDiscoveryInput({ resource: 'http://mcp.example.com' })).toBeNull();
    expect(scopeDiscoveryInput({ issuer: 'https://user:password@example.com' })).toBeNull();
  });
});
