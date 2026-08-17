/**
 * In-process notice bus for scheduled-task firings.
 *
 * The host sweep publishes a `TaskRunNotice` whenever a `kind='task'` row
 * transitions to `completed`. Channel adapters (currently the web channel)
 * subscribe to push a live timeline event to attached clients. This inverts
 * the dependency so core sweep code never imports a channel adapter.
 */

export interface TaskRunNotice {
  /** channel_type of the task row (listeners filter on this). */
  channelType: string;
  /** platform_id of the task row (adapter-specific routing key). */
  platformId: string;
  /** thread_id of the task row (null for DM / default threads). */
  threadId: string | null;
  /** messages_in.id of the completed task row. */
  id: string;
  /** ISO timestamp the run was due (process_after, falling back to the row
   *  creation timestamp for legacy rows). */
  timestamp: string;
  /** Raw task content JSON (`{ prompt, script }`) for summary derivation. */
  content: string;
  /** Cron expression when recurring; null for a one-off. */
  recurrence: string | null;
  /** series_id grouping recurring occurrences (null for legacy one-offs). */
  seriesId: string | null;
  /** Durable execution outcome; legacy rows without an attempt default to completed. */
  status: 'running' | 'ready' | 'skipped' | 'failed' | 'timed_out' | 'completed';
  /** Whether this occurrence came from cron/one-shot scheduling or Run now. */
  triggerSource: 'scheduled' | 'manual';
  /** Captured execution error for failed/timed-out attempts. */
  error: string | null;
  /** The recurrence policy paused the series after this attempt. */
  autoPaused: boolean;
}

type TaskRunListener = (notice: TaskRunNotice) => void;

const listeners = new Set<TaskRunListener>();

/** Subscribe to task-run notices. Returns an unsubscribe function. */
export function onTaskRun(listener: TaskRunListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Publish a task-run notice to all subscribers. Listener errors are isolated. */
export function publishTaskRun(notice: TaskRunNotice): void {
  for (const listener of listeners) {
    try {
      listener(notice);
    } catch {
      /* isolate one bad listener from the rest */
    }
  }
}
