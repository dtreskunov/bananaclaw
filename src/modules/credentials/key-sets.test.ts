import { describe, expect, it } from 'vitest';
import { checkSetRevision, checkSetService, checkSetValues, parseSetValues } from './key-sets.js';

describe('key-set input validation', () => {
  it('validates write-only JSON without returning parser snippets', () => {
    expect(parseSetValues('{"ONE_KEY":"synthetic-value"}')).toEqual({ ONE_KEY: 'synthetic-value' });
    for (const raw of ['{"ONE_KEY":"synthetic-private', '[]', 'null', '"synthetic-private"']) {
      let message = '';
      try {
        parseSetValues(raw);
      } catch (error) {
        if (!(error instanceof Error)) throw error;
        message = error.message;
      }
      expect(message).toBeTruthy();
      expect(message).not.toContain('synthetic-private');
    }
    expect(() => checkSetValues({ ONE_KEY: 'line\nbreak' })).toThrow();
    expect(() => checkSetValues({ OAUTH_MANAGED: 'value' })).toThrow();
    expect(() =>
      checkSetValues(Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`KEY_${i}`, 'value']))),
    ).toThrow();
    expect(checkSetValues({})).toEqual({});
  });

  it('preserves supported service metadata and rejects malformed/unknown fields', () => {
    const service = {
      name: 'test-key',
      host: 'api.example.com:8443/path/*',
      enabled: false,
      https_only: true,
      auth: { type: 'custom', headers: { Authorization: 'Bearer {{ ONE_KEY }}' } },
      substitutions: [{ key: 'ONE_KEY', placeholder: '__KEY__', in: ['query'] }],
    };
    expect(checkSetService(service)).toEqual(service);
    for (const invalid of [
      { ...service, enabled: 'yes' },
      { ...service, unknown: true },
      { ...service, auth: { type: 'custom', headers: { Wrong: 123 } } },
      { ...service, substitutions: [{ key: 'ONE_KEY', placeholder: '__K__', in: [3] }] },
    ]) {
      expect(() => checkSetService(invalid)).toThrow();
    }
  });

  it('requires the exact opaque revision, never wildcard/list conditions', () => {
    const revision = `"${'a'.repeat(64)}"`;
    expect(checkSetRevision(revision)).toBe(revision);
    for (const invalid of [undefined, '*', 'abc', `${revision}, ${revision}`, 'W/' + revision])
      expect(() => checkSetRevision(invalid)).toThrow();
  });
});
