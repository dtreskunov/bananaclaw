import { describe, it, expect } from 'vitest';

import { decideFileApiCors } from './cors.js';

const PAGES = 'https://treskowitz.bananaclaw.app';
// Resolver: only group "g-tres" has this Pages origin; everything else null.
const resolve = (gid: string): string | null => (gid === 'g-tres' ? PAGES : null);

describe('decideFileApiCors — eligibility', () => {
  it('returns null for non-file-API paths', () => {
    expect(decideFileApiCors('/api/groups/g-tres/chat/foo', 'GET', PAGES, resolve)).toBeNull();
    expect(decideFileApiCors('/api/groups/g-tres/config', 'GET', PAGES, resolve)).toBeNull();
    expect(decideFileApiCors('/api/groups/g-tres/zip', 'GET', PAGES, resolve)).toBeNull();
    expect(decideFileApiCors('/index.html', 'GET', PAGES, resolve)).toBeNull();
  });

  it('matches file read and write endpoints', () => {
    for (const p of [
      '/api/groups/g-tres/files/wedding/initial-values.json',
      '/api/groups/g-tres/dirs',
      '/api/groups/g-tres/dirs/wedding',
      '/api/groups/g-tres/write',
      '/api/groups/g-tres/upload',
      '/api/groups/g-tres/mkdir',
      '/api/groups/g-tres/touch',
      '/api/groups/g-tres/rename',
      '/api/groups/g-tres/delete',
    ]) {
      expect(decideFileApiCors(p, 'GET', PAGES, resolve)).not.toBeNull();
    }
  });
});

describe('decideFileApiCors — allowed origin', () => {
  it('emits credentialed CORS headers when the origin matches the group site', () => {
    const d = decideFileApiCors('/api/groups/g-tres/files/x.json', 'GET', PAGES, resolve)!;
    expect(d.headers['Access-Control-Allow-Origin']).toBe(PAGES);
    expect(d.headers['Access-Control-Allow-Credentials']).toBe('true');
    expect(d.headers['Access-Control-Expose-Headers']).toBe('ETag');
    expect(d.headers['Vary']).toBe('Origin');
    expect(d.preflight).toBeUndefined();
  });

  it('answers a matching preflight with 204 and method/header allowances', () => {
    const d = decideFileApiCors('/api/groups/g-tres/write', 'OPTIONS', PAGES, resolve)!;
    expect(d.preflight).toEqual({ status: 204 });
    expect(d.headers['Access-Control-Allow-Origin']).toBe(PAGES);
    expect(d.headers['Access-Control-Allow-Methods']).toContain('POST');
    expect(d.headers['Access-Control-Allow-Headers']).toContain('If-Match');
    expect(d.headers['Access-Control-Max-Age']).toBe('600');
  });
});

describe('decideFileApiCors — disallowed origin', () => {
  it('emits no CORS headers when the origin does not match the group site', () => {
    // A page on group A's site trying to reach group g-tres's files: the
    // resolver returns g-tres's origin, which won't equal the attacker origin.
    const evil = 'https://evil.example.com';
    const d = decideFileApiCors('/api/groups/g-tres/files/secret.json', 'GET', evil, resolve)!;
    expect(d.headers).toEqual({});
  });

  it('cross-group request gets no headers (path group has no/other origin)', () => {
    // Page origin is g-tres's site, but the path targets a different group
    // whose resolver returns null → no match.
    const d = decideFileApiCors('/api/groups/g-other/files/secret.json', 'GET', PAGES, resolve)!;
    expect(d.headers).toEqual({});
  });

  it('rejects a preflight from a disallowed origin with 403 and no CORS headers', () => {
    const d = decideFileApiCors('/api/groups/g-tres/write', 'OPTIONS', 'https://evil.example.com', resolve)!;
    expect(d.preflight).toEqual({ status: 403 });
    expect(d.headers).toEqual({});
  });

  it('emits no headers when there is no Origin (same-origin request)', () => {
    const d = decideFileApiCors('/api/groups/g-tres/files/x.json', 'GET', undefined, resolve)!;
    expect(d.headers).toEqual({});
  });
});
