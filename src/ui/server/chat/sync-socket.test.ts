import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { WebSocket, WebSocketServer } from 'ws';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeDb, getDb, initTestDb, runMigrations } from '../../../db/index.js';
import { createApproval, updateApprovalStatus } from '../../../db/approvals.js';
import { createInteraction } from '../../../db/interactions.js';
import { createQuestion } from '../../../db/sessions.js';
import { removeMember } from '../../../modules/permissions/db/agent-group-members.js';
import { updateContainerConfigScalars, ensureContainerConfig } from '../../../db/container-configs.js';
import { authenticate, COOKIE_NAME } from '../auth.js';
import { createSession, deleteSession } from '../db.js';
import { parseSyncFrame, SYNC_PROTOCOL_VERSION, SYNC_RELOAD_CLOSE_CODE, type SyncFrame } from '../../shared/sync.js';
import { attachSyncSocket } from './sync-socket.js';
import { readGlobalSync, createGlobalProjection } from './sync-state.js';
import * as attention from './attention.js';
import { revokeRole, grantRole } from '../../../modules/permissions/db/user-roles.js';
vi.mock('./threads.js', () => ({ listThreadsForViewer: vi.fn(async () => []) }));
import { listThreadsForViewer } from './threads.js';
import { publishHostChange } from '../../../host-changes.js';

let server: WebSocketServer;
let token: string;
const clients: WebSocket[] = [];
const frames: SyncFrame[] = [];
const listThreads = vi.mocked(listThreadsForViewer);
const now = () => new Date().toISOString();

beforeEach(async () => {
  runMigrations(initTestDb());
  getDb().exec(`
    INSERT INTO users(id,kind,created_at) VALUES('viewer','web','now'),('other','web','now');
    INSERT INTO agent_groups(id,name,folder,created_at) VALUES('g','Group','group','now'),('other','Other','other','now');
    INSERT INTO agent_group_members(user_id,agent_group_id,added_at) VALUES('viewer','g','now');
    INSERT INTO user_roles(user_id,role,agent_group_id,granted_at) VALUES('viewer','admin','g','now');
    INSERT INTO messaging_groups(id,channel_type,instance,platform_id,is_group,created_at)
      VALUES('mg','web','web','group:g',1,'now');
    INSERT INTO messaging_group_agents(id,messaging_group_id,agent_group_id,session_mode,created_at)
      VALUES('wire','mg','g','per-thread','now');
    INSERT INTO sessions(id,agent_group_id,messaging_group_id,thread_id,created_at)
      VALUES('session','g','mg','thread','now');
  `);
  token = createSession('viewer', 60_000).token;
  frames.length = 0;
  listThreads.mockClear();
  server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  server.on('connection', (socket, req) => {
    const session = authenticate(req);
    if (!session) throw new Error('Test socket was not authenticated');
    attachSyncSocket(socket, session.userId, session.sessionHash);
  });
  await once(server, 'listening');
});
afterEach(async () => {
  for (const client of clients.splice(0)) client.terminate();
  for (const socket of server.clients) socket.terminate();
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  await Promise.resolve();
  vi.restoreAllMocks();
  closeDb();
});

async function connect(groupId: string | null = null) {
  const client = new WebSocket(`ws://127.0.0.1:${(server.address() as AddressInfo).port}`, {
    headers: { Cookie: `${COOKIE_NAME}=${token}` },
  });
  clients.push(client);
  client.on('message', (raw) => frames.push(parseSyncFrame(JSON.parse(raw.toString()))));
  await once(client, 'open');
  client.send(
    JSON.stringify({ kind: 'subscribe', protocolVersion: SYNC_PROTOCOL_VERSION, subscriptionId: 1, groupId }),
  );
  await vi.waitFor(() => expect(frames).toHaveLength(1));
  return client;
}

describe('global sync WebSocket integration', () => {
  it('does not rebuild metadata or scan threads for activity-only bursts', async () => {
    await connect('g');
    const readInteractions = vi.spyOn(attention, 'readInteractionSync');
    for (let i = 0; i < 1000; i++) publishHostChange({ kind: 'activity', sessionId: 'session' });
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(listThreads).toHaveBeenCalledOnce();
    expect(readInteractions).not.toHaveBeenCalled();
    expect(frames).toHaveLength(1);
  });

  it('updates inactive-group question attention without rescanning the selected group', async () => {
    grantRole({ user_id: 'viewer', role: 'admin', agent_group_id: 'other', granted_at: now(), granted_by: null });
    getDb().exec(`
      INSERT INTO messaging_groups(id,channel_type,instance,platform_id,is_group,created_at)
        VALUES('other-mg','web','web','group:other',1,'now');
      INSERT INTO messaging_group_agents(id,messaging_group_id,agent_group_id,session_mode,created_at)
        VALUES('other-wire','other-mg','other','per-thread','now');
      INSERT INTO sessions(id,agent_group_id,messaging_group_id,thread_id,created_at)
        VALUES('other-session','other','other-mg','other-thread','now');
    `);
    await connect('g');
    createQuestion({
      id: 'off-screen-question',
      session_id: 'other-session',
      message_out_id: 'other-output',
      in_reply_to: null,
      channel_type: 'web',
      platform_id: 'group:other',
      thread_id: 'other-thread',
      created_at: now(),
      input: { question: 'Choose?', responseMode: 'text', options: [] },
    });
    await vi.waitFor(() =>
      expect(frames.at(-1)?.data.attention).toEqual([
        {
          id: 'off-screen-question',
          origin: { agentGroupId: 'other', threadId: 'other-thread', channelType: 'web', messagingGroupId: 'other-mg' },
        },
      ]),
    );
    expect(listThreads).toHaveBeenCalledOnce();
  });

  it('pushes an inactive-group approval without rescanning the selected group threads', async () => {
    grantRole({ user_id: 'viewer', role: 'admin', agent_group_id: 'other', granted_at: now(), granted_by: null });
    await connect('g');
    expect(listThreads).toHaveBeenCalledOnce();
    createApproval({
      id: 'off-screen',
      request_id: 'off-screen',
      agent_group_id: 'other',
      created_at: now(),
      input: { action: 'test', title: 'Review', payload: {}, options: [] },
    });
    await vi.waitFor(() => expect(frames.at(-1)?.data.approvals.map((row) => row.id)).toEqual(['off-screen']));
    expect(listThreads).toHaveBeenCalledOnce();
  });

  it('rejects cached approval visibility immediately after a committed role change', async () => {
    createApproval({
      id: 'private-cache',
      request_id: 'private-cache',
      agent_group_id: 'g',
      created_at: now(),
      input: { action: 'test', title: 'Review', payload: {}, options: [] },
    });
    const projection = createGlobalProjection('viewer');
    const first = await projection.read('g', true);
    expect(first.approvals).toHaveLength(1);
    revokeRole('viewer', 'admin', 'g');
    expect(projection.canPublish()).toBe(false);
    const next = await projection.read('g', false);
    expect(next.approvals).toEqual([]);
    expect(next.group).not.toBeNull();
    expect(listThreads).toHaveBeenCalledTimes(2);
    expect(projection.canPublish()).toBe(true);
  });

  it('reads interaction metadata once after the asynchronous thread scan', async () => {
    let finish!: (value: never[]) => void;
    listThreads.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const readInteractions = vi.spyOn(attention, 'readInteractionSync');
    const snapshot = readGlobalSync('viewer', 'g');
    expect(readInteractions).not.toHaveBeenCalled();
    createApproval({
      id: 'during-scan',
      request_id: 'during-scan',
      agent_group_id: 'g',
      created_at: now(),
      input: { action: 'test', title: 'Review', payload: {}, options: [] },
    });
    finish([]);
    expect((await snapshot).approvals.map((row) => row.id)).toEqual(['during-scan']);
    expect(readInteractions).toHaveBeenCalledOnce();
  });

  it('uses the current approval permissions after the asynchronous scan', async () => {
    let finish!: (value: never[]) => void;
    listThreads.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    createApproval({
      id: 'private',
      request_id: 'private',
      agent_group_id: 'g',
      created_at: now(),
      input: { action: 'test', title: 'Review', payload: {}, options: [] },
    });
    const snapshot = readGlobalSync('viewer', 'g');
    revokeRole('viewer', 'admin', 'g');
    finish([]);
    const result = await snapshot;
    expect(result.approvals).toEqual([]);
    expect(result.group).not.toBeNull();
  });

  it.each([null, 'missing'])('reads metadata once without scanning an inaccessible group: %s', async (groupId) => {
    const readInteractions = vi.spyOn(attention, 'readInteractionSync');
    expect((await readGlobalSync('viewer', groupId)).group).toBeNull();
    expect(readInteractions).toHaveBeenCalledOnce();
    expect(listThreads).not.toHaveBeenCalled();
  });

  it('explicitly requests a reload for an outdated subscription protocol', async () => {
    const client = new WebSocket(`ws://127.0.0.1:${(server.address() as AddressInfo).port}`, {
      headers: { Cookie: `${COOKIE_NAME}=${token}` },
    });
    clients.push(client);
    await once(client, 'open');
    const closed = once(client, 'close');
    const mismatch = once(client, 'message');
    client.send(
      JSON.stringify({
        kind: 'subscribe',
        protocolVersion: SYNC_PROTOCOL_VERSION - 1,
        subscriptionId: 1,
        groupId: null,
      }),
    );
    const [raw] = await mismatch;
    const notice = JSON.parse(raw.toString());
    expect(notice).toEqual({ kind: 'protocol_mismatch', protocolVersion: SYNC_PROTOCOL_VERSION });
    expect(() => parseSyncFrame(notice)).toThrow('protocol changed');
    expect((await closed)[0]).toBe(SYNC_RELOAD_CLOSE_CODE);
    expect(frames).toEqual([]);
  });

  it('pushes session-less approvals without a selected group and preserves viewer scope', async () => {
    await connect();
    createApproval({
      id: 'hidden',
      request_id: 'hidden',
      agent_group_id: 'other',
      created_at: now(),
      input: { action: 'test', title: 'Private', payload: {}, options: [] },
    });
    createApproval({
      id: 'visible',
      request_id: 'visible',
      agent_group_id: 'g',
      created_at: now(),
      input: { action: 'test', title: 'Review', payload: {}, options: [] },
    });
    await vi.waitFor(() => expect(frames.at(-1)?.data.approvals.map((row) => row.id)).toEqual(['visible']));
    updateApprovalStatus('visible', 'cancelled');
    await vi.waitFor(() => expect(frames.at(-1)?.data.approvals).toEqual([]));
    expect(listThreads).not.toHaveBeenCalled();
  });

  it('enforces legacy deadlines on refresh without scheduling a workflow transition', async () => {
    const expiresAt = new Date(Date.now() + 700).toISOString();
    createInteraction({
      id: 'q',
      kind: 'question',
      session_id: 'session',
      message_out_id: 'output',
      in_reply_to: null,
      channel_type: 'web',
      platform_id: 'group:g',
      thread_id: 'thread',
      expires_at: expiresAt,
      created_at: now(),
      input: { question: 'Continue?', responseMode: 'text', options: [] },
    });
    const client = await connect();
    expect(frames[0].data.attention.map((row) => row.id)).toEqual(['q']);
    await new Promise((resolve) => setTimeout(resolve, 800));
    expect(frames).toHaveLength(1);
    client.send(
      JSON.stringify({ kind: 'subscribe', protocolVersion: SYNC_PROTOCOL_VERSION, subscriptionId: 2, groupId: null }),
    );
    await vi.waitFor(() => expect(frames.at(-1)?.data.attention).toEqual([]), { timeout: 2000 });
    expect(getDb().prepare("SELECT status FROM interactions WHERE id='q'").get()).toEqual({ status: 'pending' });
  });

  it('pushes voice configuration and explicitly clears revoked group state', async () => {
    await connect('g');
    const scans = listThreads.mock.calls.length;
    ensureContainerConfig('g');
    updateContainerConfigScalars('g', { voice_input_enabled: 0 });
    await vi.waitFor(() => expect(frames.at(-1)?.data.group?.voiceInput.reason).toBe('Voice input is disabled.'));
    expect(listThreads).toHaveBeenCalledTimes(scans);
    getDb().prepare("DELETE FROM user_roles WHERE user_id='viewer'").run();
    removeMember('viewer', 'g');
    await vi.waitFor(() => expect(frames.at(-1)?.data.group).toBeNull());
  });

  it('closes a revoked UI session without waiting for another projection mutation', async () => {
    const client = await connect();
    const closed = once(client, 'close');
    deleteSession(token);
    const [code] = await closed;
    expect(code).toBe(4401);
  });

  it('uses the authenticated session expiry to disconnect without another state mutation', async () => {
    getDb()
      .prepare('UPDATE ui_sessions SET expires_at=?')
      .run(new Date(Date.now() + 700).toISOString());
    const client = await connect('g');
    expect(listThreads).toHaveBeenCalledOnce();
    const [code] = await once(client, 'close');
    expect(code).toBe(4401);
    expect(listThreads).toHaveBeenCalledOnce();
  });

  it('never sends a selected group list after its access is revoked during an async scan', async () => {
    let finish!: (value: never[]) => void;
    listThreads.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const connecting = connect('g');
    await vi.waitFor(() => expect(listThreads).toHaveBeenCalled());
    getDb().prepare("DELETE FROM user_roles WHERE user_id='viewer'").run();
    removeMember('viewer', 'g');
    finish([]);
    await connecting;
    expect(frames).toHaveLength(1);
    expect(frames[0].data.group).toBeNull();
  });
});
