import type { Database } from 'bun:sqlite';
import { TURN_ACTIVITY_SCHEMA, TURN_INDEX_SCHEMA, TURN_SCHEMA } from './turns.js';
import { assertStorageVersion, STORAGE_VERSION, EPOCH_NOW_SQL } from './storage-lifecycle.js';

export interface PendingRunnerEvent {
  event_id: string;
  sequence: number;
  event_type: string;
  payload: string;
}

const enqueue = (eventType: string, payload: string): string => `
  INSERT INTO pending_runner_events (event_id, event_type, payload, created_at)
  VALUES (lower(hex(randomblob(16))), '${eventType}', ${payload}, ${EPOCH_NOW_SQL});
`;

export function ensureRunnerStateSchema(db: Database): void {
  assertStorageVersion(db, 'runner-state');
  db.transaction(() => {
    applyRunnerStateSchema(db);
    db.exec(`PRAGMA user_version=${STORAGE_VERSION}`);
  })();
}

function applyRunnerStateSchema(db: Database): void {
  db.exec(TURN_SCHEMA);
  db.exec(TURN_ACTIVITY_SCHEMA);
  const columns = db.prepare('PRAGMA table_info(turn_activity)').all() as Array<{ name: string; notnull: number }>;
  if (!columns.some((column) => column.name === 'timeline_position' && column.notnull === 1)) {
    throw new Error(
      'Unsupported activity-order schema: turn_activity.timeline_position must be NOT NULL. See docs/ui.md#activity-order-storage.',
    );
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS messages_in (
      id TEXT PRIMARY KEY,
      seq INTEGER UNIQUE,
      kind TEXT NOT NULL,
      timestamp INTEGER CHECK (timestamp IS NULL OR typeof(timestamp)='integer') NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      process_after INTEGER CHECK (process_after IS NULL OR typeof(process_after)='integer'),
      recurrence TEXT,
      series_id TEXT,
      tries INTEGER NOT NULL DEFAULT 0,
      trigger INTEGER NOT NULL DEFAULT 1,
      platform_id TEXT,
      channel_type TEXT,
      thread_id TEXT,
      content TEXT NOT NULL,
      source_session_id TEXT,
      on_wake INTEGER NOT NULL DEFAULT 0,
      sender_user_id TEXT,
      sender_identity TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_runner_messages_in_series ON messages_in(series_id);
    CREATE INDEX IF NOT EXISTS idx_runner_messages_in_pending_seq ON messages_in(seq)
      WHERE status='pending';
    CREATE TABLE IF NOT EXISTS destinations (
      name TEXT PRIMARY KEY,
      display_name TEXT,
      type TEXT NOT NULL,
      channel_type TEXT,
      platform_id TEXT,
      agent_group_id TEXT
    );
    CREATE TABLE IF NOT EXISTS session_routing (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      channel_type TEXT,
      platform_id TEXT,
      thread_id TEXT
    );
    CREATE TABLE IF NOT EXISTS fork_origin (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      parent_session_id TEXT NOT NULL,
      parent_continuation TEXT,
      provider TEXT NOT NULL,
      anchor_ref TEXT,
      digest TEXT NOT NULL,
      created_at INTEGER CHECK (created_at IS NULL OR typeof(created_at)='integer') NOT NULL
    );
    CREATE TABLE IF NOT EXISTS thread_titles (
      channel_type TEXT NOT NULL,
      platform_id TEXT NOT NULL DEFAULT '',
      thread_id TEXT NOT NULL DEFAULT '',
      title TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'model',
      request_message_id TEXT NOT NULL,
      published INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER CHECK (updated_at IS NULL OR typeof(updated_at)='integer') NOT NULL,
      PRIMARY KEY (channel_type, platform_id, thread_id)
    );
    CREATE TABLE IF NOT EXISTS host_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS applied_host_events (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      last_sequence INTEGER NOT NULL
    );
    INSERT OR IGNORE INTO applied_host_events (id, last_sequence) VALUES (1, 0);
    CREATE TABLE IF NOT EXISTS messages_out (
      id TEXT PRIMARY KEY,
      seq INTEGER UNIQUE,
      in_reply_to TEXT,
      timestamp INTEGER CHECK (timestamp IS NULL OR typeof(timestamp)='integer') NOT NULL,
      deliver_after INTEGER CHECK (deliver_after IS NULL OR typeof(deliver_after)='integer'),
      recurrence TEXT,
      kind TEXT NOT NULL,
      platform_id TEXT,
      channel_type TEXT,
      thread_id TEXT,
      content TEXT NOT NULL,
      turn_id TEXT REFERENCES turns(id)
    );
    CREATE TABLE IF NOT EXISTS processing_ack (
      message_id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      status_changed INTEGER CHECK (status_changed IS NULL OR typeof(status_changed)='integer') NOT NULL
    );
    CREATE TABLE IF NOT EXISTS claimed_inputs (
      message_id TEXT PRIMARY KEY
    );
    CREATE TABLE IF NOT EXISTS timeline_clock (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      position INTEGER NOT NULL CHECK (position >= 0 AND position <= 9007199254740991)
    );
    CREATE TABLE IF NOT EXISTS session_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER CHECK (updated_at IS NULL OR typeof(updated_at)='integer') NOT NULL
    );
    INSERT INTO timeline_clock (id, position)
    SELECT 1, COALESCE(MAX(position), 0) FROM (
      SELECT CASE WHEN json_valid(content) THEN json_extract(content, '$.timelinePosition') END AS position
      FROM messages_out
      UNION ALL
      SELECT CASE WHEN json_valid(value) THEN json_extract(value, '$.timelinePosition') END AS position
      FROM session_state WHERE key LIKE 'input:%'
      UNION ALL
      SELECT timeline_position FROM turn_activity
    )
    WHERE typeof(position) = 'integer' AND position BETWEEN 1 AND 9007199254740991
    ON CONFLICT(id) DO UPDATE SET position = MAX(timeline_clock.position, excluded.position);
    CREATE TABLE IF NOT EXISTS container_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      current_tool TEXT,
      tool_declared_timeout_ms INTEGER,
      tool_started_at INTEGER CHECK (tool_started_at IS NULL OR typeof(tool_started_at)='integer'),
      updated_at INTEGER CHECK (updated_at IS NULL OR typeof(updated_at)='integer') NOT NULL
    );
    CREATE TABLE IF NOT EXISTS turn_checkpoints (
      message_out_id TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      continuation TEXT NOT NULL,
      provider_turn_ref TEXT NOT NULL,
      created_at INTEGER CHECK (created_at IS NULL OR typeof(created_at)='integer') NOT NULL
    );
    CREATE TABLE IF NOT EXISTS turn_usage (
      id TEXT PRIMARY KEY,
      message_out_id TEXT,
      turn_id TEXT REFERENCES turns(id),
      cost_usd REAL,
      input_tokens INTEGER,
      output_tokens INTEGER,
      cache_read_tokens INTEGER,
      cache_write_tokens INTEGER,
      reasoning_tokens INTEGER,
      num_turns INTEGER,
      duration_ms INTEGER,
      duration_api_ms INTEGER,
      model TEXT,
      context_window INTEGER,
      max_output_tokens INTEGER,
      context_tokens INTEGER,
      timestamp INTEGER CHECK (timestamp IS NULL OR typeof(timestamp)='integer') NOT NULL DEFAULT (${EPOCH_NOW_SQL})
    );
    CREATE TABLE IF NOT EXISTS task_attempts (
      task_message_id TEXT PRIMARY KEY,
      series_id TEXT NOT NULL,
      trigger_source TEXT NOT NULL,
      status TEXT NOT NULL,
      started_at INTEGER CHECK (started_at IS NULL OR typeof(started_at)='integer') NOT NULL,
      completed_at INTEGER CHECK (completed_at IS NULL OR typeof(completed_at)='integer'),
      duration_ms INTEGER,
      exit_code INTEGER,
      signal TEXT,
      stdout TEXT,
      stderr TEXT,
      error TEXT,
      wake_agent INTEGER,
      provider_invoked INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_task_attempts_series_started
      ON task_attempts(series_id, started_at DESC);
    CREATE TABLE IF NOT EXISTS pending_runner_events (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id TEXT NOT NULL UNIQUE,
      event_type TEXT NOT NULL,
      payload TEXT NOT NULL,
      created_at INTEGER CHECK (created_at IS NULL OR typeof(created_at)='integer') NOT NULL
    );

    CREATE TRIGGER IF NOT EXISTS journal_message_out_insert
    AFTER INSERT ON messages_out BEGIN
      ${enqueue(
        'message.upsert',
        `json_object(
        'id', NEW.id, 'seq', NEW.seq, 'in_reply_to', NEW.in_reply_to,
        'timestamp', strftime('%Y-%m-%dT%H:%M:%fZ', NEW.timestamp/1000.0, 'unixepoch'), 'deliver_after', strftime('%Y-%m-%dT%H:%M:%fZ', NEW.deliver_after/1000.0, 'unixepoch'),
        'recurrence', NEW.recurrence, 'kind', NEW.kind,
        'platform_id', NEW.platform_id, 'channel_type', NEW.channel_type,
        'thread_id', NEW.thread_id, 'content', NEW.content, 'turn_id', NEW.turn_id
      )`,
      )}
    END;

    CREATE TRIGGER IF NOT EXISTS journal_processing_ack_insert
    AFTER INSERT ON processing_ack BEGIN
      ${enqueue(
        'processing.upsert',
        `json_object(
        'message_id', NEW.message_id, 'status', NEW.status,
        'status_changed', strftime('%Y-%m-%dT%H:%M:%fZ', NEW.status_changed/1000.0, 'unixepoch')
      )`,
      )}
    END;
    CREATE TRIGGER IF NOT EXISTS journal_processing_ack_update
    AFTER UPDATE ON processing_ack BEGIN
      ${enqueue(
        'processing.upsert',
        `json_object(
        'message_id', NEW.message_id, 'status', NEW.status,
        'status_changed', strftime('%Y-%m-%dT%H:%M:%fZ', NEW.status_changed/1000.0, 'unixepoch')
      )`,
      )}
    END;
    CREATE TRIGGER IF NOT EXISTS journal_processing_ack_delete
    AFTER DELETE ON processing_ack BEGIN
      ${enqueue('processing.delete', `json_object('message_id', OLD.message_id)`)}
    END;

    CREATE TRIGGER IF NOT EXISTS journal_session_state_insert
    AFTER INSERT ON session_state BEGIN
      ${enqueue(
        'state.upsert',
        `json_object(
        'key', NEW.key, 'value', NEW.value, 'updated_at', strftime('%Y-%m-%dT%H:%M:%fZ', NEW.updated_at/1000.0, 'unixepoch')
      )`,
      )}
    END;
    CREATE TRIGGER IF NOT EXISTS journal_session_state_update
    AFTER UPDATE ON session_state BEGIN
      ${enqueue(
        'state.upsert',
        `json_object(
        'key', NEW.key, 'value', NEW.value, 'updated_at', strftime('%Y-%m-%dT%H:%M:%fZ', NEW.updated_at/1000.0, 'unixepoch')
      )`,
      )}
    END;
    CREATE TRIGGER IF NOT EXISTS journal_session_state_delete
    AFTER DELETE ON session_state BEGIN
      ${enqueue('state.delete', `json_object('key', OLD.key)`)}
    END;

    CREATE TRIGGER IF NOT EXISTS journal_container_state_insert
    AFTER INSERT ON container_state BEGIN
      ${enqueue(
        'container.upsert',
        `json_object(
        'id', NEW.id, 'current_tool', NEW.current_tool,
        'tool_declared_timeout_ms', NEW.tool_declared_timeout_ms,
        'tool_started_at', strftime('%Y-%m-%dT%H:%M:%fZ', NEW.tool_started_at/1000.0, 'unixepoch'), 'updated_at', strftime('%Y-%m-%dT%H:%M:%fZ', NEW.updated_at/1000.0, 'unixepoch')
      )`,
      )}
    END;
    CREATE TRIGGER IF NOT EXISTS journal_container_state_update
    AFTER UPDATE ON container_state BEGIN
      ${enqueue(
        'container.upsert',
        `json_object(
        'id', NEW.id, 'current_tool', NEW.current_tool,
        'tool_declared_timeout_ms', NEW.tool_declared_timeout_ms,
        'tool_started_at', strftime('%Y-%m-%dT%H:%M:%fZ', NEW.tool_started_at/1000.0, 'unixepoch'), 'updated_at', strftime('%Y-%m-%dT%H:%M:%fZ', NEW.updated_at/1000.0, 'unixepoch')
      )`,
      )}
    END;

    CREATE TRIGGER IF NOT EXISTS journal_turn_checkpoint_insert
    AFTER INSERT ON turn_checkpoints BEGIN
      ${enqueue(
        'checkpoint.upsert',
        `json_object(
        'message_out_id', NEW.message_out_id, 'provider', NEW.provider,
        'continuation', NEW.continuation, 'provider_turn_ref', NEW.provider_turn_ref,
        'created_at', strftime('%Y-%m-%dT%H:%M:%fZ', NEW.created_at/1000.0, 'unixepoch')
      )`,
      )}
    END;
    CREATE TRIGGER IF NOT EXISTS journal_turn_checkpoint_update
    AFTER UPDATE ON turn_checkpoints BEGIN
      ${enqueue(
        'checkpoint.upsert',
        `json_object(
        'message_out_id', NEW.message_out_id, 'provider', NEW.provider,
        'continuation', NEW.continuation, 'provider_turn_ref', NEW.provider_turn_ref,
        'created_at', strftime('%Y-%m-%dT%H:%M:%fZ', NEW.created_at/1000.0, 'unixepoch')
      )`,
      )}
    END;

    CREATE TRIGGER IF NOT EXISTS journal_turn_activity_insert
    AFTER INSERT ON turn_activity BEGIN
      ${enqueue(
        'activity.persist',
        `json_object(
        'message_out_id', NEW.message_out_id, 'ordinal', NEW.ordinal,
        'ts', CAST(NEW.ts AS TEXT), 'text', NEW.text, 'turn_id', NEW.turn_id,
        'timeline_position', NEW.timeline_position
      )`,
      )}
    END;
    CREATE TRIGGER IF NOT EXISTS journal_turn_activity_update
    AFTER UPDATE ON turn_activity BEGIN
      ${enqueue(
        'activity.persist',
        `json_object(
        'message_out_id', NEW.message_out_id, 'ordinal', NEW.ordinal,
        'ts', CAST(NEW.ts AS TEXT), 'text', NEW.text, 'turn_id', NEW.turn_id,
        'timeline_position', NEW.timeline_position
      )`,
      )}
    END;

    CREATE TRIGGER IF NOT EXISTS journal_turn_usage_insert
    AFTER INSERT ON turn_usage BEGIN
      ${enqueue(
        'usage.persist',
        `json_object(
        'id', NEW.id, 'message_out_id', NEW.message_out_id, 'turn_id', NEW.turn_id,
        'cost_usd', NEW.cost_usd, 'input_tokens', NEW.input_tokens,
        'output_tokens', NEW.output_tokens, 'cache_read_tokens', NEW.cache_read_tokens,
        'cache_write_tokens', NEW.cache_write_tokens, 'reasoning_tokens', NEW.reasoning_tokens,
        'num_turns', NEW.num_turns, 'duration_ms', NEW.duration_ms,
        'duration_api_ms', NEW.duration_api_ms, 'model', NEW.model,
        'context_window', NEW.context_window, 'max_output_tokens', NEW.max_output_tokens,
        'context_tokens', NEW.context_tokens, 'timestamp', strftime('%Y-%m-%dT%H:%M:%fZ', NEW.timestamp/1000.0, 'unixepoch')
      )`,
      )}
    END;
    CREATE TRIGGER IF NOT EXISTS journal_turn_usage_update
    AFTER UPDATE ON turn_usage BEGIN
      ${enqueue(
        'usage.persist',
        `json_object(
        'id', NEW.id, 'message_out_id', NEW.message_out_id, 'turn_id', NEW.turn_id,
        'cost_usd', NEW.cost_usd, 'input_tokens', NEW.input_tokens,
        'output_tokens', NEW.output_tokens, 'cache_read_tokens', NEW.cache_read_tokens,
        'cache_write_tokens', NEW.cache_write_tokens, 'reasoning_tokens', NEW.reasoning_tokens,
        'num_turns', NEW.num_turns, 'duration_ms', NEW.duration_ms,
        'duration_api_ms', NEW.duration_api_ms, 'model', NEW.model,
        'context_window', NEW.context_window, 'max_output_tokens', NEW.max_output_tokens,
        'context_tokens', NEW.context_tokens, 'timestamp', strftime('%Y-%m-%dT%H:%M:%fZ', NEW.timestamp/1000.0, 'unixepoch')
      )`,
      )}
    END;

    CREATE TRIGGER IF NOT EXISTS journal_task_attempt_insert
    AFTER INSERT ON task_attempts BEGIN
      ${enqueue(
        'task-attempt.upsert',
        `json_object(
        'task_message_id', NEW.task_message_id, 'series_id', NEW.series_id,
        'trigger_source', NEW.trigger_source, 'status', NEW.status,
        'started_at', strftime('%Y-%m-%dT%H:%M:%fZ', NEW.started_at/1000.0, 'unixepoch'), 'completed_at', strftime('%Y-%m-%dT%H:%M:%fZ', NEW.completed_at/1000.0, 'unixepoch'),
        'duration_ms', NEW.duration_ms, 'exit_code', NEW.exit_code,
        'signal', NEW.signal, 'stdout', NEW.stdout, 'stderr', NEW.stderr,
        'error', NEW.error, 'wake_agent', NEW.wake_agent,
        'provider_invoked', NEW.provider_invoked
      )`,
      )}
    END;
    CREATE TRIGGER IF NOT EXISTS journal_task_attempt_update
    AFTER UPDATE ON task_attempts BEGIN
      ${enqueue(
        'task-attempt.upsert',
        `json_object(
        'task_message_id', NEW.task_message_id, 'series_id', NEW.series_id,
        'trigger_source', NEW.trigger_source, 'status', NEW.status,
        'started_at', strftime('%Y-%m-%dT%H:%M:%fZ', NEW.started_at/1000.0, 'unixepoch'), 'completed_at', strftime('%Y-%m-%dT%H:%M:%fZ', NEW.completed_at/1000.0, 'unixepoch'),
        'duration_ms', NEW.duration_ms, 'exit_code', NEW.exit_code,
        'signal', NEW.signal, 'stdout', NEW.stdout, 'stderr', NEW.stderr,
        'error', NEW.error, 'wake_agent', NEW.wake_agent,
        'provider_invoked', NEW.provider_invoked
      )`,
      )}
    END;
  `);
  db.exec(TURN_INDEX_SCHEMA);
  for (const operation of ['INSERT', 'UPDATE']) {
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS journal_turn_${operation.toLowerCase()}
      AFTER ${operation} ON turns BEGIN
        ${enqueue(
          'turn.upsert',
          `json_object(
          'id', NEW.id, 'origin_channel_type', NEW.origin_channel_type,
          'origin_platform_id', NEW.origin_platform_id, 'origin_thread_id', NEW.origin_thread_id,
          'origin_source_session_id', NEW.origin_source_session_id,
          'started_at', strftime('%Y-%m-%dT%H:%M:%fZ', NEW.started_at/1000.0, 'unixepoch'), 'ended_at', strftime('%Y-%m-%dT%H:%M:%fZ', NEW.ended_at/1000.0, 'unixepoch'), 'phase', NEW.phase,
          'outcome', NEW.outcome, 'provenance', NEW.provenance,
          'imported_from_session_id', NEW.imported_from_session_id,
          'imported_from_turn_id', NEW.imported_from_turn_id)`,
        )}
      END;
    `);
  }
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS journal_turn_input_insert AFTER INSERT ON turn_inputs BEGIN
      ${enqueue(
        'turn-input.upsert',
        `json_object('turn_id', NEW.turn_id,
        'message_in_id', NEW.message_in_id, 'association', NEW.association)`,
      )}
    END;
  `);
}

export function listPendingRunnerEvents(db: Database, limit = 32): PendingRunnerEvent[] {
  return db
    .prepare(
      `SELECT event_id, sequence, event_type, payload
       FROM pending_runner_events ORDER BY sequence LIMIT ?`,
    )
    .all(limit) as PendingRunnerEvent[];
}

export function acknowledgeRunnerEvent(db: Database, eventId: string): void {
  db.prepare('DELETE FROM pending_runner_events WHERE event_id = ?').run(eventId);
}

export function markBatchPersisted(db: Database): void {
  db.prepare(
    `INSERT INTO pending_runner_events (event_id, event_type, payload, created_at)
       VALUES (lower(hex(randomblob(16))), 'batch.persisted', '{}', ${EPOCH_NOW_SQL})`,
  ).run();
}
