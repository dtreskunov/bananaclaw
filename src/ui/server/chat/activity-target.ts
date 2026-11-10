import type { ActivityNavigationKind, ActivityTarget } from '../../shared/activity-target.js';
import type { ApprovalOrigin } from '../../shared/approval.js';
import type { ThreadSummary } from '../../shared/thread.js';
import { getDb } from '../../../db/connection.js';
import { canAccessAgentGroup } from '../../../modules/permissions/access.js';
import { hasAdminPrivilege } from '../../../modules/permissions/db/user-roles.js';
import { listThreadsForViewer } from './threads.js';
import { readConversation } from './conversation.js';
import { conversationRouteFilter, resolveTurnContext, routeMatches } from './conversation-context.js';
import {
  newestUnreadPublication,
  publicationReadCursor,
  unreadPublicationsForGroup,
  type Publication,
} from './read-state.js';
import { openInboundDb } from '../../../session-manager.js';
import { publicInboundMessageId } from './history.js';
import { readSummaryActivityBounds } from '../../../thread-summaries.js';

type Candidate = { target: ActivityTarget; order: number };

function readRouteTarget(
  userId: string,
  origin: ApprovalOrigin,
  kind: ActivityNavigationKind,
  knownUnread?: Publication,
): Candidate | null {
  const { agentGroupId: groupId, threadId } = origin;
  const context = resolveTurnContext(userId, groupId, threadId, origin);
  if (!context?.sessionId) return null;
  if (kind === 'unread') {
    const publication = knownUnread ?? newestUnreadPublication(userId, groupId, context);
    return publication &&
      publication.session_id === context.sessionId &&
      routeMatches(context, publication.channel_type, publication.platform_id, publication.thread_id || null) &&
      (publication.kind !== 'approval' || hasAdminPrivilege(userId, groupId))
      ? {
          order: publication.position,
          target: {
            origin,
            anchor: { kind: publication.kind === 'message' ? 'message' : 'interaction', id: publication.item_id },
            readCursor: { sessionId: publication.session_id, key: publication.key },
          },
        }
      : null;
  }
  const view = readConversation(userId, groupId, threadId, origin);
  const inputs = new Set(view.turns.filter((turn) => turn.phase !== 'settled').flatMap((turn) => turn.inputIds));
  if (kind === 'running') {
    const inbound = openInboundDb(groupId, context.sessionId);
    try {
      const filter = conversationRouteFilter(context);
      const queued = inbound
        .prepare(
          `SELECT id FROM messages_in
        WHERE ${filter.sql}
          AND status='pending' AND trigger=1 AND kind!='system'
          AND (process_after IS NULL OR process_after<=@now)`,
        )
        .all({ ...filter.params, now: Date.now() }) as { id: string }[];
      for (const row of queued) inputs.add(publicInboundMessageId(row.id, groupId));
    } finally {
      inbound.close();
    }
  }
  let latest: { anchor: ActivityTarget['anchor']; order: number } | undefined;
  for (const message of view.messages) {
    if (message.inputState?.status === 'cancelled' || (kind === 'running' && !inputs.has(message.id))) continue;
    if (!latest || message.timestamp >= latest.order)
      latest = { anchor: { kind: 'message', id: message.id }, order: message.timestamp };
  }
  if (kind === 'latest')
    for (const interaction of view.interactions) {
      if (!latest || interaction.createdAt >= latest.order)
        latest = { anchor: { kind: 'interaction', id: interaction.id }, order: interaction.createdAt };
    }
  if (!latest) return null;
  const readCursor = publicationReadCursor(userId, groupId, context, latest.anchor);
  return { order: latest.order, target: { origin, anchor: latest.anchor, ...(readCursor ? { readCursor } : {}) } };
}

function latestBounds(userId: string, groupId: string, threads: ThreadSummary[]): Map<ThreadSummary, number> {
  const bounds = new Map<string, number>();
  const sessionIds = [...new Set(threads.map((thread) => thread.sessionId))];
  const summaries = readSummaryActivityBounds(sessionIds);
  if (hasAdminPrivilege(userId, groupId)) {
    const approvals = getDb()
      .prepare(
        `SELECT i.session_id,MAX(i.created_at) AS latest FROM interactions i
      JOIN sessions s ON s.id=i.session_id WHERE s.agent_group_id=? GROUP BY i.session_id`,
      )
      .all(groupId) as { session_id: string; latest: number }[];
    for (const row of approvals) bounds.set(row.session_id, row.latest);
  }
  return new Map(
    threads.map((thread) => {
      const routes = summaries.get(thread.sessionId);
      // Unknown bounds disable pruning; the normal reader already handles every source kind.
      if (!routes) return [thread, Infinity];
      const context = resolveTurnContext(userId, groupId, thread.threadId, thread);
      const times = routes
        .filter(
          (route) => context && routeMatches(context, route.channel_type, route.platform_id, route.thread_id || null),
        )
        .map((route) => route.latestAt ?? -Infinity);
      return [thread, Math.max(bounds.get(thread.sessionId) ?? -Infinity, ...times)];
    }),
  );
}

/** Source IDs need neither a whole-agent activity refresh nor every conversation's traces. */
export async function readActivityTarget(
  userId: string,
  groupId: string,
  kind: ActivityNavigationKind,
  route?: Omit<ApprovalOrigin, 'agentGroupId'>,
): Promise<ActivityTarget | null> {
  if (!canAccessAgentGroup(userId, groupId).allowed) throw new Error('Activity target access denied');
  if (route) return readRouteTarget(userId, { agentGroupId: groupId, ...route }, kind)?.target ?? null;
  const threads = await listThreadsForViewer(userId, groupId, [], { projectActivity: kind === 'running' });
  if (kind === 'unread') {
    const routes = new Map(
      threads.map((thread) => [
        JSON.stringify([
          thread.sessionId,
          thread.channelType,
          thread.platformId,
          thread.kind === 'dm' ? '' : thread.threadId,
        ]),
        thread,
      ]),
    );
    for (const publication of unreadPublicationsForGroup(userId, groupId)) {
      const thread = routes.get(
        JSON.stringify([
          publication.session_id,
          publication.channel_type,
          publication.platform_id,
          publication.thread_id,
        ]),
      );
      if (!thread) continue;
      const result = readRouteTarget(
        userId,
        {
          agentGroupId: groupId,
          threadId: thread.threadId,
          channelType: thread.channelType,
          messagingGroupId: thread.messagingGroupId,
        },
        kind,
        publication,
      );
      if (result) return result.target;
    }
    return null;
  }
  const bounds = kind === 'latest' ? latestBounds(userId, groupId, threads) : new Map<ThreadSummary, number>();
  const candidates = threads
    .map((thread, index) => ({
      thread,
      index,
      bound: Math.max(thread.lastActivityAt ?? -Infinity, bounds.get(thread) ?? -Infinity),
    }))
    .filter(({ thread }) => kind !== 'running' || thread.activity === 'running');
  if (kind === 'latest') candidates.sort((a, b) => b.bound - a.bound || a.index - b.index);
  let newest: (Candidate & { index: number }) | undefined;
  for (const { thread, index, bound } of candidates) {
    if (kind === 'latest' && newest && bound < newest.order) break;
    const result = readRouteTarget(
      userId,
      {
        agentGroupId: groupId,
        threadId: thread.threadId,
        channelType: thread.channelType,
        messagingGroupId: thread.messagingGroupId,
      },
      kind,
    );
    if (result && (!newest || result.order > newest.order || (result.order === newest.order && index > newest.index)))
      newest = { ...result, index };
  }
  return newest?.target ?? null;
}
