/**
 * One-off: convert legacy `messages_out` rows of kind `internal` into
 * `internal` activity-trace entries on their turns, then delete the rows.
 *
 * Agents used to deliver `<internal>` blocks as standalone messages, which the
 * chat UI rendered as "thought" bubbles. Runners now record them as activity
 * steps instead. Every legacy row belongs to an existing settled turn and
 * carries its original timeline position, so each becomes one turn-owned
 * activity line at that position.
 *
 * Usage (stop the host first; it is the only writer of outbound.db):
 *   pnpm exec tsx scripts/backfill-internal-activity.ts           # dry run
 *   pnpm exec tsx scripts/backfill-internal-activity.ts --apply   # back up + write
 *
 * Only host-owned outbound.db files are changed. Container-owned
 * runner-state.db copies are left alone: their legacy rows were acknowledged
 * long ago and settled historical turns are never re-projected.
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

import { DATA_DIR } from '../src/config.js';

const MAX_ACTIVITY_TEXT = 16 * 1024;

interface LegacyRow {
  id: string;
  timestamp: string;
  content: string;
  turn_id: string | null;
}

function activityLine(row: LegacyRow): { ts: string; text: string; position: number } {
  const content = JSON.parse(row.content) as { text?: unknown; files?: unknown[]; timelinePosition?: unknown };
  if (typeof content.text !== 'string') throw new Error(`${row.id}: missing text`);
  if (content.files?.length) throw new Error(`${row.id}: has attachments`);
  const position = content.timelinePosition;
  if (!Number.isSafeInteger(position) || (position as number) <= 0)
    throw new Error(`${row.id}: invalid timelinePosition`);
  const ms = Date.parse(`${row.timestamp.replace(' ', 'T')}${/[zZ]|[+-]\d\d:?\d\d$/.test(row.timestamp) ? '' : 'Z'}`);
  if (!Number.isFinite(ms)) throw new Error(`${row.id}: invalid timestamp ${row.timestamp}`);
  const text = JSON.stringify({ kind: 'internal', id: `internal:${row.id}`, text: content.text });
  if (text.length > MAX_ACTIVITY_TEXT) throw new Error(`${row.id}: activity text exceeds ${MAX_ACTIVITY_TEXT} chars`);
  return { ts: String(ms), text, position: position as number };
}

function backfill(file: string, apply: boolean): number {
  const db = new Database(file, { fileMustExist: true, readonly: !apply });
  try {
    const rows = db
      .prepare("SELECT id, timestamp, content, turn_id FROM messages_out WHERE kind = 'internal' ORDER BY seq")
      .all() as LegacyRow[];
    if (!rows.length) return 0;
    const convert = db.transaction(() => {
      for (const row of rows) {
        if (!row.turn_id || !db.prepare('SELECT 1 FROM turns WHERE id = ?').get(row.turn_id))
          throw new Error(`${row.id}: no turn`);
        const line = activityLine(row);
        const { next } = db
          .prepare('SELECT COALESCE(MAX(ordinal), -1) + 1 AS next FROM turn_activity WHERE turn_id = ?')
          .get(row.turn_id) as { next: number };
        db.prepare(
          `INSERT INTO turn_activity (message_out_id, ordinal, ts, text, turn_id, timeline_position)
           VALUES (NULL, ?, ?, ?, ?, ?)`,
        ).run(next, line.ts, line.text, row.turn_id, line.position);
        db.prepare('DELETE FROM messages_out WHERE id = ?').run(row.id);
      }
    });
    if (apply) {
      fs.copyFileSync(file, `${file}.bak-internal-activity`);
      convert();
    } else {
      for (const row of rows) {
        if (!row.turn_id) throw new Error(`${row.id}: no turn`);
        activityLine(row);
      }
    }
    return rows.length;
  } finally {
    db.close();
  }
}

const apply = process.argv.includes('--apply');
const sessionsDir = path.join(DATA_DIR, 'v2-sessions');
let total = 0;
let sessions = 0;
for (const group of fs.existsSync(sessionsDir) ? fs.readdirSync(sessionsDir) : []) {
  const groupDir = path.join(sessionsDir, group);
  if (!fs.statSync(groupDir).isDirectory()) continue;
  for (const session of fs.readdirSync(groupDir)) {
    const file = path.join(groupDir, session, 'outbound.db');
    if (!fs.existsSync(file)) continue;
    const count = backfill(file, apply);
    if (!count) continue;
    total += count;
    sessions++;
    console.log(`${apply ? 'converted' : 'would convert'} ${count} in ${group}/${session}`);
  }
}
console.log(
  `${apply ? 'Converted' : 'Dry run: would convert'} ${total} legacy internal messages in ${sessions} sessions.`,
);
