import type Database from 'better-sqlite3';

import { log } from '../../log.js';
import type { Session } from '../../types.js';
import { stageThreadTitle } from './db.js';

export async function handleSetThreadTitle(
  content: Record<string, unknown>,
  session: Session,
  inDb: Database.Database,
): Promise<void> {
  const channelType = typeof content.channelType === 'string' ? content.channelType : '';
  const platformId = typeof content.platformId === 'string' ? content.platformId : null;
  const threadId = typeof content.threadId === 'string' ? content.threadId : null;
  const requestMessageId = typeof content.requestMessageId === 'string' ? content.requestMessageId : '';
  const title = typeof content.title === 'string' ? content.title : '';

  const inbound = requestMessageId
    ? inDb
        .prepare(
          `SELECT 1
             FROM messages_in
            WHERE id = @requestMessageId
              AND channel_type = @channelType
              AND COALESCE(platform_id, '') = @platformId
              AND COALESCE(thread_id, '') = @threadId`,
        )
        .get({
          requestMessageId,
          channelType,
          platformId: platformId ?? '',
          threadId: threadId ?? '',
        })
    : undefined;
  if (!inbound || (session.thread_id && session.thread_id !== threadId)) {
    log.warn('Rejected thread title with mismatched routing', { sessionId: session.id, requestMessageId });
    return;
  }

  const staged = stageThreadTitle(inDb, { channelType, platformId, threadId, title, requestMessageId });
  if (staged) log.info('Thread title staged', { sessionId: session.id, threadId });
}
