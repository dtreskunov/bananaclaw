// Integration tests for the static-website serve handler. Exercises the
// security-critical paths: host gating, path traversal rejection,
// index.html resolution, the workspace-root escape guard, and method
// rejection. PAGES_BASE_DOMAIN + a real fixture under groups/ are required,
// so config-reading modules are imported dynamically after the env is set.
import fs from 'fs';
import http from 'http';
import path from 'path';
import { Writable } from 'stream';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

process.env.PAGES_BASE_DOMAIN = 'pages.test';

type ServeMod = typeof import('./serve.js');
type DbMod = typeof import('../../../db/index.js');
type ConfigMod = typeof import('../../../config.js');

let serve: ServeMod;
let db: DbMod;
let config: ConfigMod;

const FOLDER = `__site_test_${process.pid}`;
const SLUG = 'svsite';
let siteRoot: string;
let groupRoot: string;

function now(): string {
  return new Date().toISOString();
}

interface CapturedRes {
  res: http.ServerResponse;
  done: Promise<void>;
  status(): number;
  headers(): http.OutgoingHttpHeaders;
  body(): string;
}

function makeRes(): CapturedRes {
  let status = 0;
  let headers: http.OutgoingHttpHeaders = {};
  const chunks: Buffer[] = [];
  let resolve!: () => void;
  const done = new Promise<void>((r) => {
    resolve = r;
  });

  const w = new Writable({
    write(chunk, _enc, cb): void {
      chunks.push(Buffer.from(chunk));
      cb();
    },
  });
  const res = w as unknown as http.ServerResponse;
  res.writeHead = ((s: number, h?: http.OutgoingHttpHeaders) => {
    status = s;
    if (h) headers = h;
    return res;
  }) as http.ServerResponse['writeHead'];
  w.on('finish', resolve);

  return {
    res,
    done,
    status: () => status,
    headers: () => headers,
    body: () => Buffer.concat(chunks).toString('utf-8'),
  };
}

function makeReq(host: string | undefined, url = '/', method = 'GET'): http.IncomingMessage {
  return { headers: { host }, url, method } as unknown as http.IncomingMessage;
}

beforeAll(async () => {
  db = await import('../../../db/index.js');
  serve = await import('./serve.js');
  config = await import('../../../config.js');
  const d = db.initTestDb();
  db.runMigrations(d);

  groupRoot = path.join(config.GROUPS_DIR, FOLDER);
  siteRoot = path.join(groupRoot, `${SLUG}.pages.test`);
  fs.mkdirSync(siteRoot, { recursive: true });
  fs.writeFileSync(path.join(siteRoot, 'index.html'), '<h1>hello</h1>');
  fs.writeFileSync(path.join(siteRoot, 'style.css'), 'body{color:red}');
  fs.mkdirSync(path.join(siteRoot, 'sub'), { recursive: true });
  fs.writeFileSync(path.join(siteRoot, 'sub', 'index.html'), '<p>sub</p>');
  // A sensitive file in the group root that must never be reachable.
  fs.writeFileSync(path.join(groupRoot, 'CLAUDE.md'), 'SECRET');

  db.createAgentGroup({ id: 'svg', name: 'Site', folder: FOLDER, agent_provider: null, created_at: now() });
  db.updateAgentGroup('svg', { site_slug: SLUG, site_enabled: 1 });
  db.createAgentGroup({ id: 'svgoff', name: 'Off', folder: `${FOLDER}_off`, agent_provider: null, created_at: now() });
  db.updateAgentGroup('svgoff', { site_slug: 'offsite', site_enabled: 0 });
});

afterAll(() => {
  fs.rmSync(groupRoot, { recursive: true, force: true });
  db.closeDb();
});

describe('handlePagesRequest', () => {
  it('declines requests whose host is not a site subdomain', () => {
    const c = makeRes();
    expect(serve.handlePagesRequest(makeReq('pages.test'), c.res)).toBe(false);
    expect(serve.handlePagesRequest(makeReq(undefined), makeRes().res)).toBe(false);
  });

  it('declines a disabled group', () => {
    const c = makeRes();
    expect(serve.handlePagesRequest(makeReq('offsite.pages.test'), c.res)).toBe(false);
  });

  it('serves index.html at the root', async () => {
    const c = makeRes();
    expect(serve.handlePagesRequest(makeReq('svsite.pages.test', '/'), c.res)).toBe(true);
    await c.done;
    expect(c.status()).toBe(200);
    expect(c.headers()['Content-Type']).toBe('text/html; charset=utf-8');
    expect(c.headers()['X-Content-Type-Options']).toBe('nosniff');
    expect(c.body()).toBe('<h1>hello</h1>');
  });

  it('serves a nested directory index.html', async () => {
    const c = makeRes();
    expect(serve.handlePagesRequest(makeReq('svsite.pages.test', '/sub/'), c.res)).toBe(true);
    await c.done;
    expect(c.status()).toBe(200);
    expect(c.body()).toBe('<p>sub</p>');
  });

  it('serves a css asset with the right type', async () => {
    const c = makeRes();
    expect(serve.handlePagesRequest(makeReq('svsite.pages.test', '/style.css'), c.res)).toBe(true);
    await c.done;
    expect(c.status()).toBe(200);
    expect(c.headers()['Content-Type']).toBe('text/css; charset=utf-8');
  });

  it('404s a missing file', async () => {
    const c = makeRes();
    expect(serve.handlePagesRequest(makeReq('svsite.pages.test', '/nope.txt'), c.res)).toBe(true);
    await c.done;
    expect(c.status()).toBe(404);
  });

  it('rejects path traversal out of the site root', async () => {
    const c = makeRes();
    // ../CLAUDE.md would escape into the group root if not guarded.
    expect(serve.handlePagesRequest(makeReq('svsite.pages.test', '/../CLAUDE.md'), c.res)).toBe(true);
    await c.done;
    expect(c.status()).toBe(404);
    expect(c.body()).not.toContain('SECRET');
  });

  it('rejects encoded traversal', async () => {
    const c = makeRes();
    expect(serve.handlePagesRequest(makeReq('svsite.pages.test', '/%2e%2e/CLAUDE.md'), c.res)).toBe(true);
    await c.done;
    expect(c.status()).toBe(404);
  });

  it('rejects non-GET/HEAD methods with 405', async () => {
    const c = makeRes();
    expect(serve.handlePagesRequest(makeReq('svsite.pages.test', '/', 'POST'), c.res)).toBe(true);
    await c.done;
    expect(c.status()).toBe(405);
    expect(c.headers()['Allow']).toBe('GET, HEAD');
  });

  it('keeps public Pages read-only', async () => {
    const c = makeRes();
    expect(serve.handlePagesRequest(makeReq('svsite.pages.test', '/style.css', 'PUT'), c.res)).toBe(true);
    await c.done;
    expect(c.status()).toBe(405);
    expect(fs.readFileSync(path.join(siteRoot, 'style.css'), 'utf8')).toBe('body{color:red}');
  });

  it('supports HEAD without a body', async () => {
    const c = makeRes();
    expect(serve.handlePagesRequest(makeReq('svsite.pages.test', '/', 'HEAD'), c.res)).toBe(true);
    await c.done;
    expect(c.status()).toBe(200);
    expect(c.body()).toBe('');
  });
});
