import type Database from 'better-sqlite3';

export interface ThreadTitleKey {
  channelType: string;
  platformId: string | null;
  threadId: string | null;
}

export interface StageThreadTitle extends ThreadTitleKey {
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

export function stageThreadTitle(db: Database.Database, input: StageThreadTitle): boolean {
  const title = normalizeThreadTitle(input.title);
  if (!title || !input.channelType || !input.requestMessageId) return false;
  const result = db
    .prepare(
      `INSERT INTO thread_titles
         (channel_type, platform_id, thread_id, title, source, request_message_id, published, updated_at)
       VALUES (@channelType, @platformId, @threadId, @title, 'model', @requestMessageId, 0, datetime('now'))
       ON CONFLICT(channel_type, platform_id, thread_id) DO NOTHING`,
    )
    .run({ ...keyParams(input), title, requestMessageId: input.requestMessageId });
  return result.changes > 0;
}

export function publishThreadTitle(db: Database.Database, key: ThreadTitleKey, requestMessageId: string): boolean {
  const result = db
    .prepare(
      `UPDATE thread_titles
          SET published = 1, updated_at = datetime('now')
        WHERE channel_type = @channelType
          AND platform_id = @platformId
          AND thread_id = @threadId
          AND request_message_id = @requestMessageId
          AND published = 0`,
    )
    .run({ ...keyParams(key), requestMessageId });
  return result.changes > 0;
}

export function readPublishedThreadTitle(db: Database.Database, key: ThreadTitleKey): string | null {
  const row = db
    .prepare(
      `SELECT title
         FROM thread_titles
        WHERE channel_type = @channelType
          AND platform_id = @platformId
          AND thread_id = @threadId
          AND published = 1`,
    )
    .get(keyParams(key)) as { title: string } | undefined;
  return row?.title ?? null;
}

export function publishTitlesForDeliveredReplies(inDb: Database.Database, outDb: Database.Database): number {
  const pending = inDb
    .prepare(
      `SELECT channel_type, platform_id, thread_id, request_message_id
         FROM thread_titles
        WHERE published = 0`,
    )
    .all() as Array<{
    channel_type: string;
    platform_id: string;
    thread_id: string;
    request_message_id: string;
  }>;
  const replyStmt = outDb.prepare(
    `SELECT id
       FROM messages_out
      WHERE kind IN ('chat', 'text', 'chat-sdk')
        AND (
          in_reply_to = @requestMessageId
          OR (
            channel_type = @channelType
            AND COALESCE(platform_id, '') = @platformId
            AND COALESCE(thread_id, '') = @threadId
          )
        )
      ORDER BY seq
      LIMIT 1`,
  );
  const deliveredStmt = inDb.prepare(
    `SELECT 1
       FROM delivered
      WHERE message_out_id = ? AND status = 'delivered'`,
  );
  let published = 0;
  for (const row of pending) {
    const reply = replyStmt.get({
      requestMessageId: row.request_message_id,
      channelType: row.channel_type,
      platformId: row.platform_id,
      threadId: row.thread_id,
    }) as { id: string } | undefined;
    if (!reply || !deliveredStmt.get(reply.id)) continue;
    if (
      publishThreadTitle(
        inDb,
        { channelType: row.channel_type, platformId: row.platform_id, threadId: row.thread_id },
        row.request_message_id,
      )
    ) {
      published += 1;
    }
  }
  return published;
}
