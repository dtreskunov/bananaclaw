/**
 * Two-DB connection layer.
 *
 * The session uses two SQLite files to eliminate write contention across
 * the host-container mount boundary:
 *
 *   inbound.db  — host writes new messages here; container opens READ-ONLY
 *   outbound.db — container writes responses + acks here; host opens read-only
 *
 * Each file has exactly one writer, so no cross-process lock contention.
 *
 * ⚠ Cross-mount visibility: inbound.db MUST be journal_mode=DELETE (set by
 * the host when the file is created). WAL's `-shm` is memory-mapped and
 * VirtioFS does not propagate mmap coherency from host to guest, so a
 * WAL-mode inbound.db would leave this reader frozen on an early snapshot
 * and it would silently never see new host messages. See
 * src/session-manager.ts for the full set of cross-mount invariants and
 * scripts/sanity-live-poll.ts for the empirical validation.
 */
import { Database } from 'bun:sqlite';
import fs from 'fs';

const DEFAULT_INBOUND_PATH = '/workspace/inbound.db';
const DEFAULT_OUTBOUND_PATH = '/workspace/outbound.db';
const DEFAULT_HEARTBEAT_PATH = '/workspace/.heartbeat';
const DEFAULT_TURN_ENDED_PATH = '/workspace/.turn-ended';
const DEFAULT_ACTIVITY_PATH = '/workspace/.activity';

let _inbound: Database | null = null;
let _outbound: Database | null = null;
let _heartbeatPath: string = DEFAULT_HEARTBEAT_PATH;
let _turnEndedPath: string = DEFAULT_TURN_ENDED_PATH;
let _activityPath: string = DEFAULT_ACTIVITY_PATH;
let _testMode = false;

/**
 * Avoid all cached db reads; open inbound.db read-only with mmap and page cache disabled.
 *
 * Use this (not getInboundDb) for readers that need to see host-written rows
 * promptly — e.g. messages_in polling. Caller must .close() the returned
 * connection (try/finally).
 *
 * Needed for mounts where host writes don't reliably invalidate
 * SQLite's caches: virtiofs (Colima, Lima, Podman Machine, Apple
 * Container), NFS.
 *
 * Cost is microseconds per query, so safe for universal use.
 */
export function openInboundDb(): Database {
  // In test mode return a thin wrapper over the in-memory singleton.
  // Callers do try/finally { db.close() } — the wrapper no-ops close()
  // so the singleton survives for the rest of the test.
  if (_testMode && _inbound) {
    const db = _inbound;
    return { prepare: (sql: string) => db.prepare(sql), exec: (sql: string) => db.exec(sql), close: () => {} } as unknown as Database;
  }
  const db = new Database(DEFAULT_INBOUND_PATH, { readonly: true });
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec('PRAGMA mmap_size = 0');
  return db;
}

/**
 * Inbound DB — long-lived singleton, OK for tables the host writes once
 * at spawn and never again (destinations, session_routing). For
 * messages_in polling — where the host writes continuously and a stale
 * view causes the pollHandle hang — use `openInboundDb()` instead.
 */
export function getInboundDb(): Database {
  if (!_inbound) {
    _inbound = new Database(DEFAULT_INBOUND_PATH, { readonly: true });
    _inbound.exec('PRAGMA busy_timeout = 5000');
    _inbound.exec('PRAGMA mmap_size = 0');
  }
  return _inbound;
}

/** Outbound DB — container owns this file (sole writer). */
export function getOutboundDb(): Database {
  if (!_outbound) {
    _outbound = new Database(DEFAULT_OUTBOUND_PATH);
    _outbound.exec('PRAGMA journal_mode = DELETE');
    _outbound.exec('PRAGMA busy_timeout = 5000');
    _outbound.exec('PRAGMA foreign_keys = ON');
    // Lightweight forward-compat: session_state was added after the initial
    // v2 schema, so older session DBs don't have it. Create it on demand
    // instead of requiring a formal migration pass. Also handle the case
    // where an earlier revision of this table existed without updated_at —
    // ALTER TABLE to add any missing columns.
    _outbound.exec(`
      CREATE TABLE IF NOT EXISTS session_state (
        key        TEXT PRIMARY KEY,
        value      TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
    const cols = new Set(
      (_outbound.prepare("PRAGMA table_info('session_state')").all() as Array<{ name: string }>).map((c) => c.name),
    );
    if (!cols.has('updated_at')) {
      _outbound.exec(`ALTER TABLE session_state ADD COLUMN updated_at TEXT NOT NULL DEFAULT ''`);
    }
    // turn_usage: per-turn provider usage snapshots (cost, tokens, model).
    // Forward-compat for older outbound.db files.
    _outbound.exec(`
      CREATE TABLE IF NOT EXISTS turn_usage (
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
        timestamp           TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
    // container_state: tracks the current tool in flight (if any) so the host
    // sweep can widen its stuck tolerance when Bash is running with a user-
    // declared long timeout. Forward-compat for older outbound.db files.
    _outbound.exec(`
      CREATE TABLE IF NOT EXISTS container_state (
        id                       INTEGER PRIMARY KEY CHECK (id = 1),
        current_tool             TEXT,
        tool_declared_timeout_ms INTEGER,
        tool_started_at          TEXT,
        updated_at               TEXT NOT NULL
      );
    `);
    // task_attempts: durable execution outcome for each task occurrence.
    // The container is the sole writer; the host reads it for recurrence
    // policy and the task UI. Created lazily for existing sessions.
    _outbound.exec(`
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
    `);
    // turn_activity: the ordered progress trace for a turn (one row per
    // step), persisted at turn end so the web UI can show the full activity
    // trace on historical messages, not just live. Linked to the turn's last
    // outbound row via message_out_id; ordered by `ordinal` (append order) —
    // timestamps are display-only and CAN collide, so never sort/key by them.
    // Forward-compat for older outbound.db files.
    _outbound.exec(`
      CREATE TABLE IF NOT EXISTS turn_activity (
        message_out_id TEXT NOT NULL,
        ordinal        INTEGER NOT NULL,
        ts             TEXT NOT NULL,
        text           TEXT NOT NULL,
        PRIMARY KEY (message_out_id, ordinal)
      );
    `);
    // turn_checkpoints: the provider-private handle for the turn behind each
    // outbound row, with the continuation it was minted under. Read by the
    // host when forking a thread to cut the provider's own session at the
    // branch point. Forward-compat for older outbound.db files.
    _outbound.exec(`
      CREATE TABLE IF NOT EXISTS turn_checkpoints (
        message_out_id    TEXT PRIMARY KEY,
        provider          TEXT NOT NULL,
        continuation      TEXT NOT NULL,
        provider_turn_ref TEXT NOT NULL,
        created_at        TEXT NOT NULL
      );
    `);
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
    .run(tool, declaredTimeoutMs, now, now);
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
 * Touch the heartbeat file — replaces the old touchProcessing() DB writes.
 * The host checks this file's mtime for stale container detection.
 * A file touch is cheaper and avoids cross-boundary DB write contention.
 */
export function touchHeartbeat(): void {
  const p = _heartbeatPath;
  const now = new Date();
  try {
    fs.utimesSync(p, now, now);
  } catch {
    try {
      fs.writeFileSync(p, '');
    } catch {
      // Silently ignore — parent dir may not exist (e.g., in-memory test DBs)
    }
  }
}

/**
 * Append one progress line to the append-only `.activity` file.
 *
 * This file accumulates every progress line for the current turn so the
 * host can forward the *full* ordered trace to the web UI (and derive the
 * single latest typing hint as the last line — there is no separate
 * `.progress` file). Each line is `<epochMs>\t<text>`, where `text` is a
 * JSON-encoded ActivityStep (JSON escapes newlines, so the line format holds
 * even for multi-line tool arguments). The timestamp is the emit time.
 * File-based signaling (not outbound.db) avoids lock contention with the MCP
 * subprocess — both share outbound.db with journal_mode=DELETE (exclusive
 * locks). Cleared at each turn start.
 *
 * The newline-strip below is defensive only: callers pass single-line JSON,
 * but stripping any stray newline keeps the one-line-per-step invariant that
 * the host reader relies on.
 */
export function appendActivityFile(line: string): void {
  try {
    fs.appendFileSync(_activityPath, line.replace(/\r?\n/g, ' ') + '\n');
  } catch {
    // Best-effort — same as touchHeartbeat.
  }
}

export function clearActivityFile(): void {
  try {
    fs.unlinkSync(_activityPath);
  } catch {
    // Already gone or parent dir missing — fine.
  }
}

/**
 * Write the turn-ended marker to a file. The host reads the file's content
 * (epoch ms string) to detect when the agent finishes a turn.
 */
export function writeTurnEndedFile(epochMs: string): void {
  try {
    fs.writeFileSync(_turnEndedPath, epochMs);
  } catch {
    // Best-effort.
  }
}

export function clearTurnEndedFile(): void {
  try {
    fs.unlinkSync(_turnEndedPath);
  } catch {
    // Already gone or parent dir missing — fine.
  }
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
export function initTestSessionDb(): { inbound: Database; outbound: Database } {
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
      ))
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

  return { inbound: _inbound, outbound: _outbound };
}

export function closeSessionDb(): void {
  _inbound?.close();
  _inbound = null;
  _testMode = false;
  _outbound?.close();
  _outbound = null;
}

/**
 * @deprecated Use getInboundDb() / getOutboundDb() instead.
 * Kept for backward compatibility during migration.
 */
export function getSessionDb(): Database {
  return getInboundDb();
}
