/**
 * Handle an admin's response to an approval card.
 *
 * For module-initiated actions, the module called `requestApproval()` with
 *      some free-form `action` string and registered a handler via
 *      `registerApprovalHandler(action, handler)`. On approve, we look up the
 *      handler and call it; on reject, we notify the agent and move on.
 *
 * The response handler is registered via core's `registerResponseHandler`;
 * core iterates handlers and the first one to return `true` claims the response.
 */
import { wakeContainer } from '../../container-runner.js';
import { beginApprovalExecution, endApprovalExecution, getSession } from '../../db/sessions.js';
import { getApproval, updateApprovalStatus } from '../../db/approvals.js';
import type { ResponsePayload } from '../../response-registry.js';
import { log } from '../../log.js';
import type { Approval } from '../../types.js';
import { hasAdminPrivilege, isGlobalAdmin, isOwner } from '../permissions/db/user-roles.js';
import { getApprovalHandler, getInteractiveApprovalHandler } from './primitive.js';
import { writeApprovalNotification, type ApprovalNotificationOptions } from './notification.js';

import {
  ApprovalMessageError,
  parseApprovalMessage,
  type ApprovalResponseMessage,
} from '../../ui/shared/approval-message.js';

export async function handleApprovalsResponse(payload: ResponsePayload): Promise<boolean> {
  if (payload.responseType === 'skipped') return false;
  const approval = getApproval(payload.questionId);
  if (!approval) return false;

  if (!isAuthorizedApprovalClick(approval, payload)) {
    log.warn('Ignoring unauthorized approval response', {
      approvalId: approval.approval_id,
      action: approval.action,
      userId: payload.userId,
      channelType: payload.channelType,
    });
    return true;
  }
  if (approval.status !== 'pending') {
    log.info('Ignoring response to an approval that is no longer pending', { approvalId: approval.approval_id });
    return true;
  }
  const message = parseApprovalMessage(payload.message);
  if (message && !approval.session_id)
    throw new ApprovalMessageError('This approval has no originating conversation for a message.');

  const interactive = getInteractiveApprovalHandler(approval.action);
  if (interactive) {
    await interactive(approval, payload, namespacedUserId(payload) ?? '');
    return true;
  }

  if (!beginApprovalExecution(approval)) {
    log.info('Ignoring duplicate response to an approval being processed', { approvalId: approval.approval_id });
    return true;
  }
  try {
    await handleRegisteredApproval(approval, payload.value, namespacedUserId(payload) ?? '', message);
  } finally {
    endApprovalExecution(approval.approval_id);
  }
  return true;
}

async function handleRegisteredApproval(
  approval: Approval,
  selectedOption: string,
  userId: string,
  message?: string,
): Promise<void> {
  const session = approval.session_id ? getSession(approval.session_id) : undefined;
  if (!session) {
    const outcome = 'Approval cannot be applied because its originating conversation is unavailable.';
    log.warn(outcome, { approvalId: approval.approval_id });
    updateApprovalStatus(approval.approval_id, 'cancelled', { outcome });
    return;
  }

  let responseMessage: ApprovalResponseMessage | undefined = message ? { userId, message } : undefined;
  const response = { userId, decision: selectedOption, message };
  let outcomeMessage: string | undefined;
  const notify = (text: string, options?: Pick<ApprovalNotificationOptions, 'afterRestart'>): void => {
    writeApprovalNotification(session, text, {
      originMessageId: approval.origin_message_id,
      ...options,
      responseMessage,
      approvalId: approval.approval_id,
    });
    responseMessage = undefined;
    if (!options?.afterRestart || !outcomeMessage) outcomeMessage = text;
  };

  if (selectedOption !== 'approve') {
    notify(`Your ${approval.action} request was rejected by admin.`);
    log.info('Approval rejected', { approvalId: approval.approval_id, action: approval.action, userId });
    updateApprovalStatus(approval.approval_id, 'rejected', { ...response, outcome: outcomeMessage });
    await wakeContainer(session);
    return;
  }

  // Approved — dispatch to the module that registered for this action.
  const handler = getApprovalHandler(approval.action);
  if (!handler) {
    log.warn('No approval handler registered', {
      approvalId: approval.approval_id,
      action: approval.action,
    });
    notify(`Your ${approval.action} was approved, but no handler is installed to apply it.`);
    updateApprovalStatus(approval.approval_id, 'failed', { ...response, outcome: outcomeMessage });
    await wakeContainer(session);
    return;
  }

  const payload = JSON.parse(approval.payload);
  updateApprovalStatus(approval.approval_id, 'applying', response);
  let outcome: 'approved' | 'failed' = 'approved';
  try {
    await handler({ session, payload, userId, notify, originMessageId: approval.origin_message_id });
    if (responseMessage) notify(`Your ${approval.action} request was approved.`);
    log.info('Approval handled', { approvalId: approval.approval_id, action: approval.action, userId });
  } catch (err) {
    outcome = 'failed';
    log.error('Approval handler threw', { approvalId: approval.approval_id, action: approval.action, err });
    notify(
      `Your ${approval.action} was approved, but applying it failed: ${err instanceof Error ? err.message : String(err)}.`,
    );
  }

  updateApprovalStatus(approval.approval_id, outcome, { ...response, outcome: outcomeMessage });
  await wakeContainer(session);
}

function namespacedUserId(payload: ResponsePayload): string | null {
  if (!payload.userId) return null;
  // Web responses already carry the canonical central-DB user id (a bare UUID
  // like "e5a1f280-..." or an existing "<channel>:<handle>"). Never re-namespace
  // them — prefixing a colon-less UUID with "web:" would fail every role lookup,
  // so an authorized approval click gets silently dropped and the card reappears.
  if (payload.channelType === 'web') return payload.userId;
  return payload.userId.includes(':') ? payload.userId : `${payload.channelType}:${payload.userId}`;
}

function isAuthorizedApprovalClick(approval: Approval, payload: ResponsePayload): boolean {
  const userId = namespacedUserId(payload);
  if (!userId) return false;

  const agentGroupId =
    approval.agent_group_id ?? (approval.session_id ? getSession(approval.session_id)?.agent_group_id : null);

  if (!agentGroupId) {
    return isOwner(userId) || isGlobalAdmin(userId);
  }

  return hasAdminPrivilege(userId, agentGroupId);
}
