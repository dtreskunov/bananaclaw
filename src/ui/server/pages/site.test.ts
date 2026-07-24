// Tests for the static-website helpers. PAGES_BASE_DOMAIN must be set before
// config.js loads, so every module that reads it is imported dynamically
// inside beforeAll (after the env assignment below has run).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

process.env.PAGES_BASE_DOMAIN = 'pages.test';

type SiteMod = typeof import('./site.js');
type DbMod = typeof import('../../../db/index.js');

let site: SiteMod;
let db: DbMod;

function now(): string {
  return new Date().toISOString();
}

beforeAll(async () => {
  db = await import('../../../db/index.js');
  site = await import('./site.js');
  const d = db.initTestDb();
  db.runMigrations(d);
});

afterAll(() => {
  db.closeDb();
});

describe('sanitizeSlug', () => {
  it('lower-cases and replaces non-label chars with hyphens', () => {
    expect(site.sanitizeSlug('Good News Bot')).toBe('good-news-bot');
    expect(site.sanitizeSlug('admin@bananaclaw.app')).toBe('admin-bananaclaw-app');
    expect(site.sanitizeSlug('  --Foo__Bar--  ')).toBe('foo-bar');
  });

  it('returns empty string when nothing usable remains', () => {
    expect(site.sanitizeSlug('!!!')).toBe('');
    expect(site.sanitizeSlug('')).toBe('');
  });

  it('caps at 63 characters with no trailing hyphen', () => {
    const slug = site.sanitizeSlug('a'.repeat(100));
    expect(slug.length).toBe(63);
    expect(slug.endsWith('-')).toBe(false);
  });
});

describe('isValidSlug', () => {
  it('accepts valid DNS labels', () => {
    expect(site.isValidSlug('goodnewsbot')).toBe(true);
    expect(site.isValidSlug('a')).toBe(true);
    expect(site.isValidSlug('a-b-c')).toBe(true);
  });

  it('rejects invalid labels', () => {
    expect(site.isValidSlug('')).toBe(false);
    expect(site.isValidSlug('-leading')).toBe(false);
    expect(site.isValidSlug('trailing-')).toBe(false);
    expect(site.isValidSlug('UPPER')).toBe(false);
    expect(site.isValidSlug('has space')).toBe(false);
    expect(site.isValidSlug('a'.repeat(64))).toBe(false);
    expect(site.isValidSlug('secure-report')).toBe(false);
  });
});

describe('siteMimeFor', () => {
  it('maps common web types', () => {
    expect(site.siteMimeFor('/x/index.html')).toBe('text/html; charset=utf-8');
    expect(site.siteMimeFor('app.CSS')).toBe('text/css; charset=utf-8');
    expect(site.siteMimeFor('bundle.js')).toBe('text/javascript; charset=utf-8');
    expect(site.siteMimeFor('logo.svg')).toBe('image/svg+xml');
    expect(site.siteMimeFor('font.woff2')).toBe('font/woff2');
  });

  it('falls back to octet-stream for unknown extensions', () => {
    expect(site.siteMimeFor('archive.xyz')).toBe('application/octet-stream');
    expect(site.siteMimeFor('noext')).toBe('application/octet-stream');
  });
});

describe('siteFqdn / siteUrl', () => {
  it('builds the FQDN and URL from the slug', () => {
    expect(site.siteFqdn({ site_slug: 'goodnewsbot' })).toBe('goodnewsbot.pages.test');
    expect(site.siteUrl({ site_slug: 'goodnewsbot' })).toBe('https://goodnewsbot.pages.test/');
  });

  it('returns null without a slug', () => {
    expect(site.siteFqdn({ site_slug: null })).toBeNull();
    expect(site.siteUrl({ site_slug: null })).toBeNull();
  });
});

describe('allocateSiteSlug', () => {
  it('derives a unique slug, suffixing on collision', () => {
    db.createAgentGroup({ id: 'g1', name: 'News Bot', folder: 'g1', agent_provider: null, created_at: now() });
    db.createAgentGroup({ id: 'g2', name: 'News Bot', folder: 'g2', agent_provider: null, created_at: now() });
    db.updateAgentGroup('g1', { site_slug: 'news-bot' });

    // g2 wants the same base; should get a numeric suffix.
    const slug = site.allocateSiteSlug({ id: 'g2', name: 'News Bot' });
    expect(slug).toBe('news-bot-2');
  });

  it('reuses the base slug for the same group id', () => {
    expect(site.allocateSiteSlug({ id: 'g1', name: 'News Bot' })).toBe('news-bot');
  });

  it('returns null when the name yields no usable slug', () => {
    expect(site.allocateSiteSlug({ id: 'g3', name: '!!!' })).toBeNull();
  });

  it('keeps automatic allocations out of the secure namespace', () => {
    expect(site.allocateSiteSlug({ id: 'g4', name: 'Secure Report' })).toBe('site-secure-report');
  });
});

describe('resolveHostToGroup', () => {
  beforeAll(() => {
    db.createAgentGroup({ id: 'site', name: 'Site', folder: 'site', agent_provider: null, created_at: now() });
    db.updateAgentGroup('site', { site_slug: 'mysite', site_enabled: 1 });
    db.createAgentGroup({ id: 'off', name: 'Off', folder: 'off', agent_provider: null, created_at: now() });
    db.updateAgentGroup('off', { site_slug: 'offsite', site_enabled: 0 });
  });

  it('resolves an enabled group subdomain (port stripped)', () => {
    const m = site.resolveHostToGroup('mysite.pages.test');
    expect(m?.group.id).toBe('site');
    expect(m?.fqdn).toBe('mysite.pages.test');
    expect(site.resolveHostToGroup('mysite.pages.test:3000')?.group.id).toBe('site');
  });

  it('declines the apex domain', () => {
    expect(site.resolveHostToGroup('pages.test')).toBeNull();
  });

  it('declines a disabled group', () => {
    expect(site.resolveHostToGroup('offsite.pages.test')).toBeNull();
  });

  it('declines unknown subdomains and nested labels', () => {
    expect(site.resolveHostToGroup('nope.pages.test')).toBeNull();
    expect(site.resolveHostToGroup('a.mysite.pages.test')).toBeNull();
    expect(site.resolveHostToGroup('mysite.other.test')).toBeNull();
    expect(site.resolveHostToGroup(undefined)).toBeNull();
  });
});
