import { getDb } from '../../db/connection.js';
import { getPendingApproval, getSession } from '../../db/sessions.js';
import { writeSessionMessage } from '../../session-manager.js';
import { isContainerRunning, killContainer, wakeContainer } from '../../container-runner.js';

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
  return (
    getDb()
      .prepare(
        `UPDATE approval_workflows SET stage='applying',revision=revision+1,data_json=?,updated_at=?
    WHERE approval_id=? AND stage='pending' AND revision=?`,
      )
      .run(JSON.stringify(data), new Date().toISOString(), id, revision).changes === 1
  );
}

export function finishApprovalWorkflow(
  id: string,
  stage: Exclude<WorkflowStage, 'pending' | 'applying'>,
  message: string,
  restart = false,
): void {
  getDb().transaction(() => {
    const updated = getDb()
      .prepare(
        `UPDATE approval_workflows SET stage=?,revision=revision+1,result_json=?,updated_at=?
      WHERE approval_id=? AND stage IN ('pending','applying')`,
      )
      .run(stage, JSON.stringify({ message, restart }), new Date().toISOString(), id);
    if (!updated.changes) return;
    getDb()
      .prepare('UPDATE pending_approvals SET status=? WHERE approval_id=?')
      .run(stage === 'completed' ? 'approved' : stage === 'expired' ? 'expired' : 'rejected', id);
  })();
}

export async function notifyApprovalWorkflow(id: string): Promise<void> {
  const workflow = getApprovalWorkflow(id);
  if (!workflow || workflow.notified || !workflow.result_json) return;
  const approval = getPendingApproval(id);
  const session = approval?.session_id ? getSession(approval.session_id) : undefined;
  if (!session) return;
  const result = JSON.parse(workflow.result_json) as { message: string; restart?: boolean };
  writeSessionMessage(session.agent_group_id, session.id, {
    id: `approval-result-${id}`,
    idempotent: true,
    kind: 'chat',
    timestamp: workflow.updated_at,
    channelType: 'agent',
    platformId: session.agent_group_id,
    threadId: session.thread_id,
    ...(result.restart ? { onWake: 1 as const } : {}),
    content: JSON.stringify({ text: result.message, sender: 'system', senderId: 'system' }),
  });
  if (result.restart && isContainerRunning(session.id)) {
    await new Promise<void>((resolve, reject) => {
      killContainer(session.id, 'approved configuration changed', () => {
        void wakeContainer(session).then(() => resolve(), reject);
      });
    });
  } else {
    await wakeContainer(session);
  }
  getDb().prepare('UPDATE approval_workflows SET notified=1 WHERE approval_id=?').run(id);
}
