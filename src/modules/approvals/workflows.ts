import { getDb } from '../../db/connection.js';
import { getApproval, updateApprovalStatus, type Approval } from '../../db/approvals.js';
import { getInteraction, queryInteractions } from '../../db/interactions.js';
import { getSession } from '../../db/sessions.js';
import { wakeContainer } from '../../container-runner.js';
import { writeApprovalNotification } from './notification.js';
import type { ApprovalResponseMessage } from '../../ui/shared/approval-message.js';
import { getAgentGroup } from '../../db/agent-groups.js';
import { ConnectionInputError } from '../../ui/shared/connection-input.js';
import type { AccountRequestData, AccountRequestStatus } from '../../ui/shared/approval.js';

export type ApprovalWorkflow = Approval & {
  data_json: string;
  submission_ids_json: string;
  notified: number;
  restart: number;
};

const workflowSelect = `SELECT a.*,w.data_json,w.submission_ids_json,w.notified,w.restart
  FROM interactions a JOIN interaction_progress w ON w.id=a.id`;

export function getApprovalWorkflow(id: string): ApprovalWorkflow | undefined {
  return queryInteractions<ApprovalWorkflow>(
    `${workflowSelect} WHERE a.id=?
      OR EXISTS(SELECT 1 FROM json_each(w.submission_ids_json) WHERE value=?)`,
    id,
    id,
  )[0];
}

export function getAccountRequest(id: string, sessionId?: string): AccountRequestData {
  const workflow = getApprovalWorkflow(id);
  const approval = workflow ?? getApproval(id);
  const session = approval?.session_id ? getSession(approval.session_id) : undefined;
  if (
    !approval ||
    approval.kind === 'confirmation' ||
    !session ||
    (sessionId !== undefined && session.id !== sessionId)
  )
    throw new ConnectionInputError('Access request not found', 404);
  if (!workflow && (approval.status === 'pending' || approval.status === 'applying'))
    throw new ConnectionInputError('Account recovery state unavailable; review this request on the host.', 409);
  if (approval.status === 'pending' && approval.expires_at && approval.expires_at <= new Date().toISOString()) {
    finishApprovalWorkflow(
      approval.id,
      'expired',
      'Your access request expired without changing credentials. Request access again if still needed.',
    );
    return getAccountRequest(id, sessionId);
  }
  return {
    id: approval.id,
    kind: approval.kind,
    requirements: approval.input.payload,
    status: approval.status,
    revision: approval.revision,
    retryable: approval.status === 'failed' && workflow !== undefined,
    agentGroupId: session.agent_group_id,
    agentGroupName: getAgentGroup(session.agent_group_id)?.name ?? session.agent_group_id,
    createdAt: approval.created_at,
    expiresAt: approval.expires_at,
    outcomeMessage: approval.outcome_message,
    resolvedAt: approval.resolved_at,
  };
}

export function linkApprovalSubmission(id: string, submissionId: string): void {
  const existing = getInteraction(submissionId) ?? getApprovalWorkflow(submissionId);
  if (existing) {
    if (existing.id !== id) throw new Error('Approval submission is already associated with another request');
    return;
  }
  getDb()
    .prepare("UPDATE interaction_progress SET submission_ids_json=json_insert(submission_ids_json,'$[#]',?) WHERE id=?")
    .run(submissionId, id);
}

export function pendingWorkflow(key: string): ApprovalWorkflow | undefined {
  return queryInteractions<ApprovalWorkflow>(
    `${workflowSelect} WHERE a.dedupe_key=? AND a.status IN ('pending','applying')`,
    key,
  )[0];
}

export function latestApprovalWorkflow(key: string): ApprovalWorkflow | undefined {
  return queryInteractions<ApprovalWorkflow>(
    `${workflowSelect} WHERE a.dedupe_key=? ORDER BY a.updated_at DESC,a.rowid DESC LIMIT 1`,
    key,
  )[0];
}

export function recoverableApprovalWorkflows(): ApprovalWorkflow[] {
  return queryInteractions<ApprovalWorkflow>(
    `${workflowSelect}
    WHERE json_extract(a.input_json,'$.action')='request_access' AND (a.status IN ('pending','applying') OR w.notified=0)`,
  );
}

export function createApprovalWorkflow(id: string, key: string): void {
  getDb().transaction(() => {
    getDb().prepare('UPDATE interactions SET dedupe_key=? WHERE id=?').run(key, id);
    getDb().prepare('INSERT INTO interaction_progress(id) VALUES(?)').run(id);
  })();
}

export function claimApprovalWorkflow(id: string, revision: number, data: Record<string, unknown>): boolean {
  return getDb().transaction(() => {
    const previous = getApprovalWorkflow(id);
    if (!previous || previous.status !== 'pending' || previous.revision !== revision) return false;
    const stored = JSON.parse(previous.data_json) as Record<string, unknown>;
    if (
      !updateApprovalStatus(
        previous.id,
        'applying',
        {
          userId: typeof data.userId === 'string' ? data.userId : undefined,
          decision: 'approve',
          message: (data.responseMessage as ApprovalResponseMessage | undefined)?.message,
        },
        revision,
      )
    )
      return false;
    getDb()
      .prepare('UPDATE interaction_progress SET data_json=? WHERE id=?')
      .run(
        JSON.stringify({ ...data, ...(stored.attempt_history ? { attempt_history: stored.attempt_history } : {}) }),
        previous.id,
      );
    return true;
  })();
}

export function updateApprovalWorkflowData(id: string, data: Record<string, unknown>): void {
  const workflow = getApprovalWorkflow(id);
  if (!workflow || workflow.status !== 'applying') throw new Error('Approval is not being applied');
  const stored = JSON.parse(workflow.data_json) as Record<string, unknown>;
  getDb()
    .prepare('UPDATE interaction_progress SET data_json=? WHERE id=?')
    .run(JSON.stringify({ ...stored, ...data }), workflow.id);
}

export function retryApprovalWorkflow(id: string, revision: number, userId: string): boolean {
  return getDb().transaction(() => {
    const workflow = getApprovalWorkflow(id);
    if (
      !workflow ||
      workflow.status !== 'failed' ||
      workflow.revision !== revision ||
      (workflow.dedupe_key !== null && pendingWorkflow(workflow.dedupe_key))
    )
      return false;
    const { attempt_history, ...selection } = JSON.parse(workflow.data_json) as Record<string, unknown>;
    const history = Array.isArray(attempt_history) ? attempt_history : [];
    const data = {
      attempt_history: [
        ...history,
        {
          status: workflow.status,
          selection,
          outcome: workflow.outcome_message,
          finished_at: workflow.resolved_at,
          reopened_by: userId,
        },
      ],
    };
    if (!updateApprovalStatus(workflow.id, 'pending', undefined, revision)) return false;
    getDb()
      .prepare('UPDATE interaction_progress SET data_json=?,restart=0,notified=0 WHERE id=?')
      .run(JSON.stringify(data), workflow.id);
    return true;
  })();
}

export function finishApprovalWorkflow(
  id: string,
  status: Exclude<AccountRequestStatus, 'pending' | 'applying'>,
  message: string,
  restart = false,
  responseMessage?: ApprovalResponseMessage,
  resolvedBy?: string,
): void {
  getDb().transaction(() => {
    const workflow = getApprovalWorkflow(id);
    if (!workflow || !['pending', 'applying'].includes(workflow.status)) return;
    const data = JSON.parse(workflow.data_json) as { userId?: string };
    updateApprovalStatus(
      workflow.id,
      status,
      {
        userId: resolvedBy ?? responseMessage?.userId ?? data.userId,
        decision:
          status === 'rejected' ? 'reject' : status === 'completed' || status === 'failed' ? 'approve' : undefined,
        message: responseMessage?.message ?? workflow.response.message ?? undefined,
        outcome: message,
      },
      workflow.revision,
    );
    getDb()
      .prepare('UPDATE interaction_progress SET restart=?,notified=0 WHERE id=?')
      .run(restart ? 1 : 0, workflow.id);
  })();
}

export async function notifyApprovalWorkflow(id: string): Promise<void> {
  const workflow = getApprovalWorkflow(id);
  if (!workflow || workflow.notified || workflow.outcome_message === null || workflow.resolved_at === null) return;
  const session = workflow.session_id ? getSession(workflow.session_id) : undefined;
  if (!session) throw new Error(`Approval notification session unavailable: ${workflow.id}`);
  const options = {
    originMessageId: workflow.origin_message_id,
    id: `approval-result-${workflow.id}-r${workflow.revision}`,
    idempotent: true,
    timestamp: workflow.resolved_at,
    approvalId: workflow.id,
  };
  writeApprovalNotification(
    session,
    workflow.restart
      ? 'The approval was applied and the runtime configuration saved. Finish the current response first. The container will restart afterward; verify the new configuration only after that restart.'
      : workflow.outcome_message,
    {
      ...options,
      responseMessage:
        workflow.responded_by && workflow.response.message
          ? { userId: workflow.responded_by, message: workflow.response.message }
          : undefined,
    },
  );
  if (workflow.restart)
    writeApprovalNotification(session, `The approved configuration is now loaded.\n${workflow.outcome_message}`, {
      ...options,
      id: `${options.id}-restart`,
      afterRestart: true,
    });
  await wakeContainer(session);
  getDb()
    .prepare(
      `UPDATE interaction_progress SET notified=1 WHERE id=?
    AND EXISTS(SELECT 1 FROM interactions WHERE id=? AND revision=?)`,
    )
    .run(workflow.id, workflow.id, workflow.revision);
}
