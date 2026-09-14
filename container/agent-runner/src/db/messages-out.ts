/**
 * Outbound message operations (container side).
 *
 * Writes to the runner-state projection. A trigger journals each row and the
 * session link applies it to the host-owned outbound.db.
 */
import { getInboundDb, getOutboundDb } from './connection.js';
import type { Database } from 'bun:sqlite';
import { isSafeAttachmentName } from '../attachment-safety.js';

const MAX_OUTPUT_BYTES = Number.parseInt(process.env.NANOCLAW_MAX_OUTPUT_BYTES || '10485760', 10);
const MAX_CONTENT_ARRAY_ITEMS = 100;
const MAX_CONTENT_DEPTH = 16;
const MAX_OUTBOUND_FILES = 32;
const MAX_QUESTION_OPTIONS = 50;

function validateStructuredContent(value: unknown, depth = 0): boolean {
  if (depth > MAX_CONTENT_DEPTH) return false;
  if (value === null || typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string') return true;
  if (Array.isArray(value)) {
    return value.length <= MAX_CONTENT_ARRAY_ITEMS && value.every((item) => validateStructuredContent(item, depth + 1));
  }
  if (!value || typeof value !== 'object') return false;
  const entries = Object.entries(value as Record<string, unknown>);
  return (
    entries.length <= MAX_CONTENT_ARRAY_ITEMS &&
    entries.every(([key, item]) => key.length <= 256 && validateStructuredContent(item, depth + 1))
  );
}

function validateMessageContent(raw: string): void {
  if (raw.length === 0 || Buffer.byteLength(raw) > MAX_OUTPUT_BYTES) {
    throw new Error('outbound message exceeds durable link limits');
  }
  let content: Record<string, unknown>;
  try {
    content = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    throw new Error('outbound message content must be a JSON object');
  }
  if (!content || typeof content !== 'object' || Array.isArray(content) || !validateStructuredContent(content)) {
    throw new Error('outbound message content exceeds structural limits');
  }
  if (
    content.files !== undefined &&
    (!Array.isArray(content.files) ||
      content.files.length > MAX_OUTBOUND_FILES ||
      !content.files.every((file) => typeof file === 'string' && isSafeAttachmentName(file)))
  ) {
    throw new Error('invalid outbound files');
  }
  if (
    content.file_paths !== undefined &&
    (!Array.isArray(content.file_paths) ||
      content.file_paths.length > MAX_OUTBOUND_FILES ||
      !content.file_paths.every((file) => file === null || (typeof file === 'string' && file.length <= 4096)))
  ) {
    throw new Error('invalid outbound file paths');
  }
  if (content.options !== undefined && (!Array.isArray(content.options) || content.options.length > MAX_QUESTION_OPTIONS)) {
    throw new Error('invalid question options');
  }
}

export interface MessageOutRow {
  id: string;
  seq: number | null;
  in_reply_to: string | null;
  timestamp: string;
  deliver_after: string | null;
  recurrence: string | null;
  kind: string;
  platform_id: string | null;
  channel_type: string | null;
  thread_id: string | null;
  content: string;
}

export interface WriteMessageOut {
  id: string;
  in_reply_to?: string | null;
  deliver_after?: string | null;
  recurrence?: string | null;
  kind: string;
  platform_id?: string | null;
  channel_type?: string | null;
  thread_id?: string | null;
  content: string;
}

/**
 * Write a new outbound message, auto-assigning an odd seq number.
 * Container uses odd seq (1, 3, 5...), host uses even (2, 4, 6...).
 *
 * The disjoint namespace is load-bearing, not just collision avoidance:
 * seq is the agent-facing message ID returned by send_message and accepted
 * by edit_message / add_reaction, and getMessageIdBySeq() below looks up
 * by seq across BOTH tables. If inbound and outbound could share a seq,
 * the agent's "edit message #5" could resolve to the wrong row.
 */
export function writeMessageOut(msg: WriteMessageOut): number {
  const outbound = getOutboundDb();
  const inbound = getInboundDb();
  return writeMessageOutWithConnections(msg, outbound, inbound);
}

export function writeMessageOutWithConnections(
  msg: WriteMessageOut,
  outbound: Database,
  inbound: Database,
): number {
  validateMessageContent(msg.content);
  outbound.exec('BEGIN IMMEDIATE');
  try {
    // Read max seq from both host stores and the runner projection while
    // holding the runner-state write lock. A sidecar writer must wait and
    // then recompute after this row commits.
    const maxOut = (outbound.prepare('SELECT COALESCE(MAX(seq), 0) AS m FROM messages_out').get() as { m: number }).m;
    const maxHostOut = Number(
      (outbound.prepare("SELECT value FROM host_state WHERE key = 'sequence_floor'").get() as { value?: string } | undefined)
        ?.value ?? 0,
    );
    const maxIn = (inbound.prepare('SELECT COALESCE(MAX(seq), 0) AS m FROM messages_in').get() as { m: number }).m;
    const max = Math.max(maxOut, maxHostOut, maxIn);
    const nextSeq = max % 2 === 0 ? max + 1 : max + 2;

    // bun:sqlite requires named parameters to be passed with the prefix character
    // in the JS object keys (better-sqlite3 auto-stripped it, bun:sqlite does not).
    outbound
      .prepare(
        `INSERT INTO messages_out (id, seq, in_reply_to, timestamp, deliver_after, recurrence, kind, platform_id, channel_type, thread_id, content)
     VALUES ($id, $seq, $in_reply_to, datetime('now'), $deliver_after, $recurrence, $kind, $platform_id, $channel_type, $thread_id, $content)`,
      )
      .run({
        $id: msg.id,
        $seq: nextSeq,
        $in_reply_to: msg.in_reply_to ?? null,
        $deliver_after: msg.deliver_after ?? null,
        $recurrence: msg.recurrence ?? null,
        $kind: msg.kind,
        $platform_id: msg.platform_id ?? null,
        $channel_type: msg.channel_type ?? null,
        $thread_id: msg.thread_id ?? null,
        $content: msg.content,
      });

    outbound.exec('COMMIT');
    return nextSeq;
  } catch (error) {
    if (outbound.inTransaction) outbound.exec('ROLLBACK');
    throw error;
  }
}

/**
 * Look up a message's platform ID by seq number.
 * Searches both inbound and outbound DBs since seq spans both.
 *
 * For inbound messages, the Chat SDK message ID is already the platform message ID
 * (e.g., "6037840640:42" for Telegram).
 *
 * For outbound messages, the internal ID (msg-xxx) won't work for edits/reactions.
 * Instead, look up the platform_message_id from the delivered table (host writes this
 * after successful delivery).
 */
export function getMessageIdBySeq(seq: number): string | null {
  const inbound = getInboundDb();

  // Inbound messages: ID is already the platform message ID
  const inRow = inbound.prepare('SELECT id FROM messages_in WHERE seq = ?').get(seq) as { id: string } | undefined;
  if (inRow) return inRow.id;

  // Outbound messages: look up platform message ID from delivered table
  const outRow = getOutboundDb().prepare('SELECT id FROM messages_out WHERE seq = ?').get(seq) as
    | { id: string }
    | undefined;
  if (!outRow) return null;

  // The host resolves this stable NanoClaw ID to its platform receipt when
  // delivering edit/reaction operations.
  return outRow.id;
}

/**
 * Look up the routing fields for a message by seq (for edit/reaction targeting).
 * Returns the channel_type, platform_id, thread_id of the referenced message.
 */
export function getRoutingBySeq(
  seq: number,
): { channel_type: string | null; platform_id: string | null; thread_id: string | null } | null {
  const inbound = getInboundDb();
  const inRow = inbound
    .prepare('SELECT channel_type, platform_id, thread_id FROM messages_in WHERE seq = ?')
    .get(seq) as { channel_type: string | null; platform_id: string | null; thread_id: string | null } | undefined;
  if (inRow) return inRow;

  const outRow = getOutboundDb()
    .prepare('SELECT channel_type, platform_id, thread_id FROM messages_out WHERE seq = ?')
    .get(seq) as { channel_type: string | null; platform_id: string | null; thread_id: string | null } | undefined;
  return outRow ?? null;
}

/** Get undelivered messages (for host polling — reads from outbound.db). */
export function getUndeliveredMessages(): MessageOutRow[] {
  return getOutboundDb()
    .prepare(
      `SELECT * FROM messages_out
       WHERE (deliver_after IS NULL OR deliver_after <= datetime('now'))
       ORDER BY timestamp ASC`,
    )
    .all() as MessageOutRow[];
}
