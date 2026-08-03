/**
 * Optimistic-concurrency tests for the file API's `write` op.
 *
 * The `write` endpoint (`POST /api/groups/:gid/write`) accepts an `If-Match`
 * precondition — either the header or an `ifMatch` body field — carrying the
 * ETag the client last read. A stale token yields 412 so a client can never
 * clobber a version it hasn't seen. Reads (`?meta=1`) expose the ETag.
 */
import fs from 'fs';
import http from 'http';
import path from 'path';
import { Writable } from 'stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const TEST_ROOT = '/tmp/nanoclaw-test-ui-write-concurrency';
const TEST_GROUPS_DIR = path.join(TEST_ROOT, 'groups');
const TEST_DATA_DIR = path.join(TEST_ROOT, 'data');

vi.mock('../../../config.js', async () => {
  const actual = await vi.importActual<typeof import('../../../config.js')>('../../../config.js');
  return {
    ...actual,
    GROUPS_DIR: '/tmp/nanoclaw-test-ui-write-concurrency/groups',
    DATA_DIR: '/tmp/nanoclaw-test-ui-write-concurrency/data',
    PAGES_BASE_DOMAIN: 'pages.test',
  };
});

let mockUserId: string | null = null;
vi.mock('../auth.js', () => ({
  authenticate: () => (mockUserId ? { userId: mockUserId } : null),
  recordAccess: vi.fn(),
}));

import { initTestDb, closeDb, runMigrations, getDb } from '../../../db/index.js';
import { grantRole } from '../../../modules/permissions/db/user-roles.js';
import { handle } from './routes.js';

const NOW = () => new Date().toISOString();

interface CapturedRes {
  done: Promise<void>;
  res: http.ServerResponse;
  status(): number;
  header(name: string): string | undefined;
  body(): unknown;
}

function makeRes(): CapturedRes {
  let status = 0;
  const headers = new Map<string, string>();
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
  res.setHeader = ((name: string, value: string | number | string[]) => {
    headers.set(String(name).toLowerCase(), String(value));
    return res;
  }) as http.ServerResponse['setHeader'];
  res.writeHead = ((s: number, hdrs?: http.OutgoingHttpHeaders) => {
    status = s;
    if (hdrs) for (const [k, v] of Object.entries(hdrs)) headers.set(k.toLowerCase(), String(v));
    return res;
  }) as http.ServerResponse['writeHead'];
  w.on('finish', resolve);
  return {
    done,
    res,
    status: () => status,
    header: (name: string) => headers.get(name.toLowerCase()),
    body: () => {
      const raw = Buffer.concat(chunks).toString('utf-8');
      try {
        return JSON.parse(raw) as unknown;
      } catch {
        return raw;
      }
    },
  };
}

function makeReq(
  method: string,
  url: string,
  opts: { body?: unknown; headers?: Record<string, string> } = {},
): http.IncomingMessage {
  const buf = opts.body !== undefined ? Buffer.from(JSON.stringify(opts.body)) : Buffer.alloc(0);
  let pulled = false;
  return {
    method,
    url,
    headers: { host: 'localhost', 'content-type': 'application/json', ...(opts.headers ?? {}) },
    socket: { remoteAddress: '127.0.0.1' },
    [Symbol.asyncIterator]() {
      return {
        next: () => {
          if (pulled || buf.length === 0) return Promise.resolve({ value: undefined, done: true });
          pulled = true;
          return Promise.resolve({ value: buf, done: false });
        },
      };
    },
  } as unknown as http.IncomingMessage;
}

async function call(
  method: string,
  url: string,
  opts: { body?: unknown; headers?: Record<string, string> } = {},
): Promise<CapturedRes> {
  const cap = makeRes();
  await handle(makeReq(method, url, opts), cap.res);
  try {
    cap.res.end();
  } catch {
    /* already ended */
  }
  await cap.done;
  return cap;
}

const GID = 'ag-write';
const FOLDER = 'write-group';
const ADMIN = 'web:admin';

function seedUser(id: string): void {
  getDb().prepare(`INSERT INTO users (id, kind, display_name, created_at) VALUES (?, 'web', ?, ?)`).run(id, id, NOW());
}

function seedGroup(): void {
  getDb()
    .prepare(`INSERT INTO agent_groups (id, name, folder, agent_provider, created_at) VALUES (?, ?, ?, NULL, ?)`)
    .run(GID, FOLDER, FOLDER, NOW());
  getDb().prepare(`INSERT INTO container_configs (agent_group_id, updated_at) VALUES (?, ?)`).run(GID, NOW());
  fs.mkdirSync(path.join(TEST_GROUPS_DIR, FOLDER), { recursive: true });
}

function writeFile(rel: string, content: string): void {
  fs.writeFileSync(path.join(TEST_GROUPS_DIR, FOLDER, rel), content, 'utf-8');
}

function readFile(rel: string): string {
  return fs.readFileSync(path.join(TEST_GROUPS_DIR, FOLDER, rel), 'utf-8');
}

beforeEach(() => {
  if (fs.existsSync(TEST_ROOT)) fs.rmSync(TEST_ROOT, { recursive: true });
  fs.mkdirSync(TEST_GROUPS_DIR, { recursive: true });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
  const db = initTestDb();
  runMigrations(db);
  seedUser(ADMIN);
  seedGroup();
  grantRole({ user_id: ADMIN, role: 'admin', agent_group_id: GID, granted_by: ADMIN, granted_at: NOW() });
  mockUserId = ADMIN;
});

afterEach(() => {
  closeDb();
  if (fs.existsSync(TEST_ROOT)) fs.rmSync(TEST_ROOT, { recursive: true });
});

describe('file API origin policy', () => {
  it('does not grant an enabled Pages origin cross-origin access', async () => {
    getDb().prepare(`UPDATE agent_groups SET site_enabled = 1, site_slug = 'write' WHERE id = ?`).run(GID);
    writeFile('state.json', '{"n":1}');

    const response = await call('GET', `/api/groups/${GID}/files/state.json`, {
      headers: { origin: 'https://write.pages.test' },
    });

    expect(response.status()).toBe(200);
    expect(response.header('access-control-allow-origin')).toBeUndefined();
    expect(response.header('access-control-allow-credentials')).toBeUndefined();

    const preflight = await call('OPTIONS', `/api/groups/${GID}/write`, {
      headers: {
        origin: 'https://write.pages.test',
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'content-type, if-match',
      },
    });

    expect(preflight.status()).not.toBe(204);
    expect(preflight.header('access-control-allow-origin')).toBeUndefined();
    expect(preflight.header('access-control-allow-methods')).toBeUndefined();
  });
});

describe('file write optimistic concurrency', () => {
  it('atomically creates a new file with its initial content', async () => {
    const w = await call('POST', `/api/groups/${GID}/write`, {
      body: { path: 'notes.md', content: '# Notes\n', create: true },
    });
    expect(w.status()).toBe(201);
    expect(readFile('notes.md')).toBe('# Notes\n');
    expect((w.body() as { etag?: string }).etag).toMatch(/^"[0-9a-f]{16}"$/);
  });

  it('create mode rejects a collision without changing the existing file', async () => {
    writeFile('notes.md', 'existing');
    const w = await call('POST', `/api/groups/${GID}/write`, {
      body: { path: 'notes.md', content: 'replacement', create: true },
    });
    expect(w.status()).toBe(409);
    expect((w.body() as { error: string }).error).toBe('exists');
    expect(readFile('notes.md')).toBe('existing');
  });

  it('meta exposes an ETag; read + write round-trips it', async () => {
    writeFile('state.json', '{"n":1}');
    const meta = await call('GET', `/api/groups/${GID}/files/state.json?meta=1`);
    expect(meta.status()).toBe(200);
    const etag = (meta.body() as { etag?: string }).etag;
    expect(typeof etag).toBe('string');
    expect(etag).toMatch(/^"[0-9a-f]{16}"$/);
    expect(meta.header('etag')).toBe(etag);

    const w = await call('POST', `/api/groups/${GID}/write`, {
      body: { path: 'state.json', content: '{"n":2}', ifMatch: etag },
    });
    expect(w.status()).toBe(200);
    expect(readFile('state.json')).toBe('{"n":2}');
    // A fresh, different ETag comes back.
    const newEtag = (w.body() as { etag?: string }).etag;
    expect(newEtag).toMatch(/^"[0-9a-f]{16}"$/);
    expect(w.header('etag')).toBe(newEtag);
  });

  it('write with no precondition overwrites (backward compatible)', async () => {
    writeFile('state.json', 'a');
    const w = await call('POST', `/api/groups/${GID}/write`, { body: { path: 'state.json', content: 'b' } });
    expect(w.status()).toBe(200);
    expect(readFile('state.json')).toBe('b');
  });

  it('stale If-Match header is rejected with 412 and current ETag', async () => {
    writeFile('state.json', 'orig');
    const meta = await call('GET', `/api/groups/${GID}/files/state.json?meta=1`);
    const staleEtag = (meta.body() as { etag: string }).etag;

    // Something else changes the file after we read it.
    writeFile('state.json', 'changed-by-someone-else');

    const w = await call('POST', `/api/groups/${GID}/write`, {
      body: { path: 'state.json', content: 'my-clobber' },
      headers: { 'if-match': staleEtag },
    });
    expect(w.status()).toBe(412);
    expect((w.body() as { error: string }).error).toBe('precondition_failed');
    // Disk is untouched; response advertises the current version.
    expect(readFile('state.json')).toBe('changed-by-someone-else');
    const current = (w.body() as { etag: string }).etag;
    expect(current).not.toBe(staleEtag);
    expect(w.header('etag')).toBe(current);
  });

  it('matching If-Match header succeeds after re-read', async () => {
    writeFile('state.json', 'orig');
    const meta = await call('GET', `/api/groups/${GID}/files/state.json?meta=1`);
    const etag = (meta.body() as { etag: string }).etag;
    const w = await call('POST', `/api/groups/${GID}/write`, {
      body: { path: 'state.json', content: 'next' },
      headers: { 'if-match': etag },
    });
    expect(w.status()).toBe(200);
    expect(readFile('state.json')).toBe('next');
  });

  it('If-Match: * succeeds when the file exists', async () => {
    writeFile('state.json', 'orig');
    const w = await call('POST', `/api/groups/${GID}/write`, {
      body: { path: 'state.json', content: 'star' },
      headers: { 'if-match': '*' },
    });
    expect(w.status()).toBe(200);
    expect(readFile('state.json')).toBe('star');
  });
});
