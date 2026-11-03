import type { Approval } from '../types.js';
import { getDb } from './connection.js';
import { createInteraction, getInteraction, interactionChanged } from './interactions.js';
import { accessRequestInput } from '../ui/shared/connection-input.js';

export type { Approval } from '../types.js';

export function createApproval(
  approval: Pick<Approval, 'id' | 'request_id' | 'input' | 'created_at'> &
    Partial<Pick<Approval, 'session_id' | 'agent_group_id' | 'origin_message_id' | 'expires_at'>>,
): boolean {
  return createInteraction({
    ...approval,
    ...(approval.input.action === 'request_access'
      ? ({
          kind: 'access_grant',
          input: { ...approval.input, payload: { ...accessRequestInput(approval.input.payload) } },
        } as const)
      : ({ kind: 'confirmation' } as const)),
    response: { decision: null, message: null },
  });
}

export function getApproval(id: string): Approval | undefined {
  const record = getInteraction(id);
  return record?.kind === 'question' ? undefined : record;
}

export function updateApprovalStatus(
  id: string,
  status: Approval['status'],
  response?: { userId?: string; decision?: string; message?: string; outcome?: string },
  expectedRevision?: number,
): boolean {
  const result = getDb()
    .prepare(
      `UPDATE interactions SET status=@status,revision=revision+1,updated_at=@now,
       response_json=json_object(
         'decision',CASE WHEN @status='pending' THEN NULL ELSE COALESCE(@decision,json_extract(response_json,'$.decision')) END,
         'message',CASE WHEN @status='pending' THEN NULL WHEN @hasResponse THEN @message ELSE json_extract(response_json,'$.message') END),
       responded_by=CASE WHEN @status='pending' THEN NULL ELSE COALESCE(@userId,responded_by) END,
       responded_at=CASE WHEN @status='pending' THEN NULL WHEN @hasResponse THEN @now ELSE responded_at END,
       outcome_message=CASE WHEN @status='pending' THEN NULL ELSE COALESCE(@outcome,outcome_message) END,
       resolved_at=CASE WHEN @status IN ('pending','applying') THEN NULL ELSE @now END
       WHERE id=@id AND kind!='question' AND (@revision IS NULL OR revision=@revision)`,
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
  if (result.changes) interactionChanged(id);
  return result.changes === 1;
}
