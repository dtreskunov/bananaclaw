import { getCurrentInReplyTo } from '../current-batch.js';
import { openInboundDb, getOutboundDb } from '../db/connection.js';
import { writeMessageOut } from '../db/messages-out.js';
import { getSessionRouting, type SessionRouting } from '../db/session-routing.js';
import { registerTools } from './server.js';
import type { McpToolDefinition } from './types.js';

function result(text: string, isError = false) {
  return { content: [{ type: 'text' as const, text }], ...(isError ? { isError: true } : {}) };
}

function findActiveRequestMessageId(routing: SessionRouting): string | null {
  const processing = getOutboundDb()
    .prepare("SELECT message_id FROM processing_ack WHERE status = 'processing' ORDER BY status_changed DESC")
    .all() as Array<{ message_id: string }>;
  if (processing.length === 0) return null;
  const inbound = openInboundDb();
  try {
    const messageStmt = inbound.prepare(
      `SELECT id, seq
         FROM messages_in
        WHERE id = ?
          AND kind IN ('chat', 'chat-sdk')
          AND channel_type = ?
          AND COALESCE(platform_id, '') = ?
          AND thread_id = ?`,
    );
    let active: { id: string; seq: number } | undefined;
    for (const row of processing) {
      const message = messageStmt.get(
        row.message_id,
        routing.channel_type,
        routing.platform_id ?? '',
        routing.thread_id,
      ) as { id: string; seq: number } | undefined;
      if (message && (!active || message.seq > active.seq)) active = message;
    }
    return active?.id ?? null;
  } finally {
    inbound.close();
  }
}

export const setThreadTitle: McpToolDefinition = {
  tool: {
    name: 'set_thread_title',
    description:
      'Set the concise descriptive title shown for the current conversation in the thread list. This updates UI metadata and does not send a message.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        title: {
          type: 'string',
          description: 'Concrete 3-7 word conversation title, at most 60 characters',
        },
      },
      required: ['title'],
    },
  },
  async handler(args) {
    const title = typeof args.title === 'string' ? args.title.replace(/\s+/g, ' ').trim().slice(0, 60) : '';
    const routing = getSessionRouting();
    const requestMessageId = getCurrentInReplyTo() ?? findActiveRequestMessageId(routing);
    if (!title) return result('Error: title is required', true);
    if (!requestMessageId || !routing.channel_type || !routing.thread_id) {
      return result('Error: no active thread to title', true);
    }

    writeMessageOut({
      id: `thread-title-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      in_reply_to: requestMessageId,
      kind: 'system',
      platform_id: routing.platform_id,
      channel_type: routing.channel_type,
      thread_id: routing.thread_id,
      content: JSON.stringify({
        action: 'set_thread_title',
        title,
        requestMessageId,
        platformId: routing.platform_id,
        channelType: routing.channel_type,
        threadId: routing.thread_id,
      }),
    });
    return result(`Thread title set to: ${title}`);
  },
};

registerTools([setThreadTitle]);
