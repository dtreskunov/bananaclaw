import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../../../config.js', async original => ({
  ...(await original<typeof import('../../../config.js')>()),
  DATA_DIR: path.resolve('.test-read-state'),
}));
import { closeDb, getDb, initTestDb, runMigrations } from '../../../db/index.js';
import { initSessionFolder, inboundDbPath, outboundDbPath } from '../../../session-manager.js';
import { refreshThreadSummaries, rebuildThreadSummaries } from '../../../thread-summaries.js';
import { createQuestion } from '../../../db/sessions.js';
import { createApproval, updateApprovalStatus } from '../../../db/approvals.js';
import { grantRole } from '../../../modules/permissions/db/user-roles.js';
import { insertIdentity } from '../../../modules/permissions/db/identities.js';
import { onHostChange } from '../../../host-changes.js';
import { getUser, createUser } from '../../../modules/permissions/db/users.js';
import { readConversation } from './conversation.js';
import { listThreadsForViewer, readAgentActivity } from './threads.js';
import { acknowledgeRead, conversationUnread } from './read-state.js';
import { resolveTurnContext } from './conversation-context.js';
import { readInteractionSync } from './attention.js';
import type { ReadCursor } from '../../shared/read-state.js';
import { handle } from './routes.js';
import { createSession as createUiSession } from '../db.js';
import { COOKIE_NAME } from '../auth.js';
import { claimIdentity } from '../../../modules/permissions/identity-claim.js';

const root = path.resolve('.test-read-state');
let input: Database.Database, output: Database.Database;
beforeEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
  runMigrations(initTestDb());
  getDb().exec(`
    INSERT INTO users(id,kind,created_at) VALUES('viewer','web','now'),('other','web','now'),('admin','web','now');
    INSERT INTO agent_groups(id,name,folder,created_at) VALUES('g','Group','g','now');
    INSERT INTO agent_group_members(user_id,agent_group_id,added_at) VALUES('viewer','g','now'),('other','g','now');
    INSERT INTO messaging_groups(id,channel_type,instance,platform_id,is_group,created_at) VALUES('mg','web','web','group:g',1,'now');
    INSERT INTO messaging_group_agents(id,messaging_group_id,agent_group_id,session_mode,created_at)
      VALUES('wire','mg','g','agent-shared','now');
    INSERT INTO sessions(id,agent_group_id,created_at) VALUES('s','g','now');
  `);
  initSessionFolder('g', 's');
  input = new Database(inboundDbPath('g', 's'));
  output = new Database(outboundDbPath('g', 's'));
  input.exec(`INSERT INTO messages_in(id,seq,kind,timestamp,status,channel_type,platform_id,thread_id,content)
    VALUES('input-a',2,'chat','now','completed','web','group:g','a','{"text":"A"}'),
      ('input-b',4,'chat','now','completed','web','group:g','b','{"text":"B"}');`);
  refreshThreadSummaries('s');
});
afterEach(async () => {
  await Promise.resolve();
  input.close(); output.close(); closeDb();
  fs.rmSync(root, { recursive: true, force: true });
});
function message(id: string, thread = 'a', payload: object = { text: 'Reply' }, turn: string | null = null) {
  output.prepare(`INSERT INTO messages_out(id,seq,kind,timestamp,channel_type,platform_id,thread_id,content,turn_id)
    VALUES(?,(SELECT COALESCE(MAX(seq),-1)+2 FROM messages_out),'chat','2026-11-05T00:00:00Z','web','group:g',?,?,?)`)
    .run(id, thread, JSON.stringify(payload), turn);
  refreshThreadSummaries('s');
}
function cursor(user = 'viewer', thread = 'a'): ReadCursor {
  const value = readConversation(user, 'g', thread).readCursor;
  if (!value) throw new Error('Expected rendered content cursor');
  return value;
}
function unread(user = 'viewer', thread = 'a') {
  const context = resolveTurnContext(user, 'g', thread);
  if (!context) throw new Error('Expected authorized context');
  return conversationUnread(user, 'g', context);
}

describe('durable viewer unread state', () => {
  it('merges explicit read positions without broadly copying another account baseline', () => {
    insertIdentity({ userId: 'other', channel: 'resend', handle: 'other@example.com' });
    message('one');
    acknowledgeRead('other', 'g', 'a', cursor('other'));
    message('two');
    getDb().prepare('UPDATE users SET unread_baseline=(SELECT MAX(position) FROM conversation_publications) WHERE id=?').run('other');
    expect(claimIdentity({ targetUserId: 'viewer', channel: 'resend', handle: 'other@example.com' }).donorDeleted).toBe(true);
    expect(getUser('other')).toBeUndefined();
    expect(getDb().prepare("SELECT position FROM conversation_reads WHERE user_id='viewer'").pluck().get()).toBe(1);
    expect(unread()).toBe(true);
    acknowledgeRead('viewer', 'g', 'a', cursor());
    expect(unread()).toBe(false);
  });
  it('authenticates and validates the read HTTP operation without affecting other viewers', async () => {
    message('one');
    const token = createUiSession('viewer', 60_000).token;
    const server = http.createServer((req, res) => { void handle(req, res); });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/ui/chat/api/groups/g/chat/a/read`;
    const send = (body: string, authenticated = true) => fetch(base, {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...(authenticated ? { Cookie: `${COOKIE_NAME}=${token}` } : {}) },
      body,
    });
    try {
      expect((await send('{}', false)).status).toBe(401);
      expect((await send('{')).status).toBe(400);
      expect((await send('{}')).status).toBe(400);
      expect((await send(JSON.stringify(cursor()))).status).toBe(200);
      expect(unread()).toBe(false);
      expect(unread('other')).toBe(true);
    } finally {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });
  it('is independent per user and aggregates only visible unread threads', async () => {
    message('one');
    message('file', 'b', { files: ['report.pdf'], delivery_origin: 'send_file' });
    expect((await listThreadsForViewer('viewer', 'g')).filter(t => t.unread)).toHaveLength(2);
    expect(readAgentActivity('viewer', [], null, [])[0].unreadThreadCount).toBe(2);
    acknowledgeRead('viewer', 'g', 'a', cursor());
    expect(unread()).toBe(false);
    expect(unread('other')).toBe(true);
    expect(readAgentActivity('viewer', [], null, [])[0].unreadThreadCount).toBe(1);
  });
  it('never clears a newer arrival or regresses on out-of-order acknowledgements', () => {
    message('one'); const first = cursor();
    message('two'); const second = cursor();
    acknowledgeRead('viewer', 'g', 'a', first);
    expect(unread()).toBe(true);
    acknowledgeRead('viewer', 'g', 'a', second);
    acknowledgeRead('viewer', 'g', 'a', first);
    expect(unread()).toBe(false);
    expect(first.key).toMatch(/^[a-f0-9]{32}$/);
    expect(first).not.toHaveProperty('position');
  });
  it('is idempotent on reconnect, reproject and offline rebuild', () => {
    message('one'); const first = cursor();
    acknowledgeRead('viewer', 'g', 'a', first);
    refreshThreadSummaries('s');
    rebuildThreadSummaries(root);
    expect(cursor()).toEqual(first);
    expect(unread()).toBe(false);
    expect(getDb().prepare('SELECT COUNT(*) FROM conversation_publications').pluck().get()).toBe(1);
  });
  it('uses publication order when a previously hidden response settles after a mid-turn message was read', () => {
    output.exec(`INSERT INTO turns(id,phase,outcome,provenance,origin_channel_type,origin_platform_id,origin_thread_id,started_at)
      VALUES('turn','running','pending','native','web','group:g','a','now');`);
    message('final', 'a', { text: 'Final', delivery_origin: 'response' }, 'turn');
    expect(readConversation('viewer', 'g', 'a').readCursor).toBeUndefined();
    message('progress', 'a', { text: 'Progress', delivery_origin: 'send_message' }, 'turn');
    const progress = cursor();
    acknowledgeRead('viewer', 'g', 'a', progress);
    expect(unread()).toBe(false);
    output.exec("UPDATE turns SET phase='settled',outcome='replied' WHERE id='turn'");
    refreshThreadSummaries('s');
    expect(unread()).toBe(true);
    expect(cursor().key).not.toBe(progress.key);
  });
  it('does not make traces, edits, reactions, or deletion unread', () => {
    message('one'); acknowledgeRead('viewer', 'g', 'a', cursor());
    message('edit', 'a', { operation: 'edit', messageId: 'one', text: 'Edited' });
    message('reaction', 'a', { operation: 'reaction', messageId: 'one', emoji: 'thumbsup' });
    expect(unread()).toBe(false);
    message('two'); const seen = cursor();
    output.exec("DELETE FROM messages_out WHERE id='two'");
    refreshThreadSummaries('s');
    expect(unread()).toBe(false);
    acknowledgeRead('viewer', 'g', 'a', seen);
    expect(unread()).toBe(false);
  });
  it('publishes question cards without consuming their waiting/action state', () => {
    output.exec(`INSERT INTO turns(id,phase,outcome,provenance,origin_channel_type,origin_platform_id,origin_thread_id,started_at)
      VALUES('question-turn','running','pending','native','web','group:g','a','now');
      INSERT INTO messages_out(id,seq,kind,timestamp,channel_type,platform_id,thread_id,content,turn_id)
      VALUES('question-output',1,'chat-sdk','now','web','group:g','a','{"type":"ask_question","question":"Choose?"}','question-turn');`);
    refreshThreadSummaries('s');
    createQuestion({
      id: 'q', session_id: 's', message_out_id: 'question-output', in_reply_to: null,
      channel_type: 'web', platform_id: 'group:g', thread_id: 'a', created_at: 'now',
      input: { question: 'Choose?', responseMode: 'text', options: [] },
    });
    expect(unread()).toBe(true);
    acknowledgeRead('viewer', 'g', 'a', cursor());
    expect(unread()).toBe(false);
    expect(readInteractionSync('viewer').attention).toHaveLength(1);
  });
  it('keeps approval publications private to viewers allowed to see their transcript', () => {
    grantRole({ user_id: 'admin', role: 'admin', agent_group_id: 'g', granted_at: 'now', granted_by: null });
    createApproval({ id: 'approval', request_id: 'approval', session_id: 's', origin_message_id: 'input-a',
      created_at: 'now', input: { action: 'test', title: 'Approve?', payload: {}, options: [] } });
    expect(unread()).toBe(false);
    expect(unread('admin')).toBe(true);
    const approval = cursor('admin');
    expect(() => acknowledgeRead('viewer', 'g', 'a', approval)).toThrow('invalid_read_cursor');
    acknowledgeRead('admin', 'g', 'a', approval);
    updateApprovalStatus('approval', 'approved');
    expect(unread('admin')).toBe(false);
  });
  it('rejects forged routes, stale sessions and denied access', () => {
    message('private', 'b');
    const other = cursor('viewer', 'b');
    expect(() => acknowledgeRead('viewer', 'g', 'a', other)).toThrow('invalid_read_cursor');
    expect(() => acknowledgeRead('viewer', 'g', 'b', { ...other, sessionId: 'stale' })).toThrow('stale_read_context');
    getDb().exec("DELETE FROM agent_group_members WHERE user_id='viewer'");
    expect(() => acknowledgeRead('viewer', 'g', 'b', other)).toThrow('forbidden');
  });
  it('seeds old history once, preserves subsequent unread on rebuild, and baselines new users privately', () => {
    message('old');
    getDb().exec('UPDATE thread_summary_meta SET unread_ready=0');
    rebuildThreadSummaries(root);
    expect(unread()).toBe(false);
    message('new');
    expect(unread()).toBe(true);
    rebuildThreadSummaries(root);
    expect(unread()).toBe(true);
    createUser({ id: 'fresh', kind: 'web', display_name: 'Fresh', created_at: 'now' });
    getDb().exec("INSERT INTO agent_group_members(user_id,agent_group_id,added_at) VALUES('fresh','g','now')");
    expect(unread('fresh')).toBe(false);
    expect(getUser('fresh')).not.toHaveProperty('unread_baseline');
    message('future');
    expect(unread('fresh')).toBe(true);
  });
  it('publishes read notices only for the reader, and duplicate acknowledgements are silent', async () => {
    message('one');
    await Promise.resolve();
    const notices: string[] = [];
    const off = onHostChange(change => { if (change.kind === 'read-state') notices.push(change.userId); });
    try {
      const current = cursor();
      acknowledgeRead('viewer', 'g', 'a', current);
      await Promise.resolve();
      acknowledgeRead('viewer', 'g', 'a', current);
      await Promise.resolve();
      expect(notices).toEqual(['viewer']);
    } finally { off(); }
  });
  it('does not reveal a different DM counterparty through unread metadata', () => {
    insertIdentity({ userId: 'viewer', channel: 'resend', handle: 'own@example.com' });
    getDb().exec(`INSERT INTO messaging_groups(id,channel_type,instance,platform_id,is_group,created_at)
        VALUES('dm','resend','resend','own@example.com',0,'now');
      INSERT INTO messaging_group_agents(id,messaging_group_id,agent_group_id,session_mode,created_at)
        VALUES('dm-wire','dm','g','shared','now');
      INSERT INTO sessions(id,agent_group_id,messaging_group_id,created_at) VALUES('dm-session','g','dm','now');`);
    initSessionFolder('g', 'dm-session');
    const source = new Database(inboundDbPath('g', 'dm-session'));
    const replies = new Database(outboundDbPath('g', 'dm-session'));
    try {
      source.exec(`INSERT INTO messages_in(id,seq,kind,timestamp,status,channel_type,platform_id,content)
        VALUES('own',2,'chat','now','completed','resend','own@example.com','{"text":"Own"}');`);
      replies.exec(`INSERT INTO messages_out(id,seq,kind,timestamp,channel_type,platform_id,content)
        VALUES('secret',1,'chat','now','resend','other@example.com','{"text":"Private"}');`);
      refreshThreadSummaries('dm-session');
      const context = resolveTurnContext('viewer', 'g', '__dm:dm', { channelType: 'resend', messagingGroupId: 'dm' });
      if (!context) throw new Error('Expected own DM context');
      expect(conversationUnread('viewer', 'g', context)).toBe(false);
    } finally { source.close(); replies.close(); }
  });
});
