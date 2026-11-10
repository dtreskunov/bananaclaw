import fs from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { closeDb, getDb, initTestDb } from '../../db/connection.js';
import { runMigrations } from '../../db/migrations/index.js';
import { createMessagingGroup, getMessagingGroup } from '../../db/messaging-groups.js';
import { createSession } from '../../db/sessions.js';
import { createApproval, getApproval, updateApprovalStatus } from '../../db/approvals.js';
import { initSessionFolder, openInboundDb, writeSessionMessage } from '../../session-manager.js';
import type { Session } from '../../types.js';
import { grantRole } from '../permissions/db/user-roles.js';
import { upsertUser } from '../permissions/db/users.js';
import { applyAddMcpServer } from '../self-mod/apply.js';
import { writeApprovalNotification } from './notification.js';
import { registerApprovalHandler, requestApproval, type RequestApprovalOptions } from './primitive.js';
import { handleApprovalsResponse } from './response-handler.js';
import { createApprovalWorkflow, finishApprovalWorkflow, notifyApprovalWorkflow } from './workflows.js';
import { ensureUserDm } from '../permissions/user-dm.js';
import * as delivery from '../../delivery.js';
import { handleAddMcpServer, handleInstallPackages } from '../self-mod/request.js';

const mocks = vi.hoisted(() => ({ wake: vi.fn().mockResolvedValue(true), kill: vi.fn() }));
vi.mock('../../container-runner.js', () => ({
  wakeContainer: mocks.wake,
  killContainer: mocks.kill,
  buildAgentGroupImage: vi.fn(),
}));
vi.mock('../permissions/user-dm.js', () => ({ ensureUserDm: vi.fn().mockResolvedValue(null) }));
vi.mock('../../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../config.js')>()),
  DATA_DIR: `${process.cwd()}/.test-tmp/nanoclaw-approval-routing-${process.pid}`,
}));

const directory = `${process.cwd()}/.test-tmp/nanoclaw-approval-routing-${process.pid}`;
const session: Session = {
  id: 'session',
  agent_group_id: 'group',
  messaging_group_id: 'web-group',
  thread_id: null,
  agent_provider: null,
  status: 'active',
  container_status: 'running',
  last_active: null,
  created_at: 1767225600000,
};
const origin = { channelType: 'web', platformId: 'original-room', threadId: 'original-thread' };

beforeEach(() => {
  fs.mkdirSync(directory, { recursive: true });
  runMigrations(initTestDb());
  getDb()
    .prepare("INSERT INTO agent_groups(id,name,folder,created_at) VALUES('group','Agent','agent',1767225600000)")
    .run();
  getDb().prepare("INSERT INTO container_configs(agent_group_id,updated_at) VALUES('group',1767225600000)").run();
  createMessagingGroup({
    id: 'web-group',
    channel_type: 'web',
    platform_id: 'default-room',
    instance: 'web',
    name: null,
    is_group: 1,
    unknown_sender_policy: 'strict',
    denied_at: null,
    created_at: 1767225600000,
  });
  createSession(session);
  initSessionFolder(session.agent_group_id, session.id);
  upsertUser({ id: 'owner', kind: 'web', display_name: 'Owner', created_at: 1767225600000 });
  grantRole({
    user_id: 'owner',
    role: 'owner',
    agent_group_id: null,
    granted_by: null,
    granted_at: 1767225600000,
  });
  mocks.wake.mockClear();
  mocks.kill.mockClear();
});
afterEach(() => {
  vi.restoreAllMocks();
  closeDb();
  fs.rmSync(directory, { recursive: true, force: true });
});

function input(id: string, route = origin, sourceSessionId?: string) {
  writeSessionMessage(session.agent_group_id, session.id, {
    id,
    kind: 'chat',
    timestamp: Date.now(),
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
async function respond(
  action: string,
  value = 'approve',
  originMessageId: string | null = 'original',
  message?: string,
) {
  createApproval({
    id: 'approval',
    session_id: session.id,
    request_id: 'approval',
    created_at: 1767225600000,
    origin_message_id: originMessageId,
    input: {
      action: action,
      payload: { name: 'gmail', url: 'https://gmail.example/mcp' },
      title: 'Approval',
      options: JSON.parse('[]'),
    },
  });
  await handleApprovalsResponse({
    approvalId: 'approval',
    value,
    userId: 'owner',
    channelType: 'web',
    platformId: 'admin-dm',
    threadId: null,
    ...(message !== undefined ? { message } : {}),
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
  const submission = (): RequestApprovalOptions => ({
    session,
    approvalId: 'stable-receipt',
    originMessageId: 'original',
    agentName: 'Agent',
    action: 'request-test',
    payload: { first: 1, second: 2 },
    title: 'Review',
    question: 'Allow?',
  });

  it.each<Partial<RequestApprovalOptions>>([
    { session: { ...session, id: 'sibling', thread_id: 'sibling-thread' } },
    { originMessageId: 'later' },
    { action: 'different-action' },
    { payload: { first: 9, second: 2 } },
    { title: 'Different action' },
    { options: [{ label: 'Different option', value: 'different' }] },
    { workflowKey: 'different-workflow' },
  ])('rejects mismatched receipt reuse before delivering a second card: %j', async (changes) => {
    input('original');
    input('later');
    if (changes.session) createSession(changes.session);
    vi.mocked(ensureUserDm).mockResolvedValueOnce(getMessagingGroup('web-group')!);
    const deliver = vi.fn().mockResolvedValue('receipt');
    vi.spyOn(delivery, 'getDeliveryAdapter').mockReturnValue({ deliver });
    const opts = submission();
    await requestApproval(opts);
    const before = getApproval('stable-receipt');
    await expect(requestApproval({ ...opts, ...changes })).rejects.toThrow(
      'Approval ID is already associated with a different request.',
    );
    expect(deliver).toHaveBeenCalledOnce();
    expect(getApproval('stable-receipt')).toEqual(before);
  });

  it.each([
    { handle: handleAddMcpServer, content: { name: 'example', url: 'https://mcp.example.com/mcp' } },
    { handle: handleInstallPackages, content: { apt: ['jq'] } },
  ])('does not reissue an existing action under a self-modification card: %j', async ({ handle, content }) => {
    input('original');
    vi.mocked(ensureUserDm).mockResolvedValueOnce(getMessagingGroup('web-group')!);
    const deliver = vi.fn().mockResolvedValue('receipt');
    vi.spyOn(delivery, 'getDeliveryAdapter').mockReturnValue({ deliver });
    await requestApproval(submission());
    await expect(
      handle({ ...content, requestId: 'stable-receipt' }, session, undefined, { originMessageId: 'original' }),
    ).rejects.toThrow('different request');
    expect(deliver).toHaveBeenCalledOnce();
    expect(getApproval('stable-receipt')?.input.action).toBe('request-test');
  });

  it('allows an identical pending replay despite JSON key order and omitted undefined fields', async () => {
    input('original');
    const target = getMessagingGroup('web-group')!;
    vi.mocked(ensureUserDm).mockResolvedValueOnce(target).mockResolvedValueOnce(target);
    const deliver = vi.fn().mockResolvedValue('receipt');
    vi.spyOn(delivery, 'getDeliveryAdapter').mockReturnValue({ deliver });
    const opts = submission();
    await requestApproval(opts);
    const before = getApproval('stable-receipt');
    expect(await requestApproval({ ...opts, payload: { second: 2, first: 1, omitted: undefined } })).toBe(
      'stable-receipt',
    );
    expect(deliver).toHaveBeenCalledTimes(2);
    expect(deliver.mock.calls[1]).toEqual(deliver.mock.calls[0]);
    expect(getApproval('stable-receipt')).toEqual(before);
  });

  it.each(['approved', 'rejected', 'cancelled'] as const)(
    'does not reissue an identical %s request',
    async (status) => {
      input('original');
      vi.mocked(ensureUserDm).mockResolvedValueOnce(getMessagingGroup('web-group')!);
      const deliver = vi.fn().mockResolvedValue('receipt');
      vi.spyOn(delivery, 'getDeliveryAdapter').mockReturnValue({ deliver });
      const opts = submission();
      await requestApproval(opts);
      updateApprovalStatus('stable-receipt', status);
      const before = getApproval('stable-receipt');
      expect(await requestApproval(opts)).toBe('stable-receipt');
      expect(deliver).toHaveBeenCalledOnce();
      expect(getApproval('stable-receipt')).toEqual(before);
    },
  );

  it('reports failed approval delivery without showing the approver UUID', async () => {
    input('original');
    vi.mocked(ensureUserDm).mockResolvedValueOnce(getMessagingGroup('web-group')!);
    vi.spyOn(delivery, 'getDeliveryAdapter').mockReturnValue({
      deliver: vi.fn().mockRejectedValue(new Error('Delivery unavailable')),
    });
    const id = await requestApproval({
      session,
      originMessageId: 'original',
      agentName: 'Agent',
      action: 'delivery-test',
      payload: {},
      title: 'Review',
      question: 'Allow?',
    });
    expect(getApproval(id!)).toBeDefined();
    expect(JSON.parse(notifications()[0].content).text).toBe(
      "delivery-test failed: could not deliver approval request to the approver's DM.",
    );
  });

  it('attributes an unnamed responder by channel handle without changing their stored user ID', () => {
    getDb().prepare("UPDATE users SET display_name=NULL WHERE id='owner'").run();
    getDb()
      .prepare(
        "INSERT INTO identities(user_id,channel,handle,verified_at) VALUES('owner','resend','owner@example.net',1767225600000)",
      )
      .run();
    input('original');
    writeApprovalNotification(session, 'Approved.', {
      originMessageId: 'original',
      responseMessage: { userId: 'owner', message: 'Read only.' },
    });
    const content = JSON.parse(notifications()[0].content);
    expect(content.text).toContain('User message from "resend:owner@example.net":\nRead only.');
    expect(content.approvalResponse).toEqual({ userId: 'owner', message: 'Read only.' });
  });

  it.each(['approve', 'reject'])('delivers the %s outcome without an inline user message', async (decision) => {
    input('original');
    let applied = false;
    registerApprovalHandler('message-test', async ({ payload, notify }) => {
      applied = true;
      expect(payload).toEqual({ name: 'gmail', url: 'https://gmail.example/mcp' });
      notify('Approved and applied.');
    });
    await respond('message-test', decision, 'original');
    expect(applied).toBe(decision === 'approve');
    const rows = notifications();
    expect(rows).toHaveLength(1);
    expectOriginalRoute(rows[0]);
    const content = JSON.parse(rows[0].content);
    expect(content.approvalResponse).toBeUndefined();
    expect(content.text).toContain(decision === 'approve' ? 'Approved and applied.' : 'rejected by admin.');
    expect(
      await handleApprovalsResponse({
        approvalId: 'approval',
        value: decision,
        userId: 'owner',
        channelType: 'web',
        platformId: 'admin-dm',
        threadId: null,
      }),
    ).toBe(true);
    expect(notifications()).toHaveLength(1);
  });

  it('queues post-restart verification without adding inline messages', async () => {
    input('original');
    registerApprovalHandler('message-restart', applyAddMcpServer);
    await respond('message-restart', 'approve', 'original');
    const rows = notifications();
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.on_wake)).toEqual([0, 1]);
    expect(JSON.parse(rows[0].content).approvalResponse).toBeUndefined();
    expect(JSON.parse(rows[1].content).approvalResponse).toBeUndefined();
  });

  it('delivers a handler failure in a single outcome notification', async () => {
    input('original');
    registerApprovalHandler('message-failure', async () => {
      throw new Error('test failure');
    });
    await respond('message-failure', 'approve', 'original');
    expect(notifications()).toHaveLength(1);
    expect(JSON.parse(notifications()[0].content).text).toContain('test failure');
    expect(JSON.parse(notifications()[0].content).approvalResponse).toBeUndefined();
  });

  it('rejects retired inline messages without applying the action', async () => {
    input('original');
    const handler = vi.fn();
    registerApprovalHandler('message-no-notify', handler);
    await expect(respond('message-no-notify', 'approve', 'original', 'Finish the report.')).rejects.toThrow(
      'Approval messages are no longer supported',
    );
    expect(handler).not.toHaveBeenCalled();
    expect(getApproval('approval')?.status).toBe('pending');
    expect(notifications()).toEqual([]);
  });

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
    expect(getApproval(id!)?.origin_message_id).toBe('original');
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
    createApproval({
      id: 'workflow',
      session_id: session.id,
      request_id: 'workflow',
      created_at: 1767225600000,
      origin_message_id: 'original',
      input: {
        action: 'request_access',
        payload: { resource_url: 'https://example.test/', reason: 'Need access' },
        title: 'Access',
        options: [],
      },
    });
    createApprovalWorkflow('workflow', 'key');
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
