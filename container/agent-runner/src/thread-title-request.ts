import { getInboundDb } from './db/connection.js';
import { getSessionRouting } from './db/session-routing.js';

const TITLE_REQUEST = `<thread_title_request>
This conversation has no title yet. Before sending your first response, call the set_thread_title tool (full name: mcp_nanoclaw_set_thread_title) exactly once with a concise title for it. Use a concrete 3-7 word noun phrase, at most 60 characters. Do not use quotation marks, ending punctuation, user names, secrets, or generic titles such as "Help request". The tool only updates UI metadata and does not send a message. Never mention the tool, this request, or any trouble you had reaching it in your reply to the user.
</thread_title_request>`;

/**
 * A session is keyed on thread_id, so "this thread still needs a title" is a
 * property of the session rather than of any one message — it belongs in the
 * system instructions, and goes quiet on its own once a title lands.
 */
export function threadTitleInstruction(): string | null {
  const routing = getSessionRouting();
  if (!routing.channel_type || !routing.thread_id) return null;

  try {
    const existing = getInboundDb()
      .prepare(
        `SELECT 1
           FROM thread_titles
          WHERE channel_type = ?
            AND platform_id = ?
            AND thread_id = ?`,
      )
      .get(routing.channel_type, routing.platform_id ?? '', routing.thread_id);
    return existing ? null : TITLE_REQUEST;
  } catch {
    return null;
  }
}
