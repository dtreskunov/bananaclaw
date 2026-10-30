import { getDb } from '../../db/connection.js';
import { getPendingApproval, getSession } from '../../db/sessions.js';
import { wakeContainer } from '../../container-runner.js';
import { writeApprovalNotification } from './notification.js';

export type WorkflowStage = 'pending' | 'applying' | 'completed' | 'rejected' | 'cancelled' | 'expired' | 'failed';
export interface ApprovalWorkflow {
  approval_id: string;
  dedupe_key: string;
  origin_json: string;
  stage: WorkflowStage;
  revision: number;
  data_json: string;
  submission_ids_json: string;
  result_json: string | null;
  notified: number;
  updated_at: string;
}

export function getApprovalWorkflow(id: string): ApprovalWorkflow | undefined {
  return getDb()
    .prepare(
      `SELECT * FROM approval_workflows WHERE approval_id=?
    OR EXISTS(SELECT 1 FROM json_each(submission_ids_json) WHERE value=?)`,
    )
    .get(id, id) as ApprovalWorkflow | undefined;
}

export function linkApprovalSubmission(id: string, submissionId: string): void {
  const existing = getApprovalWorkflow(submissionId);
  if (existing) {
    if (existing.approval_id !== id) throw new Error('Approval submission is already associated with another request');
    return;
  }
  getDb()
    .prepare(
      "UPDATE approval_workflows SET submission_ids_json=json_insert(submission_ids_json,'$[#]',?) WHERE approval_id=?",
    )
    .run(submissionId, id);
}

export function pendingWorkflow(key: string): ApprovalWorkflow | undefined {
  return getDb()
    .prepare("SELECT * FROM approval_workflows WHERE dedupe_key=? AND stage IN ('pending','applying')")
    .get(key) as ApprovalWorkflow | undefined;
}

export function latestApprovalWorkflow(key: string): ApprovalWorkflow | undefined {
  return getDb()
    .prepare('SELECT * FROM approval_workflows WHERE dedupe_key=? ORDER BY updated_at DESC LIMIT 1')
    .get(key) as ApprovalWorkflow | undefined;
}

export function createApprovalWorkflow(id: string, key: string, origin: Record<string, unknown> = {}): void {
  getDb()
    .prepare('INSERT INTO approval_workflows(approval_id,dedupe_key,origin_json,updated_at) VALUES(?,?,?,?)')
    .run(id, key, JSON.stringify(origin), new Date().toISOString());
}

export function claimApprovalWorkflow(id: string, revision: number, data: Record<string, unknown>): boolean {
  const previous = getApprovalWorkflow(id);
  const stored = previous ? (JSON.parse(previous.data_json) as Record<string, unknown>) : {};
  return (
    getDb()
      .prepare(
        `UPDATE approval_workflows SET stage='applying',revision=revision+1,data_json=?,updated_at=?
    WHERE approval_id=? AND stage='pending' AND revision=?`,
      )
      .run(
        JSON.stringify({ ...data, ...(stored.attempt_history ? { attempt_history: stored.attempt_history } : {}) }),
        new Date().toISOString(),
        id,
        revision,
      ).changes === 1
  );
}

export function updateApprovalWorkflowData(id: string, data: Record<string, unknown>): void {
  const workflow = getApprovalWorkflow(id);
  if (!workflow || workflow.stage !== 'applying') throw new Error('Approval is not being applied');
  const stored = JSON.parse(workflow.data_json) as Record<string, unknown>;
  getDb()
    .prepare("UPDATE approval_workflows SET data_json=?,updated_at=? WHERE approval_id=? AND stage='applying'")
    .run(JSON.stringify({ ...stored, ...data }), new Date().toISOString(), workflow.approval_id);
}

export function retryApprovalWorkflow(id: string, revision: number, userId: string): boolean {
  return getDb().transaction(() => {
    const workflow = getApprovalWorkflow(id);
    if (
      !workflow ||
      workflow.stage !== 'failed' ||
      workflow.revision !== revision ||
      pendingWorkflow(workflow.dedupe_key)
    )
      return false;
    const { attempt_history, ...selection } = JSON.parse(workflow.data_json) as Record<string, unknown>;
    const history = Array.isArray(attempt_history) ? attempt_history : [];
    const data = {
      attempt_history: [
        ...history,
        {
          stage: workflow.stage,
          selection,
          result: workflow.result_json ? (JSON.parse(workflow.result_json) as unknown) : null,
          finished_at: workflow.updated_at,
          reopened_by: userId,
        },
      ],
    };
    const changed = getDb()
      .prepare(
        `UPDATE approval_workflows SET stage='pending',revision=revision+1,
      data_json=?,result_json=NULL,notified=0,updated_at=? WHERE approval_id=? AND stage='failed' AND revision=?`,
      )
      .run(JSON.stringify(data), new Date().toISOString(), workflow.approval_id, revision).changes;
    if (!changed) return false;
    getDb().prepare("UPDATE pending_approvals SET status='pending' WHERE approval_id=?").run(workflow.approval_id);
    return true;
  })();
}

export function finishApprovalWorkflow(
  id: string,
  stage: Exclude<WorkflowStage, 'pending' | 'applying'>,
  message: string,
  restart = false,
): void {
  getDb().transaction(() => {
    const workflow = getApprovalWorkflow(id);
    if (!workflow || !['pending', 'applying'].includes(workflow.stage)) return;
    id = workflow.approval_id;
    const notificationId = `approval-result-${id}-r${workflow.revision + 1}`;
    const updated = getDb()
      .prepare(
        `UPDATE approval_workflows SET stage=?,revision=revision+1,result_json=?,updated_at=?
      WHERE approval_id=? AND stage IN ('pending','applying')`,
      )
      .run(stage, JSON.stringify({ message, restart, notification_id: notificationId }), new Date().toISOString(), id);
    if (!updated.changes) return;
    getDb()
      .prepare('UPDATE pending_approvals SET status=? WHERE approval_id=?')
      .run(stage === 'completed' ? 'approved' : stage === 'expired' ? 'expired' : 'rejected', id);
  })();
}

export async function notifyApprovalWorkflow(id: string): Promise<void> {
  const workflow = getApprovalWorkflow(id);
  if (!workflow || workflow.notified || !workflow.result_json) return;
  const approval = getPendingApproval(workflow.approval_id);
  const session = approval?.session_id ? getSession(approval.session_id) : undefined;
  if (!session) return;
  const result = JSON.parse(workflow.result_json) as { message: string; restart?: boolean; notification_id?: string };
  const origin = JSON.parse(workflow.origin_json) as { messageId?: string | null };
  const options = {
    originMessageId: approval?.origin_message_id ?? origin.messageId,
    id: result.notification_id ?? `approval-result-${workflow.approval_id}`,
    idempotent: true,
    timestamp: workflow.updated_at,
  };
  writeApprovalNotification(
    session,
    result.restart
      ? 'The approval was applied and the runtime configuration saved. Finish the current response first. The container will restart afterward; verify the new configuration only after that restart.'
      : result.message,
    options,
  );
  if (result.restart) {
    writeApprovalNotification(session, `The approved configuration is now loaded.\n${result.message}`, {
      ...options,
      id: `${options.id}-restart`,
      afterRestart: true,
    });
  }
  await wakeContainer(session);
  getDb()
    .prepare('UPDATE approval_workflows SET notified=1 WHERE approval_id=? AND revision=?')
    .run(workflow.approval_id, workflow.revision);
}
