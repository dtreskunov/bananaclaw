import fs from 'fs';
import http from 'http';
import path from 'path';
import { Writable } from 'stream';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const TEST_ROOT = '/tmp/nanoclaw-test-private-web-issuance';
const TEST_GROUPS_DIR = path.join(TEST_ROOT, 'groups');
const TEST_DATA_DIR = path.join(TEST_ROOT, 'data');

process.env.UI_BASE_URL = 'http://localhost:3000/ui';

vi.mock('../../../config.js', async () => {
  const actual = await vi.importActual<typeof import('../../../config.js')>('../../../config.js');
  return {
    ...actual,
    GROUPS_DIR: '/tmp/nanoclaw-test-private-web-issuance/groups',
    DATA_DIR: '/tmp/nanoclaw-test-private-web-issuance/data',
    PAGES_BASE_DOMAIN: 'pages.test',
  };
});

let mockUserId: string | null = null;
let mockSessionHash = '';
vi.mock('../auth.js', () => ({
  authenticate: () => (mockUserId ? { userId: mockUserId, sessionHash: mockSessionHash } : null),
  recordAccess: vi.fn(),
}));

import { closeDb, createAgentGroup, getDb, initTestDb, runMigrations } from '../../../db/index.js';
import { addMember } from '../../../modules/permissions/db/agent-group-members.js';
import { createSession, hashToken } from '../db.js';
import { handle } from './routes.js';

const USER_ID = 'web:private-issuer';
const GROUP_ID = 'private-issuance-group';
const OTHER_GROUP_ID = 'private-other-group';
const FOLDER = 'private-issuance';

interface CapturedRes {
  done: Promise<void>;
  res: http.ServerResponse;
  status(): number;
  header(name: string): string | undefined;
  body(): Record<string, unknown>;
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
    done,
    res,
    status: () => status,
    header: (name) => headers.get(name.toLowerCase()),
    body: () => JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>,
  };
}

function makeReq(groupId: string, body: unknown, origin = 'http://localhost:3000'): http.IncomingMessage {
  const buffer = Buffer.from(JSON.stringify(body));
  let sent = false;
  return {
    method: 'POST',
    url: `/ui/chat/api/groups/${groupId}/private-web-session`,
    headers: { host: 'localhost:3000', origin, 'content-type': 'application/json' },
    socket: { remoteAddress: '127.0.0.1' },
    [Symbol.asyncIterator]() {
      return {
        next: () => {
          if (sent) return Promise.resolve({ value: undefined, done: true });
          sent = true;
          return Promise.resolve({ value: buffer, done: false });
        },
      };
    },
  } as unknown as http.IncomingMessage;
}

async function call(groupId: string, body: unknown, origin?: string): Promise<CapturedRes> {
  const captured = makeRes();
  await handle(makeReq(groupId, body, origin), captured.res);
  await captured.done;
  return captured;
}

beforeEach(() => {
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  fs.mkdirSync(path.join(TEST_GROUPS_DIR, FOLDER, 'reports'), { recursive: true });
  fs.mkdirSync(path.join(TEST_GROUPS_DIR, FOLDER, '.private'), { recursive: true });
  fs.writeFileSync(path.join(TEST_GROUPS_DIR, FOLDER, 'index.html'), '<h1>root</h1>');
  fs.writeFileSync(path.join(TEST_GROUPS_DIR, FOLDER, 'reports', 'daily.html'), '<h1>daily</h1>');
  fs.writeFileSync(path.join(TEST_GROUPS_DIR, FOLDER, 'reports', 'daily 100%.html'), '<h1>special</h1>');
  fs.writeFileSync(path.join(TEST_GROUPS_DIR, FOLDER, 'container.json'), '<h1>admin</h1>');
  fs.writeFileSync(path.join(TEST_GROUPS_DIR, FOLDER, '.private', 'secret.html'), '<h1>secret</h1>');
  fs.symlinkSync(path.join(TEST_GROUPS_DIR, FOLDER, 'index.html'), path.join(TEST_GROUPS_DIR, FOLDER, 'linked.html'));

  const database = initTestDb();
  runMigrations(database);
  database
    .prepare(`INSERT INTO users (id, kind, display_name, created_at) VALUES (?, 'web', ?, datetime('now'))`)
    .run(USER_ID, 'Private Issuer');
  createAgentGroup({
    id: GROUP_ID,
    name: 'Private',
    folder: FOLDER,
    agent_provider: null,
    created_at: new Date().toISOString(),
  });
  createAgentGroup({
    id: OTHER_GROUP_ID,
    name: 'Other',
    folder: 'other',
    agent_provider: null,
    created_at: new Date().toISOString(),
  });
  addMember({ user_id: USER_ID, agent_group_id: GROUP_ID, added_by: null, added_at: new Date().toISOString() });
  const uiSession = createSession(USER_ID, 60_000);
  mockUserId = USER_ID;
  mockSessionHash = hashToken(uiSession.token);
});

afterEach(() => {
  closeDb();
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
});

describe('POST private-web-session', () => {
  it('issues a fresh secure-origin handoff without persisting the entry path', async () => {
    const response = await call(GROUP_ID, { path: 'reports/daily.html' });
    expect(response.status()).toBe(201);
    expect(response.header('cache-control')).toBe('private, no-store');
    const url = new URL(String(response.body().url));
    expect(url.hostname).toMatch(/^secure-[a-f0-9]{48}\.pages\.test$/);
    expect(url.pathname).toBe('/_auth/redeem');
    expect(url.searchParams.get('next')).toBe('/reports/daily.html');
    expect(url.searchParams.get('t')).toBeTruthy();

    const columns = getDb().prepare('PRAGMA table_info(ui_private_web_sessions)').all() as { name: string }[];
    expect(columns.map((column) => column.name)).not.toContain('entry_path');
    expect(getDb().prepare('SELECT COUNT(*) AS n FROM ui_private_web_sessions').get()).toEqual({ n: 1 });
  });

  it('allows root-level member-visible HTML', async () => {
    expect((await call(GROUP_ID, { path: 'index.html' })).status()).toBe(201);
  });

  it('carries special-character paths without double encoding', async () => {
    const response = await call(GROUP_ID, { path: 'reports/daily 100%.html' });
    expect(response.status()).toBe(201);
    const url = new URL(String(response.body().url));
    expect(url.searchParams.get('next')).toBe('/reports/daily 100%.html');
  });

  it('requires the trusted UI origin and current group access', async () => {
    expect((await call(GROUP_ID, { path: 'index.html' }, 'https://evil.test')).status()).toBe(403);
    expect((await call(OTHER_GROUP_ID, { path: 'index.html' })).status()).toBe(403);
  });

  it('rejects traversal, non-HTML, protected paths, and symlink entries', async () => {
    expect((await call(GROUP_ID, { path: '../index.html' })).status()).toBe(404);
    expect((await call(GROUP_ID, { path: 'state.json' })).status()).toBe(400);
    expect((await call(GROUP_ID, { path: 'container.json' })).status()).toBe(400);
    expect((await call(GROUP_ID, { path: '.private/secret.html' })).status()).toBe(404);
    expect((await call(GROUP_ID, { path: 'linked.html' })).status()).toBe(404);
  });
});
