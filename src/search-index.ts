/**
 * Central search index backed by FTS5.
 *
 * Stores message text in `data/search.db` alongside a full-text index.
 * This is a rebuildable secondary index — if lost, `scripts/backfill-search-index.ts`
 * recreates it from per-session inbound/outbound DBs.
 *
 * Single long-lived connection is safe: search.db is host-only, no cross-mount concern.
 */
import Database from 'better-sqlite3';
import path from 'path';

import { DATA_DIR } from './config.js';
import { log } from './log.js';

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const SEARCH_SCHEMA = `
  CREATE TABLE IF NOT EXISTS message_index (
    id                 TEXT PRIMARY KEY,
    session_id         TEXT NOT NULL,
    agent_group_id     TEXT NOT NULL,
    messaging_group_id TEXT,
    channel_type       TEXT,
    thread_id          TEXT,
    direction          TEXT NOT NULL,  -- 'in' | 'out'
    timestamp          TEXT NOT NULL,
    text               TEXT NOT NULL,
    sender_user_id     TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_mi_agent_group ON message_index(agent_group_id);
  CREATE INDEX IF NOT EXISTS idx_mi_messaging_group ON message_index(messaging_group_id);
  CREATE INDEX IF NOT EXISTS idx_mi_session ON message_index(session_id);

  CREATE VIRTUAL TABLE IF NOT EXISTS message_fts USING fts5(
    text,
    content = message_index,
    content_rowid = rowid
  );

  -- Triggers to keep the FTS index in sync with message_index.
  -- These fire on INSERT/DELETE/UPDATE so the FTS table stays consistent.
  CREATE TRIGGER IF NOT EXISTS mi_ai AFTER INSERT ON message_index BEGIN
    INSERT INTO message_fts(rowid, text) VALUES (new.rowid, new.text);
  END;

  CREATE TRIGGER IF NOT EXISTS mi_ad AFTER DELETE ON message_index BEGIN
    INSERT INTO message_fts(message_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
  END;

  CREATE TRIGGER IF NOT EXISTS mi_au AFTER UPDATE ON message_index BEGIN
    INSERT INTO message_fts(message_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
    INSERT INTO message_fts(rowid, text) VALUES (new.rowid, new.text);
  END;
`;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface IndexableMessage {
  id: string;
  sessionId: string;
  agentGroupId: string;
  messagingGroupId: string | null;
  channelType: string | null;
  threadId: string | null;
  direction: 'in' | 'out';
  timestamp: string;
  text: string;
  senderUserId?: string | null;
}

export interface SearchResultRow {
  messageId: string;
  sessionId: string;
  threadId: string | null;
  channelType: string | null;
  messagingGroupId: string | null;
  direction: string;
  timestamp: string;
  snippet: string;
  rank: number;
}

export interface SearchConversationScope {
  sessionId: string;
  threadId: string;
  channelType: string;
}

export interface SearchOptions {
  agentGroupId: string;
  /** Restrict to these messaging groups. If omitted, all MGs in the agent group. */
  messagingGroupIds?: string[];
  /** Restrict to exact visible conversations. An empty array denies all results. */
  conversations?: SearchConversationScope[];
  limit?: number;
}

// ---------------------------------------------------------------------------
// Connection
// ---------------------------------------------------------------------------

let db: Database.Database | null = null;

function searchDbPath(): string {
  return path.join(DATA_DIR, 'search.db');
}

function getSearchDb(): Database.Database {
  if (!db) throw new Error('Search index not initialised — call initSearchDb() first');
  return db;
}

/**
 * Open (or create) the search index. Called once during host startup.
 */
export function initSearchDb(): void {
  if (db) return;
  const dbPath = searchDbPath();
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  db.exec(SEARCH_SCHEMA);
  log.info('Search index ready', { path: dbPath });
}

/**
 * Close the search index. Called during host shutdown.
 */
export function closeSearchDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}

/** Remove all indexed messages before rebuilding from the session DBs. */
export function clearSearchIndex(): void {
  getSearchDb().exec('DELETE FROM message_index');
}

/**
 * Drop every indexed message for a session. Called when a thread is deleted —
 * without it the rows outlive the session and search returns hits that
 * navigate to a thread that no longer exists.
 */
export function deleteSessionFromIndex(sessionId: string): number {
  if (!db) return 0;
  try {
    return getSearchDb().prepare('DELETE FROM message_index WHERE session_id = ?').run(sessionId).changes;
  } catch (err) {
    log.warn('Search index: failed to delete session', { sessionId, err });
    return 0;
  }
}

/**
 * Normalize a timestamp to "YYYY-MM-DD HH:MM:SS" so mixed ISO/space formats
 * sort correctly (T > space in ASCII breaks ordering within the same day).
 * Every timestamp written to or compared against the index goes through here.
 */
function normalizeIndexTimestamp(ts: string): string {
  return ts
    .replace('T', ' ')
    .replace(/\.\d+Z$/, '')
    .replace(/Z$/, '');
}

/**
 * Hand a session's older messages over to a forked branch that also holds them.
 *
 * A fork copies its parent's messages verbatim, ids included, and `indexMessage`
 * is keyed on that id — so the copies never get rows of their own and the
 * parent's rows are the only index entry for text both threads display.
 * Deleting the parent outright would therefore make messages that are still on
 * screen in the branch unsearchable. Re-pointing the rows at or before the cut
 * keeps them findable, at their surviving location.
 *
 * Called before `deleteSessionFromIndex`, which then clears whatever was left
 * behind the cut.
 */
export function reassignIndexedMessages(
  fromSessionId: string,
  toSessionId: string,
  toThreadId: string | null,
  throughTimestamp: string,
): number {
  if (!db) return 0;
  try {
    return getSearchDb()
      .prepare(
        `UPDATE message_index SET session_id = ?, thread_id = ?
          WHERE session_id = ? AND timestamp <= ?`,
      )
      .run(toSessionId, toThreadId, fromSessionId, normalizeIndexTimestamp(throughTimestamp)).changes;
  } catch (err) {
    log.warn('Search index: failed to reassign session messages', { fromSessionId, toSessionId, err });
    return 0;
  }
}

// ---------------------------------------------------------------------------
// Indexing
// ---------------------------------------------------------------------------

/**
 * Index a single message. Idempotent (INSERT OR IGNORE).
 * Designed to be called fire-and-forget from the routing/delivery hot path.
 */
export function indexMessage(msg: IndexableMessage): void {
  if (!db) return; // search index not initialised — skip silently
  if (!msg.text.trim()) return; // no text to index

  // Strip the `:agentGroupId` suffix the router appends to inbound message IDs.
  // The history API strips this suffix too, so search result IDs must match.
  const suffix = msg.agentGroupId ? `:${msg.agentGroupId}` : '';
  const id = suffix && msg.id.endsWith(suffix) ? msg.id.slice(0, -suffix.length) : msg.id;

  // Normalize timestamp to "YYYY-MM-DD HH:MM:SS" so mixed ISO/space formats
  // sort correctly (T > space in ASCII breaks ordering within the same day).
  const ts = normalizeIndexTimestamp(msg.timestamp);

  try {
    getSearchDb()
      .prepare(
        `INSERT OR IGNORE INTO message_index
         (id, session_id, agent_group_id, messaging_group_id, channel_type, thread_id, direction, timestamp, text, sender_user_id)
         VALUES (@id, @sessionId, @agentGroupId, @messagingGroupId, @channelType, @threadId, @direction, @timestamp, @text, @senderUserId)`,
      )
      .run({
        id,
        sessionId: msg.sessionId,
        agentGroupId: msg.agentGroupId,
        messagingGroupId: msg.messagingGroupId,
        channelType: msg.channelType,
        threadId: msg.threadId,
        direction: msg.direction,
        timestamp: ts,
        text: msg.text,
        senderUserId: msg.senderUserId ?? null,
      });
  } catch (err) {
    log.warn('Search index: failed to index message', { messageId: msg.id, err });
  }
}

// ---------------------------------------------------------------------------
// Querying
// ---------------------------------------------------------------------------

/**
 * Search indexed messages using FTS5.
 *
 * Supports FTS5 query syntax:
 *   - Simple words: `deployment`
 *   - Prefix: `deploy*`
 *   - Phrase: `"deploy to prod"`
 *   - Boolean: `deploy OR release`
 */
export function searchMessages(query: string, opts: SearchOptions): SearchResultRow[] {
  if (!db) return [];

  const q = query.trim();
  if (!q) return [];
  if (opts.conversations && opts.conversations.length === 0) return [];

  const limit = opts.limit ?? 50;

  // Build WHERE clause for scope filtering
  const conditions: string[] = ['mi.agent_group_id = @agentGroupId'];
  const params: Record<string, unknown> = {
    agentGroupId: opts.agentGroupId,
    query: q,
    limit,
  };

  if (opts.messagingGroupIds && opts.messagingGroupIds.length > 0) {
    // Build IN clause with positional placeholders
    const placeholders = opts.messagingGroupIds.map((_, i) => `@mg${i}`);
    conditions.push(`mi.messaging_group_id IN (${placeholders.join(', ')})`);
    for (let i = 0; i < opts.messagingGroupIds.length; i++) {
      params[`mg${i}`] = opts.messagingGroupIds[i];
    }
  }

  if (opts.conversations) {
    const scopes = opts.conversations.map((scope, i) => {
      params[`session${i}`] = scope.sessionId;
      params[`thread${i}`] = scope.threadId;
      params[`channel${i}`] = scope.channelType;
      return `(mi.session_id = @session${i} AND mi.thread_id = @thread${i} AND mi.channel_type = @channel${i})`;
    });
    conditions.push(`(${scopes.join(' OR ')})`);
  }

  const where = conditions.join(' AND ');

  try {
    return getSearchDb()
      .prepare(
        `SELECT
           mi.id          AS messageId,
           mi.session_id  AS sessionId,
           mi.thread_id   AS threadId,
           mi.channel_type AS channelType,
           mi.messaging_group_id AS messagingGroupId,
           mi.direction,
           mi.timestamp,
           snippet(message_fts, 0, '>>>', '<<<', '…', 20) AS snippet,
           rank
         FROM message_fts
         JOIN message_index mi ON mi.rowid = message_fts.rowid
         WHERE message_fts MATCH @query
           AND ${where}
         ORDER BY mi.timestamp DESC
         LIMIT @limit`,
      )
      .all(params) as SearchResultRow[];
  } catch (err) {
    // FTS5 MATCH can throw on malformed queries (unbalanced quotes, etc.).
    // Fall back to a LIKE scan so the user still gets results.
    log.warn('Search index: FTS5 MATCH failed, falling back to LIKE', { query: q, err });
    return likeFallback(q, opts, limit);
  }
}

/**
 * Fallback for malformed FTS5 queries — plain LIKE search.
 */
function likeFallback(query: string, opts: SearchOptions, limit: number): SearchResultRow[] {
  const conditions: string[] = ['agent_group_id = @agentGroupId', "text LIKE '%' || @query || '%'"];
  const params: Record<string, unknown> = {
    agentGroupId: opts.agentGroupId,
    query,
    limit,
  };

  if (opts.messagingGroupIds && opts.messagingGroupIds.length > 0) {
    const placeholders = opts.messagingGroupIds.map((_, i) => `@mg${i}`);
    conditions.push(`messaging_group_id IN (${placeholders.join(', ')})`);
    for (let i = 0; i < opts.messagingGroupIds.length; i++) {
      params[`mg${i}`] = opts.messagingGroupIds[i];
    }
  }

  if (opts.conversations) {
    const scopes = opts.conversations.map((scope, i) => {
      params[`session${i}`] = scope.sessionId;
      params[`thread${i}`] = scope.threadId;
      params[`channel${i}`] = scope.channelType;
      return `(session_id = @session${i} AND thread_id = @thread${i} AND channel_type = @channel${i})`;
    });
    conditions.push(`(${scopes.join(' OR ')})`);
  }

  const where = conditions.join(' AND ');

  return getSearchDb()
    .prepare(
      `SELECT
         id           AS messageId,
         session_id   AS sessionId,
         thread_id    AS threadId,
         channel_type AS channelType,
         messaging_group_id AS messagingGroupId,
         direction,
         timestamp,
         substr(text, 1, 200) AS snippet,
         0 AS rank
       FROM message_index
       WHERE ${where}
       ORDER BY timestamp DESC
       LIMIT @limit`,
    )
    .all(params) as SearchResultRow[];
}

// ---------------------------------------------------------------------------
// Content text extraction (shared with UI chat history parsers)
// ---------------------------------------------------------------------------

/**
 * Extract searchable text from an inbound message content JSON string.
 * Returns both the message text and email subject (if present).
 */
export function extractInboundText(content: string): string {
  try {
    const o = JSON.parse(content);
    if (typeof o === 'string') return o;
    const parts: string[] = [];
    if (typeof o?.subject === 'string') parts.push(o.subject);
    if (typeof o?.text === 'string') parts.push(o.text);
    return parts.join(' ');
  } catch {
    return content;
  }
}

/**
 * Extract searchable text from an outbound message content JSON string.
 */
export function extractOutboundText(content: string): string {
  try {
    const o = JSON.parse(content);
    if (typeof o === 'string') return o;
    if (typeof o?.text === 'string') return o.text;
    if (typeof o?.markdown === 'string') return o.markdown;
    return '';
  } catch {
    return content;
  }
}
