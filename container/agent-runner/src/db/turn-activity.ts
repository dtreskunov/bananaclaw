/**
 * Per-turn activity trace: the ordered list of progress steps (tool calls,
 * phases) the agent emitted during a turn. Written to `turn_activity` in
 * outbound.db by the poll-loop at turn end, linked to the turn's last
 * outbound row. Read by the host UI so historical messages can show the
 * same expandable activity trace the user saw live.
 *
 * Ordered by `ordinal` (append order). Timestamps are display-only and CAN
 * collide, so ordering never relies on them.
 */
import { getOutboundDb } from './connection.js';
import type { ActivityLine } from './session-state.js';

/**
 * Persist a turn's activity lines against its last outbound row.
 * `startOrdinal` is the ordinal for the first line (lets the caller flush
 * incrementally across multiple results in one query without overlap).
 * No-op when there are no lines.
 */
export function writeTurnActivity(
  messageOutId: string,
  lines: ActivityLine[],
  startOrdinal = 0,
): void {
  if (lines.length === 0) return;
  const db = getOutboundDb();
  const stmt = db.prepare(
    `INSERT OR REPLACE INTO turn_activity (message_out_id, ordinal, ts, text)
     VALUES ($message_out_id, $ordinal, $ts, $text)`,
  );
  const tx = db.transaction((rows: ActivityLine[]) => {
    for (let i = 0; i < rows.length; i++) {
      stmt.run({
        $message_out_id: messageOutId,
        $ordinal: startOrdinal + i,
        $ts: rows[i].ts,
        $text: rows[i].text,
      });
    }
  });
  tx(lines);
}
