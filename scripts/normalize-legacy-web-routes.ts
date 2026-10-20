/**
 * One-off: move pre-shared-room web history onto each agent group's shared
 * web route.
 *
 * Migration 029 collapsed per-user web rooms (`<userId>#<agentGroupId>`) into
 * one shared room per agent group (`group:<agentGroupId>`) and moved their
 * sessions, but left the stored route on existing messages and turns. Every
 * reader filters by the room's route, so that history renders as empty.
 *
 * Rewrites web rows whose platform ID ends in `#<agentGroupId>`:
 *   inbound.db  messages_in.platform_id   (journal triggers queue the runner copy)
 *   outbound.db messages_out.platform_id, turns.origin_platform_id
 *   v2.db       questions.platform_id
 * Session routing and destinations are rebuilt from the central DB on every
 * wake, so their stale snapshots are left alone.
 *
 * Usage (stop the host first; it is the only writer of these files):
 *   pnpm exec tsx scripts/normalize-legacy-web-routes.ts           # dry run
 *   pnpm exec tsx scripts/normalize-legacy-web-routes.ts --apply   # back up + write
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

import { DATA_DIR } from '../src/config.js';

const BACKUP_SUFFIX = '.bak-legacy-web-routes';
const LEGACY = `channel_type = 'web' AND substr(platform_id, -length(@suffix)) = @suffix`;
const LEGACY_TURN = `origin_channel_type = 'web' AND substr(origin_platform_id, -length(@suffix)) = @suffix`;

const apply = process.argv.includes('--apply');
const counts: Record<string, number> = {};
const tally = (key: string, n: number) => (counts[key] = (counts[key] ?? 0) + n);

function hasTable(db: Database.Database, name: string): boolean {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
}

function rewrite(file: string, statements: Array<[string, string]>, params: Record<string, string>): void {
  if (!fs.existsSync(file)) return;
  const db = new Database(file, { fileMustExist: true, readonly: !apply });
  try {
    const present = statements.filter(([table]) => hasTable(db, table.split('.')[0]!));
    if (hasTable(db, 'thread_titles')) {
      const titles = db.prepare(`SELECT count(*) AS n FROM thread_titles WHERE ${LEGACY}`).get(params) as { n: number };
      if (titles.n) throw new Error(`${file}: ${titles.n} legacy thread titles need manual handling`);
    }
    const pending = present.map(([key, where]) => {
      const [table, column] = key.split('.') as [string, string];
      const { n } = db.prepare(`SELECT count(*) AS n FROM ${table} WHERE ${where}`).get(params) as { n: number };
      return { key, table, column, where, n };
    });
    if (!pending.some((entry) => entry.n)) return;
    for (const entry of pending) tally(entry.key, entry.n);
    if (!apply) return;
    fs.copyFileSync(file, `${file}${BACKUP_SUFFIX}`);
    db.transaction(() => {
      for (const entry of pending) {
        if (!entry.n) continue;
        db.prepare(`UPDATE ${entry.table} SET ${entry.column} = @canonical WHERE ${entry.where}`).run(params);
      }
    })();
  } finally {
    db.close();
  }
}

const centralPath = path.join(DATA_DIR, 'v2.db');
const central = new Database(centralPath, { fileMustExist: true, readonly: !apply });
if (apply) await central.backup(`${centralPath}${BACKUP_SUFFIX}`);

const groups = central.prepare('SELECT id FROM agent_groups ORDER BY id').all() as Array<{ id: string }>;
const skipped: string[] = [];
for (const { id: group } of groups) {
  const canonical = `group:${group}`;
  const shared = central
    .prepare("SELECT 1 FROM messaging_groups WHERE id = ? AND channel_type = 'web' AND platform_id = ?")
    .get(`mg-web-shared-${group}`, canonical);
  if (!shared) {
    skipped.push(group);
    continue;
  }
  const params = { suffix: `#${group}`, canonical };
  const sessionsDir = path.join(DATA_DIR, 'v2-sessions', group);
  for (const session of fs.existsSync(sessionsDir) ? fs.readdirSync(sessionsDir) : []) {
    const dir = path.join(sessionsDir, session);
    rewrite(path.join(dir, 'inbound.db'), [['messages_in.platform_id', LEGACY]], params);
    rewrite(
      path.join(dir, 'outbound.db'),
      [
        ['messages_out.platform_id', LEGACY],
        ['turns.origin_platform_id', LEGACY_TURN],
      ],
      params,
    );
  }
  const questions = central
    .prepare(
      `SELECT count(*) AS n FROM questions
        WHERE session_id IN (SELECT id FROM sessions WHERE agent_group_id = @group) AND ${LEGACY}`,
    )
    .get({ ...params, group }) as { n: number };
  if (questions.n) {
    tally('questions.platform_id', questions.n);
    if (apply)
      central
        .prepare(
          `UPDATE questions SET platform_id = @canonical
            WHERE session_id IN (SELECT id FROM sessions WHERE agent_group_id = @group) AND ${LEGACY}`,
        )
        .run({ ...params, group });
  }
}
central.close();

console.log(`${apply ? 'Rewrote' : 'Dry run: would rewrite'} legacy web routes:`, counts);
if (skipped.length) console.log(`Skipped ${skipped.length} groups without a shared web room: ${skipped.join(', ')}`);
