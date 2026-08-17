/**
 * Sweep hook for recurring tasks.
 *
 * Every sweep tick, find `messages_in` rows that are `completed` AND still
 * have a `recurrence` cron expression. For each, compute the next run via
 * cron-parser, insert a fresh pending row (copying series_id forward), then
 * clear the recurrence on the original so it isn't re-cloned next tick.
 *
 * Called from `src/host-sweep.ts` inside `MODULE-HOOK:scheduling-recurrence`.
 * When scheduling ships inline (current state through PR #7), the hook is a
 * direct dynamic import. When scheduling moves to the modules branch in
 * PR #8, the install skill re-fills the marker on install.
 */
import type Database from 'better-sqlite3';

import { TIMEZONE } from '../../config.js';
import { log } from '../../log.js';
import type { Session } from '../../types.js';
import { clearRecurrence, getCompletedRecurring, insertRecurrence } from './db.js';

export const MAX_CONSECUTIVE_TASK_FAILURES = 3;

function consecutiveScheduledFailures(outDb: Database.Database | null, seriesId: string): number {
  if (!outDb) return 0;
  try {
    const rows = outDb
      .prepare(
        `SELECT status FROM task_attempts
          WHERE series_id = ? AND trigger_source = 'scheduled'
          ORDER BY started_at DESC LIMIT ?`,
      )
      .all(seriesId, MAX_CONSECUTIVE_TASK_FAILURES) as Array<{ status: string }>;
    let count = 0;
    for (const row of rows) {
      if (row.status !== 'failed' && row.status !== 'timed_out') break;
      count++;
    }
    return count;
  } catch {
    return 0;
  }
}

export async function handleRecurrence(
  inDb: Database.Database,
  session: Session,
  outDb: Database.Database | null = null,
): Promise<void> {
  const recurring = getCompletedRecurring(inDb);

  for (const msg of recurring) {
    try {
      const { CronExpressionParser } = await import('cron-parser');
      // Interpret the cron expression in the user's timezone. v1 did this
      // (src/v1/task-scheduler.ts:20-49); without it, a task written "0 9 * * *"
      // by an agent running in a user's local TZ fires at 09:00 UTC instead of
      // 09:00 user-local.
      const interval = CronExpressionParser.parse(msg.recurrence, { tz: TIMEZONE });
      const nextRun = interval.next().toISOString();
      const prefix = msg.kind === 'task' ? 'task' : 'msg';
      const newId = `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const failureCount = msg.kind === 'task' ? consecutiveScheduledFailures(outDb, msg.series_id) : 0;
      let nextMessage = msg;
      try {
        const content = JSON.parse(msg.content) as Record<string, unknown>;
        content.consecutiveFailures = failureCount;
        content.autoPaused = failureCount >= MAX_CONSECUTIVE_TASK_FAILURES;
        nextMessage = { ...msg, content: JSON.stringify(content) };
      } catch {
        /* preserve malformed legacy content */
      }

      insertRecurrence(inDb, nextMessage, newId, nextRun);
      if (failureCount >= MAX_CONSECUTIVE_TASK_FAILURES) {
        inDb.prepare("UPDATE messages_in SET status = 'paused' WHERE id = ?").run(newId);
      }
      if (nextMessage.content !== msg.content) {
        inDb.prepare('UPDATE messages_in SET content = ? WHERE id = ?').run(nextMessage.content, msg.id);
      }
      clearRecurrence(inDb, msg.id);

      log.info('Inserted next recurrence', {
        originalId: msg.id,
        newId,
        seriesId: msg.series_id,
        nextRun,
        failureCount,
        paused: failureCount >= MAX_CONSECUTIVE_TASK_FAILURES,
        sessionId: session.id,
      });
    } catch (err) {
      log.error('Failed to compute next recurrence', {
        messageId: msg.id,
        recurrence: msg.recurrence,
        err,
      });
    }
  }
}
