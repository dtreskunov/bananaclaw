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

const TEST_ROOT = process.cwd() + '/.test-tmp/nanoclaw-test-cli-archive-restore';
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
    GROUPS_DIR: process.cwd() + '/.test-tmp/nanoclaw-test-cli-archive-restore/groups',
    DATA_DIR: process.cwd() + '/.test-tmp/nanoclaw-test-cli-archive-restore/data',
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
import { SessionCandidates } from '../../session-candidates.js';
import './groups.js';
import './approvals.js';
import { createApproval, getApproval, updateApprovalStatus } from '../../db/approvals.js';
import { beginApprovalExecution, endApprovalExecution } from '../../db/sessions.js';
import {
  createApprovalWorkflow,
  finishApprovalWorkflow,
  getAccountRequest,
} from '../../modules/approvals/workflows.js';

const NOW = () => Date.now();

interface SeedRefs {
  id: string;
  folder: string;
  userId: string;
  messagingGroupId: string;
  wiringId: string;
  sessionId: string;
}

function seedApproval(refs: SeedRefs, id: string, action = 'request_access') {
  createApproval({
    id: id,
    request_id: id,
    session_id: refs.sessionId,
    created_at: NOW(),
    input: {
      action: action,
      payload: JSON.parse('{"resource_url":"https://api.example.com/","reason":"Read"}'),
      title: 'Request',
      options: JSON.parse('[]'),
    },
  });
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
  it('rejects legacy ISO archive records without inserting rows or renaming files', async () => {
    const refs = seedGroup('iso-archive', 'iso-archive');
    expect((await archive(refs.id)).ok).toBe(true);
    const filename = path.join(TEST_GROUPS_DIR, 'iso-archive~', 'archive.json');
    const dump = JSON.parse(
      fs.readFileSync(filename, 'utf8'),
    ) as import('../../modules/archive/archive-group.js').ArchiveDump;
    dump.agent_group.created_at = '2026-01-01T00:00:00.000Z';
    const contents = JSON.stringify(dump);
    fs.writeFileSync(filename, contents);
    const result = await restore('iso-archive', true);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain('Invalid epoch-millisecond timestamp');
    expect(getDb().prepare('SELECT id FROM agent_groups WHERE id=?').get(refs.id)).toBeUndefined();
    expect(getDb().prepare('SELECT id FROM sessions WHERE id=?').get(refs.sessionId)).toBeUndefined();
    expect(fs.readFileSync(filename, 'utf8')).toBe(contents);
    expect(fs.existsSync(path.join(TEST_GROUPS_DIR, 'iso-archive'))).toBe(false);
  });

  it('cancels pending approvals and restores finalized account records without private recovery or retry', async () => {
    const refs = seedGroup('audit', 'audit');
    for (const id of ['pending', 'failed']) {
      seedApproval(refs, id);
      createApprovalWorkflow(id, id);
      getDb()
        .prepare('UPDATE interaction_progress SET data_json=? WHERE id=?')
        .run('{"private_selection":"must-not-be-archived"}', id);
    }
    finishApprovalWorkflow('failed', 'failed', 'Review uncertain effects.');
    expect(getAccountRequest('failed').retryable).toBe(true);
    const listed = await dispatch({ id: 'list', command: 'approvals-get', args: { id: 'failed' } }, { caller: 'host' });
    expect(listed.ok).toBe(true);
    expect(JSON.stringify(listed)).not.toContain('must-not-be-archived');
    expect(JSON.stringify(listed)).not.toContain('data_json');
    expect((await archive(refs.id)).ok).toBe(true);
    const dumpText = fs.readFileSync(path.join(TEST_GROUPS_DIR, 'audit~', 'archive.json'), 'utf8');
    expect(dumpText).not.toContain('must-not-be-archived');
    expect(JSON.parse(dumpText)).toMatchObject({
      version: 4,
      interactions: expect.arrayContaining([
        expect.objectContaining({ id: 'pending', status: 'cancelled' }),
        expect.objectContaining({ id: 'failed', status: 'failed' }),
      ]),
    });
    expect((await restore('audit', true)).ok).toBe(true);
    expect(getApproval('pending')?.status).toBe('cancelled');
    expect(getAccountRequest('failed')).toMatchObject({
      kind: 'access_grant',
      status: 'failed',
      outcomeMessage: 'Review uncertain effects.',
      retryable: false,
    });
    expect(getDb().prepare('SELECT * FROM interaction_progress').all()).toEqual([]);
  });

  it.each(['persisted', 'process-local'])(
    'refuses archive and deletion while approval execution is %s',
    async (mode) => {
      const refs = seedGroup('busy', 'busy');
      seedApproval(refs, 'busy', 'install_packages');
      if (mode === 'persisted') updateApprovalStatus('busy', 'applying');
      else beginApprovalExecution(getApproval('busy')!);
      try {
        for (const command of ['groups-archive', 'groups-delete']) {
          const result = await dispatch({ id: command, command, args: { id: refs.id } }, { caller: 'host' });
          expect(result.ok).toBe(false);
          if (!result.ok) expect(result.error.message).toContain('being processed');
        }
        expect(getApproval('busy')?.status).toBe(mode === 'persisted' ? 'applying' : 'pending');
        expect(fs.existsSync(path.join(TEST_GROUPS_DIR, 'busy', 'archive.json'))).toBe(false);
      } finally {
        endApprovalExecution('busy');
      }
    },
  );

  it.each([1, 2])('rejects retired archive format %s without replaying rows', async (version) => {
    const refs = seedGroup('old-format', 'old-format');
    await archive(refs.id);
    const file = path.join(TEST_GROUPS_DIR, 'old-format~', 'archive.json');
    const dump = JSON.parse(fs.readFileSync(file, 'utf8'));
    dump.version = version;
    fs.writeFileSync(file, JSON.stringify(dump));
    const result = await restore('old-format', true);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain('Unsupported archive storage');
    expect(fs.existsSync(file)).toBe(true);
  });

  it('does not cancel pending decisions when writing the archive fails', async () => {
    const refs = seedGroup('write-failure', 'write-failure');
    seedApproval(refs, 'pending');
    fs.mkdirSync(path.join(TEST_GROUPS_DIR, 'write-failure', 'archive.json'));
    expect((await archive(refs.id)).ok).toBe(false);
    expect(getApproval('pending')?.status).toBe('pending');
  });

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
      `INSERT INTO interactions(
      id,kind,request_id,session_id,input_json,created_at,updated_at,status,responded_by,response_json)
      VALUES('retained-approval','confirmation','retained-approval',?,
      '{"action":"install_packages","payload":{},"title":"Install package","options":[]}',?,1767225600000,'approved',?,
      '{"decision":"approve","message":"Keep existing work."}')`,
    ).run(refs.sessionId, NOW(), refs.userId);
    const approval = db.prepare("SELECT * FROM interactions WHERE id='retained-approval'").get();

    await Promise.resolve();
    const candidates = new SessionCandidates();
    candidates.start();
    try {
      candidates.inspected(refs.sessionId, candidates.token(refs.sessionId), null);
      await archive(refs.id);
      expect([...candidates.due()]).toEqual([]);
      const r = await restore('rt-sess', true);
      expect(r.ok).toBe(true);

      expect(db.prepare('SELECT * FROM sessions WHERE agent_group_id = ?').get(refs.id)).toEqual(seededSession);
      expect(db.prepare("SELECT * FROM interactions WHERE id='retained-approval'").get()).toEqual(approval);
      expect([...candidates.due()].map((session) => session.id)).toEqual([refs.sessionId]);
    } finally {
      candidates.stop();
    }
  });

  it('restores numeric archive dates without losing epoch zero or null', async () => {
    const refs = seedGroup('ag-legacy-iso', 'legacy-iso');
    const db = getDb();
    db.prepare('UPDATE agent_groups SET created_at=0 WHERE id=?').run(refs.id);
    db.prepare('UPDATE container_configs SET updated_at=0 WHERE agent_group_id=?').run(refs.id);
    db.prepare('UPDATE sessions SET created_at=0,last_active=NULL WHERE id=?').run(refs.sessionId);
    expect((await archive(refs.id)).ok).toBe(true);
    const archivePath = path.join(TEST_GROUPS_DIR, 'legacy-iso~', 'archive.json');
    const dump = JSON.parse(fs.readFileSync(archivePath, 'utf8'));
    expect(dump.agent_group.created_at).toBe(0);
    expect(dump.container_config.updated_at).toBe(0);
    expect(dump.sessions[0].last_active).toBeNull();
    expect((await restore('legacy-iso', true)).ok).toBe(true);
    expect(db.prepare('SELECT created_at FROM agent_groups WHERE id=?').get(refs.id)).toEqual({ created_at: 0 });
    expect(db.prepare('SELECT updated_at FROM container_configs WHERE agent_group_id=?').get(refs.id)).toEqual({
      updated_at: 0,
    });
    expect(db.prepare('SELECT created_at,last_active FROM sessions WHERE id=?').get(refs.sessionId)).toEqual({
      created_at: 0,
      last_active: null,
    });
  });

  it('rejects corrupt archived timestamps without partially restoring records', async () => {
    const refs = seedGroup('ag-invalid-date', 'invalid-date');
    await archive(refs.id);
    const archivePath = path.join(TEST_GROUPS_DIR, 'invalid-date~', 'archive.json');
    const dump = JSON.parse(fs.readFileSync(archivePath, 'utf8'));
    dump.agent_group.created_at = 'not-a-timestamp';
    fs.writeFileSync(archivePath, JSON.stringify(dump));
    const result = await restore('invalid-date');
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('Expected invalid timestamp rejection');
    expect(result.error.message).toContain('Invalid epoch-millisecond timestamp');
    expect(getDb().prepare('SELECT id FROM agent_groups WHERE id=?').get(refs.id)).toBeUndefined();
    expect(fs.existsSync(archivePath)).toBe(true);
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
