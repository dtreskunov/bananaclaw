/**
 * Load-bearing round-trip test for `ncl groups archive` + `ncl groups restore`.
 *
 * Proves that:
 *   - archive snapshots every restorable row and cascades the DB,
 *   - restore re-inserts those rows with IDENTICAL ids and payloads,
 *   - folders + sessions trees rename back,
 *   - archive markers are removed once restored,
 *   - sessions/pending_* default OFF and opt-in via --with-sessions,
 *   - collision detection prevents lossy restores.
 *
 * This is the canary test for the archive/restore contract — if it fails,
 * an archived group cannot be brought back, and the feature is broken.
 */
import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const TEST_ROOT = '/tmp/nanoclaw-test-cli-archive-restore';
const TEST_GROUPS_DIR = path.join(TEST_ROOT, 'groups');
const TEST_DATA_DIR = path.join(TEST_ROOT, 'data');

vi.mock('../../container-runner.js', () => ({
  isContainerRunning: vi.fn().mockReturnValue(false),
  killContainer: vi.fn(),
  wakeContainer: vi.fn().mockResolvedValue(undefined),
  getActiveContainerCount: vi.fn().mockReturnValue(0),
  buildAgentGroupImage: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../config.js', async () => {
  const actual = await vi.importActual<typeof import('../../config.js')>('../../config.js');
  return {
    ...actual,
    GROUPS_DIR: '/tmp/nanoclaw-test-cli-archive-restore/groups',
    DATA_DIR: '/tmp/nanoclaw-test-cli-archive-restore/data',
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
} from '../../db/index.js';
import { dispatch } from '../dispatch.js';
import './groups.js';

const NOW = () => new Date().toISOString();

interface SeedRefs {
  id: string;
  folder: string;
  userId: string;
  messagingGroupId: string;
  wiringId: string;
  sessionId: string;
}

function seedGroup(id: string, folder: string): SeedRefs {
  const userId = `u-${id}`;
  const messagingGroupId = `mg-${id}`;
  const wiringId = `wir-${id}`;
  const sessionId = `sess-${id}`;

  createAgentGroup({ id, name: folder, folder, agent_provider: null, created_at: NOW() });
  getDb().prepare(`INSERT INTO container_configs (agent_group_id, updated_at) VALUES (?, ?)`).run(id, NOW());
  createMessagingGroup({
    id: messagingGroupId,
    channel_type: 'web',
    platform_id: `plat-${id}`,
    name: 'web',
    is_group: 0,
    unknown_sender_policy: 'strict',
    created_at: NOW(),
  });
  createMessagingGroupAgent({
    id: wiringId,
    messaging_group_id: messagingGroupId,
    agent_group_id: id,
    engage_mode: 'pattern',
    engage_pattern: '.',
    sender_scope: 'all',
    ignored_message_policy: 'drop',
    session_mode: 'shared',
    priority: 0,
    created_at: NOW(),
  });
  getDb()
    .prepare(`INSERT INTO users (id, kind, display_name, created_at) VALUES (?, 'human', ?, ?)`)
    .run(userId, `User ${id}`, NOW());
  getDb()
    .prepare(`INSERT INTO agent_group_members (user_id, agent_group_id, added_by, added_at) VALUES (?, ?, NULL, ?)`)
    .run(userId, id, NOW());
  getDb()
    .prepare(
      `INSERT INTO user_roles (user_id, role, agent_group_id, granted_by, granted_at) VALUES (?, 'admin', ?, NULL, ?)`,
    )
    .run(userId, id, NOW());
  createSession({
    id: sessionId,
    agent_group_id: id,
    messaging_group_id: messagingGroupId,
    thread_id: null,
    agent_provider: null,
    status: 'active',
    container_status: 'stopped',
    last_active: NOW(),
    created_at: NOW(),
  });
  fs.mkdirSync(path.join(TEST_GROUPS_DIR, folder), { recursive: true });
  fs.writeFileSync(path.join(TEST_GROUPS_DIR, folder, 'CLAUDE.local.md'), '# seed\n', 'utf-8');
  fs.mkdirSync(path.join(TEST_DATA_DIR, 'v2-sessions', id, sessionId), { recursive: true });
  fs.writeFileSync(path.join(TEST_DATA_DIR, 'v2-sessions', id, sessionId, 'heartbeat'), '', 'utf-8');

  return { id, folder, userId, messagingGroupId, wiringId, sessionId };
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

async function archive(id: string) {
  return dispatch({ id: 'req-arch', command: 'groups-archive', args: { id } }, { caller: 'host' });
}
async function restore(folder: string, withSessions = false) {
  return dispatch(
    {
      id: 'req-res',
      command: 'groups-restore',
      args: withSessions ? { folder, 'with-sessions': true } : { folder },
    },
    { caller: 'host' },
  );
}

describe('ncl groups archive ↔ restore round trip', () => {
  it('restores agent_groups, container_configs, members, scoped roles, wirings — IDENTICAL ids and payloads', async () => {
    const refs = seedGroup('ag-rt-1', 'rt-one');

    // Capture pre-state for comparison.
    const db = getDb();
    const before = {
      group: db.prepare('SELECT * FROM agent_groups WHERE id = ?').get(refs.id),
      cfg: db.prepare('SELECT * FROM container_configs WHERE agent_group_id = ?').get(refs.id),
      members: db.prepare('SELECT * FROM agent_group_members WHERE agent_group_id = ?').all(refs.id),
      roles: db.prepare('SELECT * FROM user_roles WHERE agent_group_id = ?').all(refs.id),
      wirings: db.prepare('SELECT * FROM messaging_group_agents WHERE agent_group_id = ?').all(refs.id),
    };

    const archRes = await archive(refs.id);
    expect(archRes.ok).toBe(true);
    if (!archRes.ok) throw new Error('archive failed');
    expect(fs.existsSync(path.join(TEST_GROUPS_DIR, 'rt-one~', 'archive.json'))).toBe(true);
    expect(db.prepare('SELECT 1 FROM agent_groups WHERE id = ?').get(refs.id)).toBeUndefined();
    expect(db.prepare('SELECT 1 FROM container_configs WHERE agent_group_id = ?').get(refs.id)).toBeUndefined();

    const resRes = await restore('rt-one');
    expect(resRes.ok).toBe(true);
    if (!resRes.ok) throw new Error('restore failed');
    const data = resRes.data as { id: string; folder: string };
    expect(data.id).toBe(refs.id);
    expect(data.folder).toBe(refs.folder);

    // Folder renamed back, archive markers gone.
    expect(fs.existsSync(path.join(TEST_GROUPS_DIR, 'rt-one'))).toBe(true);
    expect(fs.existsSync(path.join(TEST_GROUPS_DIR, 'rt-one~'))).toBe(false);
    expect(fs.existsSync(path.join(TEST_GROUPS_DIR, 'rt-one', 'archive.json'))).toBe(false);
    expect(fs.existsSync(path.join(TEST_GROUPS_DIR, 'rt-one', 'ARCHIVE_RESTORE.md'))).toBe(false);
    // Sessions tree renamed back.
    expect(fs.existsSync(path.join(TEST_DATA_DIR, 'v2-sessions', refs.id))).toBe(true);
    expect(fs.existsSync(path.join(TEST_DATA_DIR, 'v2-sessions', refs.id + '~'))).toBe(false);

    // Rows restored with IDENTICAL payloads.
    expect(db.prepare('SELECT * FROM agent_groups WHERE id = ?').get(refs.id)).toEqual(before.group);
    expect(db.prepare('SELECT * FROM container_configs WHERE agent_group_id = ?').get(refs.id)).toEqual(before.cfg);
    expect(db.prepare('SELECT * FROM agent_group_members WHERE agent_group_id = ?').all(refs.id)).toEqual(
      before.members,
    );
    expect(db.prepare('SELECT * FROM user_roles WHERE agent_group_id = ?').all(refs.id)).toEqual(before.roles);
    expect(db.prepare('SELECT * FROM messaging_group_agents WHERE agent_group_id = ?').all(refs.id)).toEqual(
      before.wirings,
    );

    // Default: sessions NOT replayed.
    expect(db.prepare('SELECT 1 FROM sessions WHERE agent_group_id = ?').get(refs.id)).toBeUndefined();
  });

  it('replays sessions when --with-sessions is passed', async () => {
    const refs = seedGroup('ag-rt-sess', 'rt-sess');
    const db = getDb();
    const seededSession = db.prepare('SELECT * FROM sessions WHERE agent_group_id = ?').get(refs.id);
    db.prepare(
      `INSERT INTO approval_history(
      approval_id,session_id,action,payload,title,options_json,created_at,status,decision,responded_by,response_message)
      VALUES('retained-approval',?,'install_packages','{}','Install package','[]',?,'approved','approve',?,'Keep existing work.')`,
    ).run(refs.sessionId, NOW(), refs.userId);
    const approval = db.prepare("SELECT * FROM approval_history WHERE approval_id='retained-approval'").get();

    await archive(refs.id);
    const r = await restore('rt-sess', true);
    expect(r.ok).toBe(true);

    expect(db.prepare('SELECT * FROM sessions WHERE agent_group_id = ?').get(refs.id)).toEqual(seededSession);
    expect(db.prepare("SELECT * FROM approval_history WHERE approval_id='retained-approval'").get()).toEqual(approval);
  });

  it('refuses to restore over a live group with the same folder', async () => {
    const refs = seedGroup('ag-rt-coll', 'rt-coll');
    await archive(refs.id);
    // Re-create a live group with the same folder; restore must refuse.
    seedGroup('ag-rt-coll-2', 'rt-coll');

    const r = await restore('rt-coll');
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('expected refusal');
    expect(r.error.message).toMatch(/already in use/);
    // Archived folder untouched.
    expect(fs.existsSync(path.join(TEST_GROUPS_DIR, 'rt-coll~', 'archive.json'))).toBe(true);
  });
});
