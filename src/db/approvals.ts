import type { Approval } from '../types.js';
import { invalidateConversation } from '../conversation-events.js';
import { getDb } from './connection.js';

export type { Approval } from '../types.js';

export function createApproval(
  approval: Pick<
    Approval,
    'approval_id' | 'request_id' | 'action' | 'payload' | 'created_at' | 'title' | 'options_json'
  > &
    Partial<Pick<Approval, 'session_id' | 'agent_group_id' | 'origin_message_id' | 'expires_at'>>,
): boolean {
  const result = getDb()
    .prepare(
      `INSERT INTO approvals
        (approval_id,request_id,action,payload,created_at,updated_at,title,options_json,
         session_id,agent_group_id,origin_message_id,expires_at,kind)
       VALUES (@approval_id,@request_id,@action,@payload,@created_at,@created_at,@title,@options_json,
         @session_id,@agent_group_id,@origin_message_id,@expires_at,@kind)
       ON CONFLICT(approval_id) DO NOTHING`,
    )
    .run({
      session_id: null,
      agent_group_id: null,
      origin_message_id: null,
      expires_at: null,
      kind: approval.action === 'request_access' ? 'access_grant' : 'confirmation',
      ...approval,
    });
  const sessionId = approval.session_id;
  if (result.changes && sessionId) queueMicrotask(() => invalidateConversation(sessionId));
  return result.changes > 0;
}

export function getApproval(id: string): Approval | undefined {
  return getDb().prepare('SELECT * FROM approvals WHERE approval_id=?').get(id) as Approval | undefined;
}

export function updateApprovalStatus(
  id: string,
  status: Approval['status'],
  response?: { userId?: string; decision?: string; message?: string; outcome?: string },
  expectedRevision?: number,
): boolean {
  const result = getDb()
    .prepare(
      `UPDATE approvals SET status=@status,revision=revision+1,updated_at=@now,
       decision=CASE WHEN @status='pending' THEN NULL ELSE COALESCE(@decision,decision) END,
       responded_by=CASE WHEN @status='pending' THEN NULL ELSE COALESCE(@userId,responded_by) END,
       response_message=CASE WHEN @status='pending' THEN NULL WHEN @hasResponse THEN @message ELSE response_message END,
       outcome_message=CASE WHEN @status='pending' THEN NULL ELSE COALESCE(@outcome,outcome_message) END,
       resolved_at=CASE WHEN @status IN ('pending','applying') THEN NULL ELSE @now END
       WHERE approval_id=@id AND (@revision IS NULL OR revision=@revision)`,
    )
    .run({
      id,
      status,
      now: new Date().toISOString(),
      revision: expectedRevision ?? null,
      decision: response?.decision ?? null,
      userId: response?.userId ?? null,
      message: response?.message ?? null,
      outcome: response?.outcome ?? null,
      hasResponse: response !== undefined ? 1 : 0,
    });
  const sessionId = result.changes ? getApproval(id)?.session_id : null;
  if (sessionId) queueMicrotask(() => invalidateConversation(sessionId));
  return result.changes === 1;
}
