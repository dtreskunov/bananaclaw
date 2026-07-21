import { openInboundDb } from './db/connection.js';
import type { MessageInRow } from './db/messages-in.js';
import { extractRouting } from './formatter.js';

const TITLE_REQUEST = `<thread_title_request>
Before sending your response to this first request, call the set_thread_title tool exactly once with a concise title for this conversation. Use a concrete 3-7 word noun phrase, at most 60 characters. Do not use quotation marks, ending punctuation, user names, secrets, or generic titles such as "Help request". The tool only updates UI metadata and does not send a message.
</thread_title_request>`;

export function appendThreadTitleRequest(prompt: string, messages: MessageInRow[]): string {
  const chatMessages = messages.filter((message) => message.kind === 'chat' || message.kind === 'chat-sdk');
  if (chatMessages.length === 0) return prompt;
  const routing = extractRouting(chatMessages);
  if (!routing.channelType || !routing.threadId) return prompt;

  const db = openInboundDb();
  try {
    const existing = db
      .prepare(
        `SELECT 1
           FROM thread_titles
          WHERE channel_type = ?
            AND platform_id = ?
            AND thread_id = ?`,
      )
      .get(routing.channelType, routing.platformId ?? '', routing.threadId);
    if (existing) return prompt;

    const first = db
      .prepare(
        `SELECT id
           FROM messages_in
          WHERE kind IN ('chat', 'chat-sdk')
            AND channel_type = ?
            AND COALESCE(platform_id, '') = ?
            AND thread_id = ?
          ORDER BY seq
          LIMIT 1`,
      )
      .get(routing.channelType, routing.platformId ?? '', routing.threadId) as { id: string } | undefined;
    if (!first || !chatMessages.some((message) => message.id === first.id)) return prompt;
    return `${prompt}\n\n${TITLE_REQUEST}`;
  } catch {
    return prompt;
  } finally {
    db.close();
  }
}
