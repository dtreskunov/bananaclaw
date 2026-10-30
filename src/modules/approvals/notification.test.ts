import fs from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { closeDb, getDb, initTestDb } from '../../db/connection.js';
import { runMigrations } from '../../db/migrations/index.js';
import { createMessagingGroup } from '../../db/messaging-groups.js';
import { createPendingApproval, createSession, getPendingApproval } from '../../db/sessions.js';
import { initSessionFolder, openInboundDb, writeSessionMessage } from '../../session-manager.js';
import type { Session } from '../../types.js';
import { grantRole } from '../permissions/db/user-roles.js';
import { upsertUser } from '../permissions/db/users.js';
import { applyAddMcpServer } from '../self-mod/apply.js';
import { writeApprovalNotification } from './notification.js';
import { registerApprovalHandler, requestApproval } from './primitive.js';
import { handleApprovalsResponse } from './response-handler.js';
import { createApprovalWorkflow, finishApprovalWorkflow, notifyApprovalWorkflow } from './workflows.js';

const mocks = vi.hoisted(() => ({ wake: vi.fn().mockResolvedValue(true), kill: vi.fn() }));
vi.mock('../../container-runner.js', () => ({
  wakeContainer: mocks.wake,
  killContainer: mocks.kill,
  buildAgentGroupImage: vi.fn(),
}));
vi.mock('../permissions/user-dm.js', () => ({ ensureUserDm: vi.fn().mockResolvedValue(null) }));
vi.mock('../../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../config.js')>()),
  DATA_DIR: `/tmp/nanoclaw-approval-routing-${process.pid}`,
}));

const directory = `/tmp/nanoclaw-approval-routing-${process.pid}`;
const session: Session = {
  id: 'session',
  agent_group_id: 'group',
  messaging_group_id: 'web-group',
  thread_id: null,
  agent_provider: null,
  status: 'active',
  container_status: 'running',
  last_active: null,
  created_at: 'now',
};
const origin = { channelType: 'web', platformId: 'original-room', threadId: 'original-thread' };

beforeEach(() => {
  fs.mkdirSync(directory, { recursive: true });
  runMigrations(initTestDb());
  getDb().prepare("INSERT INTO agent_groups(id,name,folder,created_at) VALUES('group','Agent','agent','now')").run();
  getDb().prepare("INSERT INTO container_configs(agent_group_id,updated_at) VALUES('group','now')").run();
  createMessagingGroup({
    id: 'web-group',
    channel_type: 'web',
    platform_id: 'default-room',
    instance: 'web',
    name: null,
    is_group: 1,
    unknown_sender_policy: 'strict',
    denied_at: null,
    created_at: 'now',
  });
  createSession(session);
  initSessionFolder(session.agent_group_id, session.id);
  upsertUser({ id: 'owner', kind: 'web', display_name: 'Owner', created_at: 'now' });
  grantRole({ user_id: 'owner', role: 'owner', agent_group_id: null, granted_by: null, granted_at: 'now' });
  mocks.wake.mockClear();
  mocks.kill.mockClear();
});
afterEach(() => {
  closeDb();
  fs.rmSync(directory, { recursive: true, force: true });
});

function input(id: string, route = origin, sourceSessionId?: string) {
  writeSessionMessage(session.agent_group_id, session.id, {
    id,
    kind: 'chat',
    timestamp: new Date().toISOString(),
    ...route,
    sourceSessionId,
    content: JSON.stringify({ text: id }),
  });
}
function notifications() {
  const db = openInboundDb(session.agent_group_id, session.id);
  try {
    return db
      .prepare("SELECT * FROM messages_in WHERE json_extract(content,'$.senderId')='system' ORDER BY seq")
      .all() as Array<{
      id: string;
      channel_type: string;
      platform_id: string;
      thread_id: string | null;
      source_session_id: string | null;
      on_wake: number;
      content: string;
    }>;
  } finally {
    db.close();
  }
}
async function respond(action: string, value = 'approve', originMessageId: string | null = 'original') {
  createPendingApproval({
    approval_id: 'approval',
    session_id: session.id,
    request_id: 'approval',
    action,
    payload: JSON.stringify({ name: 'gmail', url: 'https://gmail.example/mcp' }),
    created_at: 'now',
    title: 'Approval',
    options_json: '[]',
    origin_message_id: originMessageId,
  });
  await handleApprovalsResponse({
    questionId: 'approval',
    value,
    userId: 'owner',
    channelType: 'web',
    platformId: 'admin-dm',
    threadId: null,
  });
}
function expectOriginalRoute(row: ReturnType<typeof notifications>[number]) {
  expect(row).toMatchObject({
    channel_type: 'web',
    platform_id: 'original-room',
    thread_id: 'original-thread',
    source_session_id: null,
  });
  expect(JSON.parse(row.content).inputHandling).toEqual({ mode: 'steer' });
}

describe('approval conversation identity', () => {
  it('persists the requesting input, not a later conversation in a shared session', async () => {
    input('original');
    input('later', { ...origin, threadId: 'another-thread' });
    const id = await requestApproval({
      session,
      originMessageId: 'original',
      agentName: 'Agent',
      action: 'test',
      payload: {},
      title: 'Approve',
      question: 'Approve?',
    });
    expect(getPendingApproval(id!)?.origin_message_id).toBe('original');
    expectOriginalRoute(notifications()[0]);
  });

  it.each(['approve', 'reject'])('steers a %s outcome into the requesting conversation', async (decision) => {
    input('original');
    input('later', { ...origin, threadId: 'another-thread' });
    registerApprovalHandler('route-test', async ({ notify }) => {
      notify('Approved and applied.');
    });
    await respond('route-test', decision);
    expectOriginalRoute(notifications()[0]);
    expect(mocks.kill).not.toHaveBeenCalled();
  });

  it('routes handler failures and unavailable handlers to the original conversation', async () => {
    input('original');
    registerApprovalHandler('route-failure', async () => {
      throw new Error('test apply failure');
    });
    await respond('route-failure');
    expectOriginalRoute(notifications()[0]);
    expect(JSON.parse(notifications()[0].content).text).toContain('test apply failure');
  });

  it('preserves a peer conversation and its exact source-session return path', () => {
    input('peer-input', { channelType: 'agent', platformId: 'peer-group', threadId: 'peer-thread' }, 'peer-session');
    writeApprovalNotification(session, 'Approved', { originMessageId: 'peer-input' });
    expect(notifications()[0]).toMatchObject({
      channel_type: 'agent',
      platform_id: 'peer-group',
      thread_id: 'peer-thread',
      source_session_id: 'peer-session',
    });
  });

  it('uses the session conversation for legacy approvals instead of fabricating a peer sender', async () => {
    await respond('legacy', 'reject', null);
    expect(notifications()[0]).toMatchObject({
      channel_type: 'web',
      platform_id: 'default-room',
      thread_id: null,
      source_session_id: null,
    });
  });

  it('does not silently reroute a missing recorded origin', () => {
    expect(() => writeApprovalNotification(session, 'Approved', { originMessageId: 'missing' })).toThrow(
      'Approval origin message not found',
    );
    expect(notifications()).toEqual([]);
  });

  it('steers an MCP approval now and leaves verification for the replacement runner', async () => {
    input('original');
    registerApprovalHandler('mcp-route-test', applyAddMcpServer);
    await respond('mcp-route-test');
    const rows = notifications();
    expect(rows).toHaveLength(2);
    rows.forEach(expectOriginalRoute);
    expect(rows.map((row) => row.on_wake)).toEqual([0, 1]);
    expect(mocks.kill).not.toHaveBeenCalled();
    expect(
      JSON.parse(getDb().prepare('SELECT mcp_servers FROM container_configs').pluck().get() as string),
    ).toHaveProperty('gmail');
  });

  it('idempotently steers workflow outcomes and schedules a restart without killing an active response', async () => {
    input('original');
    createPendingApproval({
      approval_id: 'workflow',
      session_id: session.id,
      request_id: 'workflow',
      action: 'request_access',
      payload: '{}',
      created_at: 'now',
      title: 'Access',
      options_json: '[]',
    });
    createApprovalWorkflow('workflow', 'key', { messageId: 'original' });
    finishApprovalWorkflow('workflow', 'completed', 'Access granted', true);
    await notifyApprovalWorkflow('workflow');
    await notifyApprovalWorkflow('workflow');
    const rows = notifications();
    expect(rows).toHaveLength(2);
    rows.forEach(expectOriginalRoute);
    expect(rows.map((row) => row.on_wake)).toEqual([0, 1]);
    expect(mocks.kill).not.toHaveBeenCalled();
  });
});
