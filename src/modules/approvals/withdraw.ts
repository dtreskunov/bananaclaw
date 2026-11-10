import { getApproval, updateApprovalStatus } from '../../db/approvals.js';
import { isApprovalExecuting } from '../../db/sessions.js';
import { transaction } from '../../db/transaction.js';
import { getDb } from '../../db/connection.js';
import { log } from '../../log.js';
import { getApprovalWorkflow } from './workflows.js';

export function withdrawApproval(id: string, sessionId: string) {
  return transaction(getDb(), () => {
    const approval = getApproval(id) ?? getApprovalWorkflow(id);
    if (!approval || approval.session_id !== sessionId) throw new Error('Approval not found in this session.');
    if (approval.status !== 'pending' || isApprovalExecuting(approval.id))
      throw new Error('Only a pending request can be withdrawn; this request is already being applied or resolved.');
    if (!updateApprovalStatus(approval.id, 'cancelled', undefined, approval.revision))
      throw new Error('The request changed before it could be withdrawn. Inspect its current status.');
    log.info('Approval withdrawn by agent', { approvalId: approval.id, sessionId });
    return { id: approval.id, status: 'cancelled' as const };
  })();
}
