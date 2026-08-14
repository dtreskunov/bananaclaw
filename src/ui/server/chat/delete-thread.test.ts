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
}));

import { killContainer } from '../../../container-runner.js';
import { closeDb, getDb, initTestDb, runMigrations } from '../../../db/index.js';
import { grantRole } from '../../../modules/permissions/db/user-roles.js';
import { handleChatRequest } from './chat.js';

const NOW = new Date().toISOString();
const USER_ID = 'web:admin';
const GROUP_ID = 'agent';

function makeRes(): { res: http.ServerResponse; done: Promise<void>; status: () => number } {
  let status = 0;
  let resolve!: () => void;
  const done = new Promise<void>((doneResolve) => {
    resolve = doneResolve;
  });
  const writable = new Writable({
    write(_chunk, _encoding, callback): void {
      callback();
    },
  });
  const res = writable as unknown as http.ServerResponse;
  res.writeHead = ((nextStatus: number) => {
    status = nextStatus;
    return res;
  }) as http.ServerResponse['writeHead'];
  writable.on('finish', resolve);
  return { res, done, status: () => status };
}

async function deleteThread(threadId: string, query: string): Promise<number> {
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
  return response.status();
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

    expect(await deleteThread('same-thread', '?channel=resend&mg=email-mg')).toBe(200);

    expect(getDb().prepare('SELECT id FROM sessions WHERE id = ?').get('email-session')).toBeUndefined();
    expect(getDb().prepare('SELECT id FROM sessions WHERE id = ?').get('web-session')).toBeDefined();
    expect(fs.existsSync(emailDir)).toBe(false);
    expect(fs.existsSync(webDir)).toBe(true);
    expect(killContainer).toHaveBeenCalledWith('email-session', 'thread-deleted');
  });

  it('does not delete a shared session when no exact thread session exists', async () => {
    seedMessagingGroup('email-mg', 'resend', 'resend:agent@example.com', 'shared');
    const sharedDir = seedSession('shared-session', 'email-mg', null);

    expect(await deleteThread('embedded-thread', '?channel=resend&mg=email-mg')).toBe(404);

    expect(getDb().prepare('SELECT id FROM sessions WHERE id = ?').get('shared-session')).toBeDefined();
    expect(fs.existsSync(sharedDir)).toBe(true);
    expect(killContainer).not.toHaveBeenCalled();
  });
});
