import type { MessageInRow } from './messages-in.js';
import { getOutboundDb } from './connection.js';

export type TaskAttemptStatus =
  | 'running'
  | 'ready'
  | 'skipped'
  | 'failed'
  | 'timed_out'
  | 'completed';

export interface TaskScriptAttemptResult {
  status: 'ready' | 'skipped' | 'failed' | 'timed_out';
  durationMs: number;
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  error: string | null;
  wakeAgent: boolean | null;
}

const MAX_CAPTURE_CHARS = 64 * 1024;

function clip(value: string): string {
  return value.length <= MAX_CAPTURE_CHARS ? value : value.slice(0, MAX_CAPTURE_CHARS);
}

function taskMetadata(message: MessageInRow): { seriesId: string; triggerSource: string } {
  let triggerSource = 'scheduled';
  try {
    const content = JSON.parse(message.content) as Record<string, unknown>;
    if (content.triggerSource === 'manual') triggerSource = 'manual';
  } catch {
    /* malformed content is handled by the formatter */
  }
  return {
    seriesId: message.series_id || message.id,
    triggerSource,
  };
}

export function startTaskAttempt(message: MessageInRow): void {
  if (message.kind !== 'task') return;
  const { seriesId, triggerSource } = taskMetadata(message);
  getOutboundDb()
    .prepare(
      `INSERT OR IGNORE INTO task_attempts
        (task_message_id, series_id, trigger_source, status, started_at)
       VALUES (?, ?, ?, 'running', ?)`,
    )
    .run(message.id, seriesId, triggerSource, new Date().toISOString());
}

export function recordTaskScriptResult(taskMessageId: string, result: TaskScriptAttemptResult): void {
  const terminal = result.status !== 'ready';
  getOutboundDb()
    .prepare(
      `UPDATE task_attempts SET
         status = ?, completed_at = ?, duration_ms = ?, exit_code = ?, signal = ?,
         stdout = ?, stderr = ?, error = ?, wake_agent = ?
       WHERE task_message_id = ?`,
    )
    .run(
      result.status,
      terminal ? new Date().toISOString() : null,
      result.durationMs,
      result.exitCode,
      result.signal,
      clip(result.stdout),
      clip(result.stderr),
      result.error,
      result.wakeAgent === null ? null : result.wakeAgent ? 1 : 0,
      taskMessageId,
    );
}

export function markTaskAttemptsProviderInvoked(taskMessageIds: string[]): void {
  if (taskMessageIds.length === 0) return;
  const statement = getOutboundDb().prepare(
    `UPDATE task_attempts SET provider_invoked = 1 WHERE task_message_id = ?`,
  );
  getOutboundDb().transaction(() => {
    for (const id of taskMessageIds) statement.run(id);
  })();
}

export function completeTaskAttempts(taskMessageIds: string[], failed: boolean): void {
  if (taskMessageIds.length === 0) return;
  const completedAt = new Date().toISOString();
  const statement = getOutboundDb().prepare(
    `UPDATE task_attempts SET status = ?, completed_at = ?,
       duration_ms = CAST((julianday(?) - julianday(started_at)) * 86400000 AS INTEGER)
     WHERE task_message_id = ? AND status IN ('running', 'ready')`,
  );
  getOutboundDb().transaction(() => {
    for (const id of taskMessageIds) {
      statement.run(failed ? 'failed' : 'completed', completedAt, completedAt, id);
    }
  })();
}