import Database from 'better-sqlite3';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../config.js', async (original) => ({
  ...(await original<typeof import('../../../config.js')>()),
  DATA_DIR: path.resolve('.test-peer-transcripts'),
}));

import { closeDb, getDb, initTestDb, runMigrations } from '../../../db/index.js';
import { putTurn } from '../../../db/turns.js';
import { inboundDbPath, initSessionFolder, outboundDbPath, sessionDir } from '../../../session-manager.js';
import { refreshThreadSummaries } from '../../../thread-summaries.js';
import { handleChatRequest } from './chat.js';
import { readConversation } from './conversation.js';
import { resolveTurnContext } from './conversation-context.js';
import { listThreadsForViewer, viewerHasContent } from './threads.js';
import {
  CONVERSATION_PROTOCOL_VERSION,
  diffConversation,
  parseConversationFrame,
  reduceConversation,
} from '../../shared/conversation-protocol.js';

const root = path.resolve('.test-peer-transcripts');
const now = 1794261600000;
const viewer = '10000000-0000-4000-8000-000000000001';
const handles: Database.Database[] = [];
let aIn: Database.Database;
let aOut: Database.Database;
let bIn: Database.Database;
let bOut: Database.Database;

function input(db: Database.Database, id: string, channel: string, platform: string, thread: string | null, text = id) {
  const seq = db.prepare('SELECT COALESCE(MAX(seq),0)+2 FROM messages_in').pluck().get() as number;
  db.prepare(
    `INSERT INTO messages_in(id,seq,kind,timestamp,status,channel_type,platform_id,thread_id,content,sender_user_id)
    VALUES(?,?,'chat',?,'completed',?,?,?,?,?)`,
  ).run(
    id,
    seq,
    now + seq,
    channel,
    platform,
    thread,
    JSON.stringify({
      text,
      sender: 'Untrusted sender',
      author: { userId: 'spoof', displayName: 'Spoof' },
    }),
    channel === 'web' ? viewer : null,
  );
}

function output(db: Database.Database, id: string, channel: string, platform: string, thread: string | null) {
  const seq = db.prepare('SELECT COALESCE(MAX(seq),-1)+2 FROM messages_out').pluck().get() as number;
  db.prepare(
    `INSERT INTO messages_out(id,seq,kind,timestamp,channel_type,platform_id,thread_id,content)
    VALUES(?,?,'chat',?,?,?,?,?)`,
  ).run(id, seq, now + seq, channel, platform, thread, JSON.stringify({ text: id, delivery_origin: 'send_message' }));
}

beforeEach(() => {
  runMigrations(initTestDb());
  getDb().exec(`
    INSERT INTO users(id,kind,display_name,created_at) VALUES('${viewer}','web','Viewer',${now});
    INSERT INTO agent_groups(id,name,folder,created_at) VALUES('a','Agent A','a',${now}),('b','Agent B','b',${now});
    INSERT INTO agent_group_members(user_id,agent_group_id,added_at) VALUES('${viewer}','a',${now}),('${viewer}','b',${now});
    INSERT INTO messaging_groups(id,channel_type,instance,platform_id,is_group,created_at)
      VALUES('mg-a','web','web','group:a',1,${now});
    INSERT INTO messaging_group_agents(id,messaging_group_id,agent_group_id,session_mode,created_at)
      VALUES('wire-a','mg-a','a','per-thread',${now});
    INSERT INTO sessions(id,agent_group_id,messaging_group_id,thread_id,created_at)
      VALUES('sa','a','mg-a','human',${now}),('sb','b',NULL,NULL,${now}),('other','a','mg-a','other',${now});
  `);
  for (const [group, session] of [
    ['a', 'sa'],
    ['b', 'sb'],
    ['a', 'other'],
  ]) {
    initSessionFolder(group, session);
    handles.push(new Database(inboundDbPath(group, session)), new Database(outboundDbPath(group, session)));
  }
  [aIn, aOut, bIn, bOut] = handles;
  input(aIn, 'human', 'web', 'group:a', 'human');
  output(aOut, 'sent-to-b', 'agent', 'b', null);
  input(bIn, 'received-from-a', 'agent', 'a', null);
  output(bOut, 'sent-to-a', 'agent', 'a', null);
  input(aIn, 'received-from-b', 'agent', 'b', null);
  input(aIn, 'host-note', 'agent', 'a', null);
  input(bIn, 'private-human', 'web', 'private-platform', 'private-thread');
  output(bOut, 'private-reply', 'web', 'private-platform', 'private-thread');
  input(handles[4], 'unrelated-peer', 'agent', 'b', null);
  for (const session of ['sa', 'sb', 'other']) refreshThreadSummaries(session);
});

afterEach(() => {
  for (const db of handles.splice(0)) db.close();
  closeDb();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('peer-agent transcripts', () => {
  it('includes sent and received peers in a dedicated thread with trusted user/agent attribution', async () => {
    const view = readConversation(viewer, 'a', 'human');
    expect(view.messages.map((message) => message.id).sort()).toEqual(['human', 'received-from-b', 'sent-to-b']);
    expect(view.messages.find((message) => message.id === 'human')?.author).toEqual({
      userId: viewer,
      displayName: 'Viewer',
    });
    expect(view.messages.find((message) => message.id === 'received-from-b')).toMatchObject({
      direction: 'in',
      author: { agentGroupId: 'b', displayName: 'Agent B' },
      canEditPending: false,
    });
    expect(view.messages.find((message) => message.id === 'sent-to-b')).toMatchObject({
      direction: 'out',
      recipient: { agentGroupId: 'b', displayName: 'Agent B' },
    });
    const threads = await listThreadsForViewer(viewer, 'a');
    expect(threads.find((thread) => thread.threadId === 'human')).toMatchObject({ messageCount: 3, canSend: true });
    expect(threads.some((thread) => thread.threadId === '__agent:sa')).toBe(false);
    expect(readConversation(viewer, 'a', 'other').messages.map((message) => message.id)).toEqual(['unrelated-peer']);
  });

  it('lists and opens both sides in an agent without a human channel, without exposing other routes', async () => {
    expect(viewerHasContent(viewer, 'b')).toBe(true);
    const threads = await listThreadsForViewer(viewer, 'b');
    expect(threads).toEqual([
      expect.objectContaining({
        threadId: '__agent:sb',
        title: 'Agent messages',
        channelType: 'agent',
        messagingGroupId: 'sb',
        sessionId: 'sb',
        canSend: false,
        messageCount: 2,
      }),
    ]);
    const thread = threads[0];
    const view = readConversation(viewer, 'b', thread.threadId, thread);
    expect(view.messages.map((message) => message.id).sort()).toEqual(['received-from-a', 'sent-to-a']);
    expect(view.messages.find((message) => message.id === 'received-from-a')?.author).toEqual({
      agentGroupId: 'a',
      displayName: 'Agent A',
    });
    expect(view.messages.find((message) => message.id === 'sent-to-a')?.recipient).toEqual({
      agentGroupId: 'a',
      displayName: 'Agent A',
    });
    expect(view.capabilities).toMatchObject({ canSend: false, stop: false, steer: false, editInput: false });
  });

  it('lists outbound-only exchanges, including when there are no channel contexts', async () => {
    bIn.prepare("DELETE FROM messages_in WHERE channel_type='agent'").run();
    refreshThreadSummaries('sb');
    expect((await listThreadsForViewer(viewer, 'b'))[0]).toMatchObject({ messageCount: 1 });
    expect(
      readConversation(viewer, 'b', '__agent:sb', { channelType: 'agent', messagingGroupId: 'sb' }).messages.map(
        (message) => message.id,
      ),
    ).toEqual(['sent-to-a']);
  });

  it('keeps peers out of unrelated routes in shared sessions and offers a separate peer transcript', async () => {
    getDb().prepare("UPDATE sessions SET thread_id=NULL WHERE id='sa'").run();
    expect(readConversation(viewer, 'a', 'human').messages.map((message) => message.id)).toEqual(['human']);
    const peer = (await listThreadsForViewer(viewer, 'a')).find((thread) => thread.threadId === '__agent:sa')!;
    expect(peer).toMatchObject({ messageCount: 2, canSend: false });
    expect(
      readConversation(viewer, 'a', peer.threadId, peer)
        .messages.map((message) => message.id)
        .sort(),
    ).toEqual(['received-from-b', 'sent-to-b']);
  });

  it('rejects forged session/group combinations, missing context and revoked group membership', async () => {
    const peer = { channelType: 'agent', messagingGroupId: 'sb' };
    expect(resolveTurnContext(viewer, 'a', '__agent:sb', peer)).toBeNull();
    expect(resolveTurnContext(viewer, 'b', '__agent:sb')).toBeNull();
    expect(resolveTurnContext(viewer, 'b', '__agent:sb', { ...peer, messagingGroupId: 'sa' })).toBeNull();
    getDb().prepare("DELETE FROM agent_group_members WHERE agent_group_id='b'").run();
    expect(() => readConversation(viewer, 'b', '__agent:sb', peer)).toThrow('not accessible');
    await expect(listThreadsForViewer(viewer, 'b')).rejects.toThrow('access denied');
  });

  it('uses the peer ID if its name is unavailable, rather than trusting message content', () => {
    getDb().prepare("UPDATE agent_groups SET name='  ' WHERE id='b'").run();
    const messages = readConversation(viewer, 'a', 'human').messages;
    expect(messages.find((message) => message.id === 'received-from-b')?.author).toEqual({
      agentGroupId: 'b',
      displayName: 'b',
    });
    expect(messages.find((message) => message.id === 'sent-to-b')?.recipient).toEqual({
      agentGroupId: 'b',
      displayName: 'b',
    });
  });

  it('projects peer turns but not host self-notes, and preserves attribution through snapshots and updates', () => {
    for (const platform of ['a', 'b'])
      putTurn(aOut, {
        id: `turn-${platform}`,
        origin_channel_type: 'agent',
        origin_platform_id: platform,
        origin_thread_id: null,
        origin_source_session_id: null,
        started_at: now,
        ended_at: now + 100,
        phase: 'settled',
        outcome: 'replied',
        provenance: 'native',
        imported_from_session_id: null,
        imported_from_turn_id: null,
      });
    aOut.prepare("UPDATE messages_out SET turn_id='turn-b' WHERE id='sent-to-b'").run();
    const initial = readConversation(viewer, 'a', 'human');
    expect(initial.turns.map((turn) => turn.id)).toEqual(['turn-b']);
    const snapshot = reduceConversation(
      null,
      parseConversationFrame(
        JSON.parse(
          JSON.stringify({
            kind: 'snapshot',
            protocolVersion: CONVERSATION_PROTOCOL_VERSION,
            streamId: 'peer-stream',
            revision: 0,
            conversation: initial,
          }),
        ),
      ),
    );
    input(aIn, 'followup-from-b', 'agent', 'b', null);
    const current = readConversation(viewer, 'a', 'human');
    const applied = reduceConversation(
      snapshot,
      parseConversationFrame(
        JSON.parse(
          JSON.stringify({
            kind: 'update',
            protocolVersion: CONVERSATION_PROTOCOL_VERSION,
            streamId: 'peer-stream',
            baseRevision: 0,
            revision: 1,
            changes: diffConversation(initial, current),
          }),
        ),
      ),
    );
    expect(applied.conversation).toEqual(JSON.parse(JSON.stringify(current)));
    expect(applied.conversation.messages.find((message) => message.id === 'followup-from-b')?.author).toEqual({
      agentGroupId: 'b',
      displayName: 'Agent B',
    });
  });

  it('retains the settlement barrier for responses sent to peers', () => {
    putTurn(aOut, {
      id: 'peer-turn',
      origin_channel_type: 'agent',
      origin_platform_id: 'b',
      origin_thread_id: null,
      origin_source_session_id: null,
      started_at: now,
      ended_at: null,
      phase: 'running',
      outcome: 'pending',
      provenance: 'native',
      imported_from_session_id: null,
      imported_from_turn_id: null,
    });
    aOut
      .prepare("UPDATE messages_out SET turn_id='peer-turn',content=? WHERE id='sent-to-b'")
      .run(JSON.stringify({ text: 'Final peer response', delivery_origin: 'response' }));
    expect(readConversation(viewer, 'a', 'human').messages.some((message) => message.id === 'sent-to-b')).toBe(false);
    aOut.prepare("UPDATE turns SET phase='settled',outcome='replied',ended_at=? WHERE id='peer-turn'").run(now + 100);
    expect(readConversation(viewer, 'a', 'human').messages.find((message) => message.id === 'sent-to-b')).toMatchObject(
      { text: 'Final peer response', recipient: { agentGroupId: 'b', displayName: 'Agent B' } },
    );
  });

  it('serves received peer attachments only from the authorized transcript', async () => {
    const file = 'inbox/peer-file/note.txt';
    fs.mkdirSync(path.join(sessionDir('b', 'sb'), 'inbox/peer-file'), { recursive: true });
    fs.writeFileSync(path.join(sessionDir('b', 'sb'), file), 'Peer attachment');
    bIn.prepare("UPDATE messages_in SET content=? WHERE id='received-from-a'").run(
      JSON.stringify({
        text: 'Attached',
        attachments: [{ name: 'note.txt', localPath: file, mimeType: 'text/plain' }],
      }),
    );
    bIn.prepare("UPDATE messages_in SET content=? WHERE id='private-human'").run(
      JSON.stringify({
        text: 'Private attachment',
        attachments: [{ name: 'private.txt', localPath: 'inbox/private.txt' }],
      }),
    );
    const view = readConversation(viewer, 'b', '__agent:sb', { channelType: 'agent', messagingGroupId: 'sb' });
    const attachment = view.messages.find((message) => message.id === 'received-from-a')?.files?.[0];
    expect(attachment).toMatchObject({ filename: 'note.txt', size: 15 });
    expect(attachment?.url).toContain('?channel=agent&mg=sb');
    const server = http.createServer((req, res) => {
      void handleChatRequest(req, res, new URL(req.url!, 'http://localhost').pathname, viewer);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Missing fixture server address');
      const base = `http://127.0.0.1:${address.port}/`;
      const response = await fetch(new URL(attachment!.url!, base));
      expect(response.status).toBe(200);
      expect(await response.text()).toBe('Peer attachment');
      const privateResponse = await fetch(
        new URL('api/groups/b/chat/__agent%3Asb/attachments/inbox/private.txt?channel=agent&mg=sb', base),
      );
      expect(privateResponse.status).toBe(404);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  });
});
