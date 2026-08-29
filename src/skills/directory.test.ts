import { afterEach, describe, expect, it, vi } from 'vitest';

import { auditIsBlocking, fetchAudits, searchDirectory, DirectoryError } from './directory.js';

interface StubCall {
  url: string;
  token: string | null;
}

/**
 * Replace global fetch with a route table. Returns the calls made so tests can
 * assert which skills.sh endpoint was used and whether it carried a token.
 */
function stubFetch(routes: Record<string, { status: number; body: unknown }>): StubCall[] {
  const calls: StubCall[] = [];
  vi.stubGlobal('fetch', (input: string, init?: { headers?: Record<string, string> }) => {
    const url = String(input);
    const auth = init?.headers?.authorization ?? null;
    calls.push({ url, token: auth ? auth.replace(/^Bearer /, '') : null });
    const match = Object.entries(routes).find(([prefix]) => url.includes(prefix));
    const hit = match?.[1] ?? { status: 404, body: { error: 'not_found' } };
    return Promise.resolve({
      status: hit.status,
      json: () => Promise.resolve(hit.body),
    } as Response);
  });
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.SKILLS_SH_TOKEN;
});

describe('searchDirectory', () => {
  it('normalizes the unauthenticated legacy shape', async () => {
    stubFetch({
      '/api/search': {
        status: 200,
        body: {
          query: 'alpha-query',
          searchType: 'fuzzy',
          skills: [
            { id: 'anthropics/skills/pdf', skillId: 'pdf', name: 'pdf', installs: 186605, source: 'anthropics/skills' },
            { id: 'broken', name: 'no source' },
          ],
        },
      },
    });

    const result = await searchDirectory('alpha-query');
    expect(result.authenticated).toBe(false);
    expect(result.searchType).toBe('fuzzy');
    // The entry without a `source` is dropped — we can't turn it into a catalog.
    expect(result.skills).toEqual([
      {
        id: 'anthropics/skills/pdf',
        slug: 'pdf',
        name: 'pdf',
        source: 'anthropics/skills',
        installs: 186605,
        url: null,
      },
    ]);
  });

  it('uses the v1 endpoint with a bearer token when one is configured', async () => {
    process.env.SKILLS_SH_TOKEN = 'oidc-token';
    const calls = stubFetch({
      '/api/v1/skills/search': {
        status: 200,
        body: {
          searchType: 'semantic',
          data: [
            {
              id: 'expo/skills/react-native',
              slug: 'react-native',
              name: 'React Native',
              source: 'expo/skills',
              installs: 3842,
              url: 'https://skills.sh/expo/skills/react-native',
            },
          ],
        },
      },
    });

    const result = await searchDirectory('beta-query words');
    expect(result.authenticated).toBe(true);
    expect(result.skills[0]).toMatchObject({ slug: 'react-native', source: 'expo/skills' });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.token).toBe('oidc-token');
  });

  it('falls back to the legacy endpoint when the token is rejected', async () => {
    process.env.SKILLS_SH_TOKEN = 'expired';
    const calls = stubFetch({
      '/api/v1/skills/search': { status: 401, body: { error: 'authentication_required' } },
      '/api/search': {
        status: 200,
        body: { searchType: 'fuzzy', skills: [{ skillId: 'pdf', name: 'pdf', source: 'openai/skills' }] },
      },
    });

    const result = await searchDirectory('gamma-query');
    expect(result.authenticated).toBe(false);
    expect(result.skills[0]!.source).toBe('openai/skills');
    expect(calls.map((c) => c.url.includes('/api/v1/'))).toEqual([true, false]);
  });

  it('caches repeat queries instead of hammering the directory', async () => {
    const calls = stubFetch({
      '/api/search': { status: 200, body: { searchType: 'fuzzy', skills: [] } },
    });
    await searchDirectory('delta-query');
    await searchDirectory('delta-query');
    expect(calls).toHaveLength(1);
  });

  it('rejects queries the directory would refuse anyway', async () => {
    await expect(searchDirectory('a')).rejects.toBeInstanceOf(DirectoryError);
  });

  it('surfaces an unreachable directory as a DirectoryError', async () => {
    stubFetch({ '/api/search': { status: 503, body: { error: 'unavailable' } } });
    await expect(searchDirectory('epsilon-query')).rejects.toBeInstanceOf(DirectoryError);
  });
});

describe('fetchAudits', () => {
  it('normalizes audit entries', async () => {
    stubFetch({
      '/api/v1/skills/audit': {
        status: 200,
        body: {
          audits: [
            {
              provider: 'Gen Agent Trust Hub',
              slug: 'agent-trust-hub',
              status: 'pass',
              summary: 'No risks detected',
              auditedAt: '2026-02-17T18:51:16.219Z',
              riskLevel: 'SAFE',
              categories: ['PROMPT_INJECTION', 7],
            },
            { status: 'pass' },
          ],
        },
      },
    });

    const audits = await fetchAudits('anthropics/skills', 'audit-one');
    expect(audits).toHaveLength(1);
    expect(audits![0]).toMatchObject({ provider: 'Gen Agent Trust Hub', status: 'pass', riskLevel: 'SAFE' });
    expect(audits![0]!.categories).toEqual(['PROMPT_INJECTION']);
  });

  it('returns null when nobody has audited the skill', async () => {
    stubFetch({ '/api/v1/skills/audit': { status: 404, body: { error: 'not_found' } } });
    expect(await fetchAudits('anthropics/skills', 'audit-two')).toBeNull();
  });

  it('returns null rather than throwing when the directory is unreachable', async () => {
    vi.stubGlobal('fetch', () => Promise.reject(new Error('ECONNREFUSED')));
    expect(await fetchAudits('anthropics/skills', 'audit-three')).toBeNull();
  });
});

describe('auditIsBlocking', () => {
  const entry = (over: Partial<Parameters<typeof auditIsBlocking>[0][number]>) => ({
    provider: 'p',
    slug: 'p',
    status: 'pass',
    summary: '',
    auditedAt: null,
    riskLevel: null,
    categories: [],
    ...over,
  });

  it('blocks on a failing verdict or a high risk level, whatever the other partners say', () => {
    expect(auditIsBlocking([entry({}), entry({ riskLevel: 'LOW' })])).toBe(false);
    expect(auditIsBlocking([entry({}), entry({ status: 'fail', riskLevel: 'HIGH' })])).toBe(true);
    expect(auditIsBlocking([entry({ riskLevel: 'critical' })])).toBe(true);
    expect(auditIsBlocking([entry({ status: 'warn', riskLevel: 'MEDIUM' })])).toBe(false);
  });
});
