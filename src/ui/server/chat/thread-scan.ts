import Database from 'better-sqlite3';
import path from 'node:path';

import { extractDisplayQuery, HA_CHANNEL_TYPE } from '../../../channels/homeassistant-text.js';
import { readThreadTitle } from '../../../modules/thread-titles/db.js';
import type { LiveTaskDto } from './chat.js';

export interface ThreadScanSpec {
  agentGroupId: string;
  sessionId: string;
  thread?: { channelType: string; platformId: string; threadId: string };
}

export interface ScannedThread {
  channelType: string;
  platformId: string;
  threadId: string;
  title: string;
  messageCount: number;
  lastActivityAt: string;
  liveTasks?: LiveTaskDto[];
}

export interface SessionThreadScan {
  threads: ScannedThread[];
  owners: string[];
  dms: { channelType: string; platformId: string; messageCount: number; lastActivityAt: string }[];
  dmReplies: { channelType: string; messageCount: number; lastActivityAt: string }[];
  totalCost: number;
  totalTokens: number;
  turnCount: number;
}

function parsedContent(content: string): unknown {
  try {
    return JSON.parse(content);
  } catch (error) {
    if (error instanceof SyntaxError) return content;
    throw error;
  }
}

function contentObject(content: string): Record<string, unknown> {
  const parsed = parsedContent(content);
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
}

export function summarizeTaskPrompt(content: string): string {
  const parsed = parsedContent(content);
  const prompt = typeof parsed === 'string' ? parsed : contentObject(content).prompt;
  const line =
    (typeof prompt === 'string' ? prompt : '')
      .split('\n')
      .map((s) => s.trim())
      .find(Boolean) || 'Scheduled task';
  return line.length > 80 ? line.slice(0, 77) + '\u2026' : line;
}

function extractTitle(channelType: string, content: string): string {
  const parsed = parsedContent(content);
  const object = contentObject(content);
  if (channelType === 'resend') {
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
  return channelType === HA_CHANNEL_TYPE ? extractDisplayQuery(text) : text;
}

function finalizeTitle(title: string): string {
  return (
    title
      .replace(/^>\s*Context.*\n+/i, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 60) || '(new thread)'
  );
}

function latest(...timestamps: (string | null)[]): string {
  return (
    timestamps
      .filter((s): s is string => !!s)
      .sort((a, b) => Date.parse(b.includes('T') ? b : b + 'Z') - Date.parse(a.includes('T') ? a : a + 'Z'))[0] || ''
  );
}

interface CountRow {
  channel_type: string;
  platform_id: string;
  thread_id: string | null;
  n: number;
  max_ts: string | null;
}

/** Worker-only reads: no host services, schema writes, or runner-private databases. */
export function scanThreadSession(dataDir: string, spec: ThreadScanSpec): SessionThreadScan {
  const directory = path.join(dataDir, 'v2-sessions', spec.agentGroupId, spec.sessionId);
  const inbound = new Database(path.join(directory, 'inbound.db'), { readonly: true, timeout: 250 });
  try {
    const outbound = new Database(path.join(directory, 'outbound.db'), { readonly: true, timeout: 250 });
    try {
      const usage = outbound
        .prepare(
          `SELECT COALESCE(SUM(cost_usd), 0) AS totalCost,
                COALESCE(SUM(input_tokens + output_tokens), 0) AS totalTokens,
                COUNT(*) AS turnCount FROM turn_usage`,
        )
        .get() as Pick<SessionThreadScan, 'totalCost' | 'totalTokens' | 'turnCount'>;
      const result: SessionThreadScan = { threads: [], owners: [], dms: [], dmReplies: [], ...usage };
      const replies = outbound
        .prepare(
          `SELECT channel_type, thread_id, COUNT(*) AS n, MAX(timestamp) AS max_ts
         FROM messages_out WHERE kind IN ('chat', 'text') GROUP BY channel_type, thread_id`,
        )
        .all() as CountRow[];

      const groups = spec.thread
        ? (inbound
            .prepare(
              `SELECT channel_type, COUNT(*) AS n, MAX(timestamp) AS max_ts FROM messages_in
           WHERE channel_type = ? AND thread_id = ?`,
            )
            .all(spec.thread.channelType, spec.thread.threadId) as CountRow[])
        : (inbound
            .prepare(
              `SELECT channel_type, platform_id, thread_id, COUNT(*) AS n, MAX(timestamp) AS max_ts
           FROM messages_in GROUP BY channel_type, platform_id, thread_id`,
            )
            .all() as CountRow[]);

      for (const group of groups) {
        if (!spec.thread && group.thread_id === null) {
          result.dms.push({
            channelType: group.channel_type,
            platformId: group.platform_id,
            messageCount: group.n,
            lastActivityAt: group.max_ts || '',
          });
          continue;
        }
        const key = spec.thread ?? {
          channelType: group.channel_type,
          platformId: group.platform_id,
          threadId: group.thread_id!,
        };
        const first = spec.thread
          ? (inbound
              .prepare('SELECT content FROM messages_in WHERE channel_type = ? AND thread_id = ? ORDER BY seq LIMIT 1')
              .get(key.channelType, key.threadId) as { content: string } | undefined)
          : (inbound
              .prepare(
                `SELECT content FROM messages_in WHERE channel_type = ? AND platform_id = ?
             AND thread_id = ? ORDER BY seq LIMIT 1`,
              )
              .get(key.channelType, key.platformId, key.threadId) as { content: string } | undefined);
        const title = readThreadTitle(inbound, key);
        const reply = replies.find((r) => r.channel_type === key.channelType && r.thread_id === key.threadId);
        result.threads.push({
          ...key,
          title: finalizeTitle(title ?? (first ? extractTitle(key.channelType, first.content) : '')),
          messageCount: group.n + (reply?.n ?? 0),
          lastActivityAt: latest(group.max_ts, reply?.max_ts ?? null),
        });
      }
      for (const reply of replies.filter((r) => r.thread_id === null)) {
        result.dmReplies.push({
          channelType: reply.channel_type,
          messageCount: reply.n,
          lastActivityAt: reply.max_ts || '',
        });
      }
      if (spec.thread) {
        const { channelType, threadId } = spec.thread;
        const firstMessages = inbound
          .prepare(
            'SELECT content, platform_id FROM messages_in WHERE channel_type = ? AND thread_id = ? ORDER BY seq LIMIT 5',
          )
          .all(channelType, threadId) as { content: string; platform_id: string }[];
        for (const row of firstMessages) {
          result.owners.push(row.platform_id);
          const content = contentObject(row.content);
          const sender = typeof content.sender === 'string' ? content.sender : content.from;
          if (typeof sender === 'string') result.owners.push(sender);
        }
        const tasks = inbound
          .prepare(
            `SELECT series_id, status, process_after, recurrence, content, MAX(seq)
           FROM messages_in WHERE kind = 'task' AND status IN ('pending', 'paused')
             AND COALESCE(json_extract(content, '$.triggerSource'), 'scheduled') != 'manual'
             AND channel_type = ? AND thread_id = ?
           GROUP BY series_id ORDER BY (process_after IS NULL) ASC, process_after ASC`,
          )
          .all(channelType, threadId) as {
          series_id: string;
          status: string;
          process_after: string | null;
          recurrence: string | null;
          content: string;
        }[];
        if (tasks.length)
          result.threads[0].liveTasks = tasks.map((task) => ({
            seriesId: task.series_id,
            nextRunAt: task.process_after,
            recurrence: task.recurrence,
            summary: summarizeTaskPrompt(task.content),
            paused: task.status === 'paused',
          }));
      }
      return result;
    } finally {
      outbound.close();
    }
  } finally {
    inbound.close();
  }
}
