/**
 * Tests for `POST /api/groups` — the UI surface that lets an owner or
 * global admin create a new agent group end-to-end.
 *
 * Covered:
 * - 403 for non-elevated users (plain members, scoped admins).
 * - 200 for owner / global admin: row inserted, folder scaffolded,
 *   container_configs created, creator auto-granted scoped admin.
 * - 400 for missing name.
 * - 409 for folder collision.
 */
import fs from 'fs';
import http from 'http';
import path from 'path';
import { Writable } from 'stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const TEST_ROOT = '/tmp/nanoclaw-test-ui-create-group';
const TEST_GROUPS_DIR = path.join(TEST_ROOT, 'groups');
const TEST_DATA_DIR = path.join(TEST_ROOT, 'data');

vi.mock('../../../config.js', async () => {
  const actual = await vi.importActual<typeof import('../../../config.js')>('../../../config.js');
  return {
    ...actual,
    GROUPS_DIR: '/tmp/nanoclaw-test-ui-create-group/groups',
    DATA_DIR: '/tmp/nanoclaw-test-ui-create-group/data',
    PAGES_BASE_DOMAIN: 'pages.test',
  };
});

// Stub container runner so initGroupFilesystem doesn't pull in real spawn paths.
vi.mock('../../../container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(undefined),
  isContainerRunning: vi.fn().mockReturnValue(false),
  getActiveContainerCount: vi.fn().mockReturnValue(0),
  killContainer: vi.fn(),
  buildAgentGroupImage: vi.fn().mockResolvedValue(undefined),
}));

// Stub the auth module — tests inject the desired userId per-call via the
// `mockUserId` setter below.
let mockUserId: string | null = null;
vi.mock('../auth.js', () => ({
  authenticate: () => (mockUserId ? { userId: mockUserId } : null),
  recordAccess: vi.fn(),
}));

import { initTestDb, closeDb, runMigrations, getDb } from '../../../db/index.js';
import { addMember } from '../../../modules/permissions/db/agent-group-members.js';
import { grantRole } from '../../../modules/permissions/db/user-roles.js';
import { handle } from './routes.js';

function now(): string {
  return new Date().toISOString();
}

interface CapturedRes {
  done: Promise<void>;
  res: http.ServerResponse;
  status(): number;
  body(): unknown;
  raw(): string;
}

function makeRes(): CapturedRes {
  let status = 0;
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
  res.writeHead = ((s: number) => {
    status = s;
    return res;
  }) as http.ServerResponse['writeHead'];
  w.on('finish', resolve);
  return {
    done,
    res,
    status: () => status,
    body: () => {
      const raw = Buffer.concat(chunks).toString('utf-8');
      try {
        return JSON.parse(raw) as unknown;
      } catch {
        return raw;
      }
    },
    raw: () => Buffer.concat(chunks).toString('utf-8'),
  };
}

function makeReq(method: string, url: string, body?: unknown): http.IncomingMessage {
  const buf = body !== undefined ? Buffer.from(JSON.stringify(body)) : Buffer.alloc(0);
  let pulled = false;
  const req = {
    method,
    url,
    headers: { host: 'localhost', 'content-type': 'application/json' },
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

async function call(method: string, url: string, body?: unknown): Promise<CapturedRes> {
  const cap = makeRes();
  await handle(makeReq(method, url, body), cap.res);
  try {
    cap.res.end();
  } catch {
    /* already ended */
  }
  await cap.done;
  return cap;
}

function seedUser(id: string, name = 'Test User'): void {
  getDb()
    .prepare(`INSERT INTO users (id, kind, display_name, created_at) VALUES (?, 'web', ?, ?)`)
    .run(id, name, now());
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

describe('GET /api/groups', () => {
  it('marks only groups requiring system-wide access as elevated-only', async () => {
    seedUser('web:admin');
    for (const [id, name] of [
      ['ag-member', 'Member'],
      ['ag-scoped', 'Scoped'],
      ['ag-elevated', 'Elevated'],
    ]) {
      getDb()
        .prepare(`INSERT INTO agent_groups (id, name, folder, agent_provider, created_at) VALUES (?, ?, ?, NULL, ?)`)
        .run(id, name, id, now());
    }
    grantRole({
      user_id: 'web:admin',
      role: 'admin',
      agent_group_id: null,
      granted_by: 'web:admin',
      granted_at: now(),
    });
    addMember({
      user_id: 'web:admin',
      agent_group_id: 'ag-member',
      added_by: 'web:admin',
      added_at: now(),
    });
    getDb().prepare('UPDATE agent_groups SET site_slug = ?, site_enabled = 1 WHERE id = ?').run('member', 'ag-member');
    grantRole({
      user_id: 'web:admin',
      role: 'admin',
      agent_group_id: 'ag-scoped',
      granted_by: 'web:admin',
      granted_at: now(),
    });

    mockUserId = 'web:admin';
    const res = await call('GET', '/ui/chat/api/groups');
    expect(res.status()).toBe(200);
    const body = res.body() as { groups: Array<{ id: string; elevatedOnly: boolean; siteUrl: string | null }> };
    const elevatedById = Object.fromEntries(body.groups.map((group) => [group.id, group.elevatedOnly]));
    expect(elevatedById).toEqual({
      'ag-member': false,
      'ag-scoped': false,
      'ag-elevated': true,
    });
    const siteById = Object.fromEntries(body.groups.map((group) => [group.id, group.siteUrl]));
    expect(siteById).toEqual({
      'ag-member': 'https://member.pages.test/',
      'ag-scoped': null,
      'ag-elevated': null,
    });
  });
});

describe('POST /api/groups', () => {
  it('returns 403 for a non-elevated user', async () => {
    seedUser('web:plain');
    mockUserId = 'web:plain';
    const res = await call('POST', '/ui/chat/api/groups', { name: 'X' });
    expect(res.status()).toBe(403);
    expect((res.body() as { error: string }).error).toBe('forbidden');
  });

  it('returns 403 for a scoped admin (must be owner / global admin)', async () => {
    seedUser('web:scoped');
    mockUserId = 'web:scoped';
    // Seed an unrelated group + scoped admin role.
    getDb()
      .prepare(`INSERT INTO agent_groups (id, name, folder, agent_provider, created_at) VALUES (?, ?, ?, NULL, ?)`)
      .run('ag-existing', 'Existing', 'existing', now());
    grantRole({
      user_id: 'web:scoped',
      role: 'admin',
      agent_group_id: 'ag-existing',
      granted_by: 'web:scoped',
      granted_at: now(),
    });
    const res = await call('POST', '/ui/chat/api/groups', { name: 'X' });
    expect(res.status()).toBe(403);
  });

  it('returns 400 when name is missing', async () => {
    seedUser('web:owner');
    grantRole({
      user_id: 'web:owner',
      role: 'owner',
      agent_group_id: null,
      granted_by: 'web:owner',
      granted_at: now(),
    });
    mockUserId = 'web:owner';
    const res = await call('POST', '/ui/chat/api/groups', {});
    expect(res.status()).toBe(400);
    expect((res.body() as { error: string }).error).toBe('name_required');
  });

  it('creates the group, scaffolds the folder, and grants the creator scoped admin', async () => {
    seedUser('web:owner');
    grantRole({
      user_id: 'web:owner',
      role: 'owner',
      agent_group_id: null,
      granted_by: 'web:owner',
      granted_at: now(),
    });
    mockUserId = 'web:owner';
    const res = await call('POST', '/ui/chat/api/groups', { name: 'New Group', instructions: 'Hi.' });
    expect(res.status()).toBe(200);

    const body = res.body() as { id: string; name: string; folder: string; createdAt: string };
    expect(body.name).toBe('New Group');
    expect(body.folder).toBe('new-group');
    expect(body.id).toMatch(/^ag-/);

    // DB row exists.
    const row = getDb().prepare('SELECT id, name, folder FROM agent_groups WHERE id = ?').get(body.id);
    expect(row).toEqual({ id: body.id, name: 'New Group', folder: 'new-group' });

    // Folder + seeded instructions on disk.
    const claudeLocal = path.join(TEST_GROUPS_DIR, 'new-group', 'CLAUDE.local.md');
    expect(fs.existsSync(claudeLocal)).toBe(true);
    expect(fs.readFileSync(claudeLocal, 'utf-8')).toContain('Hi.');

    // container_configs row exists.
    const cfg = getDb().prepare('SELECT 1 FROM container_configs WHERE agent_group_id = ?').get(body.id);
    expect(cfg).toBeTruthy();

    // Creator auto-granted scoped admin.
    const role = getDb()
      .prepare(`SELECT user_id, role FROM user_roles WHERE user_id = ? AND agent_group_id = ?`)
      .get('web:owner', body.id);
    expect(role).toEqual({ user_id: 'web:owner', role: 'admin' });
  });

  it('returns 409 when --folder collides with an existing group', async () => {
    seedUser('web:admin');
    grantRole({
      user_id: 'web:admin',
      role: 'admin',
      agent_group_id: null,
      granted_by: 'web:admin',
      granted_at: now(),
    });
    mockUserId = 'web:admin';

    await call('POST', '/ui/chat/api/groups', { name: 'A', folder: 'fixed' });
    const res = await call('POST', '/ui/chat/api/groups', { name: 'B', folder: 'fixed' });
    expect(res.status()).toBe(409);
    expect((res.body() as { error: string }).error).toBe('folder_conflict');
  });
});
