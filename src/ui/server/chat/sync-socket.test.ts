import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { WebSocket, WebSocketServer } from 'ws';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeDb, getDb, initTestDb, runMigrations } from '../../../db/index.js';
import { createApproval, updateApprovalStatus } from '../../../db/approvals.js';
import { createInteraction } from '../../../db/interactions.js';
import { removeMember } from '../../../modules/permissions/db/agent-group-members.js';
import { updateContainerConfigScalars, ensureContainerConfig } from '../../../db/container-configs.js';
import { authenticate, COOKIE_NAME } from '../auth.js';
import { createSession, deleteSession } from '../db.js';
import { parseSyncFrame, SYNC_PROTOCOL_VERSION, type SyncFrame } from '../../shared/sync.js';
import { attachSyncSocket } from './sync-socket.js';

let server: WebSocketServer;
let token: string;
const clients: WebSocket[] = [];
const frames: SyncFrame[] = [];
const listThreads = vi.fn(async () => []);
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
    attachSyncSocket(socket, session.userId, session.sessionHash, listThreads);
  });
  await once(server, 'listening');
});
afterEach(async () => {
  for (const client of clients.splice(0)) client.terminate();
  for (const socket of server.clients) socket.terminate();
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  await Promise.resolve();
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

  it('removes expired attention without another database mutation', async () => {
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
    await connect();
    expect(frames[0].data.attention.map((row) => row.id)).toEqual(['q']);
    await vi.waitFor(() => expect(frames.at(-1)?.data.attention).toEqual([]), { timeout: 2000 });
    expect(getDb().prepare("SELECT status FROM interactions WHERE id='q'").get()).toEqual({ status: 'pending' });
  });

  it('pushes voice configuration and explicitly clears revoked group state', async () => {
    await connect('g');
    ensureContainerConfig('g');
    updateContainerConfigScalars('g', { voice_input_enabled: 0 });
    await vi.waitFor(() => expect(frames.at(-1)?.data.group?.voiceInput.reason).toBe('Voice input is disabled.'));
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
