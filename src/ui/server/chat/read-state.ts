import { getDb } from '../../../db/connection.js';
import { transaction, recordHostChange } from '../../../db/transaction.js';
import { hasAdminPrivilege } from '../../../modules/permissions/db/user-roles.js';
import { assertUnreadReady } from '../../../conversation-publications.js';
import type { ReadCursor } from '../../shared/read-state.js';
import type { Conversation } from '../../shared/conversation.js';
import { resolveTurnContext, type TurnContext } from './conversation-context.js';

interface Publication {
  position: number;
  key: string;
  session_id: string;
  channel_type: string;
  platform_id: string;
  thread_id: string;
  kind: string;
  item_id: string;
}

function visiblePublications(
  userId: string,
  groupId: string,
  context: TurnContext,
  item?: { kind: 'message' | 'approval'; id: string },
): Publication[] {
  assertUnreadReady();
  if (!context.sessionId || !context.platformIds.length) return [];
  return getDb()
    .prepare(
      `SELECT * FROM conversation_publications WHERE session_id=? AND channel_type=?
    AND thread_id=? AND platform_id IN (${context.platformIds.map(() => '?')}) AND visible=1
    AND (kind!='approval' OR ?=1) ${item ? 'AND kind=? AND item_id=?' : ''} ORDER BY position`,
    )
    .all(
      context.sessionId,
      context.channelType,
      context.threadId ?? '',
      ...context.platformIds,
      Number(hasAdminPrivilege(userId, groupId)),
      ...(item ? [item.kind, item.id] : []),
    ) as Publication[];
}

function baselineFor(userId: string): number {
  const baseline = getDb().prepare('SELECT unread_baseline FROM users WHERE id=?').pluck().get(userId) as number;
  if (typeof baseline !== 'number') throw new Error('Unread viewer does not exist');
  return baseline;
}

export function newestUnreadPublication(
  userId: string,
  groupId: string,
  context: TurnContext,
): Publication | undefined {
  if (context.channelType !== 'web') return undefined;
  const db = getDb();
  const baseline = baselineFor(userId);
  const reads = db
    .prepare(
      `SELECT platform_id,position FROM conversation_reads
    WHERE user_id=? AND session_id=? AND channel_type=? AND thread_id=?
      AND platform_id IN (${context.platformIds.map(() => '?')})`,
    )
    .all(userId, context.sessionId ?? '', context.channelType, context.threadId ?? '', ...context.platformIds) as {
    platform_id: string;
    position: number;
  }[];
  const positions = new Map(reads.map((row) => [row.platform_id, row.position]));
  return visiblePublications(userId, groupId, context)
    .filter((row) => row.position > Math.max(baseline, positions.get(row.platform_id) ?? 0))
    .at(-1);
}

export function unreadPublicationsForGroup(userId: string, groupId: string): Publication[] {
  assertUnreadReady();
  return getDb()
    .prepare(
      `SELECT p.* FROM conversation_publications p
    JOIN sessions s ON s.id=p.session_id
    LEFT JOIN conversation_reads r ON r.user_id=? AND r.session_id=p.session_id
      AND r.channel_type=p.channel_type AND r.platform_id=p.platform_id AND r.thread_id=p.thread_id
    WHERE s.agent_group_id=? AND p.channel_type='web' AND p.visible=1
      AND p.position>? AND p.position>COALESCE(r.position,0)
      AND (p.kind!='approval' OR ?=1) ORDER BY p.position DESC`,
    )
    .all(userId, groupId, baselineFor(userId), Number(hasAdminPrivilege(userId, groupId))) as Publication[];
}

export function conversationUnread(userId: string, groupId: string, context: TurnContext): boolean {
  return !!newestUnreadPublication(userId, groupId, context);
}

export function publicationReadCursor(
  userId: string,
  groupId: string,
  context: TurnContext,
  anchor: { kind: 'message' | 'interaction'; id: string },
): ReadCursor | undefined {
  if (context.channelType !== 'web') return undefined;
  const row = visiblePublications(userId, groupId, context, {
    kind: anchor.kind === 'message' ? 'message' : 'approval',
    id: anchor.id,
  }).at(-1);
  return row ? { sessionId: row.session_id, key: row.key } : undefined;
}

export function renderedReadCursor(
  userId: string,
  groupId: string,
  context: TurnContext,
  view: Conversation,
): ReadCursor | undefined {
  if (context.channelType !== 'web') return undefined;
  const messages = new Set(view.messages.filter((message) => message.direction === 'out').map((message) => message.id));
  const interactions = new Set(view.interactions.map((item) => item.id));
  const last = visiblePublications(userId, groupId, context)
    .filter((row) => (row.kind === 'message' ? messages : interactions).has(row.item_id))
    .at(-1);
  return last ? { sessionId: last.session_id, key: last.key } : undefined;
}

export class ReadStateError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
  ) {
    super(code);
  }
}

export function acknowledgeRead(
  userId: string,
  groupId: string,
  threadId: string,
  cursor: ReadCursor,
  override?: { channelType: string; messagingGroupId: string },
): void {
  const context = resolveTurnContext(userId, groupId, threadId, override);
  if (!context) throw new ReadStateError(403, 'forbidden');
  if (context.sessionId !== cursor.sessionId) throw new ReadStateError(409, 'stale_read_context');
  assertUnreadReady();
  const row = getDb().prepare('SELECT * FROM conversation_publications WHERE key=?').get(cursor.key) as
    | Publication
    | undefined;
  if (
    !row ||
    row.session_id !== context.sessionId ||
    row.channel_type !== context.channelType ||
    row.thread_id !== (context.threadId ?? '') ||
    !context.platformIds.includes(row.platform_id) ||
    (row.kind === 'approval' && !hasAdminPrivilege(userId, groupId))
  )
    throw new ReadStateError(400, 'invalid_read_cursor');
  const db = getDb();
  transaction(db, () => {
    if (row.position <= baselineFor(userId)) return;
    let changed = 0;
    for (const platform of context.platformIds) {
      changed += db
        .prepare(
          `INSERT INTO conversation_reads VALUES (?,?,?,?,?,?)
        ON CONFLICT(user_id,session_id,channel_type,platform_id,thread_id)
        DO UPDATE SET position=excluded.position WHERE excluded.position>conversation_reads.position`,
        )
        .run(userId, context.sessionId, context.channelType, platform, context.threadId ?? '', row.position).changes;
    }
    if (changed) recordHostChange({ kind: 'read-state', userId, groupId }, db);
  })();
}
