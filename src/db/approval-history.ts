import { getDb } from './connection.js';
import { invalidateConversation } from '../conversation-events.js';

export type ApprovalStatus = 'pending' | 'applying' | 'approved' | 'rejected' | 'failed' | 'cancelled' | 'expired';
export interface ApprovalHistoryRow {
  approval_id: string;
  session_id: string;
  origin_message_id: string | null;
  action: string;
  payload: string;
  title: string;
  options_json: string;
  created_at: string;
  status: ApprovalStatus;
  decision: string | null;
  responded_by: string | null;
  response_message: string | null;
  outcome_message: string | null;
  resolved_at: string | null;
}

export function archiveApprovalRequest(id: string): void {
  getDb()
    .prepare(
      `INSERT OR IGNORE INTO approval_history(
    approval_id,session_id,origin_message_id,action,payload,title,options_json,created_at,status)
    SELECT approval_id,session_id,origin_message_id,action,payload,title,options_json,created_at,status
    FROM pending_approvals WHERE approval_id=? AND session_id IS NOT NULL`,
    )
    .run(id);
  const row = getApprovalHistory(id);
  if (row) queueMicrotask(() => invalidateConversation(row.session_id));
}

export function getApprovalHistory(id: string): ApprovalHistoryRow | undefined {
  return getDb().prepare('SELECT * FROM approval_history WHERE approval_id=?').get(id) as
    | ApprovalHistoryRow
    | undefined;
}

export function updateApprovalHistory(
  id: string,
  status: ApprovalStatus,
  response?: { userId?: string; decision?: string; message?: string; outcome?: string },
): void {
  getDb()
    .prepare(
      `UPDATE approval_history SET status=?,
    decision=CASE WHEN ?='pending' THEN NULL ELSE COALESCE(?,decision) END,
    responded_by=CASE WHEN ?='pending' THEN NULL ELSE COALESCE(?,responded_by) END,
    response_message=CASE WHEN ?='pending' THEN NULL WHEN ? THEN ? ELSE response_message END,
    outcome_message=CASE WHEN ?='pending' THEN NULL ELSE COALESCE(?,outcome_message) END,
    resolved_at=CASE WHEN ? IN ('pending','applying') THEN NULL ELSE ? END
    WHERE approval_id=?`,
    )
    .run(
      status,
      status,
      response?.decision ?? null,
      status,
      response?.userId ?? null,
      status,
      response !== undefined ? 1 : 0,
      response?.message ?? null,
      status,
      response?.outcome ?? null,
      status,
      new Date().toISOString(),
      id,
    );
  const row = getApprovalHistory(id);
  if (row) queueMicrotask(() => invalidateConversation(row.session_id));
}
