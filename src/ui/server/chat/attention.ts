import { queryInteractions } from '../../../db/interactions.js';
import type { Interaction } from '../../../types.js';
import type { SyncResponse } from '../../shared/sync.js';
import { projectApproval } from './approval-transcript.js';
import { canRespondToApproval } from './interaction-access.js';
import { resolveTurnContext } from './conversation-context.js';
import { publicationReadCursor } from './read-state.js';

export function readInteractionSync(userId: string): Pick<SyncResponse, 'approvals' | 'attention'> {
  const rows = queryInteractions<Interaction>(
    "SELECT * FROM interactions WHERE status IN ('pending','applying') ORDER BY created_at DESC,id DESC",
  );
  const result: Pick<SyncResponse, 'approvals' | 'attention'> = { approvals: [], attention: [] };
  for (const row of rows) {
    if (!canRespondToApproval(userId, row)) continue;
    const approval = projectApproval(userId, row);
    result.approvals.push(approval);
    if (
      approval.status === 'pending' &&
      approval.origin &&
      (approval.kind !== 'confirmation' || approval.options.length > 0)
    ) {
      const origin = approval.origin;
      const context =
        origin.channelType === 'web' ? resolveTurnContext(userId, origin.agentGroupId, origin.threadId, origin) : null;
      const readCursor = context
        ? publicationReadCursor(userId, origin.agentGroupId, context, {
            kind: 'interaction',
            id: row.id,
          })
        : undefined;
      result.attention.push({ id: row.id, origin, ...(readCursor ? { readCursor } : {}) });
    }
  }
  result.attention.reverse();
  return result;
}
