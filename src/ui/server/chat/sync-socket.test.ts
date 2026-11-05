import { once } from 'node:events';
import Database from 'better-sqlite3';
import fs from 'node:fs';
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
import {
  parseSyncFrame,
  SYNC_PROTOCOL_VERSION,
  SYNC_RELOAD_CLOSE_CODE,
  type SyncFrame,
  type SyncConversation,
  type GlobalProjection,
  reduceGlobal,
} from '../../shared/sync.js';
import { initSessionFolder, inboundDbPath, outboundDbPath } from '../../../session-manager.js';
import { refreshThreadSummaries } from '../../../thread-summaries.js';
import { applyDurableRunnerEvent } from '../../../session-link-durable.js';
import { attachSyncSocket } from './sync-socket.js';
import { readGlobalSync, createGlobalProjection } from './sync-state.js';
import * as attention from './attention.js';
import { revokeRole, grantRole } from '../../../modules/permissions/db/user-roles.js';
vi.mock('./threads.js', async (original) => ({
  ...(await original<typeof import('./threads.js')>()),
  listThreadsForViewer: vi.fn(async () => []),
}));
vi.mock('../../../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../config.js')>()),
  DATA_DIR: '.test-sync-socket',
}));
import { listThreadsForViewer } from './threads.js';
import { publishHostChange } from '../../../host-changes.js';
import { readConversation } from './conversation.js';
import { reduceConversation, type ConversationSnapshot } from '../../shared/conversation-protocol.js';

let server: WebSocketServer;
let token: string;
const clients: WebSocket[] = [];
const frames: SyncFrame[] = [];
let globalState: GlobalProjection | null = null;
const globalView = () => globalState?.data;
const globalCursor = () => (globalState ? { streamId: globalState.streamId, revision: globalState.revision } : null);
const listThreads = vi.mocked(listThreadsForViewer);
const now = () => new Date().toISOString();
const conversation = { threadId: 'thread', channelType: 'web', messagingGroupId: 'mg' };
function startTurn() {
  applyDurableRunnerEvent('g', 'session', {
    eventId: 'turn',
    sequence: 1,
    event: {
      type: 'turn.upsert',
      payload: {
        id: 'turn',
        origin_channel_type: 'web',
        origin_platform_id: 'group:g',
        origin_thread_id: 'thread',
        origin_source_session_id: null,
        started_at: now(),
        ended_at: null,
        phase: 'running',
        outcome: 'pending',
        provenance: 'native',
        imported_from_session_id: null,
        imported_from_turn_id: null,
      },
    },
  });
}
function trace(sequence = 2) {
  applyDurableRunnerEvent('g', 'session', {
    eventId: `trace-${sequence}`,
    sequence,
    event: {
      type: 'activity.persist',
      payload: {
        turn_id: 'turn',
        message_out_id: null,
        ordinal: sequence - 2,
        timeline_position: (sequence - 1) * 100,
        ts: String((sequence - 1) * 1000),
        text: JSON.stringify({
          kind: 'tool',
          id: 'tool',
          tool: 'read',
          status: sequence === 2 ? 'running' : 'completed',
        }),
      },
    },
  });
}
function conversationView() {
  let state: ConversationSnapshot | null = null;
  for (const frame of frames) if (frame.conversation) state = reduceConversation(state, frame.conversation);
  return state?.conversation;
}

beforeEach(async () => {
  fs.rmSync('.test-sync-socket', { recursive: true, force: true });
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
  initSessionFolder('g', 'session');
  frames.length = 0;
  globalState = null;
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
  fs.rmSync('.test-sync-socket', { recursive: true, force: true });
});

async function connect(
  groupId: string | null = null,
  conversation: SyncConversation | null = null,
  waitForSnapshot = true,
) {
  const client = new WebSocket(`ws://127.0.0.1:${(server.address() as AddressInfo).port}`, {
    headers: { Cookie: `${COOKIE_NAME}=${token}` },
  });
  clients.push(client);
  client.on('message', (raw) => {
    const frame = parseSyncFrame(JSON.parse(raw.toString()));
    frames.push(frame);
    if (frame.global) globalState = reduceGlobal(globalState, frame.global, frame.groupId);
  });
  await once(client, 'open');
  client.send(
    JSON.stringify({
      kind: 'subscribe',
      protocolVersion: SYNC_PROTOCOL_VERSION,
      subscriptionId: 1,
      groupId,
      conversation,
      globalCursor: null,
    }),
  );
  if (waitForSnapshot) await vi.waitFor(() => expect(frames.some((frame) => frame.global)).toBe(true));
  return client;
}

describe('unified sync WebSocket integration', () => {
  it('updates an unselected agent from runtime notices using only an agent status patch', async () => {
    grantRole({ user_id: 'viewer', role: 'admin', agent_group_id: 'other', granted_at: now(), granted_by: null });
    getDb().exec(`
      INSERT INTO messaging_groups(id,channel_type,instance,platform_id,is_group,created_at)
        VALUES('other-mg','web','web','group:other',1,'now');
      INSERT INTO messaging_group_agents(id,messaging_group_id,agent_group_id,session_mode,created_at)
        VALUES('other-wire','other-mg','other','per-thread','now');
      INSERT INTO sessions(id,agent_group_id,messaging_group_id,thread_id,created_at)
        VALUES('other-session','other','other-mg','other-thread','now');
    `);
    initSessionFolder('other', 'other-session');
    const source = new Database(inboundDbPath('other', 'other-session'));
    const output = new Database(outboundDbPath('other', 'other-session'));
    try {
      source.exec(`INSERT INTO messages_in(id,seq,kind,timestamp,channel_type,platform_id,thread_id,content)
        VALUES('other-input',2,'chat','now','web','group:other','other-thread','{"text":"Other"}');`);
      refreshThreadSummaries('other-session');
      await connect('g');
      expect(globalView()?.agentActivity.find((group) => group.id === 'other')?.activity).toBe('idle');
      output.exec(`INSERT INTO turns(id,phase,outcome,provenance,origin_channel_type,origin_platform_id,origin_thread_id,started_at)
        VALUES('other-turn','running','pending','native','web','group:other','other-thread','now');`);
      refreshThreadSummaries('other-session');
      publishHostChange({ kind: 'runtime', sessionId: 'other-session' });
      await vi.waitFor(() =>
        expect(globalView()?.agentActivity.find((group) => group.id === 'other')?.activity).toBe('running'),
      );
      const patch = frames.at(-1)?.global;
      if (patch?.kind !== 'update') throw new Error('Expected agent status patch');
      expect(patch.changes.group).toBeUndefined();
      expect(patch.changes.agentActivity?.upserts).toEqual([{ id: 'other', activity: 'running', activityStale: true }]);
      expect(JSON.stringify(frames.at(-1)).length).toBeLessThan(512);
    } finally {
      source.close();
      output.close();
    }
  });
  it('acknowledges unchanged metadata refreshes without resnapshotting the conversation', async () => {
    startTurn();
    const client = await connect('g', conversation);
    const initial = frames.find((frame) => frame.conversation)?.conversation;
    client.send(
      JSON.stringify({
        kind: 'subscribe',
        protocolVersion: SYNC_PROTOCOL_VERSION,
        subscriptionId: 2,
        groupId: 'g',
        conversation,
        globalCursor: globalCursor(),
      }),
    );
    await vi.waitFor(() => expect(frames.some((frame) => frame.subscriptionId === 2 && frame.global)).toBe(true));
    expect(frames.find((frame) => frame.subscriptionId === 2 && frame.global)?.global).toMatchObject({
      kind: 'update',
      changes: {},
    });
    expect(frames.filter((frame) => frame.conversation)).toHaveLength(1);
    trace();
    await vi.waitFor(() => expect(conversationView()?.turns[0].activity).toHaveLength(1));
    expect(frames.at(-1)).toMatchObject({
      subscriptionId: 2,
      conversation: { kind: 'update', streamId: initial?.streamId, baseRevision: 0, revision: 1 },
    });
    expect(listThreads).toHaveBeenCalledTimes(2);
  });

  it('streams turn activity while a metadata scan is blocked, without rescanning threads', async () => {
    startTurn();
    let finish!: (value: never[]) => void;
    listThreads.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    await connect('g', conversation, false);
    await vi.waitFor(() => expect(conversationView()?.turns[0].id).toBe('turn'));
    await vi.waitFor(() => expect(listThreads).toHaveBeenCalledOnce());
    expect(frames.some((frame) => frame.global)).toBe(false);
    const committedAt = Date.now();
    trace();
    await vi.waitFor(() => expect(conversationView()?.turns[0].activity).toHaveLength(1));
    expect(Date.now() - committedAt).toBeLessThanOrEqual(250);
    expect(listThreads).toHaveBeenCalledOnce();
    finish([]);
    await vi.waitFor(() => expect(frames.some((frame) => frame.global)).toBe(true));
    expect(conversationView()).toEqual(readConversation('viewer', 'g', 'thread', conversation));
  });

  it('reduces trace lifecycle updates once and restores the same activity on reconnect', async () => {
    startTurn();
    const client = await connect('g', conversation);
    const readInteractions = vi.spyOn(attention, 'readInteractionSync');
    trace();
    trace(3);
    await vi.waitFor(() => expect(conversationView()?.turns[0].activity[0].text).toContain('"completed"'));
    expect(conversationView()?.turns[0].activity).toHaveLength(1);
    expect(readInteractions).not.toHaveBeenCalled();
    expect(listThreads).toHaveBeenCalledOnce();
    const current = conversationView();
    const count = frames.length;
    trace(3);
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(frames).toHaveLength(count);
    const closed = once(client, 'close');
    client.close();
    await closed;
    frames.length = 0;
    await connect('g', conversation);
    expect(conversationView()).toEqual(current);
    expect(frames.find((frame) => frame.conversation)?.conversation?.revision).toBe(0);
  });

  it('switches threads on one socket, cancels stale trace work and reuses the group scan', async () => {
    startTurn();
    const client = await connect('g', conversation);
    const count = frames.length;
    trace();
    client.send(
      JSON.stringify({
        kind: 'subscribe',
        protocolVersion: SYNC_PROTOCOL_VERSION,
        subscriptionId: 2,
        groupId: 'g',
        conversation: { ...conversation, threadId: 'other-thread' },
        globalCursor: globalCursor(),
      }),
    );
    await vi.waitFor(() => expect(frames.some((frame) => frame.subscriptionId === 2 && frame.global)).toBe(true));
    expect(frames.slice(count).every((frame) => frame.subscriptionId === 2)).toBe(true);
    const snapshot = frames.slice(count).find((frame) => frame.conversation)?.conversation;
    expect(snapshot?.kind).toBe('snapshot');
    if (snapshot?.kind !== 'snapshot') throw new Error('Expected selected conversation snapshot');
    expect(snapshot.conversation).toMatchObject({ threadId: 'other-thread', turns: [] });
    expect(clients).toHaveLength(1);
    expect(listThreads).toHaveBeenCalledTimes(2);
  });

  it('clears revoked conversation and group state while retaining the global subscription', async () => {
    startTurn();
    const client = await connect('g', conversation);
    revokeRole('viewer', 'admin', 'g');
    removeMember('viewer', 'g');
    await vi.waitFor(() => expect(frames.some((frame) => frame.conversation === null)).toBe(true));
    await vi.waitFor(() => expect(globalView()?.group).toBeNull());
    expect(client.readyState).toBe(WebSocket.OPEN);
    expect(globalView()?.approvals).toEqual([]);
  });

  it('does not expose a forged non-web messaging context despite group access', async () => {
    const client = await connect('g', { ...conversation, channelType: 'telegram' });
    expect(frames.find((frame) => frame.conversation !== undefined)?.conversation).toBeNull();
    expect(globalView()?.group).not.toBeNull();
    expect(client.readyState).toBe(WebSocket.OPEN);
  });

  it('expires authentication even when the first metadata scan has not completed', async () => {
    getDb()
      .prepare('UPDATE ui_sessions SET expires_at=?')
      .run(new Date(Date.now() + 500).toISOString());
    let finish!: (value: never[]) => void;
    listThreads.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const client = await connect('g', conversation, false);
    await vi.waitFor(() => expect(listThreads).toHaveBeenCalledOnce());
    const [code] = await once(client, 'close');
    expect(code).toBe(4401);
    finish([]);
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(frames.some((frame) => frame.global)).toBe(false);
  });

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
    initSessionFolder('other', 'other-session');
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
      expect(globalView()?.attention).toEqual([
        {
          id: 'off-screen-question',
          origin: { agentGroupId: 'other', threadId: 'other-thread', channelType: 'web', messagingGroupId: 'other-mg' },
        },
      ]),
    );
    expect(globalView()?.agentActivity.find((group) => group.id === 'other')?.activity).toBe('waiting');
    expect(listThreads).toHaveBeenCalledTimes(2);
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
    await vi.waitFor(() => expect(globalView()?.approvals.map((row) => row.id)).toEqual(['off-screen']));
    const last = frames.at(-1)?.global;
    expect(last?.kind).toBe('update');
    if (last?.kind !== 'update') throw new Error('Expected metadata patch');
    expect(last.changes.group).toBeUndefined();
    expect(last.changes.approvals?.upserts.map((row) => row.id)).toEqual(['off-screen']);
    expect(listThreads).toHaveBeenCalledTimes(2);
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
    const first = await projection.read('g');
    expect(first.approvals).toHaveLength(1);
    revokeRole('viewer', 'admin', 'g');
    expect(projection.canPublish()).toBe(false);
    const next = await projection.read('g');
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
    await vi.waitFor(() => expect(globalView()?.approvals.map((row) => row.id)).toEqual(['visible']));
    updateApprovalStatus('visible', 'cancelled');
    await vi.waitFor(() => expect(globalView()?.approvals).toEqual([]));
    expect(listThreads).not.toHaveBeenCalled();
  });

  it('enforces legacy deadlines on refresh without scheduling a workflow transition', async () => {
    const expiresAt = new Date(Date.now() + 2000).toISOString();
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
    expect(globalView()!.attention.map((row) => row.id)).toEqual(['q']);
    await new Promise((resolve) => setTimeout(resolve, Math.max(1, Date.parse(expiresAt) - Date.now() + 50)));
    expect(frames).toHaveLength(1);
    client.send(
      JSON.stringify({
        kind: 'subscribe',
        protocolVersion: SYNC_PROTOCOL_VERSION,
        subscriptionId: 2,
        groupId: null,
        conversation: null,
        globalCursor: globalCursor(),
      }),
    );
    await vi.waitFor(() => expect(globalView()?.attention).toEqual([]), { timeout: 2000 });
    expect(getDb().prepare("SELECT status FROM interactions WHERE id='q'").get()).toEqual({ status: 'pending' });
  });

  it('pushes voice configuration and explicitly clears revoked group state', async () => {
    await connect('g');
    const scans = listThreads.mock.calls.length;
    ensureContainerConfig('g');
    updateContainerConfigScalars('g', { voice_input_enabled: 0 });
    await vi.waitFor(() => expect(globalView()?.group?.voiceInput.reason).toBe('Voice input is disabled.'));
    expect(frames.at(-1)?.global).toMatchObject({
      kind: 'update',
      changes: { group: { kind: 'update', voiceInput: { reason: 'Voice input is disabled.' } } },
    });
    const voicePatch = frames.at(-1)?.global;
    if (voicePatch?.kind !== 'update' || voicePatch.changes.group?.kind !== 'update')
      throw new Error('Expected voice patch');
    expect(voicePatch.changes.group.threads).toBeUndefined();
    expect(listThreads).toHaveBeenCalledTimes(scans + 1);
    getDb().prepare("DELETE FROM user_roles WHERE user_id='viewer'").run();
    removeMember('viewer', 'g');
    await vi.waitFor(() => expect(globalView()?.group).toBeNull());
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
    expect(globalView()!.group).toBeNull();
  });
});
