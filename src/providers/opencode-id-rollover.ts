/**
 * Works around OpenCode's 48-bit message-ID rollover.
 *
 * OpenCode mints message IDs as the low 6 bytes of `Date.now() * 4096 +
 * counter` (packages/opencode `Identifier`). `Date.now()` needs 41 bits, so
 * the top 5 bits are silently dropped and the ID's time field wraps every
 * 2^36 ms (~795 days). The most recent wrap was 2026-08-14T11:19:55.136Z.
 *
 * IDs minted after a wrap sort lexicographically *below* every ID minted
 * before it. OpenCode's prompt loop bails at step 0 when the newest user
 * message ID sorts below the last assistant message ID:
 *
 *     if (assistant?.finish && assistant.finish !== "tool-calls" &&
 *         !pendingTool && user.id < assistant.id) break;   // "exiting loop"
 *
 * so every session carrying pre-wrap history answers nothing, forever, with
 * no error — the agent-runner only sees an empty result.
 *
 * Dropping `finish` from that one trailing assistant message defeats the
 * guard for exactly one turn. The loop then mints a fresh (post-wrap)
 * assistant message, after which IDs compare correctly again and the session
 * heals permanently. Nothing else reads `finish` off historical messages.
 */
import fs from 'fs';
import path from 'path';

import Database from 'better-sqlite3';

import { log } from '../log.js';

/** Width of the millisecond field that survives OpenCode's 6-byte ID packing. */
const MS_FIELD_MASK = 0xf_ffff_ffffn;

/** Milliseconds field encoded in an OpenCode ID (`<prefix>_<12 hex><14 base62>`). */
function idTimeField(id: string): bigint | null {
  const start = id.indexOf('_') + 1;
  if (start <= 0) return null;
  const hex = id.slice(start, start + 12);
  if (!/^[0-9a-f]{12}$/.test(hex)) return null;
  return BigInt(`0x${hex}`) >> 12n;
}

export function repairOpencodeIdRollover(opencodeDataDir: string): void {
  const dbPath = path.join(opencodeDataDir, 'opencode', 'opencode.db');
  if (!fs.existsSync(dbPath)) return;

  let db: Database.Database | undefined;
  try {
    db = new Database(dbPath);
    const nowField = BigInt(Date.now()) & MS_FIELD_MASK;
    const trailing = db
      .prepare<[], { id: string; sessionId: string }>(
        `SELECT m.id AS id, m.session_id AS sessionId
           FROM message m
          WHERE json_extract(m.data, '$.role') = 'assistant'
            AND json_extract(m.data, '$.finish') IS NOT NULL
            AND m.time_created = (
              SELECT MAX(m2.time_created) FROM message m2
               WHERE m2.session_id = m.session_id
                 AND json_extract(m2.data, '$.role') = 'assistant'
            )`,
      )
      .all();

    const strip = db.prepare(`UPDATE message SET data = json_remove(data, '$.finish') WHERE id = ?`);
    for (const row of trailing) {
      const field = idTimeField(row.id);
      if (field === null || field <= nowField) continue;
      strip.run(row.id);
      log.warn('Cleared OpenCode finish marker stranded by ID rollover', {
        sessionId: row.sessionId,
        messageId: row.id,
      });
    }
    // eslint-disable-next-line no-catch-all/no-catch-all -- best-effort repair: a bad DB must never block a container spawn
  } catch (err) {
    log.warn('OpenCode ID rollover repair skipped', { dbPath, err });
  } finally {
    db?.close();
  }
}
