import { describe, expect, it } from 'vitest';
import { serviceMatchesResource } from './credential-matching.js';

describe('canonical credential destination matching', () => {
  it('handles explicit default ports and separate or inline paths', () => {
    expect(
      serviceMatchesResource({ host: 'api.example.com:443', path: '/v1/*' }, 'https://api.example.com/v1/items'),
    ).toBe(true);
    expect(serviceMatchesResource({ host: 'api.example.com:8443/v1/*' }, 'https://api.example.com:8443/v1/items')).toBe(
      true,
    );
    expect(serviceMatchesResource({ host: 'api.example.com:8443' }, 'https://api.example.com/v1/items')).toBe(false);
    expect(serviceMatchesResource({ host: 'api.example.com', path: '/v1/*' }, 'https://api.example.com/v2/items')).toBe(
      false,
    );
  });
  it('does not turn matching into an authorization or HTTPS override', () => {
    expect(serviceMatchesResource({ host: '*.example.com', https_only: true }, 'http://api.example.com/')).toBe(false);
    expect(serviceMatchesResource({ host: '*.example.com', enabled: false }, 'https://api.example.com/')).toBe(false);
    expect(serviceMatchesResource({ host: 'api.example.com/API/*' }, 'https://api.example.com/api/items')).toBe(false);
    expect(serviceMatchesResource({ host: 'api.example.com' }, 'https://evil.example/')).toBe(false);
    expect(serviceMatchesResource({ host: 'api.example.com' }, 'bad')).toBe(false);
  });
});
