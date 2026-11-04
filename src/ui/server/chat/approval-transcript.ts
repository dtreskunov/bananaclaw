import { getDb } from '../../../db/connection.js';
import { queryInteractions, legacyInteractionExpired } from '../../../db/interactions.js';
import fs from 'node:fs';

import { getApproval, type Approval } from '../../../db/approvals.js';
import { getAgentGroup } from '../../../db/agent-groups.js';
import { getSession } from '../../../db/sessions.js';
import { getMessagingGroup } from '../../../db/messaging-groups.js';
import { getUser } from '../../../modules/permissions/db/users.js';
import { hasAdminPrivilege } from '../../../modules/permissions/db/user-roles.js';
import { getAccountRequest } from '../../../modules/approvals/workflows.js';
import type { AccountInteraction, AccountRequestData } from '../../shared/approval.js';
import { inboundDbPath, openInboundDb } from '../../../session-manager.js';
import type { ApprovalOrigin, ConversationApproval } from '../../shared/approval.js';
import { presentApproval } from './approval-presentation.js';
import { resolveTurnContext, type TurnContext } from './conversation-context.js';

export function approvalOrigin(
  userId: string,
  row: { session_id: string | null; origin_message_id?: string | null },
): ApprovalOrigin | null {
  const session = row.session_id ? getSession(row.session_id) : undefined;
  if (!session || !fs.existsSync(inboundDbPath(session.agent_group_id, session.id))) return null;
  const mg = session.messaging_group_id ? getMessagingGroup(session.messaging_group_id) : undefined;
  if (!row.origin_message_id && session.thread_id === null && mg?.is_group === 1) return null;
  let route = {
    channel_type: mg?.channel_type ?? null,
    platform_id: mg?.platform_id ?? null,
    thread_id: session.thread_id,
  };
  if (row.origin_message_id) {
    const db = openInboundDb(session.agent_group_id, session.id);
    try {
      const source = db
        .prepare('SELECT channel_type,platform_id,thread_id FROM messages_in WHERE id=?')
        .get(row.origin_message_id) as typeof route | undefined;
      if (!source) return null;
      route = source;
    } finally {
      db.close();
    }
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
  const threadId = route.thread_id ?? `__dm:${messagingGroupId}`;
  const context = resolveTurnContext(userId, session.agent_group_id, threadId, {
    channelType: route.channel_type,
    messagingGroupId,
  });
  if (
    !context ||
    context.sessionId !== session.id ||
    context.channelType !== route.channel_type ||
    !context.platformIds.includes(route.platform_id) ||
    context.threadId !== route.thread_id
  )
    return null;
  return { agentGroupId: session.agent_group_id, threadId, channelType: route.channel_type, messagingGroupId };
}

function responseContext(userId: string, row: Approval) {
  const responder = row.responded_by ? getUser(row.responded_by) : undefined;
  return {
    decision: row.response.decision,
    respondedBy: row.responded_by
      ? { userId: row.responded_by, displayName: responder?.display_name || row.responded_by }
      : null,
    responseMessage: row.response.message,
    origin: approvalOrigin(userId, row),
  };
}

export function projectAccountInteraction(userId: string, account: AccountRequestData): AccountInteraction {
  const approval = getApproval(account.id);
  if (!approval) throw new Error('Account request unavailable');
  return { ...responseContext(userId, approval), ...account };
}

export function projectApproval(userId: string, row: Approval): ConversationApproval {
  if (row.kind !== 'confirmation') return { ...responseContext(userId, row), ...getAccountRequest(row.id) };
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
    supportsResponseMessage: row.session_id !== null,
    status: legacyInteractionExpired(row) ? 'expired' : row.status,
    resolvedAt: row.resolved_at,
    outcomeMessage: row.outcome_message,
  };
}

export function approvalTranscript(userId: string, groupId: string, context: TurnContext): ConversationApproval[] {
  if (!context.sessionId || !hasAdminPrivilege(userId, groupId)) return [];
  const rows = queryInteractions<Approval>(
    "SELECT * FROM interactions WHERE session_id=? AND kind!='question' ORDER BY created_at,id",
    context.sessionId,
  );
  return rows.flatMap((row) => {
    const approval = projectApproval(userId, row);
    const origin = approval.origin;
    if (
      !origin ||
      origin.channelType !== context.channelType ||
      origin.threadId !== (context.threadId ?? `__dm:${origin.messagingGroupId}`)
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
    origin.threadId === (context.threadId ?? `__dm:${origin.messagingGroupId}`)
  );
}
