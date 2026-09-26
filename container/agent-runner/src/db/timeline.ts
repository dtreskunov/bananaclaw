import type { Database } from 'bun:sqlite';
import { getOutboundDb } from './connection.js';

/** One persisted clock orders first input consumption and every outbound write. */
export function allocateTimelinePosition(db: Database = getOutboundDb()): number {
  const wallClock = Date.now() * 1000;
  if (!Number.isSafeInteger(wallClock)) throw new Error('Invalid timeline wall clock');
  const row = db.prepare(
    'UPDATE timeline_clock SET position = MAX(?, position + 1) WHERE id = 1 RETURNING position',
  ).get(wallClock) as { position: number } | null;
  if (!row || !Number.isSafeInteger(row.position) || row.position <= 0) {
    throw new Error('Unable to allocate a safe timeline position');
  }
  return row.position;
}
