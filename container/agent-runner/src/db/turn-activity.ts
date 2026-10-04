/**
 * Per-turn activity trace: the ordered list of progress steps (tool calls,
 * phases) the agent emitted during a turn. Written to the journaled local
 * projection at turn end and applied to host `turn_activity`, linked to the
 * outbound row. Read by the host UI so historical messages can show the
 * same expandable activity trace the user saw live.
 *
 * Ordered by `ordinal` (append order). Timestamps are display-only and CAN
 * collide, so ordering never relies on them.
 */
import { getOutboundDb } from './connection.js';
import type { ActivityLine } from './session-state.js';
import { getTurnContext } from '../current-batch.js';

/**
 * Persist a turn's activity lines against its last outbound row.
 * `startOrdinal` is the ordinal for the first line (lets the caller flush
 * incrementally across multiple results in one query without overlap).
 * No-op when there are no lines.
 */
export function writeTurnActivity(
  messageOutId: string | null,
  lines: ActivityLine[],
  startOrdinal = 0,
  turnId = getTurnContext()?.turnId ?? null,
): void {
  if (lines.length === 0) return;
  const db = getOutboundDb();
  const stmt = db.prepare(
    `INSERT OR REPLACE INTO turn_activity (message_out_id, ordinal, ts, text, turn_id, timeline_position)
     VALUES ($message_out_id, $ordinal, $ts, $text, $turn_id, $timeline_position)`,
  );
  const tx = db.transaction((rows: ActivityLine[]) => {
    for (let i = 0; i < rows.length; i++) {
      stmt.run({
        $message_out_id: messageOutId,
        $turn_id: turnId,
        $ordinal: startOrdinal + i,
        $ts: rows[i].ts,
        $text: rows[i].text,
        $timeline_position: rows[i].timelinePosition,
      });
    }
  });
  tx(lines);
}
