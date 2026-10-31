import { getDb } from '../../../db/connection.js';
import fs from 'node:fs';
import { getApprovalHistory, type ApprovalHistoryRow } from '../../../db/approval-history.js';
import { getAgentGroup } from '../../../db/agent-groups.js';
import { getSession, isApprovalExecuting } from '../../../db/sessions.js';
import { getMessagingGroup } from '../../../db/messaging-groups.js';
import { getUser } from '../../../modules/permissions/db/users.js';
import { hasAdminPrivilege } from '../../../modules/permissions/db/user-roles.js';
import { getApprovalWorkflow } from '../../../modules/approvals/workflows.js';
import { inboundDbPath, openInboundDb } from '../../../session-manager.js';
import type { ApprovalOrigin, ConversationApproval } from '../../shared/approval.js';
import type { ConversationMessage } from '../../shared/conversation.js';
import { presentApproval } from './approval-presentation.js';
import { resolveTurnContext, type TurnContext } from './chat.js';

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

export function presentApprovalHistory(userId: string, row: ApprovalHistoryRow): ConversationApproval {
  const session = getSession(row.session_id);
  const responder = row.responded_by ? getUser(row.responded_by) : undefined;
  const status = row.status === 'pending' && isApprovalExecuting(row.approval_id) ? 'applying' : row.status;
  return {
    approvalId: row.approval_id,
    action: row.action,
    title: row.title,
    ...presentApproval(row.action, row.payload),
    options: JSON.parse(row.options_json),
    agentGroupId: session?.agent_group_id ?? null,
    agentGroupName: session ? (getAgentGroup(session.agent_group_id)?.name ?? null) : null,
    createdAt: row.created_at,
    supportsResponseMessage: true,
    reviewRequired: !!getApprovalWorkflow(row.approval_id),
    stage: status,
    status,
    decision: row.decision,
    respondedBy: row.responded_by
      ? { userId: row.responded_by, displayName: responder?.display_name || row.responded_by }
      : null,
    responseMessage: row.response_message,
    resolvedAt: row.resolved_at,
    outcomeMessage: row.outcome_message,
    origin: approvalOrigin(userId, row),
  };
}

export function approvalTranscript(userId: string, groupId: string, context: TurnContext): ConversationMessage[] {
  if (!context.sessionId || !hasAdminPrivilege(userId, groupId)) return [];
  const rows = getDb()
    .prepare('SELECT * FROM approval_history WHERE session_id=? ORDER BY created_at,approval_id')
    .all(context.sessionId) as ApprovalHistoryRow[];
  return rows.flatMap((row) => {
    const approval = presentApprovalHistory(userId, row);
    const origin = approval.origin;
    if (
      !origin ||
      origin.channelType !== context.channelType ||
      origin.threadId !== (context.threadId ?? `__dm:${origin.messagingGroupId}`)
    )
      return [];
    return [
      {
        id: `approval:${row.approval_id}`,
        direction: 'out' as const,
        timestamp: row.created_at,
        text: row.title || row.action,
        approval,
      },
    ];
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
  const row = getApprovalHistory(payload.approvalId);
  if (!row || row.session_id !== context.sessionId) return false;
  const origin = approvalOrigin(userId, row);
  return (
    !!origin &&
    origin.channelType === context.channelType &&
    origin.threadId === (context.threadId ?? `__dm:${origin.messagingGroupId}`)
  );
}
