import fs from 'node:fs';
import http from 'node:http';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const runtime = vi.hoisted(() => ({
  root: `${process.cwd()}/.test-tmp/nanoclaw-question-responses-${process.pid}`,
  userId: 'web:member' as string | null,
  wake: vi.fn().mockResolvedValue(true),
}));
vi.mock('../../../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../config.js')>()),
  DATA_DIR: runtime.root,
}));
vi.mock('../auth.js', () => ({
  authenticate: () => (runtime.userId ? { userId: runtime.userId, sessionHash: 'test' } : null),
  recordAccess: vi.fn(),
}));
vi.mock('../../../container-runner.js', () => ({
  wakeContainer: runtime.wake,
  killContainer: vi.fn(),
  resolveProviderName: () => 'claude',
}));
vi.mock('../../../modules/typing/index.js', () => ({
  startTypingRefresh: vi.fn(),
  stopTypingRefresh: vi.fn(),
}));

import { closeDb, getDb, initTestDb, runMigrations } from '../../../db/index.js';
import { createQuestion, getQuestion } from '../../../db/sessions.js';
import { createApproval } from '../../../db/approvals.js';
import { initSessionFolder, openInboundDb } from '../../../session-manager.js';
import '../../../modules/interactive/index.js';
import { handleApprovalsResponse } from '../../../modules/approvals/response-handler.js';
import { registerApprovalHandler } from '../../../modules/approvals/primitive.js';
import { registerResponseHandler } from '../../../response-registry.js';
import { handle } from './routes.js';
import { readChatHistory } from './history.js';

const NOW = 1791223200000;
registerResponseHandler(handleApprovalsResponse);
beforeEach(() => {
  runMigrations(initTestDb());
  const db = getDb();
  db.exec(`
    INSERT INTO users (id, kind, created_at) VALUES ('web:member', 'web', ${NOW}), ('web:other', 'web', ${NOW});
    INSERT INTO agent_groups (id, name, folder, created_at) VALUES ('agent', 'Agent', 'agent', ${NOW});
    INSERT INTO agent_group_members (user_id, agent_group_id, added_at) VALUES ('web:member', 'agent', ${NOW});
    INSERT INTO messaging_groups (id, channel_type, platform_id, instance, is_group, created_at)
      VALUES ('mg', 'web', 'group:agent', 'web', 1, ${NOW});
    INSERT INTO messaging_group_agents (id, messaging_group_id, agent_group_id, session_mode, created_at)
      VALUES ('wiring', 'mg', 'agent', 'agent-shared', ${NOW});
    INSERT INTO sessions (id, agent_group_id, created_at) VALUES ('session', 'agent', ${NOW});
  `);
  initSessionFolder('agent', 'session');
  createQuestion({
    id: 'q',
    session_id: 'session',
    message_out_id: 'out',
    in_reply_to: null,
    platform_id: 'group:agent',
    channel_type: 'web',
    thread_id: 'thread',
    created_at: NOW,
    input: {
      question: 'Which option?',
      responseMode: 'choice',
      options: [{ label: 'Yes', selectedLabel: 'Selected yes', value: 'yes' }],
    },
  });
  runtime.userId = 'web:member';
  runtime.wake.mockReset().mockResolvedValue(true);
});
afterEach(() => {
  closeDb();
  fs.rmSync(runtime.root, { recursive: true, force: true });
});

async function request(method: string, url: string, body?: unknown) {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]) as http.IncomingMessage;
  req.method = method;
  req.url = url;
  req.headers = { 'x-nanoclaw-ui-protocol': '16', host: 'localhost', 'content-type': 'application/json' };
  const res = new http.ServerResponse(req);
  let status = 0;
  let content = '';
  res.setHeader = vi.fn(() => res);
  res.writeHead = ((code: number) => {
    status = code;
    return res;
  }) as typeof res.writeHead;
  res.end = ((data?: string) => {
    content = data ?? '';
    return res;
  }) as typeof res.end;
  await handle(req, res);
  return { status, body: JSON.parse(content) };
}

function respond(body: unknown, id = 'q') {
  return request('POST', `/ui/chat/api/approvals/${id}/respond`, body);
}

describe('global attention sync', () => {
  it('does not make a cancelled question actionable or mutate it during reads', async () => {
    getDb().prepare("UPDATE interactions SET status='cancelled' WHERE id='q'").run();
    const before = getQuestion('q');
    expect((await request('GET', '/ui/chat/api/sync')).body.attention).toEqual([]);
    expect(await respond({ responseType: 'choice', value: 'yes' })).toMatchObject({
      status: 409,
      body: { error: 'question_cancelled' },
    });
    expect(getQuestion('q')).toEqual(before);
    expect(runtime.wake).not.toHaveBeenCalled();
  });

  it('includes questions without selecting a group and clears only after canonical resolution', async () => {
    const first = await request('GET', '/ui/chat/api/sync');
    expect(first.status).toBe(200);
    expect(first.body.attention).toEqual([
      {
        id: 'q',
        origin: { agentGroupId: 'agent', threadId: 'thread', channelType: 'web', messagingGroupId: 'mg' },
      },
    ]);
    expect(await respond({ responseType: 'skipped' })).toMatchObject({ status: 200 });
    expect((await request('GET', '/ui/chat/api/sync')).body.attention).toEqual([]);
  });

  it('does not disclose counts or destinations to another user', async () => {
    runtime.userId = 'web:other';
    expect((await request('GET', '/ui/chat/api/sync')).body.attention).toEqual([]);
  });
});

describe('approval response messages', () => {
  const applied = vi.fn();
  beforeEach(() => {
    applied.mockReset();
    getDb().exec(`
      INSERT INTO user_roles(user_id,role,granted_at) VALUES('web:member','owner',${NOW});
      UPDATE sessions SET messaging_group_id='mg',thread_id='thread' WHERE id='session';
    `);
    createApproval({
      id: 'message-approval',
      session_id: 'session',
      request_id: 'request',
      created_at: NOW,
      input: {
        action: 'message-test',
        payload: JSON.parse('{"requested":"unchanged"}'),
        title: 'Test approval',
        options: JSON.parse('[]'),
      },
    });
    registerApprovalHandler('message-test', async ({ payload, notify }) => {
      applied(payload);
      notify('Approved and applied.');
    });
  });

  it('rejects a terminal approval before applying any effects', async () => {
    getDb().prepare("UPDATE interactions SET status='expired' WHERE id='message-approval'").run();
    expect(await respond({ value: 'approve' }, 'message-approval')).toMatchObject({
      status: 409,
      body: { error: 'not_pending' },
    });
    expect(applied).not.toHaveBeenCalled();
    expect(runtime.wake).not.toHaveBeenCalled();
  });
  function notificationRows() {
    const db = openInboundDb('agent', 'session');
    try {
      return db.prepare('SELECT channel_type,platform_id,thread_id,content FROM messages_in').all() as {
        channel_type: string;
        platform_id: string;
        thread_id: string;
        content: string;
      }[];
    } finally {
      db.close();
    }
  }
  it.each(['approve', 'reject'])('carries the note in the same authenticated %s outcome', async (value) => {
    expect(await respond({ value, message: '  Keep the original account.  ' }, 'message-approval')).toEqual({
      status: 200,
      body: { ok: true },
    });
    const rows = notificationRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ channel_type: 'web', platform_id: 'group:agent', thread_id: 'thread' });
    expect(JSON.parse(rows[0].content).approvalResponse).toEqual({
      userId: 'web:member',
      message: 'Keep the original account.',
    });
    expect(JSON.parse(rows[0].content).text).toContain('Keep the original account.');
    expect(applied).toHaveBeenCalledTimes(value === 'approve' ? 1 : 0);
    if (value === 'approve') expect(applied).toHaveBeenCalledWith({ requested: 'unchanged' });
    await respond({ value, message: 'Duplicate message' }, 'message-approval');
    expect(notificationRows()).toHaveLength(1);
  });
  it.each([null, 42, {}, 'x'.repeat(4001)])('rejects invalid notes before resolving the approval', async (message) => {
    expect((await respond({ value: 'approve', message }, 'message-approval')).status).toBe(400);
    expect(applied).not.toHaveBeenCalled();
    expect(notificationRows()).toEqual([]);
    expect(getDb().prepare("SELECT status FROM interactions WHERE id='message-approval'").pluck().get()).toBe(
      'pending',
    );
  });
  it('does not deliver a note from an unauthorized responder', async () => {
    runtime.userId = 'web:other';
    expect((await respond({ value: 'reject', message: 'Forged note' }, 'message-approval')).status).toBe(403);
    expect(notificationRows()).toEqual([]);
    expect(applied).not.toHaveBeenCalled();
  });
  it('uses the requesting session group for scoped-admin authorization', async () => {
    getDb().exec(
      "DELETE FROM user_roles; INSERT INTO user_roles(user_id,role,agent_group_id,granted_at) VALUES('web:member','admin','agent',1767225600000)",
    );
    expect((await respond({ value: 'approve', message: 'Keep existing work.' }, 'message-approval')).status).toBe(200);
    expect(applied).toHaveBeenCalledOnce();
  });
  it('rejects notes for sessionless approvals rather than silently discarding them', async () => {
    getDb().exec("UPDATE interactions SET session_id=NULL WHERE id='message-approval'");
    expect((await respond({ value: 'approve', message: 'A note' }, 'message-approval')).status).toBe(400);
    expect(applied).not.toHaveBeenCalled();
  });
  it('does not reinterpret an ordinary question response as an approval message', async () => {
    expect((await respond({ value: 'yes', message: 'A note' })).status).toBe(400);
    expect(getQuestion('q')?.status).toBe('pending');
  });
});

describe('typed responses through the existing endpoint', () => {
  it('persists and projects one skip event across duplicate requests', async () => {
    expect(await respond({ responseType: 'skipped' })).toEqual({ status: 200, body: { ok: true } });
    const saved = getQuestion('q');
    expect(saved).toMatchObject({
      status: 'answered',
      responded_by: 'web:member',
      response: { responseType: 'skipped' },
    });
    expect((await respond({ responseType: 'skipped' })).status).toBe(200);
    expect(getQuestion('q')).toEqual(saved);
    const db = openInboundDb('agent', 'session');
    try {
      const rows = db
        .prepare("SELECT id, kind, trigger, content FROM messages_in WHERE id = 'question-response:q'")
        .all();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ id: 'question-response:q', kind: 'interactive_response', trigger: 1 });
    } finally {
      db.close();
    }
    expect(readChatHistory('web:member', 'agent', 'thread', { channelType: 'web', messagingGroupId: 'mg' })).toEqual([
      expect.objectContaining({
        id: 'question-response:q',
        questionId: 'q',
        questionResponseType: 'skipped',
        text: 'Question skipped',
        timestamp: saved?.responded_at ?? null,
      }),
    ]);
    expect(runtime.wake).toHaveBeenCalled();
  });

  it.each(['answer', 'skip'])('keeps the first %s resolution across competing requests', async (first) => {
    const answer = { responseType: 'choice', value: 'yes' };
    const skip = { responseType: 'skipped' };
    await respond(first === 'answer' ? answer : skip);
    await respond(first === 'answer' ? skip : answer);
    expect(getQuestion('q')).toMatchObject({
      response: first === 'answer' ? { responseType: 'choice', value: 'yes' } : { responseType: 'skipped' },
    });
    const db = openInboundDb('agent', 'session');
    try {
      expect(db.prepare('SELECT COUNT(*) AS count FROM messages_in').get()).toEqual({ count: 1 });
    } finally {
      db.close();
    }
  });

  it('requires authentication and access to the actual question route', async () => {
    runtime.userId = null;
    expect((await respond({ responseType: 'skipped' })).status).toBe(401);
    runtime.userId = 'web:other';
    expect((await respond({ responseType: 'skipped' })).status).toBe(403);
    runtime.userId = 'web:member';
    getDb().exec("UPDATE interactions SET platform_id = 'private-recipient' WHERE id = 'q'");
    expect((await respond({ responseType: 'skipped' })).status).toBe(403);
    expect(getQuestion('q')?.status).toBe('pending');
    expect(runtime.wake).not.toHaveBeenCalled();
  });

  it.each([
    { responseType: 'skipped', value: 'yes' },
    { responseType: 'unknown' },
    { value: 'yes' },
    { responseType: 'choice', value: 'invalid' },
    { responseType: 'text', value: 'yes' },
    {},
  ])('rejects malformed response %j without resolving the question', async (body) => {
    expect((await respond(body)).status).toBe(400);
    expect(getQuestion('q')?.status).toBe('pending');
  });

  it('rejects cancelled and unknown questions and never treats a skip as an approval', async () => {
    expect((await respond({ responseType: 'skipped' }, 'missing')).status).toBe(404);
    getDb().exec("UPDATE interactions SET status = 'cancelled' WHERE id = 'q'");
    expect((await respond({ responseType: 'skipped' })).status).toBe(409);
    getDb().exec(`INSERT INTO user_roles (user_id, role, granted_at) VALUES ('web:member', 'owner', ${NOW})`);
    createApproval({
      id: 'approval',
      session_id: 'session',
      request_id: 'request',
      created_at: NOW,
      input: { action: 'test', payload: JSON.parse('{}'), title: 'Test approval', options: JSON.parse('[]') },
    });
    expect((await respond({ responseType: 'skipped' }, 'approval')).body.error).toBe('approval_cannot_be_skipped');
    expect(
      await handleApprovalsResponse({
        questionId: 'approval',
        responseType: 'skipped',
        userId: 'web:member',
        channelType: 'web',
        platformId: 'group:agent',
        threadId: 'thread',
      }),
    ).toBe(false);
    expect(runtime.wake).not.toHaveBeenCalled();
  });
});
