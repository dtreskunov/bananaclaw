import { queryInteractions } from '../../../db/interactions.js';
import type { Interaction } from '../../../types.js';
import type { SyncResponse } from '../../shared/sync.js';
import { projectApproval } from './approval-transcript.js';
import { canRespondToApproval, questionResponseOrigin } from './interaction-access.js';

export function readInteractionSync(userId: string): Pick<SyncResponse, 'approvals' | 'attention'> {
  const rows = queryInteractions<Interaction>(
    "SELECT * FROM interactions WHERE status IN ('pending','applying') ORDER BY created_at DESC,id DESC",
  );
  const result: Pick<SyncResponse, 'approvals' | 'attention'> = { approvals: [], attention: [] };
  for (const row of rows) {
    if (row.kind === 'question') {
      if (row.status !== 'pending') continue;
      const origin = questionResponseOrigin(userId, row);
      if (origin) result.attention.push({ id: row.id, origin });
      continue;
    }
    if (!canRespondToApproval(userId, row)) continue;
    const approval = projectApproval(userId, row);
    result.approvals.push(approval);
    if (
      approval.status === 'pending' &&
      approval.origin &&
      (approval.kind !== 'confirmation' || approval.options.length > 0)
    )
      result.attention.push({ id: row.id, origin: approval.origin });
  }
  result.attention.reverse();
  return result;
}
