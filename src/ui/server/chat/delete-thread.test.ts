import fs from 'fs';
import http from 'http';
import path from 'path';
import { Writable } from 'stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const TEST_ROOT = '/tmp/nanoclaw-test-ui-delete-thread';
const TEST_DATA_DIR = path.join(TEST_ROOT, 'data');

vi.mock('../../../config.js', async () => {
  const actual = await vi.importActual<typeof import('../../../config.js')>('../../../config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-ui-delete-thread/data' };
});

vi.mock('../../../container-runner.js', () => ({
  killContainer: vi.fn(),
  wakeContainer: vi.fn().mockResolvedValue(true),
}));

import { killContainer, wakeContainer } from '../../../container-runner.js';
import {
  closeDb,
  createPendingApproval,
  getDb,
  getPendingApproval,
  getQuestion,
  initTestDb,
  runMigrations,
} from '../../../db/index.js';
import { createThreadFork, getThreadFork } from '../../../db/thread-forks.js';
import { registerApprovalHandler } from '../../../modules/approvals/primitive.js';
import { handleApprovalsResponse } from '../../../modules/approvals/response-handler.js';
import { grantRole } from '../../../modules/permissions/db/user-roles.js';
import { initSessionFolder } from '../../../session-manager.js';
import { handleChatRequest } from './chat.js';

const NOW = new Date().toISOString();
const USER_ID = 'web:admin';
const GROUP_ID = 'agent';

function makeRes(): { res: http.ServerResponse; done: Promise<void>; status: () => number; body: () => string } {
  let status = 0;
  const chunks: Buffer[] = [];
  let resolve!: () => void;
  const done = new Promise<void>((doneResolve) => {
    resolve = doneResolve;
  });
  const writable = new Writable({
    write(chunk, _encoding, callback): void {
      chunks.push(Buffer.from(chunk));
      callback();
    },
  });
  const res = writable as unknown as http.ServerResponse;
  res.writeHead = ((nextStatus: number) => {
    status = nextStatus;
    return res;
  }) as http.ServerResponse['writeHead'];
  writable.on('finish', resolve);
  return { res, done, status: () => status, body: () => Buffer.concat(chunks).toString('utf8') };
}

async function deleteThread(threadId: string, query: string): Promise<{ status: number; json: unknown }> {
  const request = {
    method: 'DELETE',
    url: `/api/groups/${GROUP_ID}/chat/${encodeURIComponent(threadId)}${query}`,
  } as http.IncomingMessage;
  const response = makeRes();
  await handleChatRequest(
    request,
    response.res,
    `/api/groups/${GROUP_ID}/chat/${encodeURIComponent(threadId)}`,
    USER_ID,
  );
  response.res.end();
  await response.done;
  return { status: response.status(), json: JSON.parse(response.body()) };
}

function seedMessagingGroup(id: string, channelType: string, platformId: string, sessionMode: string): void {
  getDb()
    .prepare(
      `INSERT INTO messaging_groups
         (id, channel_type, platform_id, instance, name, is_group, unknown_sender_policy, created_at)
       VALUES (?, ?, ?, ?, ?, 0, 'strict', ?)`,
    )
    .run(id, channelType, platformId, channelType, id, NOW);
  getDb()
    .prepare(
      `INSERT INTO messaging_group_agents
         (id, messaging_group_id, agent_group_id, session_mode, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(`wire-${id}`, id, GROUP_ID, sessionMode, NOW);
}

function seedSession(id: string, messagingGroupId: string, threadId: string | null): string {
  getDb()
    .prepare(
      `INSERT INTO sessions
         (id, agent_group_id, messaging_group_id, thread_id, status, container_status, created_at)
       VALUES (?, ?, ?, ?, 'active', 'stopped', ?)`,
    )
    .run(id, GROUP_ID, messagingGroupId, threadId, NOW);
  const dir = path.join(TEST_DATA_DIR, 'v2-sessions', GROUP_ID, id);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function seedApproval(id: string, sessionId: string | null): void {
  createPendingApproval({
    approval_id: id,
    session_id: sessionId,
    agent_group_id: GROUP_ID,
    request_id: id,
    action: sessionId ? 'install_packages' : 'onecli_credential',
    payload: '{}',
    created_at: NOW,
    title: 'Approval required',
    options_json: '[]',
  });
}

function seedFork(threadId: string, parentThreadId: string): void {
  createThreadFork({
    agent_group_id: GROUP_ID,
    messaging_group_id: 'web-mg',
    thread_id: threadId,
    parent_thread_id: parentThreadId,
    parent_message_id: 'parent-message',
    parent_message_ts: NOW,
    parent_title: 'Parent',
    fidelity: 'transcript',
    created_at: NOW,
  });
}

beforeEach(() => {
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
  const db = initTestDb();
  runMigrations(db);
  getDb()
    .prepare(`INSERT INTO users (id, kind, display_name, created_at) VALUES (?, 'web', 'Admin', ?)`)
    .run(USER_ID, NOW);
  getDb()
    .prepare(
      `INSERT INTO agent_groups (id, name, folder, agent_provider, created_at) VALUES (?, 'Agent', 'agent', NULL, ?) `,
    )
    .run(GROUP_ID, NOW);
  grantRole({ user_id: USER_ID, role: 'admin', agent_group_id: GROUP_ID, granted_by: USER_ID, granted_at: NOW });
  vi.mocked(killContainer).mockReset();
  vi.mocked(wakeContainer).mockReset().mockResolvedValue(true);
});

afterEach(() => {
  closeDb();
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
});

describe('DELETE chat thread', () => {
  it('deletes only the exact non-web per-thread session', async () => {
    seedMessagingGroup('email-mg', 'resend', 'resend:agent@example.com', 'per-thread');
    seedMessagingGroup('web-mg', 'web', `web:${GROUP_ID}`, 'per-thread');
    const emailDir = seedSession('email-session', 'email-mg', 'same-thread');
    const webDir = seedSession('web-session', 'web-mg', 'same-thread');

    expect((await deleteThread('same-thread', '?channel=resend&mg=email-mg')).status).toBe(200);

    expect(getDb().prepare('SELECT id FROM sessions WHERE id = ?').get('email-session')).toBeUndefined();
    expect(getDb().prepare('SELECT id FROM sessions WHERE id = ?').get('web-session')).toBeDefined();
    expect(fs.existsSync(emailDir)).toBe(false);
    expect(fs.existsSync(webDir)).toBe(true);
    expect(killContainer).toHaveBeenCalledWith('email-session', 'thread-deleted');
  });

  it('does not delete a shared session when no exact thread session exists', async () => {
    seedMessagingGroup('email-mg', 'resend', 'resend:agent@example.com', 'shared');
    const sharedDir = seedSession('shared-session', 'email-mg', null);

    expect((await deleteThread('embedded-thread', '?channel=resend&mg=email-mg')).status).toBe(404);

    expect(getDb().prepare('SELECT id FROM sessions WHERE id = ?').get('shared-session')).toBeDefined();
    expect(fs.existsSync(sharedDir)).toBe(true);
    expect(killContainer).not.toHaveBeenCalled();
  });

  it.each(['pending', 'answered', 'cancelled'])('deletes a web thread with %s questions', async (status) => {
    seedMessagingGroup('web-mg', 'web', `group:${GROUP_ID}`, 'per-thread');
    const dir = seedSession('web-session', 'web-mg', 'web-thread');
    getDb()
      .prepare(
        `INSERT INTO questions
        (question_id, session_id, message_out_id, question_text, response_mode, options_json, status, created_at)
       VALUES ('question', 'web-session', 'message', 'Continue?', 'choice', '[]', ?, ?)`,
      )
      .run(status, NOW);

    expect(await deleteThread('web-thread', '')).toEqual({
      status: 200,
      json: { ok: true, removed: 1, cancelledApprovals: 0 },
    });
    expect(getQuestion('question')).toBeUndefined();
    expect(fs.existsSync(dir)).toBe(false);
  });

  it('requires cancellation consent without changing the session, lineage, or container', async () => {
    seedMessagingGroup('web-mg', 'web', `group:${GROUP_ID}`, 'per-thread');
    const dir = seedSession('web-session', 'web-mg', 'web-thread');
    seedFork('web-thread', 'origin');
    seedApproval('approval', 'web-session');

    const result = await deleteThread('web-thread', '');

    expect(result.status).toBe(409);
    expect(result.json).toMatchObject({ error: 'approval_cancellation_required' });
    expect(getPendingApproval('approval')).toBeDefined();
    expect(getDb().prepare('SELECT id FROM sessions WHERE id = ?').get('web-session')).toBeDefined();
    expect(getThreadFork(GROUP_ID, 'web-mg', 'web-thread')).toBeDefined();
    expect(fs.existsSync(dir)).toBe(true);
    expect(killContainer).not.toHaveBeenCalled();
  });

  it('cancels only confirmed session approvals, preserving other sessions and OneCLI requests', async () => {
    seedMessagingGroup('web-mg', 'web', `group:${GROUP_ID}`, 'per-thread');
    seedSession('web-session', 'web-mg', 'web-thread');
    const otherDir = seedSession('other-session', 'web-mg', 'other-thread');
    seedApproval('approval', 'web-session');
    seedApproval('other-approval', 'other-session');
    seedApproval('onecli-approval', null);

    expect(await deleteThread('web-thread', '?cancelApprovals=1')).toEqual({
      status: 200,
      json: { ok: true, removed: 1, cancelledApprovals: 1 },
    });
    expect(getPendingApproval('approval')).toBeUndefined();
    expect(getPendingApproval('other-approval')).toBeDefined();
    expect(getPendingApproval('onecli-approval')).toBeDefined();
    expect(fs.existsSync(otherDir)).toBe(true);
  });

  it.each([false, true])(
    'blocks a cascade throughout approval execution and wake (handler fails: %s)',
    async (fails) => {
      seedMessagingGroup('web-mg', 'web', `group:${GROUP_ID}`, 'per-thread');
      const parentDir = seedSession('parent-session', 'web-mg', 'parent');
      const childDir = seedSession('child-session', 'web-mg', 'child');
      initSessionFolder(GROUP_ID, 'child-session');
      seedFork('child', 'parent');
      seedApproval('child-approval', 'child-session');
      let finish!: () => void;
      const paused = new Promise<void>((resolve) => {
        finish = resolve;
      });
      const handler = vi.fn(async () => {
        await paused;
        if (fails) throw new Error('test approval failure');
      });
      registerApprovalHandler('install_packages', handler);
      const responsePayload = {
        questionId: 'child-approval',
        value: 'approve',
        userId: USER_ID,
        channelType: 'web',
        platformId: `group:${GROUP_ID}`,
        threadId: 'child',
      };
      const query = '?cascade=1&cancelApprovals=1';
      const assertBlocked = async (): Promise<void> => {
        const result = await deleteThread('parent', query);
        expect(result.status).toBe(409);
        expect(result.json).toMatchObject({ error: 'approval_in_progress' });
        expect(getDb().prepare('SELECT id FROM sessions').all()).toHaveLength(2);
        expect(getThreadFork(GROUP_ID, 'web-mg', 'child')).toBeDefined();
        expect(fs.existsSync(parentDir)).toBe(true);
        expect(fs.existsSync(childDir)).toBe(true);
        expect(killContainer).not.toHaveBeenCalled();
      };
      vi.mocked(wakeContainer).mockImplementationOnce(async () => {
        expect(getPendingApproval('child-approval')).toBeUndefined();
        await assertBlocked();
        return true;
      });

      const resolution = handleApprovalsResponse(responsePayload);
      try {
        await assertBlocked();
        expect(getPendingApproval('child-approval')).toBeDefined();
        expect(await handleApprovalsResponse(responsePayload)).toBe(true);
        expect(handler).toHaveBeenCalledTimes(1);
      } finally {
        finish();
        await resolution;
      }

      expect(await deleteThread('parent', query)).toEqual({
        status: 200,
        json: { ok: true, removed: 2, cancelledApprovals: 0 },
      });
    },
  );

  it('rolls back an entire cascade if a descendant needs cancellation consent', async () => {
    seedMessagingGroup('web-mg', 'web', `group:${GROUP_ID}`, 'per-thread');
    const parentDir = seedSession('parent-session', 'web-mg', 'parent');
    const childDir = seedSession('child-session', 'web-mg', 'child');
    seedFork('child', 'parent');
    seedApproval('child-approval', 'child-session');

    expect((await deleteThread('parent', '?cascade=1')).status).toBe(409);
    expect(getDb().prepare('SELECT id FROM sessions').all()).toHaveLength(2);
    expect(getThreadFork(GROUP_ID, 'web-mg', 'child')).toBeDefined();
    expect(getPendingApproval('child-approval')).toBeDefined();
    expect(fs.existsSync(parentDir)).toBe(true);
    expect(fs.existsSync(childDir)).toBe(true);
    expect(killContainer).not.toHaveBeenCalled();

    expect(await deleteThread('parent', '?cascade=1&cancelApprovals=1')).toEqual({
      status: 200,
      json: { ok: true, removed: 2, cancelledApprovals: 1 },
    });
    expect(getDb().prepare('SELECT id FROM sessions').all()).toHaveLength(0);
    expect(getThreadFork(GROUP_ID, 'web-mg', 'child')).toBeUndefined();
    expect(getPendingApproval('child-approval')).toBeUndefined();
    expect(fs.existsSync(parentDir)).toBe(false);
    expect(fs.existsSync(childDir)).toBe(false);
  });
});
