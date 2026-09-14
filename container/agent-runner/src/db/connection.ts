/**
 * Runner session storage connections.
 *
 * The runner opens only runner-state.db. Host events are committed into its
 * local projection over the session link before ACK; runner mutations are
 * journaled in the same file and projected back to the host after ACK.
 */
import { Database } from 'bun:sqlite';
import fs from 'node:fs';
import { ensureRunnerStateSchema } from './runner-state.js';

const DEFAULT_RUNNER_STATE_PATH = '/workspace/runner-state/runner-state.db';
const MAX_DECLARED_TOOL_TIMEOUT_MS = 6 * 60 * 60 * 1000;

let _inbound: Database | null = null;
let _outbound: Database | null = null;
let _testMode = false;

/**
 * Compatibility wrapper for callers that own a short-lived read handle.
 * Production reads use the runner-state singleton; close() is intentionally
 * a no-op because the session link shares that connection.
 */
export function openInboundDb(): Database {
  const db = _testMode && _inbound ? _inbound : getOutboundDb();
  return {
    prepare: (sql: string) => db.prepare(sql),
    exec: (sql: string) => db.exec(sql),
    close: () => {},
  } as unknown as Database;
}

/**
 * Host-state projection in the runner-owned database.
 */
export function getInboundDb(): Database {
  if (_testMode && _inbound) return _inbound;
  return getOutboundDb();
}

/** Runner-private projection and durable event journal. */
export function getOutboundDb(): Database {
  if (!_outbound) {
    if (!_testMode && !fs.existsSync(DEFAULT_RUNNER_STATE_PATH)) {
      throw new Error('runner-state.db is missing; refusing to reset durable session state');
    }
    _outbound = new Database(DEFAULT_RUNNER_STATE_PATH);
    _outbound.exec('PRAGMA journal_mode = DELETE');
    _outbound.exec('PRAGMA busy_timeout = 5000');
    _outbound.exec('PRAGMA foreign_keys = ON');
    ensureRunnerStateSchema(_outbound);
  }
  return _outbound;
}

/**
 * Record that a tool is starting. `declaredTimeoutMs` is the tool's own
 * timeout hint when one is available (Bash exposes it in the tool_use input);
 * omit for tools with no declared timeout.
 */
export function setContainerToolInFlight(tool: string, declaredTimeoutMs: number | null): void {
  const now = new Date().toISOString();
  const boundedTimeoutMs =
    declaredTimeoutMs !== null && Number.isFinite(declaredTimeoutMs) && declaredTimeoutMs >= 0
      ? Math.min(Math.floor(declaredTimeoutMs), MAX_DECLARED_TOOL_TIMEOUT_MS)
      : null;
  getOutboundDb()
    .prepare(
      `INSERT INTO container_state (id, current_tool, tool_declared_timeout_ms, tool_started_at, updated_at)
       VALUES (1, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         current_tool = excluded.current_tool,
         tool_declared_timeout_ms = excluded.tool_declared_timeout_ms,
         tool_started_at = excluded.tool_started_at,
         updated_at = excluded.updated_at`,
    )
    .run(tool.slice(0, 256), boundedTimeoutMs, now, now);
}

/** Clear the in-flight tool — called on PostToolUse / PostToolUseFailure. */
export function clearContainerToolInFlight(): void {
  const now = new Date().toISOString();
  getOutboundDb()
    .prepare(
      `INSERT INTO container_state (id, current_tool, tool_declared_timeout_ms, tool_started_at, updated_at)
       VALUES (1, NULL, NULL, NULL, ?)
       ON CONFLICT(id) DO UPDATE SET
         current_tool = NULL,
         tool_declared_timeout_ms = NULL,
         tool_started_at = NULL,
         updated_at = excluded.updated_at`,
    )
    .run(now);
}

/**
 * Clear stale processing_ack entries on container startup.
 * If the previous container crashed, 'processing' entries are leftover.
 * Clearing them lets the new container re-process those messages.
 */
export function clearStaleProcessingAcks(): void {
  getOutboundDb().prepare("DELETE FROM processing_ack WHERE status = 'processing'").run();
}

/** For tests — creates in-memory DBs with the session schemas. */
export function initTestSessionDb(options: { unifiedHostProjection?: boolean } = {}): {
  inbound: Database;
  outbound: Database;
} {
  _testMode = true;
  _inbound = new Database(':memory:');
  _inbound.exec('PRAGMA foreign_keys = ON');
  _inbound.exec(`
    CREATE TABLE messages_in (
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
      platform_id    TEXT,
      channel_type   TEXT,
      thread_id      TEXT,
      content        TEXT NOT NULL,
      on_wake        INTEGER NOT NULL DEFAULT 0,
      sender_user_id TEXT CHECK (sender_user_id IS NULL OR (
        length(sender_user_id) = 36
        AND substr(sender_user_id, 9, 1) = '-'
        AND substr(sender_user_id, 14, 1) = '-'
        AND substr(sender_user_id, 19, 1) = '-'
        AND substr(sender_user_id, 24, 1) = '-'
      )),
      sender_identity TEXT
    );
    CREATE TABLE delivered (
      message_out_id      TEXT PRIMARY KEY,
      platform_message_id TEXT,
      status              TEXT NOT NULL DEFAULT 'delivered',
      delivered_at        TEXT NOT NULL
    );
    CREATE TABLE destinations (
      name            TEXT PRIMARY KEY,
      display_name    TEXT,
      type            TEXT NOT NULL,
      channel_type    TEXT,
      platform_id     TEXT,
      agent_group_id  TEXT
    );
    CREATE TABLE session_routing (
      id           INTEGER PRIMARY KEY CHECK (id = 1),
      channel_type TEXT,
      platform_id  TEXT,
      thread_id    TEXT
    );
    CREATE TABLE thread_titles (
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
    CREATE TABLE fork_origin (
      id                  INTEGER PRIMARY KEY CHECK (id = 1),
      parent_session_id   TEXT NOT NULL,
      parent_continuation TEXT,
      provider            TEXT,
      anchor_ref          TEXT,
      digest              TEXT NOT NULL,
      created_at          TEXT NOT NULL
    );
  `);

  _outbound = new Database(':memory:');
  _outbound.exec('PRAGMA foreign_keys = ON');
  _outbound.exec(`
    CREATE TABLE messages_out (
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
      content        TEXT NOT NULL
    );
    CREATE TABLE processing_ack (
      message_id     TEXT PRIMARY KEY,
      status         TEXT NOT NULL,
      status_changed TEXT NOT NULL
    );
    CREATE TABLE session_state (
      key        TEXT PRIMARY KEY,
      value      TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE container_state (
      id                       INTEGER PRIMARY KEY CHECK (id = 1),
      current_tool             TEXT,
      tool_declared_timeout_ms INTEGER,
      tool_started_at          TEXT,
      updated_at               TEXT NOT NULL
    );
    CREATE TABLE turn_checkpoints (
      message_out_id    TEXT PRIMARY KEY,
      provider          TEXT NOT NULL,
      continuation      TEXT NOT NULL,
      provider_turn_ref TEXT NOT NULL,
      created_at        TEXT NOT NULL
    );
    CREATE TABLE turn_activity (
      message_out_id TEXT NOT NULL,
      ordinal        INTEGER NOT NULL,
      ts             TEXT NOT NULL,
      text           TEXT NOT NULL,
      PRIMARY KEY (message_out_id, ordinal)
    );
    CREATE TABLE turn_usage (
      id                  TEXT PRIMARY KEY,
      message_out_id      TEXT,
      cost_usd            REAL,
      input_tokens        INTEGER,
      output_tokens        INTEGER,
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
    CREATE TABLE task_attempts (
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
    CREATE INDEX idx_task_attempts_series_started
      ON task_attempts(series_id, started_at DESC);
  `);
  ensureRunnerStateSchema(_outbound);

  if (options.unifiedHostProjection) {
    _inbound.close();
    _inbound = _outbound;
  }

  return { inbound: _inbound, outbound: _outbound };
}

export function closeSessionDb(): void {
  if (_inbound && _inbound !== _outbound) _inbound.close();
  _inbound = null;
  _testMode = false;
  _outbound?.close();
  _outbound = null;
}
