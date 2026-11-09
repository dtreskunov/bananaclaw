import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

import { DATA_DIR } from './config.js';
import { getDb, hasTable } from './db/connection.js';
import { ensureSchema } from './db/session-db.js';
import { isEpochMs } from './time.js';
import { extractDisplayQuery, HA_CHANNEL_TYPE } from './channels/homeassistant-text.js';
import { onHostChange, publishHostChange } from './host-changes.js';
import type { LiveTaskDto } from './ui/shared/thread.js';
export type SummaryTask = LiveTaskDto;
import {
  projectMessagePublications,
  projectInteractionPublications,
  finishUnreadBootstrap,
} from './conversation-publications.js';

const failures = new WeakMap<Database.Database, Map<string, unknown>>();
function projectionErrors(db = getDb()): Map<string, unknown> {
  let errors = failures.get(db);
  if (!errors) {
    errors = new Map();
    failures.set(db, errors);
  }
  return errors;
}

interface Route {
  channel_type: string;
  platform_id: string;
  thread_id: string;
}
interface DirtyRoute extends Route {
  kind: 'route' | 'usage' | 'turn';
  revision: number;
}
interface SummaryRow extends Route {
  source: 'inbound' | 'outbound';
  kind: DirtyRoute['kind'];
  value: string;
}
interface InboundSummary {
  count: number;
  pendingAt: number | null;
  last: number | null;
  first: { seq: number; title: string } | null;
  owners: { seq: number; handles: string[] }[];
  title: string | null;
  tasks: (SummaryTask & { seq: number })[];
}
interface OutboundSummary {
  count: number;
  last: number | null;
}
export interface SummaryTurn {
  id: string;
  phase: string;
  started_at: number | null;
}
export interface ThreadSummarySpec {
  agentGroupId: string;
  sessionId: string;
  thread?: { channelType: string; platformId: string; threadId: string };
}
export interface SummarizedThread {
  channelType: string;
  platformId: string;
  threadId: string;
  title: string;
  messageCount: number;
  lastActivityAt: number | null;
  liveTasks?: SummaryTask[];
}
export interface SessionThreadSummary {
  threads: SummarizedThread[];
  owners: string[];
  dms: { channelType: string; platformId: string; messageCount: number; lastActivityAt: number | null }[];
  dmReplies: { channelType: string; messageCount: number; lastActivityAt: number | null }[];
  totalCost: number;
  totalTokens: number;
  turnCount: number;
  peerMessages?: { messageCount: number; lastActivityAt: number | null };
}

function parsedContent(content: string): unknown {
  try {
    return JSON.parse(content);
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    return content;
  }
}
function contentObject(content: string): Record<string, unknown> {
  const value = parsedContent(content);
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

export function summarizeTaskPrompt(content: string): string {
  const parsed = parsedContent(content);
  const prompt = typeof parsed === 'string' ? parsed : contentObject(content).prompt;
  const line =
    typeof prompt === 'string'
      ? prompt
          .split('\n')
          .map((part) => part.trim())
          .find(Boolean)
      : undefined;
  return line ? (line.length > 80 ? `${line.slice(0, 77)}\u2026` : line) : 'Scheduled task';
}

function fallbackTitle(channel: string, content: string): string {
  const parsed = parsedContent(content);
  const object = contentObject(content);
  if (channel === 'resend') {
    const metadata = object.metadata;
    const headers = object.headers;
    const subject =
      object.subject ??
      (metadata && typeof metadata === 'object' && 'subject' in metadata ? metadata.subject : undefined) ??
      (headers && typeof headers === 'object' && 'subject' in headers ? headers.subject : undefined);
    if (typeof subject === 'string' && subject.trim()) return subject.trim();
  }
  const text =
    object.cancelled === true
      ? ''
      : typeof parsed === 'string' && parsed !== content
        ? parsed
        : typeof object.text === 'string'
          ? object.text
          : '';
  return channel === HA_CHANNEL_TYPE ? extractDisplayQuery(text) : text;
}

function title(text: string): string {
  return (
    text
      .replace(/^>\s*Context.*\n+/i, '')
      .replace(/\s+/g, ' ')
      .trim() || '(new thread)'
  );
}
function latest(values: (number | null)[]): number | null {
  return values.reduce<number | null>((last, value) =>
    value === null ? last : last === null ? value : Math.max(last, value), null);
}

function summarizeInbound(db: Database.Database, route: Route): InboundSummary {
  const params = [route.channel_type, route.platform_id, route.thread_id];
  const where = `channel_type = ? AND COALESCE(platform_id, '') = ? AND COALESCE(thread_id, '') = ?`;
  const count =
    db
      .prepare(
        `SELECT COUNT(*) AS count, MAX(timestamp) AS last,
      MIN(CASE WHEN status = 'pending' AND trigger = 1 AND kind != 'system'
        THEN CASE WHEN process_after IS NULL THEN 0
          ELSE process_after END END) AS pendingAt
      FROM messages_in WHERE ${where}`,
      )
      .get(...params) as Pick<InboundSummary, 'count' | 'last' | 'pendingAt'>;
  const first = db
    .prepare(`SELECT seq, content, platform_id FROM messages_in WHERE ${where} ORDER BY seq LIMIT 5`)
    .all(...params) as { seq: number; content: string; platform_id: string }[];
  const explicit = db
    .prepare(`SELECT title FROM thread_titles WHERE channel_type=? AND platform_id=? AND thread_id=?`)
    .get(...params) as { title: string } | undefined;
  const tasks = db
    .prepare(
      `
    SELECT series_id, status, process_after, recurrence, content, MAX(seq) AS seq
    FROM messages_in WHERE ${where} AND kind='task' AND status IN ('pending','paused')
      AND COALESCE(json_extract(content,'$.triggerSource'),'scheduled') != 'manual'
    GROUP BY series_id ORDER BY (process_after IS NULL), process_after
  `,
    )
    .all(...params) as {
    series_id: string;
    status: string;
    process_after: number | null;
    recurrence: string | null;
    content: string;
    seq: number;
  }[];
  return {
    ...count,
    first: first[0] ? { seq: first[0].seq, title: fallbackTitle(route.channel_type, first[0].content) } : null,
    owners: first.map((row) => {
      const object = contentObject(row.content);
      const sender = typeof object.sender === 'string' ? object.sender : object.from;
      return { seq: row.seq, handles: [row.platform_id, ...(typeof sender === 'string' ? [sender] : [])] };
    }),
    title: explicit?.title ?? null,
    tasks: tasks.map((task) => ({
      seriesId: task.series_id,
      nextRunAt: task.process_after,
      recurrence: task.recurrence,
      summary: summarizeTaskPrompt(task.content),
      paused: task.status === 'paused',
      seq: task.seq,
    })),
  };
}

function summarizeSource(db: Database.Database, source: SummaryRow['source'], route: DirtyRoute): unknown {
  if (route.kind === 'usage')
    return db
      .prepare(
        `
    SELECT COALESCE(SUM(cost_usd),0) AS totalCost,
      COALESCE(SUM(input_tokens + output_tokens),0) AS totalTokens, COUNT(*) AS turnCount FROM turn_usage
  `,
      )
      .get();
  if (route.kind === 'turn')
    return (
      db
        .prepare(
          `
    SELECT id, phase, started_at FROM turns WHERE COALESCE(origin_channel_type,'')=?
      AND COALESCE(origin_platform_id,'')=? AND COALESCE(origin_thread_id,'')=?
    ORDER BY started_at DESC, id DESC LIMIT 1
  `,
        )
        .get(route.channel_type, route.platform_id, route.thread_id) ?? null
    ) as SummaryTurn | null;
  if (source === 'inbound') return summarizeInbound(db, route);
  return (
    db
      .prepare(
        `
    SELECT COUNT(*) AS count, MAX(timestamp) AS last FROM messages_out
    WHERE COALESCE(channel_type,'')=? AND COALESCE(platform_id,'')=? AND COALESCE(thread_id,'')=?
      AND kind IN ('chat','text')
  `,
      )
      .get(route.channel_type, route.platform_id, route.thread_id)
  ) as OutboundSummary;
}

export function assertThreadSummariesReady(): void {
  const ready = getDb().prepare('SELECT ready FROM thread_summary_meta WHERE id=1').pluck().get();
  if (ready !== 1)
    throw new Error(
      'Thread summaries require offline backfill: pnpm exec tsx scripts/rebuild-thread-summaries.ts --host-stopped',
    );
}

/** Source markers and data commit together; acknowledge only after the central copy commits. */
export function refreshThreadSummaries(sessionId: string, dataDir = DATA_DIR): void {
  const central = getDb();
  const session = central.prepare('SELECT agent_group_id FROM sessions WHERE id=?').get(sessionId) as
    | { agent_group_id: string }
    | undefined;
  if (!session) return;
  const errors = projectionErrors(central);
  const recovering = errors.has(sessionId);
  let changed = 0;
  try {
    for (const source of ['inbound', 'outbound'] as const) {
      const file = path.join(dataDir, 'v2-sessions', session.agent_group_id, sessionId, `${source}.db`);
      fs.accessSync(file);
      const db = new Database(file);
      try {
        db.pragma('busy_timeout = 250');
        if (!hasTable(db, 'thread_summary_dirty'))
          throw new Error(`Missing thread summary markers in ${file}; run the offline backfill`);
        const dirty = db.prepare('SELECT * FROM thread_summary_dirty').all() as DirtyRoute[];
        if (!dirty.length) continue;
        const values = dirty.map((route) => ({ route, value: JSON.stringify(summarizeSource(db, source, route)) }));
        central.transaction(() => {
          const upsert = central.prepare(`
            INSERT INTO thread_summaries VALUES (?,?,?,?,?,?,?)
            ON CONFLICT(session_id,source,kind,channel_type,platform_id,thread_id)
            DO UPDATE SET value=excluded.value WHERE value != excluded.value
          `);
          for (const { route, value } of values)
            changed += upsert.run(
              sessionId,
              source,
              route.kind,
              route.channel_type,
              route.platform_id,
              route.thread_id,
              value,
            ).changes;
          if (source === 'outbound' && dirty.some((route) => route.kind !== 'usage'))
            changed += projectMessagePublications(db, sessionId);
          if (source === 'inbound') changed += projectInteractionPublications(sessionId, true);
        })();
        const acknowledge = db.prepare(
          `DELETE FROM thread_summary_dirty WHERE kind=? AND channel_type=? AND platform_id=? AND thread_id=? AND revision=?`,
        );
        db.transaction(() => {
          for (const { route } of values)
            acknowledge.run(route.kind, route.channel_type, route.platform_id, route.thread_id, route.revision);
        })();
      } finally {
        db.close();
      }
    }
    errors.delete(sessionId);
  } catch (error) {
    errors.set(sessionId, error);
    throw error;
  }
  if (changed || recovering)
    publishHostChange({ kind: 'thread-summaries', sessionId, groupId: session.agent_group_id });
}

export function reconcileThreadSummaries(groupId?: string, dataDir = DATA_DIR): void {
  assertThreadSummariesReady();
  if (getDb().prepare(`SELECT 1 FROM thread_summaries s,json_tree(s.value) field
    WHERE field.key IN ('last','nextRunAt','started_at') AND field.type NOT IN ('integer','null') LIMIT 1`).get())
    throw new Error('Numeric thread summaries require offline backfill: pnpm exec tsx scripts/rebuild-thread-summaries.ts --host-stopped');
  const sessions = getDb()
    .prepare(`SELECT id FROM sessions${groupId ? ' WHERE agent_group_id=?' : ''}`)
    .all(...(groupId ? [groupId] : [])) as { id: string }[];
  for (const session of sessions) refreshThreadSummaries(session.id, dataDir);
}

/** Explicit offline installation/backfill; normal startup only drains committed dirty routes. */
export function rebuildThreadSummaries(dataDir = DATA_DIR): void {
  const central = getDb();
  central.prepare('UPDATE thread_summary_meta SET ready=0 WHERE id=1').run();
  central.exec('DELETE FROM thread_summaries;');
  const sessions = central.prepare('SELECT id, agent_group_id FROM sessions').all() as {
    id: string;
    agent_group_id: string;
  }[];
  for (const session of sessions) {
    for (const source of ['inbound', 'outbound'] as const) {
      const file = path.join(dataDir, 'v2-sessions', session.agent_group_id, session.id, `${source}.db`);
      fs.accessSync(file);
      const db = new Database(file);
      try {
        if (source === 'inbound') db.exec('DROP TRIGGER IF EXISTS thread_summary_messages_in_update');
        ensureSchema(file, source);
        const table = source === 'inbound' ? 'messages_in' : 'messages_out';
        const routes = db
          .prepare(
            `SELECT DISTINCT COALESCE(channel_type,'') AS channel_type,
          COALESCE(platform_id,'') AS platform_id, COALESCE(thread_id,'') AS thread_id FROM ${table}
          ${source === 'inbound' ? `UNION SELECT channel_type,platform_id,thread_id FROM thread_titles` : ''}`,
          )
          .all() as Route[];
        const marker = db.prepare(`INSERT OR REPLACE INTO thread_summary_dirty VALUES (?,?,?,?,?)`);
        db.transaction(() => {
          db.prepare('UPDATE thread_summary_clock SET revision=revision+1 WHERE id=1').run();
          const revision = db.prepare('SELECT revision FROM thread_summary_clock WHERE id=1').pluck().get() as number;
          for (const route of routes)
            marker.run('route', route.channel_type, route.platform_id, route.thread_id, revision);
          if (source === 'outbound') {
            marker.run('usage', '', '', '', revision);
            const turns = db
              .prepare(
                `SELECT DISTINCT COALESCE(origin_channel_type,'') AS channel_type,
              COALESCE(origin_platform_id,'') AS platform_id, COALESCE(origin_thread_id,'') AS thread_id FROM turns`,
              )
              .all() as Route[];
            for (const route of turns)
              marker.run('turn', route.channel_type, route.platform_id, route.thread_id, revision);
          }
        })();
      } finally {
        db.close();
      }
    }
    refreshThreadSummaries(session.id, dataDir);
  }
  for (const session of sessions) projectInteractionPublications(session.id);
  finishUnreadBootstrap();
  central.prepare('UPDATE thread_summary_meta SET ready=1 WHERE id=1').run();
}

export function assertThreadSummaryAvailable(sessionId: string): void {
  const errors = projectionErrors();
  if (errors.has(sessionId)) {
    const error = errors.get(sessionId);
    throw new Error(
      `Thread summary projection unavailable: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

function sourceRows(sessionId: string, turnsOnly = false): SummaryRow[] {
  assertThreadSummariesReady();
  assertThreadSummaryAvailable(sessionId);
  return getDb()
    .prepare(
      `SELECT * FROM thread_summaries WHERE session_id=?${turnsOnly ? " AND source='outbound' AND kind='turn'" : ''}`,
    )
    .all(sessionId) as SummaryRow[];
}

export function readSummaryTurns(sessionId: string): (Route & SummaryTurn)[] {
  return sourceRows(sessionId, true).flatMap((row) => {
    const turn = JSON.parse(row.value) as SummaryTurn | null;
    if (turn) assertNumericSummaryTime(turn.started_at);
    return turn ? [{ ...row, ...turn }] : [];
  });
}

function assertNumericSummaryTime(value: unknown): void {
  if (value !== null && !isEpochMs(value))
    throw new Error('Numeric thread summaries require offline backfill: pnpm exec tsx scripts/rebuild-thread-summaries.ts --host-stopped');
}

function readInboundSummary(row: SummaryRow): InboundSummary {
  const value = JSON.parse(row.value) as InboundSummary;
  if (value.pendingAt === undefined)
    throw new Error(
      'Thread queue summaries require offline backfill: pnpm exec tsx scripts/rebuild-thread-summaries.ts --host-stopped',
    );
  assertNumericSummaryTime(value.last);
  for (const task of value.tasks) assertNumericSummaryTime(task.nextRunAt);
  return value;
}

export function readSummaryQueuedRoutes(sessionId: string): Route[] {
  return sourceRows(sessionId).filter((row) => {
    if (row.source !== 'inbound' || row.kind !== 'route') return false;
    const { pendingAt } = readInboundSummary(row);
    return pendingAt !== null && pendingAt <= Date.now();
  });
}

/** Central indexed summaries only; no session DB handles, history scans or viewer cache. */
export function readSessionThreadSummary(spec: ThreadSummarySpec): SessionThreadSummary {
  const rows = sourceRows(spec.sessionId);
  const inbound = rows
    .filter((row) => row.kind === 'route' && row.source === 'inbound')
    .map((row) => ({ ...row, data: readInboundSummary(row) }));
  const outbound = rows
    .filter((row) => row.kind === 'route' && row.source === 'outbound')
    .map((row) => {
      const data = JSON.parse(row.value) as OutboundSummary;
      assertNumericSummaryTime(data.last);
      return { ...row, data };
    })
    .filter((row) => row.data.count > 0);
  const usage = rows.find((row) => row.kind === 'usage');
  const result: SessionThreadSummary = {
    threads: [],
    owners: [],
    dms: [],
    dmReplies: [],
    ...(usage
      ? (JSON.parse(usage.value) as Pick<SessionThreadSummary, 'totalCost' | 'totalTokens' | 'turnCount'>)
      : { totalCost: 0, totalTokens: 0, turnCount: 0 }),
  };
  const peers = [...inbound, ...outbound].filter((row) =>
    row.channel_type === 'agent' && row.platform_id !== spec.agentGroupId && !row.thread_id);
  const peerCount = peers.reduce((count, row) => count + row.data.count, 0);
  if (peerCount) result.peerMessages = {
    messageCount: peerCount,
    lastActivityAt: latest(peers.map((row) => row.data.last)),
  };
  const replies = (channel: string, thread: string) =>
    outbound.filter((row) => row.channel_type === channel && row.thread_id === thread);
  const addThread = (key: NonNullable<ThreadSummarySpec['thread']>, inputs: typeof inbound) => {
    const first = inputs.flatMap((row) => (row.data.first ? [row.data.first] : [])).sort((a, b) => a.seq - b.seq)[0];
    const explicit = inbound.find(
      (row) =>
        row.channel_type === key.channelType && row.platform_id === key.platformId && row.thread_id === key.threadId,
    )?.data.title;
    const outputs = replies(key.channelType, key.threadId);
    const series = new Map<string, SummaryTask & { seq: number }>();
    for (const task of inputs.flatMap((row) => row.data.tasks))
      if (!series.has(task.seriesId) || series.get(task.seriesId)!.seq < task.seq) series.set(task.seriesId, task);
    const tasks = [...series.values()].map(({ seq: _seq, ...task }) => task);
    result.threads.push({
      ...key,
      title: title(explicit ?? first?.title ?? ''),
      messageCount:
        inputs.reduce((n, row) => n + row.data.count, 0) + outputs.reduce((n, row) => n + row.data.count, 0),
      lastActivityAt: latest([...inputs.map((row) => row.data.last), ...outputs.map((row) => row.data.last)]),
      ...(spec.thread && tasks.length
        ? {
            liveTasks: tasks.sort((a, b) =>
              a.nextRunAt === null ? 1 : b.nextRunAt === null ? -1 : a.nextRunAt - b.nextRunAt,
            ),
          }
        : {}),
    });
    if (spec.thread)
      result.owners = inputs
        .flatMap((row) => row.data.owners)
        .sort((a, b) => a.seq - b.seq)
        .slice(0, 5)
        .flatMap((row) => row.handles);
  };
  if (spec.thread)
    addThread(
      spec.thread,
      inbound.filter((row) => row.channel_type === spec.thread!.channelType && row.thread_id === spec.thread!.threadId),
    );
  else
    for (const row of inbound) {
      if (!row.data.count) continue;
      if (!row.thread_id)
        result.dms.push({
          channelType: row.channel_type,
          platformId: row.platform_id,
          messageCount: row.data.count,
          lastActivityAt: row.data.last,
        });
      else addThread({ channelType: row.channel_type, platformId: row.platform_id, threadId: row.thread_id }, [row]);
    }
  for (const channel of new Set(outbound.filter((row) => !row.thread_id).map((row) => row.channel_type))) {
    const outputs = replies(channel, '');
    result.dmReplies.push({
      channelType: channel,
      messageCount: outputs.reduce((n, row) => n + row.data.count, 0),
      lastActivityAt: latest(outputs.map((row) => row.data.last)),
    });
  }
  return result;
}

export function startThreadSummaryProjection(): () => void {
  assertThreadSummariesReady();
  return onHostChange((change) => {
    if (change.kind === 'sessions' && change.sessionId) refreshThreadSummaries(change.sessionId);
    else if (change.kind === 'sessions' || change.kind === 'access')
      reconcileThreadSummaries(change.groupId ?? undefined);
  });
}
