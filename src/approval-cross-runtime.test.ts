import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { afterEach, expect, it, vi } from 'vitest';

vi.mock('./config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./config.js')>()),
  DATA_DIR: path.resolve('.test-approval-routing'),
}));
vi.mock('./container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(true),
  isContainerRunning: vi.fn(() => true),
  recoverStoppedSession: vi.fn().mockResolvedValue(true),
  killContainer: vi.fn(),
}));
vi.mock('./modules/typing/index.js', () => ({
  setTypingAdapter: vi.fn(),
  startTypingRefresh: vi.fn(),
  stopTypingRefresh: vi.fn(),
}));

import { closeDb, createAgentGroup, createMessagingGroup, initTestDb, runMigrations } from './db/index.js';
import { createPendingApproval } from './db/sessions.js';
import { restartAgentGroupContainers } from './container-restart.js';
import { deliverSessionMessages, setDeliveryAdapter } from './delivery.js';
import { registerApprovalHandler } from './modules/approvals/primitive.js';
import { handleApprovalsResponse } from './modules/approvals/response-handler.js';
import { grantRole } from './modules/permissions/db/user-roles.js';
import { upsertUser } from './modules/permissions/db/users.js';
import { openInboundDb, outboundDbPath, resolveSession, writeSessionMessage } from './session-manager.js';
import {
  getSessionActiveTurn,
  sessionLinkSocketPath,
  startSessionSignalServer,
  stopAllSessionSignalServers,
} from './session-link.js';

let child: ChildProcessWithoutNullStreams | undefined;
let outbound: Database.Database | undefined;
afterEach(async () => {
  if (child && child.exitCode === null) {
    const exited = new Promise<void>((resolve) => child!.once('exit', () => resolve()));
    child.kill('SIGTERM');
    await exited;
  }
  await stopAllSessionSignalServers();
  outbound?.close();
  closeDb();
  fs.rmSync(path.resolve('.test-approval-routing'), { recursive: true, force: true });
});

it.skipIf(spawnSync('bun', ['--version'], { stdio: 'ignore' }).status !== 0).each(['approval', 'settings'] as const)(
  'commits the final reply before a deferred %s restart across Node/Bun, without consuming queued work',
  async (mode) => {
    runMigrations(initTestDb());
    const timestamp = new Date().toISOString();
    createAgentGroup({ id: 'group', name: 'Group', folder: 'group', agent_provider: null, created_at: timestamp });
    createMessagingGroup({
      id: 'web-group',
      channel_type: 'web',
      platform_id: 'web-room',
      instance: 'web',
      name: 'Web',
      is_group: 1,
      unknown_sender_policy: 'strict',
      created_at: timestamp,
    });
    const session = resolveSession('group', 'web-group', 'thread', 'per-thread').session;
    upsertUser({ id: 'owner', kind: 'web', display_name: 'Owner', created_at: timestamp });
    grantRole({ user_id: 'owner', role: 'owner', agent_group_id: null, granted_by: null, granted_at: timestamp });
    const write = (id: string, text: string) =>
      writeSessionMessage('group', session.id, {
        id,
        kind: 'chat',
        timestamp,
        channelType: 'web',
        platformId: 'web-room',
        threadId: 'thread',
        content: JSON.stringify({ text, inputHandling: { mode: 'queue' } }),
      });
    write('original', 'Original request');
    const delivered: string[] = [];
    setDeliveryAdapter({
      async deliver(channel, platform, thread, _kind, content) {
        expect([channel, platform, thread]).toEqual(['web', 'web-room', 'thread']);
        delivered.push(JSON.parse(content).text as string);
        return 'receipt';
      },
    });
    await startSessionSignalServer(session.id, 'group');
    outbound = new Database(outboundDbPath('group', session.id), { readonly: true });
    let stderr = '';
    child = spawn('bun', ['src/test-fixtures/approval-runner.mjs', sessionLinkSocketPath(session.id)], {
      env: { ...process.env, NODE_ENV: 'test', NANOCLAW_BOOT_INBOUND_SEQ: '2' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    child.stderr.on('data', (data) => {
      stderr += String(data);
    });
    const exited = new Promise<number | null>((resolve) => child!.once('exit', resolve));
    const wait = async (check: () => void) => {
      try {
        await vi.waitFor(check, { timeout: 10_000, interval: 20 });
      } catch (error) {
        throw new Error(`${String(error)}\nRunner stderr:\n${stderr}`, { cause: error });
      }
    };
    await wait(() => expect(getSessionActiveTurn(session.id).turn?.status).toBe('running'));
    const turnId = getSessionActiveTurn(session.id).turn!.id;
    if (mode === 'approval') {
      registerApprovalHandler('cross-runtime-approval', async ({ notify }) => {
        notify('Approved. Finish this response before restarting.');
        notify('The new configuration is loaded; verify it now.', { afterRestart: true });
      });
      createPendingApproval({
        approval_id: 'approval',
        session_id: session.id,
        request_id: 'approval',
        origin_message_id: 'original',
        action: 'cross-runtime-approval',
        payload: '{}',
        created_at: timestamp,
        title: 'Approve',
        options_json: '[]',
      });
      await handleApprovalsResponse({
        questionId: 'approval',
        value: 'approve',
        userId: 'owner',
        channelType: 'web',
        platformId: 'admin-dm',
        threadId: null,
      });
      await wait(() => {
        const applied = outbound!
          .prepare(
            "SELECT value FROM session_state WHERE key LIKE 'input:%' AND json_extract(value,'$.status')='applied'",
          )
          .get();
        expect(applied).toBeTruthy();
      });
    } else {
      expect(restartAgentGroupContainers('group', 'settings changed', undefined, true)).toBe(1);
      await wait(() => {
        const inbound = openInboundDb('group', session.id);
        try {
          expect(inbound.prepare('SELECT COUNT(*) FROM pending_host_events').pluck().get()).toBe(0);
        } finally { inbound.close(); }
      });
      expect(outbound.prepare("SELECT 1 FROM session_state WHERE key LIKE 'input:%' AND json_extract(value,'$.status')='applied'").get())
        .toBeUndefined();
    }
    expect(getSessionActiveTurn(session.id).turn?.id).toBe(turnId);
    expect(child.exitCode).toBeNull();
    write('queued-user', 'A follow-up for the next turn');
    child.stdin.write('complete\n');
    await wait(() => expect(child!.exitCode).not.toBeNull());
    expect(await exited).toBe(0);
    expect(
      outbound
        .prepare('SELECT phase,outcome,origin_channel_type,origin_platform_id,origin_thread_id FROM turns WHERE id=?')
        .get(turnId),
    ).toEqual({
      phase: 'settled',
      outcome: 'replied',
      origin_channel_type: 'web',
      origin_platform_id: 'web-room',
      origin_thread_id: 'thread',
    });
    expect(outbound.prepare('SELECT COUNT(*) FROM turns').pluck().get()).toBe(1);
    await deliverSessionMessages(session);
    expect(delivered).toEqual(['Response finished normally.']);
    const inbound = openInboundDb('group', session.id);
    try {
      expect(
        inbound.prepare("SELECT COUNT(*) FROM messages_in WHERE on_wake=1 AND status='pending'").pluck().get(),
      ).toBe(1);
      expect(inbound.prepare("SELECT status FROM messages_in WHERE id='queued-user'").pluck().get()).toBe('pending');
    } finally {
      inbound.close();
    }
  },
  15_000,
);
