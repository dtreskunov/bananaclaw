import type { Database } from 'bun:sqlite';

export interface PendingRunnerEvent {
  event_id: string;
  sequence: number;
  event_type: string;
  payload: string;
}

const enqueue = (eventType: string, payload: string): string => `
  INSERT INTO pending_runner_events (event_id, event_type, payload, created_at)
  VALUES (lower(hex(randomblob(16))), '${eventType}', ${payload}, datetime('now'));
`;

export function ensureRunnerStateSchema(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS messages_out (
      id TEXT PRIMARY KEY,
      seq INTEGER UNIQUE,
      in_reply_to TEXT,
      timestamp TEXT NOT NULL,
      deliver_after TEXT,
      recurrence TEXT,
      kind TEXT NOT NULL,
      platform_id TEXT,
      channel_type TEXT,
      thread_id TEXT,
      content TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS processing_ack (
      message_id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      status_changed TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS session_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS container_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      current_tool TEXT,
      tool_declared_timeout_ms INTEGER,
      tool_started_at TEXT,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS turn_checkpoints (
      message_out_id TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      continuation TEXT NOT NULL,
      provider_turn_ref TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS turn_activity (
      message_out_id TEXT NOT NULL,
      ordinal INTEGER NOT NULL,
      ts TEXT NOT NULL,
      text TEXT NOT NULL,
      PRIMARY KEY (message_out_id, ordinal)
    );
    CREATE TABLE IF NOT EXISTS turn_usage (
      id TEXT PRIMARY KEY,
      message_out_id TEXT,
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
      timestamp TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS task_attempts (
      task_message_id TEXT PRIMARY KEY,
      series_id TEXT NOT NULL,
      trigger_source TEXT NOT NULL,
      status TEXT NOT NULL,
      started_at TEXT NOT NULL,
      completed_at TEXT,
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
      created_at TEXT NOT NULL
    );

    CREATE TRIGGER IF NOT EXISTS journal_message_out_insert
    AFTER INSERT ON messages_out BEGIN
      ${enqueue(
        'message.upsert',
        `json_object(
        'id', NEW.id, 'seq', NEW.seq, 'in_reply_to', NEW.in_reply_to,
        'timestamp', NEW.timestamp, 'deliver_after', NEW.deliver_after,
        'recurrence', NEW.recurrence, 'kind', NEW.kind,
        'platform_id', NEW.platform_id, 'channel_type', NEW.channel_type,
        'thread_id', NEW.thread_id, 'content', NEW.content
      )`,
      )}
    END;

    CREATE TRIGGER IF NOT EXISTS journal_processing_ack_insert
    AFTER INSERT ON processing_ack BEGIN
      ${enqueue(
        'processing.upsert',
        `json_object(
        'message_id', NEW.message_id, 'status', NEW.status,
        'status_changed', NEW.status_changed
      )`,
      )}
    END;
    CREATE TRIGGER IF NOT EXISTS journal_processing_ack_update
    AFTER UPDATE ON processing_ack BEGIN
      ${enqueue(
        'processing.upsert',
        `json_object(
        'message_id', NEW.message_id, 'status', NEW.status,
        'status_changed', NEW.status_changed
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
        'key', NEW.key, 'value', NEW.value, 'updated_at', NEW.updated_at
      )`,
      )}
    END;
    CREATE TRIGGER IF NOT EXISTS journal_session_state_update
    AFTER UPDATE ON session_state BEGIN
      ${enqueue(
        'state.upsert',
        `json_object(
        'key', NEW.key, 'value', NEW.value, 'updated_at', NEW.updated_at
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
        'tool_started_at', NEW.tool_started_at, 'updated_at', NEW.updated_at
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
        'tool_started_at', NEW.tool_started_at, 'updated_at', NEW.updated_at
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
        'created_at', NEW.created_at
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
        'created_at', NEW.created_at
      )`,
      )}
    END;

    CREATE TRIGGER IF NOT EXISTS journal_turn_activity_insert
    AFTER INSERT ON turn_activity BEGIN
      ${enqueue(
        'activity.persist',
        `json_object(
        'message_out_id', NEW.message_out_id, 'ordinal', NEW.ordinal,
        'ts', NEW.ts, 'text', NEW.text
      )`,
      )}
    END;
    CREATE TRIGGER IF NOT EXISTS journal_turn_activity_update
    AFTER UPDATE ON turn_activity BEGIN
      ${enqueue(
        'activity.persist',
        `json_object(
        'message_out_id', NEW.message_out_id, 'ordinal', NEW.ordinal,
        'ts', NEW.ts, 'text', NEW.text
      )`,
      )}
    END;

    CREATE TRIGGER IF NOT EXISTS journal_turn_usage_insert
    AFTER INSERT ON turn_usage BEGIN
      ${enqueue(
        'usage.persist',
        `json_object(
        'id', NEW.id, 'message_out_id', NEW.message_out_id,
        'cost_usd', NEW.cost_usd, 'input_tokens', NEW.input_tokens,
        'output_tokens', NEW.output_tokens, 'cache_read_tokens', NEW.cache_read_tokens,
        'cache_write_tokens', NEW.cache_write_tokens, 'reasoning_tokens', NEW.reasoning_tokens,
        'num_turns', NEW.num_turns, 'duration_ms', NEW.duration_ms,
        'duration_api_ms', NEW.duration_api_ms, 'model', NEW.model,
        'context_window', NEW.context_window, 'max_output_tokens', NEW.max_output_tokens,
        'context_tokens', NEW.context_tokens, 'timestamp', NEW.timestamp
      )`,
      )}
    END;
    CREATE TRIGGER IF NOT EXISTS journal_turn_usage_update
    AFTER UPDATE ON turn_usage BEGIN
      ${enqueue(
        'usage.persist',
        `json_object(
        'id', NEW.id, 'message_out_id', NEW.message_out_id,
        'cost_usd', NEW.cost_usd, 'input_tokens', NEW.input_tokens,
        'output_tokens', NEW.output_tokens, 'cache_read_tokens', NEW.cache_read_tokens,
        'cache_write_tokens', NEW.cache_write_tokens, 'reasoning_tokens', NEW.reasoning_tokens,
        'num_turns', NEW.num_turns, 'duration_ms', NEW.duration_ms,
        'duration_api_ms', NEW.duration_api_ms, 'model', NEW.model,
        'context_window', NEW.context_window, 'max_output_tokens', NEW.max_output_tokens,
        'context_tokens', NEW.context_tokens, 'timestamp', NEW.timestamp
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
        'started_at', NEW.started_at, 'completed_at', NEW.completed_at,
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
        'started_at', NEW.started_at, 'completed_at', NEW.completed_at,
        'duration_ms', NEW.duration_ms, 'exit_code', NEW.exit_code,
        'signal', NEW.signal, 'stdout', NEW.stdout, 'stderr', NEW.stderr,
        'error', NEW.error, 'wake_agent', NEW.wake_agent,
        'provider_invoked', NEW.provider_invoked
      )`,
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

export function markTurnPersisted(db: Database): void {
  db.prepare(
    `INSERT INTO pending_runner_events (event_id, event_type, payload, created_at)
       VALUES (lower(hex(randomblob(16))), 'turn.persisted', '{}', datetime('now'))`,
  ).run();
}

export function markBatchPersisted(db: Database): void {
  db.prepare(
    `INSERT INTO pending_runner_events (event_id, event_type, payload, created_at)
       VALUES (lower(hex(randomblob(16))), 'batch.persisted', '{}', datetime('now'))`,
  ).run();
}
