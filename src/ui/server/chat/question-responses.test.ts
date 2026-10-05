import fs from 'node:fs';
import http from 'node:http';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const runtime = vi.hoisted(() => ({
  root: `/tmp/nanoclaw-question-responses-${process.pid}`,
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
import { createPendingApproval, createQuestion, getQuestion } from '../../../db/sessions.js';
import { initSessionFolder, openInboundDb } from '../../../session-manager.js';
import '../../../modules/interactive/index.js';
import { handleApprovalsResponse } from '../../../modules/approvals/response-handler.js';
import { handle } from './routes.js';
import { readChatHistory } from './chat.js';

const NOW = '2026-10-05T18:00:00Z';
beforeEach(() => {
  runMigrations(initTestDb());
  const db = getDb();
  db.exec(`
    INSERT INTO users (id, kind, created_at) VALUES ('web:member', 'web', '${NOW}'), ('web:other', 'web', '${NOW}');
    INSERT INTO agent_groups (id, name, folder, created_at) VALUES ('agent', 'Agent', 'agent', '${NOW}');
    INSERT INTO agent_group_members (user_id, agent_group_id, added_at) VALUES ('web:member', 'agent', '${NOW}');
    INSERT INTO messaging_groups (id, channel_type, platform_id, instance, is_group, created_at)
      VALUES ('mg', 'web', 'group:agent', 'web', 1, '${NOW}');
    INSERT INTO messaging_group_agents (id, messaging_group_id, agent_group_id, session_mode, created_at)
      VALUES ('wiring', 'mg', 'agent', 'agent-shared', '${NOW}');
    INSERT INTO sessions (id, agent_group_id, created_at) VALUES ('session', 'agent', '${NOW}');
  `);
  initSessionFolder('agent', 'session');
  createQuestion({
    question_id: 'q',
    session_id: 'session',
    message_out_id: 'out',
    in_reply_to: null,
    platform_id: 'group:agent',
    channel_type: 'web',
    thread_id: 'thread',
    title: 'Choose',
    question_text: 'Which option?',
    response_mode: 'choice',
    options: [{ label: 'Yes', selectedLabel: 'Selected yes', value: 'yes' }],
    status: 'pending',
    answer_value: null,
    answer_type: null,
    answered_by: null,
    answered_at: null,
    cancelled_at: null,
    created_at: NOW,
  });
  runtime.userId = 'web:member';
  runtime.wake.mockReset().mockResolvedValue(true);
});
afterEach(() => {
  closeDb();
  fs.rmSync(runtime.root, { recursive: true, force: true });
});

async function respond(body: unknown, id = 'q') {
  const req = Readable.from([Buffer.from(JSON.stringify(body))]) as http.IncomingMessage;
  req.method = 'POST';
  req.url = `/ui/chat/api/approvals/${id}/respond`;
  req.headers = { host: 'localhost', 'content-type': 'application/json' };
  const res = new http.ServerResponse(req);
  let status = 0;
  let content = '';
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

describe('typed responses through the existing endpoint', () => {
  it('persists and projects one skip event across duplicate requests', async () => {
    expect(await respond({ responseType: 'skipped' })).toEqual({ status: 200, body: { ok: true } });
    const saved = getQuestion('q');
    expect(saved).toMatchObject({
      status: 'answered',
      answer_type: 'skipped',
      answer_value: null,
      answered_by: 'web:member',
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
        timestamp: saved?.answered_at,
      }),
    ]);
    expect(runtime.wake).toHaveBeenCalled();
  });

  it.each(['answer', 'skip'])('keeps the first %s resolution across competing requests', async (first) => {
    const answer = { value: 'yes' };
    const skip = { responseType: 'skipped' };
    await respond(first === 'answer' ? answer : skip);
    await respond(first === 'answer' ? skip : answer);
    expect(getQuestion('q')).toMatchObject({
      answer_type: first === 'answer' ? 'choice' : 'skipped',
      answer_value: first === 'answer' ? 'yes' : null,
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
    getDb().exec("UPDATE questions SET platform_id = 'private-recipient' WHERE question_id = 'q'");
    expect((await respond({ responseType: 'skipped' })).status).toBe(403);
    expect(getQuestion('q')?.status).toBe('pending');
    expect(runtime.wake).not.toHaveBeenCalled();
  });

  it.each([{ responseType: 'skipped', value: 'yes' }, { responseType: 'unknown' }, {}])(
    'rejects malformed response %j without resolving the question',
    async (body) => {
      expect((await respond(body)).status).toBe(400);
      expect(getQuestion('q')?.status).toBe('pending');
    },
  );

  it('rejects cancelled and unknown questions and never treats a skip as an approval', async () => {
    expect((await respond({ responseType: 'skipped' }, 'missing')).status).toBe(404);
    getDb().exec("UPDATE questions SET status = 'cancelled' WHERE question_id = 'q'");
    expect((await respond({ responseType: 'skipped' })).status).toBe(409);
    getDb().exec(`INSERT INTO user_roles (user_id, role, granted_at) VALUES ('web:member', 'owner', '${NOW}')`);
    createPendingApproval({
      approval_id: 'approval',
      session_id: 'session',
      request_id: 'request',
      action: 'test',
      payload: '{}',
      title: 'Test approval',
      options_json: '[]',
      created_at: NOW,
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
