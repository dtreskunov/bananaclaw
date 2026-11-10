import { getDb } from '../../../db/connection.js';
import { queryInteractions } from '../../../db/interactions.js';

import { getApproval, type Approval } from '../../../db/approvals.js';
import { getAgentGroup } from '../../../db/agent-groups.js';
import { getSession } from '../../../db/sessions.js';
import { getMessagingGroup } from '../../../db/messaging-groups.js';
import { getUserDisplayName } from '../../../modules/permissions/db/users.js';
import { hasAdminPrivilege } from '../../../modules/permissions/db/user-roles.js';
import { getAccountRequest } from '../../../modules/approvals/workflows.js';
import type { AccountInteraction, AccountRequestData } from '../../shared/approval.js';
import { interactionRoute } from '../../../conversation-publications.js';
import type { ApprovalOrigin, ConversationApproval } from '../../shared/approval.js';
import { presentApproval } from './approval-presentation.js';
import { resolveTurnContext, type TurnContext } from './conversation-context.js';
import { peerConversationId } from '../../shared/peer-conversation.js';

export function approvalOrigin(
  userId: string,
  row: { session_id: string | null; origin_message_id?: string | null },
): ApprovalOrigin | null {
  const session = row.session_id ? getSession(row.session_id) : undefined;
  if (!session) return null;
  const mg = session.messaging_group_id ? getMessagingGroup(session.messaging_group_id) : undefined;
  const route = interactionRoute(row);
  if (!route) return null;
  if (
    route.channel_type === 'agent' &&
    route.platform_id &&
    route.thread_id &&
    route.platform_id !== session.agent_group_id
  ) {
    const threadId = peerConversationId(session.id, route.thread_id);
    const origin = {
      agentGroupId: session.agent_group_id,
      threadId,
      channelType: 'agent',
      messagingGroupId: session.id,
    };
    return resolveTurnContext(userId, session.agent_group_id, threadId, origin) ? origin : null;
  }
  let messagingGroupId = mg?.channel_type === route.channel_type && mg.platform_id === route.platform_id ? mg.id : null;
  if (!messagingGroupId) {
    const candidates = getDb()
      .prepare('SELECT id FROM messaging_groups WHERE channel_type=? AND platform_id=? LIMIT 2')
      .all(route.channel_type, route.platform_id) as { id: string }[];
    if (candidates.length !== 1) return null;
    messagingGroupId = candidates[0].id;
  }
  if (!route.channel_type || !route.platform_id) return null;
  const threadId = route.thread_id || `__dm:${messagingGroupId}`;
  const context = resolveTurnContext(userId, session.agent_group_id, threadId, {
    channelType: route.channel_type,
    messagingGroupId,
  });
  if (
    !context ||
    context.sessionId !== session.id ||
    context.channelType !== route.channel_type ||
    !context.platformIds.includes(route.platform_id) ||
    context.threadId !== (route.thread_id || null)
  )
    return null;
  return { agentGroupId: session.agent_group_id, threadId, channelType: route.channel_type, messagingGroupId };
}

function responseContext(userId: string, row: Approval) {
  return {
    decision: row.response.decision,
    respondedBy: row.responded_by
      ? { userId: row.responded_by, displayName: getUserDisplayName(row.responded_by) }
      : null,
    responseMessage: row.response.message,
    origin: approvalOrigin(userId, row),
  };
}

export function projectAccountInteraction(userId: string, account: AccountRequestData): AccountInteraction {
  const approval = getApproval(account.id);
  if (!approval) throw new Error('Account request unavailable');
  return {
    ...responseContext(userId, approval),
    ...account,
  };
}

export function projectApproval(userId: string, row: Approval): ConversationApproval {
  if (row.kind !== 'confirmation') return projectAccountInteraction(userId, getAccountRequest(row.id));
  const session = row.session_id ? getSession(row.session_id) : undefined;
  const groupId = row.agent_group_id ?? session?.agent_group_id ?? null;
  return {
    ...responseContext(userId, row),
    kind: 'confirmation',
    id: row.id,
    action: row.input.action,
    title: row.input.title,
    ...presentApproval(row.input.action, row.input.payload),
    options: row.input.options,
    agentGroupId: groupId,
    agentGroupName: groupId ? (getAgentGroup(groupId)?.name ?? null) : null,
    createdAt: row.created_at,
    status: row.status,
    resolvedAt: row.resolved_at,
    outcomeMessage: row.outcome_message,
  };
}

export function approvalTranscript(userId: string, groupId: string, context: TurnContext): ConversationApproval[] {
  const sessionId = context.sessionId;
  if (!sessionId || !hasAdminPrivilege(userId, groupId)) return [];
  const rows = queryInteractions<Approval>(
    "SELECT * FROM interactions WHERE session_id=? AND status!='cancelled' ORDER BY created_at,id",
    sessionId,
  );
  return rows.flatMap((row) => {
    const approval = projectApproval(userId, row);
    const origin = approval.origin;
    if (
      !origin ||
      origin.channelType !== context.channelType ||
      origin.threadId !==
        (context.channelType === 'agent' && context.threadId
          ? peerConversationId(sessionId, context.threadId)
          : (context.threadId ?? `__dm:${origin.messagingGroupId}`))
    )
      return [];
    return [approval];
  });
}

export function isRepresentedApprovalOutcome(
  userId: string,
  groupId: string,
  context: TurnContext,
  content: string,
): boolean {
  if (!context.sessionId) return false;
  let payload: unknown;
  try {
    payload = JSON.parse(content);
  } catch (error) {
    if (error instanceof SyntaxError) return false;
    throw error;
  }
  if (
    !payload ||
    typeof payload !== 'object' ||
    !('senderId' in payload) ||
    payload.senderId !== 'system' ||
    !('approvalId' in payload) ||
    typeof payload.approvalId !== 'string' ||
    !hasAdminPrivilege(userId, groupId)
  )
    return false;
  const row = getApproval(payload.approvalId);
  if (!row || row.session_id !== context.sessionId) return false;
  const origin = approvalOrigin(userId, row);
  return (
    !!origin &&
    origin.channelType === context.channelType &&
    origin.threadId ===
      (context.channelType === 'agent' && context.threadId
        ? peerConversationId(context.sessionId, context.threadId)
        : (context.threadId ?? `__dm:${origin.messagingGroupId}`))
  );
}
