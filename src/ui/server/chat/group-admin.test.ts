/**
 * Tests for `POST /api/groups/:gid/admin/archive` — the UI archive surface.
 *
 * Covered (matching the user requirement that SCOPED admins must be
 * able to archive their own group):
 * - 200 for owner, global admin, AND scoped admin of the group.
 * - 403 for non-admin members.
 * - 403 for users with no relationship to the group.
 * - 400 when confirm_folder does not match.
 * - Side-effects on success: DB rows cascade-deleted, folder renamed
 *   with ~ suffix, archive.json + ARCHIVE_RESTORE.md written.
 */
import fs from 'fs';
import http from 'http';
import path from 'path';
import { Writable } from 'stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const TEST_ROOT = '/tmp/nanoclaw-test-ui-archive-group';
const TEST_GROUPS_DIR = path.join(TEST_ROOT, 'groups');
const TEST_DATA_DIR = path.join(TEST_ROOT, 'data');

vi.mock('../../../config.js', async () => {
  const actual = await vi.importActual<typeof import('../../../config.js')>('../../../config.js');
  return {
    ...actual,
    GROUPS_DIR: '/tmp/nanoclaw-test-ui-archive-group/groups',
    DATA_DIR: '/tmp/nanoclaw-test-ui-archive-group/data',
  };
});

vi.mock('../../../container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(undefined),
  isContainerRunning: vi.fn().mockReturnValue(false),
  getActiveContainerCount: vi.fn().mockReturnValue(0),
  killContainer: vi.fn(),
  buildAgentGroupImage: vi.fn().mockResolvedValue(undefined),
  runMcpProbeContainer: vi.fn(),
}));

let mockUserId: string | null = null;
vi.mock('../auth.js', () => ({
  authenticate: () => (mockUserId ? { userId: mockUserId } : null),
  recordAccess: vi.fn(),
}));

import { initTestDb, closeDb, runMigrations, getDb, getAgentGroup } from '../../../db/index.js';
import { grantRole } from '../../../modules/permissions/db/user-roles.js';
import { addMember } from '../../../modules/permissions/db/agent-group-members.js';
import { isContainerRunning, runMcpProbeContainer } from '../../../container-runner.js';
import {
  registerProviderContainerConfig,
  listProviderContainerConfigNames,
} from '../../../providers/provider-container-registry.js';
import { handle } from './routes.js';

const NOW = () => new Date().toISOString();

interface CapturedRes {
  done: Promise<void>;
  res: http.ServerResponse;
  status(): number;
  body(): unknown;
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
  };
}

function makeReq(method: string, url: string, body?: unknown): http.IncomingMessage {
  const buf = body !== undefined ? Buffer.from(JSON.stringify(body)) : Buffer.alloc(0);
  let pulled = false;
  return {
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

function seedUser(id: string, name = 'Test'): void {
  getDb()
    .prepare(`INSERT INTO users (id, kind, display_name, created_at) VALUES (?, 'web', ?, ?)`)
    .run(id, name, NOW());
}

function seedGroup(id: string, folder: string): void {
  getDb()
    .prepare(`INSERT INTO agent_groups (id, name, folder, agent_provider, created_at) VALUES (?, ?, ?, NULL, ?)`)
    .run(id, folder, folder, NOW());
  getDb().prepare(`INSERT INTO container_configs (agent_group_id, updated_at) VALUES (?, ?)`).run(id, NOW());
  fs.mkdirSync(path.join(TEST_GROUPS_DIR, folder), { recursive: true });
  fs.writeFileSync(path.join(TEST_GROUPS_DIR, folder, 'CLAUDE.local.md'), '# seed\n', 'utf-8');
}

beforeEach(() => {
  if (fs.existsSync(TEST_ROOT)) fs.rmSync(TEST_ROOT, { recursive: true });
  fs.mkdirSync(TEST_GROUPS_DIR, { recursive: true });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
  const db = initTestDb();
  runMigrations(db);
  mockUserId = null;
  vi.mocked(isContainerRunning).mockReset().mockReturnValue(false);
  vi.mocked(runMcpProbeContainer).mockReset();
});

afterEach(() => {
  closeDb();
  if (fs.existsSync(TEST_ROOT)) fs.rmSync(TEST_ROOT, { recursive: true });
});

describe('POST /api/groups/:gid/admin/archive', () => {
  it('owner can archive', async () => {
    seedUser('web:owner');
    grantRole({
      user_id: 'web:owner',
      role: 'owner',
      agent_group_id: null,
      granted_by: 'web:owner',
      granted_at: NOW(),
    });
    seedGroup('ag-own', 'own-grp');
    mockUserId = 'web:owner';

    const res = await call('POST', '/ui/chat/api/groups/ag-own/admin/archive', { confirm_folder: 'own-grp' });
    expect(res.status()).toBe(200);
    const body = res.body() as { ok: boolean; folder: string; archivedFolder: string };
    expect(body.ok).toBe(true);
    expect(body.folder).toBe('own-grp');
    expect(fs.existsSync(path.join(TEST_GROUPS_DIR, 'own-grp~', 'archive.json'))).toBe(true);
    expect(getAgentGroup('ag-own')).toBeUndefined();
  });

  it('global admin can archive', async () => {
    seedUser('web:gadmin');
    grantRole({
      user_id: 'web:gadmin',
      role: 'admin',
      agent_group_id: null,
      granted_by: 'web:gadmin',
      granted_at: NOW(),
    });
    seedGroup('ag-gadm', 'gadm-grp');
    mockUserId = 'web:gadmin';

    const res = await call('POST', '/ui/chat/api/groups/ag-gadm/admin/archive', { confirm_folder: 'gadm-grp' });
    expect(res.status()).toBe(200);
    expect(getAgentGroup('ag-gadm')).toBeUndefined();
  });

  it('SCOPED admin of the group can archive (load-bearing — scoped admins must own this op)', async () => {
    seedUser('web:scoped');
    seedGroup('ag-scoped', 'scoped-grp');
    grantRole({
      user_id: 'web:scoped',
      role: 'admin',
      agent_group_id: 'ag-scoped',
      granted_by: 'web:scoped',
      granted_at: NOW(),
    });
    mockUserId = 'web:scoped';

    const res = await call('POST', '/ui/chat/api/groups/ag-scoped/admin/archive', { confirm_folder: 'scoped-grp' });
    expect(res.status()).toBe(200);
    expect(getAgentGroup('ag-scoped')).toBeUndefined();
    expect(fs.existsSync(path.join(TEST_GROUPS_DIR, 'scoped-grp~'))).toBe(true);
  });

  it('plain member (no admin role) is rejected with 403', async () => {
    seedUser('web:member');
    seedGroup('ag-mem', 'mem-grp');
    addMember({ user_id: 'web:member', agent_group_id: 'ag-mem', added_by: null, added_at: NOW() });
    mockUserId = 'web:member';

    const res = await call('POST', '/ui/chat/api/groups/ag-mem/admin/archive', { confirm_folder: 'mem-grp' });
    expect(res.status()).toBe(403);
    expect(getAgentGroup('ag-mem')).toBeDefined();
    expect(fs.existsSync(path.join(TEST_GROUPS_DIR, 'mem-grp'))).toBe(true);
  });

  it('non-member with no privilege is rejected with 403', async () => {
    seedUser('web:nobody');
    seedGroup('ag-priv', 'priv-grp');
    mockUserId = 'web:nobody';

    const res = await call('POST', '/ui/chat/api/groups/ag-priv/admin/archive', { confirm_folder: 'priv-grp' });
    expect(res.status()).toBe(403);
    expect(getAgentGroup('ag-priv')).toBeDefined();
  });

  it('returns 400 when confirm_folder does not match', async () => {
    seedUser('web:owner');
    grantRole({
      user_id: 'web:owner',
      role: 'owner',
      agent_group_id: null,
      granted_by: 'web:owner',
      granted_at: NOW(),
    });
    seedGroup('ag-bad', 'bad-grp');
    mockUserId = 'web:owner';

    const res = await call('POST', '/ui/chat/api/groups/ag-bad/admin/archive', { confirm_folder: 'wrong' });
    expect(res.status()).toBe(400);
    expect(getAgentGroup('ag-bad')).toBeDefined();
  });

  it('returns 403 for missing groups (does not leak existence)', async () => {
    seedUser('web:owner');
    grantRole({
      user_id: 'web:owner',
      role: 'owner',
      agent_group_id: null,
      granted_by: 'web:owner',
      granted_at: NOW(),
    });
    mockUserId = 'web:owner';

    const res = await call('POST', '/ui/chat/api/groups/ag-missing/admin/archive', { confirm_folder: 'x' });
    expect(res.status()).toBe(403);
  });
});

function seedOwnedGroup(gid: string, folder: string, owner = 'web:owner'): void {
  seedUser(owner);
  grantRole({
    user_id: owner,
    role: 'owner',
    agent_group_id: null,
    granted_by: owner,
    granted_at: NOW(),
  });
  seedGroup(gid, folder);
  mockUserId = owner;
}

function getJsonCol(gid: string, col: string): unknown {
  const row = getDb().prepare(`SELECT ${col} AS v FROM container_configs WHERE agent_group_id = ?`).get(gid) as {
    v: string;
  };
  return JSON.parse(row.v);
}

describe('PATCH /api/groups/:gid/admin/packages', () => {
  it('replaces only the lists present in the body, dedupes, trims', async () => {
    seedOwnedGroup('ag-pkg', 'pkg-grp');

    const res = await call('PATCH', '/ui/chat/api/groups/ag-pkg/admin/packages', {
      apt: ['ripgrep', 'jq', 'ripgrep', '  jq  '],
      npm: ['typescript@5'],
    });
    expect(res.status()).toBe(200);
    const body = res.body() as { packages: { apt: string[]; npm: string[]; pip: string[] } };
    expect(body.packages.apt).toEqual(['ripgrep', 'jq']);
    expect(body.packages.npm).toEqual(['typescript@5']);
    expect(body.packages.pip).toEqual([]);
    expect(getJsonCol('ag-pkg', 'packages_apt')).toEqual(['ripgrep', 'jq']);
    expect(getJsonCol('ag-pkg', 'packages_npm')).toEqual(['typescript@5']);
    // pip not in body — left unchanged at default [].
    expect(getJsonCol('ag-pkg', 'packages_pip')).toEqual([]);
  });

  it('rejects invalid characters in a package name', async () => {
    seedOwnedGroup('ag-pkg2', 'pkg2-grp');
    const res = await call('PATCH', '/ui/chat/api/groups/ag-pkg2/admin/packages', {
      apt: ['ok', 'bad name'],
    });
    expect(res.status()).toBe(400);
  });

  it('rejects when no list is provided', async () => {
    seedOwnedGroup('ag-pkg3', 'pkg3-grp');
    const res = await call('PATCH', '/ui/chat/api/groups/ag-pkg3/admin/packages', {});
    expect(res.status()).toBe(400);
  });
});

describe('PATCH /api/groups/:gid/admin/mcp-servers', () => {
  it('accepts a stdio server with args/env and a http server with headers', async () => {
    seedOwnedGroup('ag-mcp', 'mcp-grp');

    const res = await call('PATCH', '/ui/chat/api/groups/ag-mcp/admin/mcp-servers', {
      servers: {
        context7: {
          command: 'npx',
          args: ['-y', '@upstash/context7-mcp'],
          env: { FOO: 'bar' },
          instructions: 'fetch docs',
        },
        remote: {
          type: 'http',
          url: 'https://example.com/mcp',
          headers: { Authorization: 'Bearer x' },
        },
      },
    });
    expect(res.status()).toBe(200);
    const stored = getJsonCol('ag-mcp', 'mcp_servers') as Record<string, unknown>;
    expect(Object.keys(stored).sort()).toEqual(['context7', 'remote']);
    expect((stored.context7 as { command: string }).command).toBe('npx');
    expect((stored.remote as { url: string }).url).toBe('https://example.com/mcp');
  });

  it('persists a per-server timeout and rejects an out-of-range one', async () => {
    seedOwnedGroup('ag-mcp-to', 'mcp-to-grp');

    const ok = await call('PATCH', '/ui/chat/api/groups/ag-mcp-to/admin/mcp-servers', {
      servers: {
        slow: { command: 'npx', timeout: 180000 },
        remote: { type: 'http', url: 'https://example.com/mcp', timeout: 240000 },
      },
    });
    expect(ok.status()).toBe(200);
    const stored = getJsonCol('ag-mcp-to', 'mcp_servers') as Record<string, { timeout?: number }>;
    expect(stored.slow!.timeout).toBe(180000);
    expect(stored.remote!.timeout).toBe(240000);

    const bad = await call('PATCH', '/ui/chat/api/groups/ag-mcp-to/admin/mcp-servers', {
      servers: { slow: { command: 'npx', timeout: 999999999 } },
    });
    expect(bad.status()).toBe(400);
  });

  it('rejects an http server missing url', async () => {
    seedOwnedGroup('ag-mcp2', 'mcp2-grp');
    const res = await call('PATCH', '/ui/chat/api/groups/ag-mcp2/admin/mcp-servers', {
      servers: { broken: { type: 'http' } },
    });
    expect(res.status()).toBe(400);
  });

  it('rejects an invalid server name', async () => {
    seedOwnedGroup('ag-mcp3', 'mcp3-grp');
    const res = await call('PATCH', '/ui/chat/api/groups/ag-mcp3/admin/mcp-servers', {
      servers: { '1bad': { command: 'x' } },
    });
    expect(res.status()).toBe(400);
  });

  it('full-replaces the map (empty body wipes existing servers)', async () => {
    seedOwnedGroup('ag-mcp4', 'mcp4-grp');
    await call('PATCH', '/ui/chat/api/groups/ag-mcp4/admin/mcp-servers', {
      servers: { one: { command: 'x' } },
    });
    expect(Object.keys(getJsonCol('ag-mcp4', 'mcp_servers') as object)).toEqual(['one']);
    const res = await call('PATCH', '/ui/chat/api/groups/ag-mcp4/admin/mcp-servers', { servers: {} });
    expect(res.status()).toBe(200);
    expect(getJsonCol('ag-mcp4', 'mcp_servers')).toEqual({});
  });
});

describe('POST /api/groups/:gid/admin/mcp-servers/test', () => {
  it('sanitizes a draft server and delegates to the disposable probe runner', async () => {
    seedOwnedGroup('ag-mcp-test', 'mcp-test-grp');
    vi.mocked(runMcpProbeContainer).mockResolvedValue({
      ok: true,
      latencyMs: 42,
      serverInfo: { name: 'example', version: '1.0.0' },
      tools: ['search', 'fetch'],
    });

    const res = await call('POST', '/ui/chat/api/groups/ag-mcp-test/admin/mcp-servers/test', {
      name: 'example',
      server: { command: '  npx  ', args: ['-y', 'example-mcp'], env: { TOKEN: 'secret' } },
    });

    expect(res.status()).toBe(200);
    expect(res.body()).toMatchObject({ ok: true, latencyMs: 42, tools: ['search', 'fetch'] });
    expect(runMcpProbeContainer).toHaveBeenCalledWith('ag-mcp-test', {
      command: 'npx',
      args: ['-y', 'example-mcp'],
      env: { TOKEN: 'secret' },
    });
  });

  it('rejects an invalid draft before starting a probe container', async () => {
    seedOwnedGroup('ag-mcp-test-bad', 'mcp-test-bad-grp');
    const res = await call('POST', '/ui/chat/api/groups/ag-mcp-test-bad/admin/mcp-servers/test', {
      name: 'example',
      server: { type: 'http', url: 'ftp://example.com/mcp' },
    });

    expect(res.status()).toBe(400);
    expect(runMcpProbeContainer).not.toHaveBeenCalled();
  });
});

describe('PATCH /api/groups/:gid/admin/skills', () => {
  it('accepts "all"', async () => {
    seedOwnedGroup('ag-sk', 'sk-grp');
    const res = await call('PATCH', '/ui/chat/api/groups/ag-sk/admin/skills', { skills: 'all' });
    expect(res.status()).toBe(200);
    expect(getJsonCol('ag-sk', 'skills')).toBe('all');
  });

  it('accepts a slug array, dedupes', async () => {
    seedOwnedGroup('ag-sk2', 'sk2-grp');
    const res = await call('PATCH', '/ui/chat/api/groups/ag-sk2/admin/skills', {
      skills: ['welcome', 'agent-browser', 'welcome'],
    });
    expect(res.status()).toBe(200);
    expect(getJsonCol('ag-sk2', 'skills')).toEqual(['welcome', 'agent-browser']);
  });

  it('rejects uppercase / invalid slugs', async () => {
    seedOwnedGroup('ag-sk3', 'sk3-grp');
    const res = await call('PATCH', '/ui/chat/api/groups/ag-sk3/admin/skills', {
      skills: ['Welcome'],
    });
    expect(res.status()).toBe(400);
  });

  it('rejects an object value', async () => {
    seedOwnedGroup('ag-sk4', 'sk4-grp');
    const res = await call('PATCH', '/ui/chat/api/groups/ag-sk4/admin/skills', {
      skills: { foo: 'bar' },
    });
    expect(res.status()).toBe(400);
  });
});

describe('GET /api/groups/:gid/admin/settings (extended fields)', () => {
  it('returns packages, mcpServers, and skills slices', async () => {
    seedOwnedGroup('ag-get', 'get-grp');
    await call('PATCH', '/ui/chat/api/groups/ag-get/admin/packages', { apt: ['jq'] });
    await call('PATCH', '/ui/chat/api/groups/ag-get/admin/mcp-servers', {
      servers: { fetch: { command: 'fetch-mcp' } },
    });
    await call('PATCH', '/ui/chat/api/groups/ag-get/admin/skills', { skills: ['welcome'] });

    const res = await call('GET', '/ui/chat/api/groups/ag-get/admin/settings');
    expect(res.status()).toBe(200);
    const body = res.body() as {
      packages: { apt: string[]; npm: string[]; pip: string[] };
      mcpServers: Record<string, unknown>;
      skills: string[] | 'all';
    };
    expect(body.packages.apt).toEqual(['jq']);
    expect(Object.keys(body.mcpServers)).toEqual(['fetch']);
    expect(body.skills).toEqual(['welcome']);
  });

  it('counts only sessions with a live container as running', async () => {
    seedOwnedGroup('ag-running', 'running-grp');
    const insert = getDb().prepare(`
      INSERT INTO sessions
        (id, agent_group_id, messaging_group_id, thread_id, agent_provider, status, container_status, last_active, created_at)
      VALUES (?, 'ag-running', NULL, NULL, NULL, 'active', ?, ?, ?)
    `);
    insert.run('sess-live', 'running', NOW(), NOW());
    insert.run('sess-stopped', 'stopped', NOW(), NOW());
    vi.mocked(isContainerRunning).mockImplementation((sessionId) => sessionId === 'sess-live');

    const res = await call('GET', '/ui/chat/api/groups/ag-running/admin/settings');
    expect(res.status()).toBe(200);
    expect((res.body() as { runningSessionCount: number }).runningSessionCount).toBe(1);
  });

  it('reports providesAgentSurfaces=false for the default (claude) provider', async () => {
    seedOwnedGroup('ag-surf-default', 'surf-default-grp');

    const res = await call('GET', '/ui/chat/api/groups/ag-surf-default/admin/settings');
    expect(res.status()).toBe(200);
    const body = res.body() as { providesAgentSurfaces: boolean };
    expect(body.providesAgentSurfaces).toBe(false);
  });

  it('reports providesAgentSurfaces=true when the group uses a surfaces-owning provider', async () => {
    // Register a throwaway provider that owns its agent surfaces.
    if (!listProviderContainerConfigNames().includes('test-surfaces-provider')) {
      registerProviderContainerConfig('test-surfaces-provider', () => ({}), {
        providesAgentSurfaces: true,
      });
    }
    seedOwnedGroup('ag-surf-owned', 'surf-owned-grp');
    getDb()
      .prepare(`UPDATE container_configs SET provider = ? WHERE agent_group_id = ?`)
      .run('test-surfaces-provider', 'ag-surf-owned');

    const res = await call('GET', '/ui/chat/api/groups/ag-surf-owned/admin/settings');
    expect(res.status()).toBe(200);
    const body = res.body() as { providesAgentSurfaces: boolean };
    expect(body.providesAgentSurfaces).toBe(true);
  });
});
