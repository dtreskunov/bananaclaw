import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { clearCurrentInReplyTo, setCurrentInReplyTo } from './current-batch.js';
import { closeSessionDb, getInboundDb, getOutboundDb, initTestSessionDb } from './db/connection.js';
import { getPendingMessages, markProcessing } from './db/messages-in.js';
import { setThreadTitle } from './mcp-tools/thread-titles.js';
import { appendThreadTitleRequest } from './thread-title-request.js';

beforeEach(() => {
  initTestSessionDb();
  getInboundDb()
    .prepare(
      "INSERT INTO session_routing (id, channel_type, platform_id, thread_id) VALUES (1, 'web', 'group-1', 'thread-1')",
    )
    .run();
});

afterEach(() => {
  clearCurrentInReplyTo();
  closeSessionDb();
});

function insertChat(id: string, seq: number, text: string): void {
  getInboundDb()
    .prepare(
      `INSERT INTO messages_in
         (id, seq, kind, timestamp, status, platform_id, channel_type, thread_id, content)
       VALUES (?, ?, 'chat', datetime('now'), 'pending', 'group-1', 'web', 'thread-1', ?)`,
    )
    .run(id, seq, JSON.stringify({ sender: 'User', text }));
}

describe('thread title request', () => {
  it('prompts only with the first chat message while no title exists', () => {
    insertChat('in-1', 2, 'Help me debug OAuth');
    const first = getPendingMessages();
    expect(appendThreadTitleRequest('prompt', first)).toContain('<thread_title_request>');

    insertChat('in-2', 4, 'More details');
    const second = getPendingMessages().filter((message) => message.id === 'in-2');
    expect(appendThreadTitleRequest('prompt', second)).toBe('prompt');
  });

  it('suppresses the prompt when title metadata already exists', () => {
    insertChat('in-1', 2, 'Help me debug OAuth');
    getInboundDb()
      .prepare(
        `INSERT INTO thread_titles
           (channel_type, platform_id, thread_id, title, request_message_id, updated_at)
         VALUES ('web', 'group-1', 'thread-1', 'OAuth token refresh failure', 'in-1', datetime('now'))`,
      )
      .run();
    expect(appendThreadTitleRequest('prompt', getPendingMessages())).toBe('prompt');
  });

  it('writes a routed system action instead of a visible message', async () => {
    insertChat('in-1', 2, 'Help me debug OAuth');
    markProcessing(['in-1']);
    await setThreadTitle.handler({ title: '  OAuth token\nrefresh failure  ' });

    const row = getOutboundDb().prepare('SELECT kind, in_reply_to, content FROM messages_out').get() as {
      kind: string;
      in_reply_to: string;
      content: string;
    };
    expect(row.kind).toBe('system');
    expect(row.in_reply_to).toBe('in-1');
    expect(JSON.parse(row.content)).toEqual({
      action: 'set_thread_title',
      title: 'OAuth token refresh failure',
      requestMessageId: 'in-1',
      platformId: 'group-1',
      channelType: 'web',
      threadId: 'thread-1',
    });
  });
});
