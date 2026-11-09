import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const signal = vi.hoisted(() => ({
  turn: null as {
    id: string;
    status: 'running' | 'stopping';
    channelType: string;
    platformId: string;
    threadId: string | null;
  } | null,
  connected: false,
}));
vi.mock('../../../config.js', async (original) => ({
  ...(await original<typeof import('../../../config.js')>()),
  DATA_DIR: path.resolve('.test-thread-activity'),
}));
vi.mock('../../../session-link.js', async (original) => ({
  ...(await original<typeof import('../../../session-link.js')>()),
  getSessionActiveTurn: () => ({ turn: signal.turn, connected: signal.connected }),
}));
import { initTestDb, runMigrations, closeDb, getDb } from '../../../db/index.js';
import { createApproval } from '../../../db/approvals.js';
import { grantRole } from '../../../modules/permissions/db/user-roles.js';
import { removeMember } from '../../../modules/permissions/db/agent-group-members.js';
import { insertIdentity } from '../../../modules/permissions/db/identities.js';
import { initSessionFolder, inboundDbPath, outboundDbPath } from '../../../session-manager.js';
import { putTurn } from '../../../db/turns.js';
import { refreshThreadSummaries, startThreadSummaryProjection } from '../../../thread-summaries.js';
import { publishHostChange } from '../../../host-changes.js';
import { listThreadsForViewer, readAgentActivity } from './threads.js';
import { readInteractionSync } from './attention.js';
import * as summaryProjection from '../../../thread-summaries.js';
import { addMember } from '../../../modules/permissions/db/agent-group-members.js';

const ROOT = path.resolve('.test-thread-activity');
let inbound: Database.Database;
let outbound: Database.Database;
let stopProjection = () => {};
function turn(id: string, thread: string, phase: 'running' | 'stopping' | 'settling' | 'settled') {
  putTurn(outbound, {
    id,
    origin_channel_type: 'web',
    origin_platform_id: 'group:g',
    origin_thread_id: thread,
    origin_source_session_id: null,
    started_at: 1793836800000,
    ended_at: phase === 'settled' ? 1793836860000 : null,
    phase,
    outcome: phase === 'settled' ? 'replied' : 'pending',
    provenance: 'native',
    imported_from_session_id: null,
    imported_from_turn_id: null,
  });
  refreshThreadSummaries('s');
}
async function activities(userId = 'viewer') {
  return Object.fromEntries(
    (await listThreadsForViewer(userId, 'g')).map((thread) => [
      thread.threadId,
      { activity: thread.activity, ...(thread.waiting ? { waiting: true } : {}), stale: thread.activityStale === true },
    ]),
  );
}
beforeEach(() => {
  fs.rmSync(ROOT, { recursive: true, force: true });
  runMigrations(initTestDb());
  getDb().exec(`
    INSERT INTO users(id,kind,created_at) VALUES('viewer','web',1767225600000),('admin','web',1767225600000);
    INSERT INTO agent_groups(id,name,folder,created_at) VALUES('g','Group','g',1767225600000);
    INSERT INTO agent_group_members(user_id,agent_group_id,added_at) VALUES('viewer','g',1767225600000);
    INSERT INTO messaging_groups(id,channel_type,instance,platform_id,is_group,created_at) VALUES('mg','web','web','group:g',1,1767225600000);
    INSERT INTO messaging_group_agents(id,messaging_group_id,agent_group_id,session_mode,created_at) VALUES('wire','mg','g','agent-shared',1767225600000);
    INSERT INTO sessions(id,agent_group_id,created_at) VALUES('s','g',1767225600000);
  `);
  initSessionFolder('g', 's');
  inbound = new Database(inboundDbPath('g', 's'));
  outbound = new Database(outboundDbPath('g', 's'));
  inbound.exec(`INSERT INTO messages_in(id,seq,kind,timestamp,status,channel_type,platform_id,thread_id,content)
    VALUES('input-a',2,'chat',1793836800000,'completed','web','group:g','a','{"text":"A"}'),
      ('input-b',4,'chat',1793836800000,'completed','web','group:g','b','{"text":"B"}');`);
  refreshThreadSummaries('s');
  signal.turn = null;
  signal.connected = false;
  stopProjection = startThreadSummaryProjection();
});
afterEach(async () => {
  await Promise.resolve();
  stopProjection();
  inbound.close();
  outbound.close();
  closeDb();
  fs.rmSync(ROOT, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('thread activity projection', () => {
  it('shows queued work before a turn exists, then clears it after processing', async () => {
    inbound.exec("UPDATE messages_in SET status='pending' WHERE id='input-b'");
    refreshThreadSummaries('s');
    expect(await activities()).toEqual({
      a: { activity: 'idle', stale: false },
      b: { activity: 'running', stale: false },
    });
    expect(readAgentActivity('viewer', [], null, [])).toEqual([{ id: 'g', activity: 'running', threadCount: 2 }]);
    turn('turn-b', 'b', 'running');
    signal.turn = { id: 'turn-b', status: 'running', channelType: 'web', platformId: 'group:g', threadId: 'b' };
    signal.connected = true;
    inbound.exec("UPDATE messages_in SET status='completed' WHERE id='input-b'");
    refreshThreadSummaries('s');
    expect((await activities()).b.activity).toBe('running');
    turn('turn-b', 'b', 'settled');
    expect((await activities()).b.activity).toBe('idle');
  });

  it.each([
    "status='paused'",
    "status='failed'",
    "kind='system'",
    'trigger=0',
    `process_after=${Date.parse('2999-01-01T00:00:00Z')}`,
  ])('does not spin for input excluded from runnable work: %s', async (exclude) => {
    inbound.exec(`UPDATE messages_in SET status='pending', ${exclude} WHERE id='input-b'`);
    refreshThreadSummaries('s');
    expect((await activities()).b.activity).toBe('idle');
    expect(readAgentActivity('viewer', [], null, [])[0].activity).toBe('idle');
  });
  it('marks only the executing conversation running in a shared session', async () => {
    expect(await activities()).toEqual({
      a: { activity: 'idle', stale: false },
      b: { activity: 'idle', stale: false },
    });
    turn('turn-a', 'a', 'running');
    signal.turn = { id: 'turn-a', status: 'running', channelType: 'web', platformId: 'group:g', threadId: 'a' };
    signal.connected = true;
    expect(await activities()).toEqual({
      a: { activity: 'running', stale: false },
      b: { activity: 'idle', stale: false },
    });
    turn('turn-a', 'a', 'settled');
    turn('turn-b', 'b', 'running');
    signal.turn = { ...signal.turn, id: 'turn-b', threadId: 'b' };
    expect(await activities()).toEqual({
      a: { activity: 'idle', stale: false },
      b: { activity: 'running', stale: false },
    });
  });
  it.each(['stopping', 'settling'] as const)('maps internal phase %s to running', async (phase) => {
    turn('turn-a', 'a', phase);
    signal.turn = { id: 'turn-a', status: 'stopping', channelType: 'web', platformId: 'group:g', threadId: 'a' };
    signal.connected = true;
    expect((await activities()).a.activity).toBe('running');
  });
  it('counts idle agents from the maintained projection and omits inaccessible groups', () => {
    getDb().exec(
      `INSERT INTO agent_groups(id,name,folder,created_at) VALUES('private','Private','private',1767225600000);`,
    );
    const read = vi.spyOn(summaryProjection, 'readSessionThreadSummary');
    expect(readAgentActivity('viewer', [], null, [])).toEqual([{ id: 'g', activity: 'idle', threadCount: 2 }]);
    expect(read).toHaveBeenCalledOnce();
  });
  it('reuses selected summaries and includes unselected groups without private thread leakage', async () => {
    turn('turn-a', 'a', 'running');
    signal.turn = { id: 'turn-a', status: 'running', channelType: 'web', platformId: 'group:g', threadId: 'a' };
    signal.connected = true;
    const selected = await listThreadsForViewer('viewer', 'g', []);
    const read = vi.spyOn(summaryProjection, 'readSessionThreadSummary');
    expect(readAgentActivity('viewer', [], 'g', selected)).toEqual([{ id: 'g', activity: 'running', threadCount: 2 }]);
    expect(read).not.toHaveBeenCalled();
    getDb().exec(`
      INSERT INTO agent_groups(id,name,folder,created_at) VALUES('other','Other','other',1767225600000);
      INSERT INTO messaging_groups(id,channel_type,instance,platform_id,is_group,created_at)
        VALUES('other-mg','web','web','group:other',1,1767225600000);
      INSERT INTO messaging_group_agents(id,messaging_group_id,agent_group_id,session_mode,created_at)
        VALUES('other-wire','other-mg','other','per-thread',1767225600000);
      INSERT INTO sessions(id,agent_group_id,messaging_group_id,thread_id,created_at)
        VALUES('other-session','other','other-mg','other-thread',1767225600000);
    `);
    initSessionFolder('other', 'other-session');
    const source = new Database(inboundDbPath('other', 'other-session'));
    const output = new Database(outboundDbPath('other', 'other-session'));
    try {
      source.exec(`INSERT INTO messages_in(id,seq,kind,timestamp,status,channel_type,platform_id,thread_id,content)
        VALUES('other-input',2,'chat',1767225600000,'completed','web','group:other','other-thread','{"text":"Other"}');`);
      output.exec(`INSERT INTO turns(id,phase,outcome,provenance,origin_channel_type,origin_platform_id,origin_thread_id,started_at)
        VALUES('other-turn','running','pending','native','web','group:other','other-thread',1767225600000);`);
      refreshThreadSummaries('other-session');
      expect(readAgentActivity('viewer', [], null, []).map((group) => group.id)).toEqual(['g']);
      addMember({ user_id: 'viewer', agent_group_id: 'other', added_by: null, added_at: 1767225600000 });
      expect(readAgentActivity('viewer', [], null, [])).toEqual([
        { id: 'g', activity: 'running', threadCount: 2 },
        { id: 'other', activity: 'running', activityStale: true, threadCount: 1 },
      ]);
    } finally {
      source.close();
      output.close();
    }
  });
  it('reuses one visible summary read for unselected counts and activity', () => {
    turn('turn-a', 'a', 'running');
    signal.turn = { id: 'turn-a', status: 'running', channelType: 'web', platformId: 'group:g', threadId: 'a' };
    signal.connected = true;
    const read = vi.spyOn(summaryProjection, 'readSessionThreadSummary');
    expect(readAgentActivity('viewer', [], null, [])).toEqual([{ id: 'g', activity: 'running', threadCount: 2 }]);
    expect(read).toHaveBeenCalledOnce();
    expect(read.mock.results[0].value.threads.map((thread: { threadId: string }) => thread.threadId)).toEqual([
      'a',
      'b',
    ]);
  });
  it('removes a group immediately after access is revoked and fails closed on broken projection state', () => {
    removeMember('viewer', 'g');
    expect(readAgentActivity('viewer', [], null, [])).toEqual([]);
    stopProjection();
    getDb().prepare('UPDATE thread_summary_meta SET ready=0').run();
    expect(() => readAgentActivity('viewer', [], null, [])).toThrow('offline backfill');
  });
  it('does not expose execution in a private non-web thread through its group status', async () => {
    insertIdentity({ userId: 'viewer', channel: 'resend', handle: 'own@example.com' });
    getDb().exec(`
      INSERT INTO messaging_groups(id,channel_type,instance,platform_id,is_group,created_at)
        VALUES('private-mg','resend','resend','bot@example.com',1,1767225600000);
      INSERT INTO messaging_group_agents(id,messaging_group_id,agent_group_id,session_mode,created_at)
        VALUES('private-wire','private-mg','g','per-thread',1767225600000);
      INSERT INTO sessions(id,agent_group_id,messaging_group_id,thread_id,created_at)
        VALUES('private-session','g','private-mg','private-thread',1767225600000);
    `);
    initSessionFolder('g', 'private-session');
    const source = new Database(inboundDbPath('g', 'private-session'));
    const output = new Database(outboundDbPath('g', 'private-session'));
    try {
      source.exec(`INSERT INTO messages_in(id,seq,kind,timestamp,status,channel_type,platform_id,thread_id,content)
        VALUES('private-input',2,'chat',1767225600000,'completed','resend','bot@example.com','private-thread','{"text":"Private","sender":"other@example.com"}');`);
      output.exec(`INSERT INTO turns(id,phase,outcome,provenance,origin_channel_type,origin_platform_id,origin_thread_id,started_at)
        VALUES('private-turn','running','pending','native','resend','bot@example.com','private-thread',1767225600000);`);
      refreshThreadSummaries('private-session');
      signal.turn = {
        id: 'private-turn',
        status: 'running',
        channelType: 'resend',
        platformId: 'bot@example.com',
        threadId: 'private-thread',
      };
      signal.connected = true;
      expect(readAgentActivity('viewer', [], null, [])).toEqual([{ id: 'g', activity: 'idle', threadCount: 2 }]);
      grantRole({
        user_id: 'admin',
        role: 'admin',
        agent_group_id: null,
        granted_by: null,
        granted_at: 1767225600000,
      });
      expect(readAgentActivity('admin', [], null, [])).toEqual([{ id: 'g', activity: 'running', threadCount: 3 }]);
    } finally {
      source.close();
      output.close();
    }
  });
  it('does not expose approval waiting state to a viewer who cannot act on it', async () => {
    grantRole({
      user_id: 'admin',
      role: 'admin',
      agent_group_id: 'g',
      granted_by: null,
      granted_at: 1767225600000,
    });
    createApproval({
      id: 'approval',
      request_id: 'approval',
      session_id: 's',
      agent_group_id: 'g',
      origin_message_id: 'input-a',
      created_at: 1767225600000,
      input: {
        action: 'test',
        title: 'Approve?',
        payload: {},
        options: [{ label: 'Yes', value: 'yes', selectedLabel: 'Yes' }],
      },
    });
    expect((await activities()).a.activity).toBe('idle');
    expect((await activities('admin')).a.waiting).toBe(true);
    removeMember('viewer', 'g');
    await expect(activities()).rejects.toThrow('access denied');
  });
  it('keeps disconnected execution stale rather than fabricating idle', async () => {
    turn('turn-a', 'a', 'running');
    expect((await activities()).a).toEqual({ activity: 'running', stale: true });
    signal.turn = { id: 'turn-a', status: 'running', channelType: 'web', platformId: 'group:g', threadId: 'a' };
    signal.connected = true;
    expect((await activities()).a.stale).toBe(false);
    signal.connected = false;
    expect((await activities()).a).toEqual({ activity: 'running', stale: true });
  });
  it('reads indicators with source DBs locked and ignores high-frequency trace invalidations', async () => {
    await Promise.resolve();
    inbound.exec('BEGIN EXCLUSIVE');
    outbound.exec('BEGIN EXCLUSIVE');
    try {
      for (let index = 0; index < 100; index++) publishHostChange({ kind: 'runtime', sessionId: 's' });
      for (let index = 0; index < 100; index++) publishHostChange({ kind: 'activity', sessionId: 's' });
      expect((await activities()).a.activity).toBe('idle');
    } finally {
      inbound.exec('ROLLBACK');
      outbound.exec('ROLLBACK');
    }
  });
});
