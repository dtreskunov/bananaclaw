/**
 * Tests for the first-login onboarding flow.
 *
 * Covered:
 *   - GET /ui/onboarding for an unauthenticated visitor → 303 to login.
 *   - GET for an already-onboarded user → 303 to /ui/chat/.
 *   - GET for a not-yet-onboarded user → 200 with the splash + form.
 *   - POST applies displayName / groupName / assistantName, renames the
 *     per-user agent group, updates container_config.assistant_name,
 *     stamps onboarded_at, and redirects.
 *   - postLoginRedirect returns the onboarding URL when needed.
 */
import fs from 'fs';
import http from 'http';
import path from 'path';
import { Writable } from 'stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const TEST_ROOT = '/tmp/nanoclaw-test-ui-onboarding';
const TEST_GROUPS_DIR = path.join(TEST_ROOT, 'groups');
const TEST_DATA_DIR = path.join(TEST_ROOT, 'data');

vi.mock('../../config.js', async () => {
  const actual = await vi.importActual<typeof import('../../config.js')>('../../config.js');
  return {
    ...actual,
    GROUPS_DIR: '/tmp/nanoclaw-test-ui-onboarding/groups',
    DATA_DIR: '/tmp/nanoclaw-test-ui-onboarding/data',
  };
});

vi.mock('../../container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(undefined),
  isContainerRunning: vi.fn().mockReturnValue(false),
  getActiveContainerCount: vi.fn().mockReturnValue(0),
  killContainer: vi.fn(),
  buildAgentGroupImage: vi.fn().mockResolvedValue(undefined),
}));

let mockUserId: string | null = null;
vi.mock('./auth.js', () => ({
  authenticate: () => (mockUserId ? { userId: mockUserId } : null),
  recordAccess: vi.fn(),
}));

import { initTestDb, closeDb, runMigrations, getDb } from '../../db/index.js';
import { createAgentGroup } from '../../db/agent-groups.js';
import { ensureContainerConfig, getContainerConfig, setCredentialBackend } from '../../db/container-configs.js';
import { insertOidcLink } from '../../modules/permissions/db/oidc-links.js';
import { isUserOnboarded } from '../../modules/permissions/db/users.js';
import { userAgentGroupFolder } from '../../modules/permissions/user-approval.js';
import { handleOnboarding, postLoginRedirect } from './onboarding.js';

function now(): string {
  return new Date().toISOString();
}

interface CapturedRes {
  done: Promise<void>;
  res: http.ServerResponse;
  status(): number;
  headers(): Record<string, string | string[]>;
  body(): string;
}

function makeRes(): CapturedRes {
  let status = 0;
  let headers: Record<string, string | string[]> = {};
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
  res.writeHead = ((s: number, h?: Record<string, string | string[]>) => {
    status = s;
    if (h) headers = h;
    return res;
  }) as http.ServerResponse['writeHead'];
  w.on('finish', resolve);
  return {
    done,
    res,
    status: () => status,
    headers: () => headers,
    body: () => Buffer.concat(chunks).toString('utf-8'),
  };
}

function makeReq(method: string, url: string, body?: { contentType: string; raw: string }): http.IncomingMessage {
  const buf = body ? Buffer.from(body.raw) : Buffer.alloc(0);
  let pulled = false;
  const headers: Record<string, string> = { host: 'localhost' };
  if (body) headers['content-type'] = body.contentType;
  const req = {
    method,
    url,
    headers,
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
  return req;
}

async function call(method: string, url: string, body?: { contentType: string; raw: string }): Promise<CapturedRes> {
  const cap = makeRes();
  await handleOnboarding(makeReq(method, url, body), cap.res);
  try {
    cap.res.end();
  } catch {
    /* already ended */
  }
  await cap.done;
  return cap;
}

function seedUser(id: string, displayName: string | null): void {
  getDb()
    .prepare(`INSERT INTO users (id, kind, display_name, created_at) VALUES (?, 'oidc', ?, ?)`)
    .run(id, displayName, now());
}

/** Create the per-user agent group the way approvePendingUser would.
 *  Returns the agent group id. */
function seedPerUserGroup(userId: string, provider: string, sub: string, opts?: { name?: string }): string {
  const folder = userAgentGroupFolder(provider, sub);
  const id = `ag-test-${sub}`;
  createAgentGroup({
    id,
    name: opts?.name ?? 'My Agent',
    folder,
    agent_provider: null,
    created_at: now(),
  });
  ensureContainerConfig(id);
  insertOidcLink({ provider, sub, user_id: userId, email: null, claims: null });
  return id;
}

beforeEach(() => {
  if (fs.existsSync(TEST_ROOT)) fs.rmSync(TEST_ROOT, { recursive: true });
  fs.mkdirSync(TEST_GROUPS_DIR, { recursive: true });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });

  const db = initTestDb();
  runMigrations(db);

  mockUserId = null;
});

afterEach(() => {
  closeDb();
  if (fs.existsSync(TEST_ROOT)) fs.rmSync(TEST_ROOT, { recursive: true });
});

describe('GET /ui/onboarding', () => {
  it('redirects unauthenticated requests to /ui/login', async () => {
    const res = await call('GET', '/ui/onboarding');
    expect(res.status()).toBe(303);
    expect(res.headers().Location).toBe('/ui/login?next=' + encodeURIComponent('/ui/onboarding'));
  });

  it('redirects already-onboarded users to /ui/chat/', async () => {
    seedUser('u1', 'Ada Lovelace');
    getDb().prepare(`UPDATE users SET onboarded_at = ? WHERE id = ?`).run(now(), 'u1');
    mockUserId = 'u1';
    const res = await call('GET', '/ui/onboarding');
    expect(res.status()).toBe(303);
    expect(res.headers().Location).toBe('/ui/chat/');
  });

  it('renders splash + form (no name input when display_name already set)', async () => {
    seedUser('u2', 'Ada Lovelace');
    seedPerUserGroup('u2', 'google', '12345');
    mockUserId = 'u2';
    const res = await call('GET', '/ui/onboarding');
    expect(res.status()).toBe(200);
    const html = res.body();
    expect(html).toContain('Welcome');
    expect(html).toContain('Gemini');
    expect(html).toContain('value="My Agent"');
    expect(html).toContain('value="Your Agent"');
    // display name field omitted when already present
    expect(html).not.toContain('name="displayName"');
  });

  it('includes the display name input when display_name is missing', async () => {
    seedUser('u3', null);
    seedPerUserGroup('u3', 'google', '67890');
    mockUserId = 'u3';
    const res = await call('GET', '/ui/onboarding');
    expect(res.status()).toBe(200);
    expect(res.body()).toContain('name="displayName"');
  });
});

describe('POST /ui/onboarding', () => {
  it('applies all three answers and marks the user onboarded', async () => {
    seedUser('u4', 'Ada Lovelace');
    const agentGroupId = seedPerUserGroup('u4', 'google', '99001');
    mockUserId = 'u4';

    const raw = new URLSearchParams({
      groupName: 'Ada\u2019s Sidekick',
      assistantName: 'Sidekick',
    }).toString();
    const res = await call('POST', '/ui/onboarding', {
      contentType: 'application/x-www-form-urlencoded',
      raw,
    });
    expect(res.status()).toBe(303);
    expect(res.headers().Location).toBe('/ui/chat/#credentials');

    const group = getDb().prepare('SELECT name FROM agent_groups WHERE id = ?').get(agentGroupId) as { name: string };
    expect(group.name).toBe('Ada\u2019s Sidekick');
    const cfg = getContainerConfig(agentGroupId);
    expect(cfg?.assistant_name).toBe('Sidekick');
    expect(isUserOnboarded('u4')).toBe(true);
    expect(cfg?.credential_backend).toBe('agent-vault');
  });

  it('does not cut over an existing legacy group during profile onboarding', async () => {
    seedUser('legacy-user', 'Legacy user');
    const group = seedPerUserGroup('legacy-user', 'google', 'legacy');
    setCredentialBackend(group, 'onecli');
    mockUserId = 'legacy-user';
    const res = await call('POST', '/ui/onboarding', {
      contentType: 'application/x-www-form-urlencoded',
      raw: new URLSearchParams({ groupName: 'Existing', assistantName: 'Agent' }).toString(),
    });
    expect(res.headers().Location).toBe('/ui/chat/');
    expect(getContainerConfig(group)?.credential_backend).toBe('onecli');
  });

  it('falls back to defaults when form fields are empty strings', async () => {
    seedUser('u5', 'Grace Hopper');
    const agentGroupId = seedPerUserGroup('u5', 'google', '99002');
    mockUserId = 'u5';

    const raw = new URLSearchParams({ groupName: '   ', assistantName: '' }).toString();
    const res = await call('POST', '/ui/onboarding', {
      contentType: 'application/x-www-form-urlencoded',
      raw,
    });
    expect(res.status()).toBe(303);

    const group = getDb().prepare('SELECT name FROM agent_groups WHERE id = ?').get(agentGroupId) as { name: string };
    expect(group.name).toBe('My Agent');
    const cfg = getContainerConfig(agentGroupId);
    expect(cfg?.assistant_name).toBe('Your Agent');
  });

  it('updates user display_name when the form supplies one and the user had none', async () => {
    seedUser('u6', null);
    const agentGroupId = seedPerUserGroup('u6', 'google', '99003');
    mockUserId = 'u6';

    const raw = new URLSearchParams({
      displayName: 'Margaret Hamilton',
      groupName: 'Apollo',
      assistantName: 'Guidance',
    }).toString();
    const res = await call('POST', '/ui/onboarding', {
      contentType: 'application/x-www-form-urlencoded',
      raw,
    });
    expect(res.status()).toBe(303);

    const u = getDb().prepare('SELECT display_name FROM users WHERE id = ?').get('u6') as { display_name: string };
    expect(u.display_name).toBe('Margaret Hamilton');
    expect(agentGroupId).toBeTruthy();
  });

  it('re-renders the form with an error when display_name is required but missing', async () => {
    seedUser('u7', null);
    seedPerUserGroup('u7', 'google', '99004');
    mockUserId = 'u7';

    const raw = new URLSearchParams({ groupName: 'X', assistantName: 'Y' }).toString();
    const res = await call('POST', '/ui/onboarding', {
      contentType: 'application/x-www-form-urlencoded',
      raw,
    });
    expect(res.status()).toBe(400);
    expect(res.body()).toContain('Please tell us your name');
    expect(isUserOnboarded('u7')).toBe(false);
  });

  it('still marks the user onboarded when no per-user agent group exists and no OIDC link is present', async () => {
    seedUser('u8', 'Hedy Lamarr');
    // No seedPerUserGroup call and no OIDC link, so there's nothing to
    // lazy-provision from — should still onboard cleanly.
    mockUserId = 'u8';

    const raw = new URLSearchParams({ groupName: 'X', assistantName: 'Y' }).toString();
    const res = await call('POST', '/ui/onboarding', {
      contentType: 'application/x-www-form-urlencoded',
      raw,
    });
    expect(res.status()).toBe(303);
    expect(isUserOnboarded('u8')).toBe(true);
    const cnt = getDb().prepare('SELECT COUNT(*) AS n FROM agent_groups').get() as { n: number };
    expect(cnt.n).toBe(0);
  });

  it('lazy-provisions a per-user agent group when the user has an OIDC link but no surviving group', async () => {
    seedUser('u11', 'Radia Perlman');
    // OIDC link but NO seedPerUserGroup — emulates an archived per-user
    // group, or a user that predates auto-provisioning.
    insertOidcLink({ provider: 'google', sub: '99099', user_id: 'u11', email: null, claims: null });
    mockUserId = 'u11';

    const raw = new URLSearchParams({
      groupName: 'Spanning Tree',
      assistantName: 'STP',
    }).toString();
    const res = await call('POST', '/ui/onboarding', {
      contentType: 'application/x-www-form-urlencoded',
      raw,
    });
    expect(res.status()).toBe(303);
    expect(isUserOnboarded('u11')).toBe(true);

    const groups = getDb().prepare('SELECT id, name, folder FROM agent_groups').all() as Array<{
      id: string;
      name: string;
      folder: string;
    }>;
    expect(groups).toHaveLength(1);
    expect(groups[0].folder).toBe('google-99099');
    expect(groups[0].name).toBe('Spanning Tree');

    const cfg = getContainerConfig(groups[0].id);
    expect(cfg?.assistant_name).toBe('STP');

    // User should now have a scoped-admin role + membership on the new
    // group, so listAccessibleAgentGroups returns it.
    const role = getDb()
      .prepare(`SELECT 1 FROM user_roles WHERE user_id = ? AND role = 'admin' AND agent_group_id = ?`)
      .get('u11', groups[0].id);
    expect(role).toBeTruthy();
    const member = getDb()
      .prepare('SELECT 1 FROM agent_group_members WHERE user_id = ? AND agent_group_id = ?')
      .get('u11', groups[0].id);
    expect(member).toBeTruthy();
  });
});

describe('postLoginRedirect', () => {
  it('returns the onboarding path for not-yet-onboarded users', () => {
    seedUser('u9', 'Test');
    expect(postLoginRedirect('u9', '/ui/chat/')).toBe('/ui/onboarding');
  });

  it('returns the requested next path for already-onboarded users', () => {
    seedUser('u10', 'Test');
    getDb().prepare(`UPDATE users SET onboarded_at = ? WHERE id = ?`).run(now(), 'u10');
    expect(postLoginRedirect('u10', '/ui/chat/')).toBe('/ui/chat/');
  });
});
