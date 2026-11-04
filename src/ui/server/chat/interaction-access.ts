import { getSession } from '../../../db/sessions.js';
import { getMessagingGroupByPlatform } from '../../../db/messaging-groups.js';
import { hasAdminPrivilege, isGlobalAdmin, isOwner } from '../../../modules/permissions/db/user-roles.js';
import type { Approval, Question } from '../../../types.js';
import type { ApprovalOrigin } from '../../shared/approval.js';
import { resolveTurnContext, routeMatches } from './conversation-context.js';

export function approvalGroupId(row: Pick<Approval, 'agent_group_id' | 'session_id'>): string | null {
  return row.agent_group_id ?? (row.session_id ? (getSession(row.session_id)?.agent_group_id ?? null) : null);
}

export function canRespondToApproval(userId: string, row: Approval): boolean {
  const scope = approvalGroupId(row);
  return scope === null ? isOwner(userId) || isGlobalAdmin(userId) : hasAdminPrivilege(userId, scope);
}

export function questionResponseOrigin(userId: string, question: Question): ApprovalOrigin | null {
  const session = getSession(question.session_id);
  const mg =
    question.channel_type && question.platform_id
      ? getMessagingGroupByPlatform(question.channel_type, question.platform_id)
      : undefined;
  if (!session || !mg) return null;
  const threadId = question.thread_id ?? `__dm:${mg.id}`;
  const context = resolveTurnContext(userId, session.agent_group_id, threadId, {
    channelType: mg.channel_type,
    messagingGroupId: mg.id,
  });
  if (
    !context ||
    context.sessionId !== question.session_id ||
    !routeMatches(context, question.channel_type, question.platform_id, question.thread_id)
  )
    return null;
  return { agentGroupId: session.agent_group_id, threadId, channelType: mg.channel_type, messagingGroupId: mg.id };
}
