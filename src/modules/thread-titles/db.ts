import type Database from 'better-sqlite3';
import { invalidateSessionDatabase } from '../../conversation-events.js';

export interface ThreadTitleKey {
  channelType: string;
  platformId: string | null;
  threadId: string | null;
}

export interface ThreadTitleUpdate extends ThreadTitleKey {
  title: string;
  requestMessageId: string;
}

function keyParams(key: ThreadTitleKey): { channelType: string; platformId: string; threadId: string } {
  return {
    channelType: key.channelType,
    platformId: key.platformId ?? '',
    threadId: key.threadId ?? '',
  };
}

export function normalizeThreadTitle(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const title = value.replace(/\s+/g, ' ').trim();
  if (!title || title === '(new thread)') return null;
  return title.slice(0, 60);
}

export function upsertThreadTitle(db: Database.Database, input: ThreadTitleUpdate): boolean {
  const title = normalizeThreadTitle(input.title);
  if (!title || !input.channelType || !input.requestMessageId) return false;
  const result = db
    .prepare(
      `INSERT INTO thread_titles
         (channel_type, platform_id, thread_id, title, source, request_message_id, published, updated_at)
       VALUES (@channelType, @platformId, @threadId, @title, 'model', @requestMessageId, 1, datetime('now'))
       ON CONFLICT(channel_type, platform_id, thread_id) DO UPDATE SET
         title = excluded.title,
         request_message_id = excluded.request_message_id,
         published = 1,
         updated_at = excluded.updated_at`,
    )
    .run({ ...keyParams(input), title, requestMessageId: input.requestMessageId });
  if (result.changes) invalidateSessionDatabase(db.name);
  return result.changes > 0;
}

export function readThreadTitle(db: Database.Database, key: ThreadTitleKey): string | null {
  const row = db
    .prepare(
      `SELECT title
         FROM thread_titles
        WHERE channel_type = @channelType
          AND platform_id = @platformId
          AND thread_id = @threadId`,
    )
    .get(keyParams(key)) as { title: string } | undefined;
  return row?.title ?? null;
}
