import fs from 'fs';
import http from 'http';
import path from 'path';
import { Readable, Writable } from 'stream';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

process.env.PAGES_BASE_DOMAIN = 'pages.test';

type PrivateWebMod = typeof import('./private-web.js');
type DbMod = typeof import('../../../db/index.js');
type ConfigMod = typeof import('../../../config.js');
type UiDbMod = typeof import('../db.js');
type SessionMod = typeof import('../private-web-db.js');

let privateWeb: PrivateWebMod;
let db: DbMod;
let config: ConfigMod;
let uiDb: UiDbMod;
let sessions: SessionMod;

const USER_ID = 'web:private-member';
const GROUP_ID = 'private-web-host-test';
const FOLDER = `__private_web_test_${process.pid}`;
let groupRoot: string;

interface CapturedRes {
  res: http.ServerResponse;
  done: Promise<void>;
  status(): number;
  header(name: string): string | undefined;
  body(): string;
}

function makeRes(): CapturedRes {
  let status = 0;
  const headers = new Map<string, string>();
  const chunks: Buffer[] = [];
  let resolve!: () => void;
  const done = new Promise<void>((doneResolve) => {
    resolve = doneResolve;
  });
  const writable = new Writable({
    write(chunk, _encoding, callback): void {
      chunks.push(Buffer.from(chunk));
      callback();
    },
  });
  const res = writable as unknown as http.ServerResponse;
  res.writeHead = ((nextStatus: number, nextHeaders?: http.OutgoingHttpHeaders) => {
    status = nextStatus;
    for (const [name, value] of Object.entries(nextHeaders || {})) {
      if (value !== undefined) headers.set(name.toLowerCase(), String(value));
    }
    return res;
  }) as http.ServerResponse['writeHead'];
  writable.on('finish', resolve);
  return {
    res,
    done,
    status: () => status,
    header: (name) => headers.get(name.toLowerCase()),
    body: () => Buffer.concat(chunks).toString('utf8'),
  };
}

function makeReq(args: {
  host: string;
  url?: string;
  method?: string;
  cookie?: string;
  ifMatch?: string;
  body?: string;
  accept?: string;
  fetchDest?: string;
}): http.IncomingMessage {
  const req = Readable.from(args.body === undefined ? [] : [Buffer.from(args.body)]) as unknown as http.IncomingMessage;
  req.method = args.method || 'GET';
  req.url = args.url || '/';
  req.headers = {
    host: args.host,
    ...(args.cookie ? { cookie: args.cookie } : {}),
    ...(args.ifMatch ? { 'if-match': args.ifMatch } : {}),
    ...(args.accept ? { accept: args.accept } : {}),
    ...(args.fetchDest ? { 'sec-fetch-dest': args.fetchDest } : {}),
  };
  Object.defineProperty(req, 'socket', { value: { remoteAddress: '127.0.0.1' } });
  return req;
}

async function call(args: Parameters<typeof makeReq>[0]): Promise<CapturedRes> {
  const captured = makeRes();
  expect(await privateWeb.handlePrivateWebRequest(makeReq(args), captured.res)).toBe(true);
  await captured.done;
  return captured;
}

function issue(): { id: string; handoffToken: string; host: string } {
  const uiSession = uiDb.createSession(USER_ID, 60_000);
  const privateSession = sessions.createPrivateWebSession({
    parentSessionHash: uiDb.hashToken(uiSession.token),
    userId: USER_ID,
    agentGroupId: GROUP_ID,
  });
  return {
    ...privateSession,
    host: `secure-${privateSession.id}.pages.test`,
  };
}

async function redeem(): Promise<{ host: string; cookie: string }> {
  const issued = issue();
  const response = await call({
    host: issued.host,
    url: `/_auth/redeem?t=${encodeURIComponent(issued.handoffToken)}&next=${encodeURIComponent('/report/index.html')}`,
  });
  expect(response.status()).toBe(303);
  expect(response.header('location')).toBe('/report/index.html');
  const setCookie = response.header('set-cookie');
  expect(setCookie).toContain('HttpOnly');
  expect(setCookie).toContain('Secure');
  expect(setCookie).not.toContain('Domain=');
  return { host: issued.host, cookie: setCookie!.split(';')[0] };
}

beforeAll(async () => {
  db = await import('../../../db/index.js');
  config = await import('../../../config.js');
  uiDb = await import('../db.js');
  sessions = await import('../private-web-db.js');
  privateWeb = await import('./private-web.js');
  const database = db.initTestDb();
  db.runMigrations(database);
  database
    .prepare(`INSERT INTO users (id, kind, display_name, created_at) VALUES (?, 'web', ?, datetime('now'))`)
    .run(USER_ID, 'Private Member');
  db.createAgentGroup({
    id: GROUP_ID,
    name: 'Private Web',
    folder: FOLDER,
    agent_provider: null,
    created_at: new Date().toISOString(),
  });
  database
    .prepare(
      `INSERT INTO agent_group_members (user_id, agent_group_id, added_by, added_at) VALUES (?, ?, NULL, datetime('now'))`,
    )
    .run(USER_ID, GROUP_ID);
  groupRoot = path.join(config.GROUPS_DIR, FOLDER);
  fs.mkdirSync(path.join(groupRoot, 'report'), { recursive: true });
  fs.mkdirSync(path.join(groupRoot, '.secret'), { recursive: true });
  fs.writeFileSync(path.join(groupRoot, 'report', 'index.html'), '<link rel="stylesheet" href="../style.css">');
  fs.writeFileSync(path.join(groupRoot, 'style.css'), 'body{color:red}');
  fs.writeFileSync(path.join(groupRoot, 'state.json'), '{"n":1}');
  fs.writeFileSync(path.join(groupRoot, 'container.json'), 'ADMIN');
  fs.writeFileSync(path.join(groupRoot, '.secret', 'token.txt'), 'SECRET');
  fs.mkdirSync(path.join(groupRoot, '_auth'), { recursive: true });
  fs.writeFileSync(path.join(groupRoot, '_auth', 'workspace.txt'), 'RESERVED');
  fs.writeFileSync(path.join(groupRoot, 'report', 'daily 100%.html'), '<h1>special</h1>');
  fs.symlinkSync(path.join(groupRoot, 'state.json'), path.join(groupRoot, 'state-link.json'));
  fs.symlinkSync(path.join(groupRoot, 'container.json'), path.join(groupRoot, 'public-link.json'));
});

afterAll(() => {
  fs.rmSync(groupRoot, { recursive: true, force: true });
  db.closeDb();
});

describe('private web host', () => {
  it('claims malformed secure hosts and rejects an invalid local next path', async () => {
    const malformed = await call({ host: 'secure-nope.pages.test' });
    expect(malformed.status()).toBe(404);
    expect((await call({ host: 'secure-nope.extra.pages.test' })).status()).toBe(404);

    const issued = issue();
    const badNext = await call({
      host: issued.host,
      url: `/_auth/redeem?t=${issued.handoffToken}&next=${encodeURIComponent('//outside.test/')}`,
    });
    expect(badNext.status()).toBe(400);
  });

  it('redeems once and serves member-visible files across the group workspace', async () => {
    const { host, cookie } = await redeem();
    const html = await call({ host, url: '/report/index.html', cookie });
    expect(html.status()).toBe(200);
    expect(html.body()).toBe('<link rel="stylesheet" href="../style.css">');
    expect(html.header('content-security-policy')).toContain("connect-src 'self'");
    expect(html.header('content-security-policy')).toContain('sandbox allow-scripts allow-same-origin');
    // WebAssembly is allowed, but plain eval() is not.
    expect(html.header('content-security-policy')).toContain("'wasm-unsafe-eval'");
    expect(html.header('content-security-policy')).not.toContain("'unsafe-eval'");

    const css = await call({ host, url: '/style.css', cookie });
    expect(css.status()).toBe(200);
    expect(css.body()).toBe('body{color:red}');
  });

  it('redeems preview sessions into a system shell without transforming workspace HTML', async () => {
    const issued = issue();
    const redeemed = await call({
      host: issued.host,
      url: `/_auth/redeem?t=${encodeURIComponent(issued.handoffToken)}&next=${encodeURIComponent('/report/index.html')}&preview=1`,
    });
    expect(redeemed.status()).toBe(303);
    expect(redeemed.header('location')).toBe('/_preview?path=%2Freport%2Findex.html');
    const cookie = redeemed.header('set-cookie')!.split(';')[0];

    const shell = await call({ host: issued.host, url: redeemed.header('location'), cookie });
    expect(shell.status()).toBe(200);
    expect(shell.body()).toContain('id="preview-content" src="/report/index.html"');
    expect(shell.body()).toContain("frame.style.transform = 'scale(' + scale + ')'");
    expect(shell.body()).toContain("event.data?.type === 'nanoclaw-private-web-expired'");

    const document = await call({ host: issued.host, url: '/report/index.html', cookie });
    expect(document.body()).toBe('<link rel="stylesheet" href="../style.css">');
  });

  it('redirects special-character entry paths with exactly one encoding pass', async () => {
    const issued = issue();
    const url = new URL(`https://${issued.host}/_auth/redeem`);
    url.searchParams.set('t', issued.handoffToken);
    url.searchParams.set('next', '/report/daily 100%.html');
    const response = await call({ host: issued.host, url: `${url.pathname}${url.search}` });
    expect(response.status()).toBe(303);
    expect(response.header('location')).toBe('/report/daily%20100%25.html');
  });

  it('denies hidden, admin-only, and traversal paths', async () => {
    const { host, cookie } = await redeem();
    expect((await call({ host, url: '/container.json', cookie })).status()).toBe(404);
    expect((await call({ host, url: '/.secret/token.txt', cookie })).status()).toBe(404);
    expect((await call({ host, url: '/public-link.json', cookie })).status()).toBe(404);
    expect((await call({ host, url: '/_auth/workspace.txt', cookie })).status()).toBe(404);
    expect((await call({ host, url: '/bad%00name.txt', cookie })).status()).toBe(404);
    expect((await call({ host, url: '/%2e%2e/CLAUDE.md', cookie })).status()).toBe(404);
  });

  it('requires an exact current ETag to replace an existing file', async () => {
    const { host, cookie } = await redeem();
    const read = await call({ host, url: '/state.json', cookie });
    const etag = read.header('etag');
    expect(etag).toMatch(/^"[0-9a-f]{16}"$/);

    expect((await call({ host, url: '/state.json', method: 'PUT', cookie, body: '{"n":2}' })).status()).toBe(428);
    expect(
      (await call({ host, url: '/state.json', method: 'PUT', cookie, ifMatch: '*', body: '{"n":2}' })).status(),
    ).toBe(428);

    const replaced = await call({ host, url: '/state.json', method: 'PUT', cookie, ifMatch: etag, body: '{"n":2}' });
    expect(replaced.status()).toBe(204);
    expect(fs.readFileSync(path.join(groupRoot, 'state.json'), 'utf8')).toBe('{"n":2}');
    expect(replaced.header('etag')).not.toBe(etag);

    const stale = await call({ host, url: '/state.json', method: 'PUT', cookie, ifMatch: etag, body: '{"n":3}' });
    expect(stale.status()).toBe(412);
    expect(fs.readFileSync(path.join(groupRoot, 'state.json'), 'utf8')).toBe('{"n":2}');
  });

  it('allows only one concurrent replacement for the same ETag', async () => {
    const { host, cookie } = await redeem();
    const current = await call({ host, url: '/state.json', cookie });
    const etag = current.header('etag');
    const results = await Promise.all([
      call({ host, url: '/state.json', method: 'PUT', cookie, ifMatch: etag, body: '{"winner":1}' }),
      call({ host, url: '/state.json', method: 'PUT', cookie, ifMatch: etag, body: '{"winner":2}' }),
    ]);
    expect(results.map((result) => result.status()).sort()).toEqual([204, 412]);
    expect(['{"winner":1}', '{"winner":2}']).toContain(fs.readFileSync(path.join(groupRoot, 'state.json'), 'utf8'));
  });

  it('signals renewal only for expired document navigations', async () => {
    const issued = issue();
    const subresource = await call({ host: issued.host, url: '/style.css' });
    expect(subresource.status()).toBe(401);
    expect(subresource.body()).not.toContain('postMessage');

    const document = await call({ host: issued.host, url: '/report/index.html', fetchDest: 'iframe' });
    expect(document.status()).toBe(401);
    expect(document.body()).toContain("type:'nanoclaw-private-web-expired'");
  });

  it('does not replace symlinks or create missing files', async () => {
    const { host, cookie } = await redeem();
    const target = await call({ host, url: '/state.json', cookie });
    expect(
      (
        await call({
          host,
          url: '/state-link.json',
          method: 'PUT',
          cookie,
          ifMatch: target.header('etag'),
          body: 'bad',
        })
      ).status(),
    ).toBe(404);
    expect(
      (await call({ host, url: '/missing.json', method: 'PUT', cookie, ifMatch: '"missing"', body: 'new' })).status(),
    ).toBe(404);
  });

  it('advertises conditional replacement on unsupported methods', async () => {
    const { host, cookie } = await redeem();
    const response = await call({ host, url: '/state.json', method: 'POST', cookie });
    expect(response.status()).toBe(405);
    expect(response.header('allow')).toBe('GET, HEAD, PUT');
  });

  it('rechecks group membership on every request', async () => {
    const { host, cookie } = await redeem();
    db.getDb()
      .prepare('DELETE FROM agent_group_members WHERE user_id = ? AND agent_group_id = ?')
      .run(USER_ID, GROUP_ID);
    expect((await call({ host, url: '/report/index.html', cookie })).status()).toBe(404);
    db.getDb()
      .prepare(
        `INSERT INTO agent_group_members (user_id, agent_group_id, added_by, added_at) VALUES (?, ?, NULL, datetime('now'))`,
      )
      .run(USER_ID, GROUP_ID);
  });
});
