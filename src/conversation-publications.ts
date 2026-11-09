import type Database from 'better-sqlite3';
import fs from 'node:fs';
import { getDb } from './db/connection.js';
import { inboundDbPath, openInboundDb } from './session-manager.js';
import { readableOutput } from './ui/shared/readable-output.js';

export interface PublicationRoute {
  session_id: string;
  channel_type: string;
  platform_id: string;
  thread_id: string;
}
interface Publication extends PublicationRoute {
  kind: 'message' | 'approval';
  item_id: string;
}
interface InteractionSource {
  id?: string;
  kind?: string;
  session_id: string | null;
  origin_message_id?: string | null;
  route_origin_id?: string | null;
  channel_type?: string | null;
  platform_id?: string | null;
  thread_id?: string | null;
}

export function interactionRoute(row: InteractionSource, refresh = false): PublicationRoute | null {
  if (!row.session_id) return null;
  const session = getDb().prepare(`SELECT s.agent_group_id,s.thread_id,mg.channel_type,mg.platform_id
    FROM sessions s LEFT JOIN messaging_groups mg ON mg.id=s.messaging_group_id WHERE s.id=?`)
    .get(row.session_id) as { agent_group_id: string; thread_id: string | null; channel_type: string | null; platform_id: string | null } | undefined;
  if (!session) return null;
  if (!fs.existsSync(inboundDbPath(session.agent_group_id, row.session_id))) return null;
  if (!refresh && row.channel_type && row.platform_id && row.route_origin_id === (row.origin_message_id ?? null))
    return { session_id: row.session_id, channel_type: row.channel_type, platform_id: row.platform_id, thread_id: row.thread_id ?? '' };
  let route = session;
  if (row.origin_message_id) {
    if (!fs.existsSync(inboundDbPath(session.agent_group_id, row.session_id))) return null;
    const source = openInboundDb(session.agent_group_id, row.session_id);
    try {
      const input = source.prepare('SELECT channel_type,platform_id,thread_id FROM messages_in WHERE id=?')
        .get(row.origin_message_id) as Pick<typeof session, 'channel_type' | 'platform_id' | 'thread_id'> | undefined;
      if (!input) return null;
      route = { ...session, ...input };
    } finally { source.close(); }
  } else if (session.thread_id === null) {
    const mg = getDb().prepare('SELECT mg.is_group FROM sessions s JOIN messaging_groups mg ON mg.id=s.messaging_group_id WHERE s.id=?')
      .get(row.session_id) as { is_group: number } | undefined;
    if (mg?.is_group !== 0) return null;
  }
  return route.channel_type && route.platform_id
    ? { session_id: row.session_id, channel_type: route.channel_type, platform_id: route.platform_id, thread_id: route.thread_id ?? '' }
    : null;
}

const identity = (row: Publication) => JSON.stringify([
  row.kind, row.item_id, row.channel_type, row.platform_id, row.thread_id,
]);

function replacePublications(sessionId: string, kinds: Publication['kind'][], rows: Publication[]): number {
  const db = getDb();
  const existing = db.prepare(`SELECT * FROM conversation_publications WHERE session_id=? AND kind IN (${kinds.map(() => '?')})`)
    .all(sessionId, ...kinds) as (Publication & { position: number; visible: number })[];
  const previous = new Map(existing.map(row => [identity(row), row]));
  const next = new Set(rows.map(identity));
  let changed = 0;
  const visibility = db.prepare('UPDATE conversation_publications SET visible=? WHERE position=?');
  for (const row of existing)
    if (row.visible && !next.has(identity(row))) changed += visibility.run(0, row.position).changes;
  const insert = db.prepare(`INSERT INTO conversation_publications
    (session_id,kind,item_id,channel_type,platform_id,thread_id) VALUES (@session_id,@kind,@item_id,@channel_type,@platform_id,@thread_id)`);
  for (const row of rows) {
    const old = previous.get(identity(row));
    if (!old) changed += insert.run(row).changes;
    else if (!old.visible) changed += visibility.run(1, old.position).changes;
  }
  return changed;
}

export function projectMessagePublications(source: Database.Database, sessionId: string): number {
  const rows = source.prepare(`SELECT m.id,m.kind,m.content,m.channel_type,m.platform_id,m.thread_id,t.phase
    FROM messages_out m LEFT JOIN turns t ON t.id=m.turn_id ORDER BY m.seq`).all() as {
      id: string; kind: string; content: string; channel_type: string | null;
      platform_id: string | null; thread_id: string | null; phase: string | null;
    }[];
  return replacePublications(sessionId, ['message'], rows.flatMap(row =>
    row.channel_type && row.platform_id && readableOutput(row.kind, row.content, row.phase)
      ? [{ session_id: sessionId, kind: 'message' as const, item_id: row.id, channel_type: row.channel_type,
          platform_id: row.platform_id, thread_id: row.thread_id ?? '' }]
      : [],
  ));
}

export function projectInteractionPublications(sessionId: string, refresh = false): number {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM interactions WHERE session_id=? ORDER BY created_at,id')
    .all(sessionId) as InteractionSource[];
  return replacePublications(sessionId, ['approval'], rows.flatMap(row => {
    const route = interactionRoute(row, refresh);
    if (!row.id) return [];
    if (!route) {
      db.prepare('UPDATE interactions SET channel_type=NULL,platform_id=NULL,thread_id=NULL,route_origin_id=NULL WHERE id=?').run(row.id);
      return [];
    }
    db.prepare('UPDATE interactions SET channel_type=?,platform_id=?,thread_id=?,route_origin_id=? WHERE id=?')
      .run(route.channel_type, route.platform_id, route.thread_id || null, row.origin_message_id ?? null, row.id);
    return [{ ...route, kind: 'approval' as const, item_id: row.id }];
  }));
}

export function assertUnreadReady(): void {
  if (getDb().prepare('SELECT unread_ready FROM thread_summary_meta WHERE id=1').pluck().get() !== 1)
    throw new Error('Unread projections require offline backfill: pnpm exec tsx scripts/rebuild-thread-summaries.ts --host-stopped');
}

export function finishUnreadBootstrap(): void {
  const db = getDb();
  if (db.prepare('SELECT unread_ready FROM thread_summary_meta WHERE id=1').pluck().get() === 1) return;
  db.prepare('UPDATE users SET unread_baseline=(SELECT COALESCE(MAX(position),0) FROM conversation_publications)').run();
  db.prepare('UPDATE thread_summary_meta SET unread_ready=1 WHERE id=1').run();
}
