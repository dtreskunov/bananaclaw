import { toEpoch } from '../../db/time.js';
/**
 * Tests for `archiveAgentGroup`:
 *   - dumps every restorable row into `archive.json`
 *   - cascade-deletes the same rows from the DB
 *   - renames `groups/<folder>` → `groups/<folder>~`
 *   - renames `data/v2-sessions/<id>` → `data/v2-sessions/<id>~`
 *   - allocates `~2`, `~3`, … on collision
 *   - writes `ARCHIVE_RESTORE.md` containing the `ncl groups restore` command
 *
 * No callers yet — the helper is exercised in isolation here, and wired
 * into CLI + UI in subsequent commits.
 */
import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const TEST_ROOT = '/tmp/nanoclaw-test-archive-group';
const TEST_GROUPS_DIR = path.join(TEST_ROOT, 'groups');
const TEST_DATA_DIR = path.join(TEST_ROOT, 'data');

vi.mock('../../container-runner.js', () => ({
  isContainerRunning: vi.fn().mockReturnValue(false),
  killContainer: vi.fn(),
  wakeContainer: vi.fn().mockResolvedValue(undefined),
  getActiveContainerCount: vi.fn().mockReturnValue(0),
}));

vi.mock('../../config.js', async () => {
  const actual = await vi.importActual<typeof import('../../config.js')>('../../config.js');
  return {
    ...actual,
    GROUPS_DIR: '/tmp/nanoclaw-test-archive-group/groups',
    DATA_DIR: '/tmp/nanoclaw-test-archive-group/data',
  };
});

import {
  initTestDb,
  closeDb,
  runMigrations,
  getDb,
  createAgentGroup,
  createMessagingGroup,
  createMessagingGroupAgent,
  createSession,
  getAgentGroup,
} from '../../db/index.js';
import { archiveAgentGroup, nextArchiveSuffix } from './archive-group.js';

const NOW = () => new Date().toISOString();

function seedGroup(id: string, folder: string) {
  createAgentGroup({ id, name: folder, folder, agent_provider: null, created_at: NOW() });
  fs.mkdirSync(path.join(TEST_GROUPS_DIR, folder), { recursive: true });
  fs.writeFileSync(path.join(TEST_GROUPS_DIR, folder, 'CLAUDE.local.md'), '# seed\n', 'utf-8');
}

function seedFullGroup(id: string, folder: string) {
  seedGroup(id, folder);
  // container config
  getDb().prepare(`INSERT INTO container_configs (agent_group_id, updated_at) VALUES (?, ?)`).run(id, toEpoch(NOW()));
  // wiring
  createMessagingGroup({
    id: `mg-${id}`,
    channel_type: 'web',
    platform_id: `plat-${id}`,
    name: 'web',
    is_group: 0,
    unknown_sender_policy: 'strict',
    created_at: NOW(),
  });
  createMessagingGroupAgent({
    id: `wir-${id}`,
    messaging_group_id: `mg-${id}`,
    agent_group_id: id,
    engage_mode: 'pattern',
    engage_pattern: '.',
    sender_scope: 'all',
    ignored_message_policy: 'drop',
    session_mode: 'shared',
    priority: 0,
    created_at: NOW(),
  });
  // member
  getDb()
    .prepare(`INSERT INTO users (id, kind, display_name, created_at) VALUES (?, 'human', ?, ?)`)
    .run(`u-${id}`, `User ${id}`, toEpoch(NOW()));
  getDb()
    .prepare(`INSERT INTO agent_group_members (user_id, agent_group_id, added_by, added_at) VALUES (?, ?, NULL, ?)`)
    .run(`u-${id}`, id, toEpoch(NOW()));
  // scoped admin role
  getDb()
    .prepare(
      `INSERT INTO user_roles (user_id, role, agent_group_id, granted_by, granted_at) VALUES (?, 'admin', ?, NULL, ?)`,
    )
    .run(`u-${id}`, id, toEpoch(NOW()));
  // session
  createSession({
    id: `sess-${id}`,
    agent_group_id: id,
    messaging_group_id: `mg-${id}`,
    thread_id: null,
    agent_provider: null,
    status: 'active',
    container_status: 'stopped',
    last_active: NOW(),
    created_at: NOW(),
  });
  // session dir on disk
  fs.mkdirSync(path.join(TEST_DATA_DIR, 'v2-sessions', id, 'sess-' + id), { recursive: true });
  fs.writeFileSync(path.join(TEST_DATA_DIR, 'v2-sessions', id, 'sess-' + id, 'heartbeat'), '', 'utf-8');
}

beforeEach(() => {
  if (fs.existsSync(TEST_ROOT)) fs.rmSync(TEST_ROOT, { recursive: true });
  fs.mkdirSync(TEST_GROUPS_DIR, { recursive: true });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
  const db = initTestDb();
  runMigrations(db);
});

afterEach(() => {
  closeDb();
  if (fs.existsSync(TEST_ROOT)) fs.rmSync(TEST_ROOT, { recursive: true });
});

describe('archiveAgentGroup', () => {
  it('dumps every dependent row to archive.json, cascades the DB, and renames both folders', () => {
    seedFullGroup('ag-arch-1', 'arch-one');

    const result = archiveAgentGroup('ag-arch-1', { user_id: 'u-actor', display_name: 'Actor' });

    expect(result.id).toBe('ag-arch-1');
    expect(result.folder).toBe('arch-one');
    expect(result.archivedFolder).toBe(path.join(TEST_GROUPS_DIR, 'arch-one~'));
    expect(result.archivedSessionsDir).toBe(path.join(TEST_DATA_DIR, 'v2-sessions', 'ag-arch-1~'));
    expect(fs.existsSync(result.archivedFolder)).toBe(true);
    expect(fs.existsSync(path.join(TEST_GROUPS_DIR, 'arch-one'))).toBe(false);
    expect(fs.existsSync(result.archivedSessionsDir!)).toBe(true);
    expect(fs.existsSync(path.join(TEST_DATA_DIR, 'v2-sessions', 'ag-arch-1'))).toBe(false);

    // DB rows all gone.
    expect(getAgentGroup('ag-arch-1')).toBeUndefined();
    const db = getDb();
    expect(db.prepare('SELECT COUNT(*) AS n FROM container_configs WHERE agent_group_id = ?').get('ag-arch-1')).toEqual(
      { n: 0 },
    );
    expect(
      db.prepare('SELECT COUNT(*) AS n FROM messaging_group_agents WHERE agent_group_id = ?').get('ag-arch-1'),
    ).toEqual({ n: 0 });
    expect(
      db.prepare('SELECT COUNT(*) AS n FROM agent_group_members WHERE agent_group_id = ?').get('ag-arch-1'),
    ).toEqual({ n: 0 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM user_roles WHERE agent_group_id = ?').get('ag-arch-1')).toEqual({
      n: 0,
    });
    expect(db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE agent_group_id = ?').get('ag-arch-1')).toEqual({
      n: 0,
    });

    // Dump shape.
    const dump = JSON.parse(fs.readFileSync(result.archiveJsonPath, 'utf-8'));
    expect(dump.version).toBe(3);
    expect(dump.archived_by).toEqual({ user_id: 'u-actor', display_name: 'Actor' });
    expect(dump.agent_group.id).toBe('ag-arch-1');
    expect(dump.agent_group.folder).toBe('arch-one');
    expect(dump.container_config).not.toBeNull();
    expect(dump.messaging_group_agents).toHaveLength(1);
    expect(dump.agent_group_members).toHaveLength(1);
    expect(dump.user_roles).toHaveLength(1);
    expect(dump.user_roles[0].role).toBe('admin');
    expect(dump.sessions).toHaveLength(1);

    // README documents the restore command and lives next to the JSON.
    const readme = fs.readFileSync(path.join(result.archivedFolder, 'ARCHIVE_RESTORE.md'), 'utf-8');
    expect(readme).toContain('ncl groups restore --folder arch-one');
    expect(readme).toContain('ag-arch-1');
    expect(readme).toContain('Actor');
  });

  it('allocates ~2, ~3 suffixes when archive folders collide', () => {
    // Pre-existing archive of a same-named former group.
    fs.mkdirSync(path.join(TEST_GROUPS_DIR, 'twin~'), { recursive: true });
    fs.mkdirSync(path.join(TEST_GROUPS_DIR, 'twin~2'), { recursive: true });

    seedGroup('ag-twin', 'twin');
    const result = archiveAgentGroup('ag-twin', { user_id: 'u' });
    expect(result.archivedFolder).toBe(path.join(TEST_GROUPS_DIR, 'twin~3'));
    expect(fs.existsSync(result.archivedFolder)).toBe(true);
  });

  it('skips session-tree rename when the directory does not exist', () => {
    seedGroup('ag-no-sess', 'no-sess');
    const result = archiveAgentGroup('ag-no-sess', { user_id: 'u' });
    expect(result.archivedSessionsDir).toBeNull();
  });

  it('throws when the group does not exist', () => {
    expect(() => archiveAgentGroup('ag-missing', { user_id: 'u' })).toThrow(/group not found/);
  });

  it('throws when the on-disk folder is missing', () => {
    createAgentGroup({
      id: 'ag-no-dir',
      name: 'no-dir',
      folder: 'no-dir',
      agent_provider: null,
      created_at: NOW(),
    });
    expect(() => archiveAgentGroup('ag-no-dir', { user_id: 'u' })).toThrow(/group folder missing on disk/);
  });
});

describe('nextArchiveSuffix', () => {
  it('returns <base>~ when nothing in the way', () => {
    expect(nextArchiveSuffix(path.join(TEST_GROUPS_DIR, 'fresh'))).toBe(path.join(TEST_GROUPS_DIR, 'fresh~'));
  });
  it('skips occupied suffixes', () => {
    fs.mkdirSync(path.join(TEST_GROUPS_DIR, 'occ~'), { recursive: true });
    expect(nextArchiveSuffix(path.join(TEST_GROUPS_DIR, 'occ'))).toBe(path.join(TEST_GROUPS_DIR, 'occ~2'));
  });
});
