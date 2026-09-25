/**
 * Inbound message operations (container side).
 *
 * Reads host events projected into runner-state.db.
 * Writes processing status to the runner-state projection. Triggers journal
 * the mutation for the host-owned outbound.db.
 *
 * Processing status goes through the runner journal and is projected back to
 * the host over the same session link.
 */
import { getConfig } from '../config.js';
import { openInboundDb, getOutboundDb } from './connection.js';

export const MAX_TIMER_DELAY_MS = 2_147_000_000;

export interface MessageInRow {
  id: string;
  seq: number | null;
  kind: string;
  timestamp: string;
  status: string;
  process_after: string | null;
  recurrence: string | null;
  series_id?: string | null;
  tries: number;
  /** 1 = wake-eligible (default); 0 = accumulated context only */
  trigger: number;
  platform_id: string | null;
  channel_type: string | null;
  thread_id: string | null;
  content: string;
  /** Canonical UUID of the sender (host's users.id). Null when unresolved. */
  sender_user_id?: string | null;
  /** Namespaced channel identity retained when canonical attribution is unavailable. */
  sender_identity?: string | null;
  source_session_id?: string | null;
}

// Cap on how many messages reach the agent in one prompt. Read from
// container.json; falls back to 10.
function getMaxMessagesPerPrompt(): number {
  try {
    return getConfig().maxMessagesPerPrompt;
  } catch {
    // Config not loaded yet (e.g. test harness) — use default
    return 10;
  }
}

/**
 * Fetch pending projected messages that are due for processing.
 * Filters against local processing_ack
 * to skip messages already picked up by this or a previous container run.
 *
 * Returns the most recent `MAX_MESSAGES_PER_PROMPT` pending rows in
 * chronological order, regardless of their `trigger` flag: accumulated
 * context (trigger=0) rides along with the wake-eligible rows so the agent
 * sees the prior context it missed. Host's countDueMessages gates waking on
 * trigger=1 separately (see src/db/session-db.ts).
 */
export function getPendingMessages(isFirstPoll = false): MessageInRow[] {
  const inbound = openInboundDb();
  const outbound = getOutboundDb();

  try {
    const pending = inbound
      .prepare(
        `SELECT * FROM messages_in
         WHERE status = 'pending'
           AND (process_after IS NULL OR datetime(process_after) <= datetime('now'))
           AND (on_wake = 0 OR ?1 = 1)
         ORDER BY seq DESC
         LIMIT ?2`,
      )
      .all(isFirstPoll ? 1 : 0, getMaxMessagesPerPrompt()) as MessageInRow[];

    if (pending.length === 0) return [];

    // Filter out messages already acknowledged in the local projection.
    const ackedIds = new Set(
      (outbound.prepare('SELECT message_id FROM processing_ack').all() as Array<{ message_id: string }>).map(
        (r) => r.message_id,
      ),
    );

    // Reverse: we fetched DESC to take the most recent N, but the agent
    // should see them in chronological order (oldest first).
    return pending.filter((m) => !ackedIds.has(m.id)).reverse();
  } finally {
    inbound.close();
  }

}

/** Select steering candidates before applying the prompt cap, so queued input cannot hide them. */
export function getSteeringCandidates(
  routing: { channelType: string | null; platformId: string | null; threadId: string | null },
  excludedIds: string[],
): MessageInRow[] {
  const acknowledged = getOutboundDb().prepare('SELECT message_id FROM processing_ack').all() as { message_id: string }[];
  const exclude = JSON.stringify([...excludedIds, ...acknowledged.map((row) => row.message_id)]);
  const db = openInboundDb();
  try {
    return db.prepare(
      `SELECT m.* FROM messages_in m
       WHERE m.status = 'pending' AND m.trigger = 1 AND m.on_wake = 0
         AND m.kind IN ('chat', 'chat-sdk') AND m.source_session_id IS NULL
         AND (m.process_after IS NULL OR datetime(m.process_after) <= datetime('now'))
         AND m.channel_type = ? AND m.platform_id = ? AND COALESCE(m.thread_id, '') = ?
         AND m.id NOT IN (SELECT value FROM json_each(?))
         AND (m.channel_type != 'web' OR
           CASE WHEN json_valid(m.content) THEN json_extract(m.content, '$.inputHandling.mode') END = 'steer')
       ORDER BY m.seq ASC LIMIT ?`,
    ).all(
      routing.channelType, routing.platformId, routing.threadId || '', exclude, getMaxMessagesPerPrompt(),
    ) as MessageInRow[];
  } finally {
    db.close();
  }
}

/** Milliseconds until the next future pending row becomes due. */
export function nextPendingDueDelayMs(): number | undefined {
  const inbound = openInboundDb();
  try {
    const row = inbound
      .prepare(
        `SELECT CAST(MAX(0, (julianday(MIN(process_after)) - julianday('now')) * 86400000) AS INTEGER) AS delay_ms
         FROM messages_in
         WHERE status = 'pending' AND process_after IS NOT NULL
           AND datetime(process_after) > datetime('now')`,
      )
      .get() as { delay_ms: number | null };
    return row.delay_ms === null ? undefined : Math.min(row.delay_ms, MAX_TIMER_DELAY_MS);
  } finally {
    inbound.close();
  }
}

/** Mark messages as processing in the journaled local projection. */
export function markProcessing(ids: string[]): void {
  if (ids.length === 0) return;
  const db = getOutboundDb();
  const stmt = db.prepare(
    "INSERT OR REPLACE INTO processing_ack (message_id, status, status_changed) VALUES (?, 'processing', datetime('now'))",
  );
  db.transaction(() => {
    for (const id of ids) stmt.run(id);
  })();
}

export function releaseProcessing(ids: string[]): void {
  const db = getOutboundDb();
  const stmt = db.prepare("DELETE FROM processing_ack WHERE message_id = ? AND status = 'processing'");
  db.transaction(() => { for (const id of ids) stmt.run(id); })();
}

/** Mark messages as completed in the journaled local projection. */
export function markCompleted(ids: string[]): void {
  if (ids.length === 0) return;
  const db = getOutboundDb();
  const stmt = db.prepare(
    "INSERT OR REPLACE INTO processing_ack (message_id, status, status_changed) VALUES (?, 'completed', datetime('now'))",
  );
  db.transaction(() => {
    for (const id of ids) stmt.run(id);
  })();
}

/** Mark a single message as failed in the journaled local projection. */
export function markFailed(id: string): void {
  getOutboundDb()
    .prepare(
      "INSERT OR REPLACE INTO processing_ack (message_id, status, status_changed) VALUES (?, 'failed', datetime('now'))",
    )
    .run(id);
}

/** Get a message by ID (read from inbound.db). */
export function getMessageIn(id: string): MessageInRow | undefined {
  const inbound = openInboundDb();
  try {
    return inbound.prepare('SELECT * FROM messages_in WHERE id = ?').get(id) as MessageInRow | undefined;
  } finally {
    inbound.close();
  }
}

/**
 * Find a pending response to a question (by questionId in content).
 * Reads from inbound.db, checks processing_ack to skip already-handled responses.
 */
export function findQuestionResponse(questionId: string): MessageInRow | undefined {
  const inbound = openInboundDb();
  const outbound = getOutboundDb();

  try {
    const response = inbound
      .prepare("SELECT * FROM messages_in WHERE status = 'pending' AND content LIKE ?")
      .get(`%"questionId":"${questionId}"%`) as MessageInRow | undefined;

    if (!response) return undefined;

    // Check it hasn't been acked already
    const acked = outbound.prepare('SELECT 1 FROM processing_ack WHERE message_id = ?').get(response.id);
    if (acked) return undefined;

    return response;
  } finally {
    inbound.close();
  }
}
