import Database from 'better-sqlite3';
import crypto from 'node:crypto';
import path from 'node:path';

import { CONTAINER_MAX_OUTPUT_SIZE, DATA_DIR } from './config.js';
import { isSafeAttachmentName } from './attachment-safety.js';

const MAX_ID_CHARS = 256;
const MAX_STATE_CHARS = 1024 * 1024;
const MAX_CAPTURE_CHARS = 64 * 1024;
const APPLIED_EVENT_RETENTION = 4096;
export const MAX_DECLARED_TOOL_TIMEOUT_MS = 6 * 60 * 60 * 1000;
const MAX_CONTENT_ARRAY_ITEMS = 100;
const MAX_CONTENT_DEPTH = 16;
const MAX_OUTBOUND_FILES = 32;
const MAX_QUESTION_OPTIONS = 50;

export interface DurableRunnerFrame {
  eventId: string;
  sequence: number;
  event: { type: string; payload: unknown };
}

export interface DurableApplyResult {
  deliveryReady: boolean;
  processingReady: boolean;
}

function dbPath(agentGroupId: string, sessionId: string, name: 'inbound.db' | 'outbound.db'): string {
  return path.join(DATA_DIR, 'v2-sessions', agentGroupId, sessionId, name);
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
}

function text(value: unknown, max = MAX_ID_CHARS): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max;
}

function nullableText(value: unknown, max = MAX_ID_CHARS): value is string | null {
  return value === null || (typeof value === 'string' && value.length <= max);
}

function nullableInteger(value: unknown): value is number | null {
  return value === null || (Number.isSafeInteger(value) && Number(value) >= 0);
}

function nullableNumber(value: unknown): value is number | null {
  return value === null || (typeof value === 'number' && Number.isFinite(value) && value >= 0);
}

function validateStructuredContent(value: unknown, depth = 0): boolean {
  if (depth > MAX_CONTENT_DEPTH) return false;
  if (value === null || typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string') {
    return true;
  }
  if (Array.isArray(value)) {
    return value.length <= MAX_CONTENT_ARRAY_ITEMS && value.every((item) => validateStructuredContent(item, depth + 1));
  }
  if (!value || typeof value !== 'object') return false;
  const entries = Object.entries(value as Record<string, unknown>);
  return entries.length <= MAX_CONTENT_ARRAY_ITEMS && entries.every(([key, item]) =>
    key.length <= MAX_ID_CHARS && validateStructuredContent(item, depth + 1));
}

function validateMessageCollections(content: Record<string, unknown>): void {
  if (!validateStructuredContent(content)) throw new Error('message content exceeds structural limits');
  if (content.files !== undefined) {
    if (
      !Array.isArray(content.files) ||
      content.files.length > MAX_OUTBOUND_FILES ||
      !content.files.every((file) => typeof file === 'string' && isSafeAttachmentName(file))
    ) throw new Error('invalid outbound files');
  }
  if (content.file_paths !== undefined) {
    if (
      !Array.isArray(content.file_paths) ||
      content.file_paths.length > MAX_OUTBOUND_FILES ||
      !content.file_paths.every((file) => file === null || (typeof file === 'string' && file.length <= 4096))
    ) throw new Error('invalid outbound file paths');
  }
  if (content.options !== undefined && (!Array.isArray(content.options) || content.options.length > MAX_QUESTION_OPTIONS)) {
    throw new Error('invalid question options');
  }
}

function applyMessage(db: Database.Database, payload: Record<string, unknown>, maxInboundSeq: number): boolean {
  const keys = [
    'id',
    'seq',
    'in_reply_to',
    'timestamp',
    'deliver_after',
    'recurrence',
    'kind',
    'platform_id',
    'channel_type',
    'thread_id',
    'content',
  ];
  if (
    !exactKeys(payload, keys) ||
    !text(payload.id) ||
    !Number.isSafeInteger(payload.seq) ||
    Number(payload.seq) <= 0 ||
    Number(payload.seq) % 2 !== 1 ||
    !nullableText(payload.in_reply_to) ||
    !text(payload.timestamp) ||
    !nullableText(payload.deliver_after) ||
    !nullableText(payload.recurrence) ||
    !text(payload.kind, 64) ||
    !nullableText(payload.platform_id, 1024) ||
    !nullableText(payload.channel_type, 64) ||
    !nullableText(payload.thread_id, 1024) ||
    typeof payload.content !== 'string' ||
    payload.content.length === 0 ||
    Buffer.byteLength(payload.content) > CONTAINER_MAX_OUTPUT_SIZE
  )
    throw new Error('invalid message.upsert payload');
  let content: Record<string, unknown>;
  try {
    content = JSON.parse(payload.content as string) as Record<string, unknown>;
    if (!content || typeof content !== 'object' || Array.isArray(content)) throw new Error('not an object');
  } catch {
    throw new Error('invalid message content');
  }
  validateMessageCollections(content);

  const maxOdd = (
    db.prepare('SELECT COALESCE(MAX(seq), -1) AS value FROM messages_out WHERE seq % 2 = 1').get() as { value: number }
  ).value;
  const maxOut = (db.prepare('SELECT COALESCE(MAX(seq), 0) AS value FROM messages_out').get() as { value: number })
    .value;
  const maxObserved = Math.max(maxOut, maxInboundSeq);
  const nextObservedOdd = maxObserved % 2 === 0 ? maxObserved + 1 : maxObserved + 2;
  if (Number(payload.seq) <= maxOdd || Number(payload.seq) > nextObservedOdd) {
    throw new Error('invalid outbound sequence');
  }
  db.prepare(
    `INSERT INTO messages_out
      (id, seq, in_reply_to, timestamp, deliver_after, recurrence, kind, platform_id, channel_type, thread_id, content)
     VALUES (@id, @seq, @in_reply_to, @timestamp, @deliver_after, @recurrence, @kind,
       @platform_id, @channel_type, @thread_id, @content)`,
  ).run(payload);
  return payload.kind === 'system' || content.delivery_origin !== 'response';
}

function applyProcessing(db: Database.Database, payload: Record<string, unknown>): void {
  if (
    !exactKeys(payload, ['message_id', 'status', 'status_changed']) ||
    !text(payload.message_id) ||
    !['processing', 'completed', 'failed'].includes(String(payload.status)) ||
    !text(payload.status_changed)
  )
    throw new Error('invalid processing.upsert payload');
  db.prepare(
    `INSERT INTO processing_ack (message_id, status, status_changed)
     VALUES (@message_id, @status, datetime('now'))
     ON CONFLICT(message_id) DO UPDATE SET status=excluded.status, status_changed=excluded.status_changed`,
  ).run(payload);
}

function applyState(db: Database.Database, payload: Record<string, unknown>): void {
  if (
    !exactKeys(payload, ['key', 'value', 'updated_at']) ||
    !text(payload.key) ||
    !text(payload.value, MAX_STATE_CHARS) ||
    !text(payload.updated_at)
  )
    throw new Error('invalid state.upsert payload');
  db.prepare(
    `INSERT INTO session_state (key, value, updated_at) VALUES (@key, @value, @updated_at)
     ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`,
  ).run(payload);
}

function applyContainerState(db: Database.Database, payload: Record<string, unknown>): void {
  if (
    !exactKeys(payload, ['id', 'current_tool', 'tool_declared_timeout_ms', 'tool_started_at', 'updated_at']) ||
    payload.id !== 1 ||
    !nullableText(payload.current_tool) ||
    !nullableInteger(payload.tool_declared_timeout_ms) ||
    (typeof payload.tool_declared_timeout_ms === 'number' &&
      payload.tool_declared_timeout_ms > MAX_DECLARED_TOOL_TIMEOUT_MS) ||
    !nullableText(payload.tool_started_at) ||
    !text(payload.updated_at)
  )
    throw new Error('invalid container.upsert payload');
  db.prepare(
    `INSERT INTO container_state
      (id, current_tool, tool_declared_timeout_ms, tool_started_at, updated_at)
     VALUES (@id, @current_tool, @tool_declared_timeout_ms, @tool_started_at, @updated_at)
     ON CONFLICT(id) DO UPDATE SET current_tool=excluded.current_tool,
       tool_declared_timeout_ms=excluded.tool_declared_timeout_ms,
       tool_started_at=excluded.tool_started_at, updated_at=excluded.updated_at`,
  ).run(payload);
}

function applyCheckpoint(db: Database.Database, payload: Record<string, unknown>): void {
  if (
    !exactKeys(payload, ['message_out_id', 'provider', 'continuation', 'provider_turn_ref', 'created_at']) ||
    !text(payload.message_out_id) ||
    !text(payload.provider) ||
    !text(payload.continuation, MAX_STATE_CHARS) ||
    !text(payload.provider_turn_ref, MAX_STATE_CHARS) ||
    !text(payload.created_at)
  )
    throw new Error('invalid checkpoint.upsert payload');
  db.prepare(
    `INSERT INTO turn_checkpoints
      (message_out_id, provider, continuation, provider_turn_ref, created_at)
     VALUES (@message_out_id, @provider, @continuation, @provider_turn_ref, @created_at)
     ON CONFLICT(message_out_id) DO UPDATE SET provider=excluded.provider,
       continuation=excluded.continuation, provider_turn_ref=excluded.provider_turn_ref,
       created_at=excluded.created_at`,
  ).run(payload);
}

function applyActivity(db: Database.Database, payload: Record<string, unknown>): void {
  if (
    !exactKeys(payload, ['message_out_id', 'ordinal', 'ts', 'text']) ||
    !text(payload.message_out_id) ||
    !Number.isSafeInteger(payload.ordinal) ||
    Number(payload.ordinal) < 0 ||
    !text(payload.ts) ||
    !text(payload.text, 16 * 1024)
  )
    throw new Error('invalid activity.persist payload');
  db.prepare(
    `INSERT INTO turn_activity (message_out_id, ordinal, ts, text)
     VALUES (@message_out_id, @ordinal, @ts, @text)
     ON CONFLICT(message_out_id, ordinal) DO UPDATE SET ts=excluded.ts, text=excluded.text`,
  ).run(payload);
}

function applyUsage(db: Database.Database, payload: Record<string, unknown>): void {
  const keys = [
    'id',
    'message_out_id',
    'cost_usd',
    'input_tokens',
    'output_tokens',
    'cache_read_tokens',
    'cache_write_tokens',
    'reasoning_tokens',
    'num_turns',
    'duration_ms',
    'duration_api_ms',
    'model',
    'context_window',
    'max_output_tokens',
    'context_tokens',
    'timestamp',
  ];
  if (
    !exactKeys(payload, keys) ||
    !text(payload.id) ||
    !nullableText(payload.message_out_id) ||
    !nullableNumber(payload.cost_usd) ||
    !nullableInteger(payload.input_tokens) ||
    !nullableInteger(payload.output_tokens) ||
    !nullableInteger(payload.cache_read_tokens) ||
    !nullableInteger(payload.cache_write_tokens) ||
    !nullableInteger(payload.reasoning_tokens) ||
    !nullableInteger(payload.num_turns) ||
    !nullableInteger(payload.duration_ms) ||
    !nullableInteger(payload.duration_api_ms) ||
    !nullableText(payload.model) ||
    !nullableInteger(payload.context_window) ||
    !nullableInteger(payload.max_output_tokens) ||
    !nullableInteger(payload.context_tokens) ||
    !text(payload.timestamp)
  )
    throw new Error('invalid usage.persist payload');
  db.prepare(
    `INSERT INTO turn_usage
      (id, message_out_id, cost_usd, input_tokens, output_tokens, cache_read_tokens,
       cache_write_tokens, reasoning_tokens, num_turns, duration_ms, duration_api_ms,
       model, context_window, max_output_tokens, context_tokens, timestamp)
     VALUES (@id, @message_out_id, @cost_usd, @input_tokens, @output_tokens, @cache_read_tokens,
       @cache_write_tokens, @reasoning_tokens, @num_turns, @duration_ms, @duration_api_ms,
       @model, @context_window, @max_output_tokens, @context_tokens, @timestamp)
     ON CONFLICT(id) DO UPDATE SET message_out_id=excluded.message_out_id,
       cost_usd=excluded.cost_usd, input_tokens=excluded.input_tokens,
       output_tokens=excluded.output_tokens, cache_read_tokens=excluded.cache_read_tokens,
       cache_write_tokens=excluded.cache_write_tokens, reasoning_tokens=excluded.reasoning_tokens,
       num_turns=excluded.num_turns, duration_ms=excluded.duration_ms,
       duration_api_ms=excluded.duration_api_ms, model=excluded.model,
       context_window=excluded.context_window, max_output_tokens=excluded.max_output_tokens,
       context_tokens=excluded.context_tokens, timestamp=excluded.timestamp`,
  ).run(payload);
}

function applyTaskAttempt(db: Database.Database, payload: Record<string, unknown>): void {
  const keys = [
    'task_message_id',
    'series_id',
    'trigger_source',
    'status',
    'started_at',
    'completed_at',
    'duration_ms',
    'exit_code',
    'signal',
    'stdout',
    'stderr',
    'error',
    'wake_agent',
    'provider_invoked',
  ];
  if (
    !exactKeys(payload, keys) ||
    !text(payload.task_message_id) ||
    !text(payload.series_id) ||
    !['manual', 'scheduled'].includes(String(payload.trigger_source)) ||
    !['running', 'ready', 'skipped', 'failed', 'timed_out', 'completed'].includes(String(payload.status)) ||
    !text(payload.started_at) ||
    !nullableText(payload.completed_at) ||
    !nullableInteger(payload.duration_ms) ||
    !(payload.exit_code === null || Number.isSafeInteger(payload.exit_code)) ||
    !nullableText(payload.signal, 128) ||
    !nullableText(payload.stdout, MAX_CAPTURE_CHARS) ||
    !nullableText(payload.stderr, MAX_CAPTURE_CHARS) ||
    !nullableText(payload.error, MAX_CAPTURE_CHARS) ||
    !(payload.wake_agent === null || payload.wake_agent === 0 || payload.wake_agent === 1) ||
    !(payload.provider_invoked === 0 || payload.provider_invoked === 1)
  )
    throw new Error('invalid task-attempt.upsert payload');
  db.prepare(
    `INSERT INTO task_attempts
      (task_message_id, series_id, trigger_source, status, started_at, completed_at,
       duration_ms, exit_code, signal, stdout, stderr, error, wake_agent, provider_invoked)
     VALUES (@task_message_id, @series_id, @trigger_source, @status, @started_at, @completed_at,
       @duration_ms, @exit_code, @signal, @stdout, @stderr, @error, @wake_agent, @provider_invoked)
     ON CONFLICT(task_message_id) DO UPDATE SET series_id=excluded.series_id,
       trigger_source=excluded.trigger_source, status=excluded.status,
       started_at=excluded.started_at, completed_at=excluded.completed_at,
       duration_ms=excluded.duration_ms, exit_code=excluded.exit_code, signal=excluded.signal,
       stdout=excluded.stdout, stderr=excluded.stderr, error=excluded.error,
       wake_agent=excluded.wake_agent, provider_invoked=excluded.provider_invoked`,
  ).run(payload);
}

export function applyDurableRunnerEvent(
  agentGroupId: string,
  sessionId: string,
  frame: DurableRunnerFrame,
): DurableApplyResult {
  if (!text(frame.eventId) || !Number.isSafeInteger(frame.sequence) || frame.sequence <= 0) {
    throw new Error('invalid durable event envelope');
  }
  const payload = record(frame.event.payload);
  if (!payload || !text(frame.event.type, 64)) throw new Error('invalid durable event');

  const db = new Database(dbPath(agentGroupId, sessionId, 'outbound.db'));
  db.pragma('journal_mode = DELETE');
  db.pragma('busy_timeout = 5000');
  let deliveryReady = false;
  let processingReady = false;
  const digest = crypto
    .createHash('sha256')
    .update(JSON.stringify({ type: frame.event.type, payload }))
    .digest('hex');
  let maxInboundSeq = 0;
  if (frame.event.type === 'message.upsert') {
    const inbound = new Database(dbPath(agentGroupId, sessionId, 'inbound.db'), { readonly: true });
    try {
      maxInboundSeq = (
        inbound.prepare('SELECT COALESCE(MAX(seq), 0) AS value FROM messages_in').get() as { value: number }
      ).value;
    } finally {
      inbound.close();
    }
  }
  try {
    db.transaction(() => {
      const existing = db
        .prepare('SELECT sequence, event_type, event_digest FROM applied_runner_events WHERE event_id = ?')
        .get(frame.eventId) as { sequence: number; event_type: string; event_digest: string } | undefined;
      if (existing) {
        if (
          existing.sequence !== frame.sequence ||
          existing.event_type !== frame.event.type ||
          existing.event_digest !== digest
        )
          throw new Error('conflicting durable event replay');
        deliveryReady = frame.event.type === 'turn.persisted';
        processingReady = frame.event.type === 'batch.persisted';
        return;
      }
      const lastSequence = (
        db.prepare('SELECT COALESCE(MAX(sequence), 0) AS value FROM applied_runner_events').get() as { value: number }
      ).value;
      if (frame.sequence <= lastSequence) return;
      if (frame.sequence !== lastSequence + 1) throw new Error('out-of-order durable event');
      switch (frame.event.type) {
        case 'message.upsert':
          deliveryReady = applyMessage(db, payload, maxInboundSeq);
          break;
        case 'processing.upsert':
          applyProcessing(db, payload);
          break;
        case 'processing.delete':
          if (!exactKeys(payload, ['message_id']) || !text(payload.message_id))
            throw new Error('invalid processing.delete payload');
          db.prepare('DELETE FROM processing_ack WHERE message_id = ?').run(payload.message_id);
          break;
        case 'state.upsert':
          applyState(db, payload);
          break;
        case 'state.delete':
          if (!exactKeys(payload, ['key']) || !text(payload.key)) throw new Error('invalid state.delete payload');
          db.prepare('DELETE FROM session_state WHERE key = ?').run(payload.key);
          break;
        case 'container.upsert':
          applyContainerState(db, payload);
          break;
        case 'checkpoint.upsert':
          applyCheckpoint(db, payload);
          break;
        case 'activity.persist':
          applyActivity(db, payload);
          break;
        case 'usage.persist':
          applyUsage(db, payload);
          break;
        case 'task-attempt.upsert':
          applyTaskAttempt(db, payload);
          break;
        case 'turn.persisted':
          if (!exactKeys(payload, [])) throw new Error('invalid turn.persisted payload');
          deliveryReady = true;
          break;
        case 'batch.persisted':
          if (!exactKeys(payload, [])) throw new Error('invalid batch.persisted payload');
          processingReady = true;
          break;
        default:
          throw new Error(`unknown durable event type: ${frame.event.type}`);
      }
      db.prepare(
        `INSERT INTO applied_runner_events (event_id, sequence, event_type, event_digest, applied_at)
        VALUES (?, ?, ?, ?, datetime('now'))`,
      ).run(frame.eventId, frame.sequence, frame.event.type, digest);
      db.prepare('DELETE FROM applied_runner_events WHERE sequence <= ?').run(frame.sequence - APPLIED_EVENT_RETENTION);
    })();
  } finally {
    db.close();
  }

  return { deliveryReady, processingReady };
}
