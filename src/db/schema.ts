/** Central DDL is authoritative in migrations; these are the host session stores. */
import { TURN_ACTIVITY_SCHEMA, TURN_INDEX_SCHEMA, TURN_SCHEMA } from './turns.js';
import { INBOUND_THREAD_SUMMARY_SCHEMA, OUTBOUND_THREAD_SUMMARY_SCHEMA } from './thread-summary-schema.js';
import { epochSchema } from './storage-lifecycle.js';

/**
 * Session DB schemas — split into two files so each has exactly one writer.
 * This eliminates SQLite write contention across the host-container mount boundary.
 *
 *   inbound.db  — private host input + pending host event journal
 *   outbound.db — private host projection of validated runner events
 */

/** Host-owned: inbound messages + delivery tracking + destination map. */
export const INBOUND_SCHEMA = epochSchema(`
CREATE TABLE IF NOT EXISTS host_sequence (
  id        INTEGER PRIMARY KEY CHECK (id = 1),
  last_even INTEGER NOT NULL CHECK (last_even >= 0 AND last_even % 2 = 0)
);
INSERT OR IGNORE INTO host_sequence (id, last_even) VALUES (1, 0);

CREATE TABLE IF NOT EXISTS messages_in (
  id             TEXT PRIMARY KEY,
  seq            INTEGER UNIQUE,
  kind           TEXT NOT NULL,
  timestamp      TEXT NOT NULL,
  status         TEXT DEFAULT 'pending',
  process_after  TEXT,
  recurrence     TEXT,
  series_id      TEXT,
  tries          INTEGER DEFAULT 0,
  trigger        INTEGER NOT NULL DEFAULT 1,
                 -- 0 = accumulated context (don't wake), 1 = wake agent
  platform_id    TEXT,
  channel_type   TEXT,
  thread_id      TEXT,
  content        TEXT NOT NULL,
  -- For agent-to-agent inbound rows: the source session that emitted the
  -- triggering outbound. Used as a return path when the target replies —
  -- the reply routes back to this exact session, not to the source agent
  -- group's "newest" session. NULL on channel-side inbound and on a2a rows
  -- written before this column existed.
  source_session_id TEXT,
  on_wake        INTEGER NOT NULL DEFAULT 0,
               -- 1 = only deliver on the container's first poll (fresh start).
               -- Dying containers (past first poll) skip these rows.
  -- Canonical UUID of the sender (central users.id). Null when the
  -- inbound row has no resolvable sender (system messages, scheduled
  -- tasks, agent-to-agent). Authoritative source for the container's
  -- formatter -- replaces the legacy "channel_type:raw" synthesis
  -- from message content. No FK because users lives in the central DB,
  -- not in this per-session file; the CHECK below catches obvious
  -- shape mismatches at the schema level. Host writers also validate
  -- before insert (see insertMessage in session-db.ts).
  sender_user_id TEXT CHECK (sender_user_id IS NULL OR (
    length(sender_user_id) = 36
    AND substr(sender_user_id, 9, 1) = '-'
    AND substr(sender_user_id, 14, 1) = '-'
    AND substr(sender_user_id, 19, 1) = '-'
    AND substr(sender_user_id, 24, 1) = '-'
  )),
  -- Namespaced channel identity observed on the inbound payload. This is
  -- preserved even when it cannot be linked to a canonical users.id row.
  sender_identity TEXT
);
CREATE INDEX IF NOT EXISTS idx_messages_in_series ON messages_in(series_id);
CREATE INDEX IF NOT EXISTS idx_messages_in_pending_wake ON messages_in(process_after,seq)
  WHERE status='pending' AND trigger=1 AND kind!='system';

-- Host tracks delivery outcomes for messages_out IDs.
-- Keeps channel delivery receipts with the host-owned inbound routing state.
CREATE TABLE IF NOT EXISTS delivered (
  message_out_id      TEXT PRIMARY KEY,
  platform_message_id TEXT,
  status              TEXT NOT NULL DEFAULT 'delivered',
  delivered_at        TEXT NOT NULL
);

-- Destination map for this session's agent.
-- Host overwrites on every container wake AND on demand (rewires, new child
-- agents, etc.). Container queries this live on every lookup, so changes
-- take effect mid-session without requiring a container restart.
CREATE TABLE IF NOT EXISTS destinations (
  name            TEXT PRIMARY KEY,
  display_name    TEXT,
  type            TEXT NOT NULL,   -- 'channel' | 'agent'
  channel_type    TEXT,            -- for type='channel'
  platform_id     TEXT,            -- for type='channel'
  agent_group_id  TEXT             -- for type='agent'
);

-- Default reply routing for this session. Single-row table (id=1).
-- Host overwrites on every container wake from the session's messaging_group
-- and thread_id. The session link projects it for send_message / ask_user_question to
-- default the channel/thread of outbound messages when the agent doesn't
-- specify an explicit destination.
CREATE TABLE IF NOT EXISTS session_routing (
  id           INTEGER PRIMARY KEY CHECK (id = 1),
  channel_type TEXT,
  platform_id  TEXT,
  thread_id    TEXT
);

-- Host-owned metadata for logical threads. Shared sessions may contain many
-- routing tuples, while per-thread sessions normally contain exactly one.
CREATE TABLE IF NOT EXISTS thread_titles (
  channel_type       TEXT NOT NULL,
  platform_id        TEXT NOT NULL DEFAULT '',
  thread_id          TEXT NOT NULL DEFAULT '',
  title              TEXT NOT NULL,
  source             TEXT NOT NULL DEFAULT 'model',
  request_message_id TEXT NOT NULL,
  published          INTEGER NOT NULL DEFAULT 0,
  updated_at         TEXT NOT NULL,
  PRIMARY KEY (channel_type, platform_id, thread_id)
);

-- Present only in sessions created by forking another thread. Single-row
-- (id=1), written by the host before the session row exists, read once by the
-- container on its first poll to seed the agent's memory of the parent.
--
-- The digest column is always populated: it is the fallback whenever a native
-- provider fork isn't possible (no forkContinuation, no anchor, provider
-- changed since the fork, or the fork call failed), so every degradation path
-- still yields a working thread.
CREATE TABLE IF NOT EXISTS fork_origin (
  id                  INTEGER PRIMARY KEY CHECK (id = 1),
  parent_session_id   TEXT NOT NULL,
  parent_continuation TEXT,
  provider            TEXT NOT NULL,
  anchor_ref          TEXT,
  digest              TEXT NOT NULL,
  created_at          TEXT NOT NULL
);

-- Ordered host-to-runner journal. The host is the sole writer and removes a
-- row only after the runner commits it to runner-state.db and ACKs over the
-- session link.
CREATE TABLE IF NOT EXISTS pending_host_events (
  sequence   INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id   TEXT NOT NULL UNIQUE,
  event_type TEXT NOT NULL,
  payload    TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TRIGGER IF NOT EXISTS journal_host_sequence_update
AFTER UPDATE OF last_even ON host_sequence BEGIN
  INSERT INTO pending_host_events (event_id, event_type, payload, created_at)
  VALUES (lower(hex(randomblob(16))), 'sequence.floor',
    json_object('seq', NEW.last_even), datetime('now'));
END;

CREATE TRIGGER IF NOT EXISTS journal_message_in_insert
AFTER INSERT ON messages_in BEGIN
  INSERT INTO pending_host_events (event_id, event_type, payload, created_at)
  VALUES (lower(hex(randomblob(16))), 'message.upsert', json_object(
    'id', NEW.id, 'seq', NEW.seq, 'kind', NEW.kind,
    'timestamp', NEW.timestamp, 'status', NEW.status,
    'process_after', NEW.process_after, 'recurrence', NEW.recurrence,
    'series_id', NEW.series_id, 'tries', NEW.tries, 'trigger', NEW.trigger,
    'platform_id', NEW.platform_id, 'channel_type', NEW.channel_type,
    'thread_id', NEW.thread_id, 'content_hex', hex(CAST(NEW.content AS BLOB)),
    'source_session_id', NEW.source_session_id, 'on_wake', NEW.on_wake,
    'sender_user_id', NEW.sender_user_id, 'sender_identity', NEW.sender_identity
  ), datetime('now'));
END;

CREATE TRIGGER IF NOT EXISTS journal_message_in_update
AFTER UPDATE ON messages_in BEGIN
  INSERT INTO pending_host_events (event_id, event_type, payload, created_at)
  VALUES (lower(hex(randomblob(16))), 'message.upsert', json_object(
    'id', NEW.id, 'seq', NEW.seq, 'kind', NEW.kind,
    'timestamp', NEW.timestamp, 'status', NEW.status,
    'process_after', NEW.process_after, 'recurrence', NEW.recurrence,
    'series_id', NEW.series_id, 'tries', NEW.tries, 'trigger', NEW.trigger,
    'platform_id', NEW.platform_id, 'channel_type', NEW.channel_type,
    'thread_id', NEW.thread_id, 'content_hex', hex(CAST(NEW.content AS BLOB)),
    'source_session_id', NEW.source_session_id, 'on_wake', NEW.on_wake,
    'sender_user_id', NEW.sender_user_id, 'sender_identity', NEW.sender_identity
  ), datetime('now'));
END;

CREATE TRIGGER IF NOT EXISTS journal_message_in_delete
AFTER DELETE ON messages_in BEGIN
  INSERT INTO pending_host_events (event_id, event_type, payload, created_at)
  VALUES (lower(hex(randomblob(16))), 'message.delete',
    json_object('id', OLD.id), datetime('now'));
END;

CREATE TRIGGER IF NOT EXISTS journal_fork_origin_insert
AFTER INSERT ON fork_origin BEGIN
  INSERT INTO pending_host_events (event_id, event_type, payload, created_at)
  VALUES (lower(hex(randomblob(16))), 'fork.upsert', json_object(
    'id', NEW.id, 'parent_session_id', NEW.parent_session_id,
    'parent_continuation', NEW.parent_continuation, 'provider', NEW.provider,
    'anchor_ref', NEW.anchor_ref, 'digest', NEW.digest, 'created_at', NEW.created_at
  ), datetime('now'));
END;

CREATE TRIGGER IF NOT EXISTS journal_fork_origin_update
AFTER UPDATE ON fork_origin BEGIN
  INSERT INTO pending_host_events (event_id, event_type, payload, created_at)
  VALUES (lower(hex(randomblob(16))), 'fork.upsert', json_object(
    'id', NEW.id, 'parent_session_id', NEW.parent_session_id,
    'parent_continuation', NEW.parent_continuation, 'provider', NEW.provider,
    'anchor_ref', NEW.anchor_ref, 'digest', NEW.digest, 'created_at', NEW.created_at
  ), datetime('now'));
END;

CREATE TRIGGER IF NOT EXISTS journal_thread_title_insert
AFTER INSERT ON thread_titles BEGIN
  INSERT INTO pending_host_events (event_id, event_type, payload, created_at)
  VALUES (lower(hex(randomblob(16))), 'thread-title.upsert', json_object(
    'channel_type', NEW.channel_type, 'platform_id', NEW.platform_id,
    'thread_id', NEW.thread_id, 'title', NEW.title, 'source', NEW.source,
    'request_message_id', NEW.request_message_id, 'published', NEW.published,
    'updated_at', NEW.updated_at
  ), datetime('now'));
END;

CREATE TRIGGER IF NOT EXISTS journal_thread_title_update
AFTER UPDATE ON thread_titles BEGIN
  INSERT INTO pending_host_events (event_id, event_type, payload, created_at)
  VALUES (lower(hex(randomblob(16))), 'thread-title.upsert', json_object(
    'channel_type', NEW.channel_type, 'platform_id', NEW.platform_id,
    'thread_id', NEW.thread_id, 'title', NEW.title, 'source', NEW.source,
    'request_message_id', NEW.request_message_id, 'published', NEW.published,
    'updated_at', NEW.updated_at
  ), datetime('now'));
END;

CREATE TRIGGER IF NOT EXISTS journal_thread_title_delete
AFTER DELETE ON thread_titles BEGIN
  INSERT INTO pending_host_events (event_id, event_type, payload, created_at)
  VALUES (lower(hex(randomblob(16))), 'thread-title.delete', json_object(
    'channel_type', OLD.channel_type, 'platform_id', OLD.platform_id,
    'thread_id', OLD.thread_id
  ), datetime('now'));
END;
${INBOUND_THREAD_SUMMARY_SCHEMA}
`);

/** Host-owned projection of durable runner output and state. */
const OUTBOUND_BASE_SCHEMA = `
CREATE TABLE IF NOT EXISTS messages_out (
  id             TEXT PRIMARY KEY,
  seq            INTEGER UNIQUE,
  in_reply_to    TEXT,
  timestamp      TEXT NOT NULL,
  deliver_after  TEXT,
  recurrence     TEXT,
  kind           TEXT NOT NULL,
  platform_id    TEXT,
  channel_type   TEXT,
  thread_id      TEXT,
  content        TEXT NOT NULL,
  turn_id        TEXT REFERENCES turns(id)
);

-- Host projects runner processing status here instead of allowing the
-- container to update messages_in.
-- On container startup, stale 'processing' entries are cleared (crash recovery).
CREATE TABLE IF NOT EXISTS processing_ack (
  message_id     TEXT PRIMARY KEY,
  status         TEXT NOT NULL,
  status_changed TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_out_delivery_order ON messages_out(timestamp,id);

-- Persistent key/value state owned by the container. Used (among other things)
-- to store the SDK session ID so the agent's conversation resumes across
-- container restarts. Cleared by /clear.
CREATE TABLE IF NOT EXISTS session_state (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Current tool-in-flight state. Single-row table (id=1). Runner events update
-- it on PreToolUse / PostToolUse; host sweep reads it to
-- sweep to extend the stuck-tolerance window when Bash is running with a
-- declared timeout > 60s (long-running scripts shouldn't be flagged as stuck).
CREATE TABLE IF NOT EXISTS container_state (
  id                       INTEGER PRIMARY KEY CHECK (id = 1),
  current_tool             TEXT,
  tool_declared_timeout_ms INTEGER,
  tool_started_at          TEXT,
  updated_at               TEXT NOT NULL
);

-- Provider continuation metadata for forking a thread at an outbound turn.
CREATE TABLE IF NOT EXISTS turn_checkpoints (
  message_out_id    TEXT PRIMARY KEY,
  provider          TEXT NOT NULL,
  continuation      TEXT NOT NULL,
  provider_turn_ref TEXT NOT NULL,
  created_at        TEXT NOT NULL
);

-- Ordered progress trace persisted at turn end for historical display.
${TURN_ACTIVITY_SCHEMA}

-- Per-turn provider usage linked to the final outbound message.
CREATE TABLE IF NOT EXISTS turn_usage (
  id                  TEXT PRIMARY KEY,
  message_out_id      TEXT,
  turn_id             TEXT REFERENCES turns(id),
  cost_usd            REAL,
  input_tokens        INTEGER,
  output_tokens       INTEGER,
  cache_read_tokens   INTEGER,
  cache_write_tokens  INTEGER,
  reasoning_tokens    INTEGER,
  num_turns           INTEGER,
  duration_ms         INTEGER,
  duration_api_ms     INTEGER,
  model               TEXT,
  context_window      INTEGER,
  max_output_tokens   INTEGER,
  context_tokens      INTEGER,
  timestamp           TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Durable outcome for each scheduled-task occurrence. The task message ID is
-- unique per scheduled or manual firing; series_id ties recurring attempts
-- back to the stable task handle shown to users.
CREATE TABLE IF NOT EXISTS task_attempts (
  task_message_id  TEXT PRIMARY KEY,
  series_id        TEXT NOT NULL,
  trigger_source   TEXT NOT NULL,
  status           TEXT NOT NULL,
  started_at       TEXT NOT NULL,
  completed_at     TEXT,
  duration_ms      INTEGER,
  exit_code        INTEGER,
  signal           TEXT,
  stdout           TEXT,
  stderr           TEXT,
  error             TEXT,
  wake_agent       INTEGER,
  provider_invoked INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_task_attempts_series_started
  ON task_attempts(series_id, started_at DESC);

CREATE TABLE IF NOT EXISTS applied_runner_events (
  event_id   TEXT PRIMARY KEY,
  sequence   INTEGER NOT NULL UNIQUE,
  event_type TEXT NOT NULL,
  event_digest TEXT NOT NULL,
  applied_at TEXT NOT NULL
);
`;

export const OUTBOUND_SCHEMA = epochSchema(TURN_SCHEMA + OUTBOUND_BASE_SCHEMA + TURN_INDEX_SCHEMA + OUTBOUND_THREAD_SUMMARY_SCHEMA);
