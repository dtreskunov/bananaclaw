import fs from 'node:fs';
import http from 'node:http';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const runtime = vi.hoisted(() => ({
  root: `${process.cwd()}/.test-tmp/nanoclaw-approval-responses-${process.pid}`,
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
import { createApproval } from '../../../db/approvals.js';
import { initSessionFolder, openInboundDb, openOutboundDbRw } from '../../../session-manager.js';
import * as sessionManager from '../../../session-manager.js';
import { inputStateKey } from '../../../input-timeline.js';
import { handleApprovalsResponse } from '../../../modules/approvals/response-handler.js';
import { registerApprovalHandler } from '../../../modules/approvals/primitive.js';
import { registerResponseHandler } from '../../../response-registry.js';
import { handle } from './routes.js';
import { readChatHistory } from './history.js';
import { UI_PROTOCOL_HEADER, UI_TIMESTAMP_PROTOCOL_VERSION } from '../../shared/time.js';

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
  req.headers = {
    [UI_PROTOCOL_HEADER.toLowerCase()]: String(UI_TIMESTAMP_PROTOCOL_VERSION),
    host: 'localhost',
    'content-type': 'application/json',
  };
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

function respond(body: unknown, id = 'message-approval') {
  return request('POST', `/ui/chat/api/approvals/${id}/respond`, body);
}

describe('global attention sync', () => {
  it('reads only authorized receipt rows and opens each history database once', () => {
    const input = openInboundDb('agent', 'session');
    input
      .prepare(
        `INSERT INTO messages_in(id,seq,kind,timestamp,content,status,channel_type,platform_id,thread_id,sender_user_id)
      VALUES('visible:agent',2,'chat',?,'{"text":"Visible"}','pending','web','group:agent','thread',NULL),
        ('hidden:agent',4,'chat',?,'{"text":"Hidden"}','pending','web','group:agent','private',NULL)`,
      )
      .run(NOW, NOW);
    input.close();
    const output = openOutboundDbRw('agent', 'session');
    const receipt = JSON.stringify({ messageId: 'visible:agent', status: 'queued' });
    for (const id of ['visible:agent', 'hidden:agent']) {
      output
        .prepare('INSERT INTO processing_ack(message_id,status,status_changed) VALUES(?,?,?)')
        .run(id, 'pending', NOW);
      output
        .prepare('INSERT INTO session_state(key,value,updated_at) VALUES(?,?,?)')
        .run(inputStateKey(id), id.startsWith('visible') ? receipt : '{private-invalid', NOW);
    }
    const all = vi.spyOn(Object.getPrototypeOf(output.prepare('SELECT 1')), 'all');
    output.close();
    const inbound = vi.spyOn(sessionManager, 'openInboundDb');
    const outbound = vi.spyOn(sessionManager, 'openOutboundDb');
    try {
      const history = readChatHistory('web:member', 'agent', 'thread');
      expect(history.map((row) => row.id)).toEqual(['visible']);
      expect(inbound).toHaveBeenCalledTimes(1);
      expect(outbound).toHaveBeenCalledTimes(1);
      const queries = all.mock.results.map((result, index) => ({
        source: all.mock.contexts[index].source as string,
        rows: result.type === 'return' ? result.value : undefined,
      }));
      expect(queries.find((query) => query.source.includes('FROM processing_ack'))?.rows).toEqual([
        { message_id: 'visible:agent', status: 'pending' },
      ]);
      expect(queries.find((query) => query.source.includes('FROM session_state'))?.rows).toEqual([
        { key: inputStateKey('visible:agent'), value: receipt },
      ]);
    } finally {
      inbound.mockRestore();
      outbound.mockRestore();
      all.mockRestore();
    }
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
  it.each(['approve', 'reject'])('delivers the authenticated %s outcome without an inline message', async (value) => {
    expect(await respond({ value }, 'message-approval')).toEqual({
      status: 200,
      body: { ok: true },
    });
    const rows = notificationRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ channel_type: 'web', platform_id: 'group:agent', thread_id: 'thread' });
    expect(JSON.parse(rows[0].content).approvalResponse).toBeUndefined();
    expect(applied).toHaveBeenCalledTimes(value === 'approve' ? 1 : 0);
    if (value === 'approve') expect(applied).toHaveBeenCalledWith({ requested: 'unchanged' });
    await respond({ value }, 'message-approval');
    expect(notificationRows()).toHaveLength(1);
  });
  it.each([null, 42, {}, '', 'Use a different approach.', 'x'.repeat(4001)])(
    'rejects retired approval messages before resolving the approval',
    async (message) => {
      expect((await respond({ value: 'approve', message }, 'message-approval')).status).toBe(400);
      expect(applied).not.toHaveBeenCalled();
      expect(notificationRows()).toEqual([]);
      expect(getDb().prepare("SELECT status FROM interactions WHERE id='message-approval'").pluck().get()).toBe(
        'pending',
      );
    },
  );
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
    expect((await respond({ value: 'approve' }, 'message-approval')).status).toBe(200);
    expect(applied).toHaveBeenCalledOnce();
  });
  it('rejects notes for sessionless approvals rather than silently discarding them', async () => {
    getDb().exec("UPDATE interactions SET session_id=NULL WHERE id='message-approval'");
    expect((await respond({ value: 'approve', message: 'A note' }, 'message-approval')).status).toBe(400);
    expect(applied).not.toHaveBeenCalled();
  });
  it('requires authentication before responding to approvals', async () => {
    runtime.userId = null;
    expect((await respond({ value: 'approve' })).status).toBe(401);
    expect(runtime.wake).not.toHaveBeenCalled();
  });
  it.each([
    { responseType: 'skipped', value: 'yes' },
    { responseType: 'unknown' },
    { responseType: 'choice', value: 'approve' },
    { responseType: 'text', value: 'approve' },
    { value: '' },
    { value: 42 },
    {},
  ])('rejects malformed or legacy typed response %j without resolving an approval', async (body) => {
    expect((await respond(body)).status).toBe(400);
    expect(getDb().prepare("SELECT status FROM interactions WHERE id='message-approval'").pluck().get()).toBe(
      'pending',
    );
    expect(applied).not.toHaveBeenCalled();
    expect(runtime.wake).not.toHaveBeenCalled();
  });
  it('rejects cancelled and unknown approval IDs', async () => {
    expect((await respond({ responseType: 'skipped' }, 'missing')).status).toBe(404);
    getDb().exec("UPDATE interactions SET status='cancelled' WHERE id='message-approval'");
    expect((await respond({ value: 'approve' })).status).toBe(409);
    expect(runtime.wake).not.toHaveBeenCalled();
  });
});
