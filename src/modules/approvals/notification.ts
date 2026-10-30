import { randomUUID } from 'node:crypto';

import { getMessagingGroup } from '../../db/messaging-groups.js';
import { log } from '../../log.js';
import { openInboundDb, writeSessionMessage } from '../../session-manager.js';
import type { Session } from '../../types.js';

export interface ApprovalNotificationOptions {
  originMessageId?: string | null;
  id?: string;
  timestamp?: string;
  afterRestart?: boolean;
  idempotent?: boolean;
}

export function writeApprovalNotification(
  session: Session,
  text: string,
  options: ApprovalNotificationOptions = {},
): void {
  const mg = session.messaging_group_id ? getMessagingGroup(session.messaging_group_id) : undefined;
  let routing = {
    channelType: mg?.channel_type ?? null,
    platformId: mg?.platform_id ?? null,
    threadId: session.thread_id,
    sourceSessionId: null as string | null,
  };
  if (options.originMessageId) {
    const db = openInboundDb(session.agent_group_id, session.id);
    try {
      const origin = db
        .prepare('SELECT channel_type, platform_id, thread_id, source_session_id FROM messages_in WHERE id = ?')
        .get(options.originMessageId) as
        | {
            channel_type: string | null;
            platform_id: string | null;
            thread_id: string | null;
            source_session_id: string | null;
          }
        | undefined;
      if (!origin) throw new Error(`Approval origin message not found: ${options.originMessageId}`);
      routing = {
        channelType: origin.channel_type,
        platformId: origin.platform_id,
        threadId: origin.thread_id,
        sourceSessionId: origin.source_session_id,
      };
    } finally {
      db.close();
    }
  }
  if (!routing.channelType || !routing.platformId) {
    log.warn('Approval notification has no reply destination', {
      sessionId: session.id,
      originMessageId: options.originMessageId,
    });
  }
  writeSessionMessage(session.agent_group_id, session.id, {
    id: options.id ?? `appr-note-${randomUUID()}`,
    kind: 'chat',
    timestamp: options.timestamp ?? new Date().toISOString(),
    ...routing,
    content: JSON.stringify({
      text,
      sender: 'system',
      senderId: 'system',
      inputHandling: { mode: 'steer' },
    }),
    ...(options.afterRestart ? { onWake: 1 as const } : {}),
    ...(options.idempotent ? { idempotent: true } : {}),
  });
}
