import type { ComponentProps } from 'preact';
import { ApprovalCard } from './ApprovalCard';
import { MessageBubble } from './MessageBubble';
import { isApprovalThread } from '../approval-origin';
import { AccessRequestCard } from './AccessRequestCard';
import { currentUserId, groupId } from '../state';

type Props = ComponentProps<typeof ApprovalCard> & { reference?: boolean };

export function ApprovalBubble({ approval, busy, onReview, onRespond, reference }: Props) {
  const status = approval.status;
  const answered = approval.decision === 'approve' || approval.decision === 'reject' ||
    status === 'approved' || status === 'rejected';
  const from = answered
    ? approval.respondedBy && approval.respondedBy.userId !== currentUserId.value
      ? approval.respondedBy.displayName : undefined
    : approval.agentGroupId !== groupId.value ? approval.agentGroupName || 'Global' : undefined;
  const access = approval.kind !== 'confirmation' && isApprovalThread(approval.origin) &&
    ['pending', 'applying', 'failed'].includes(status);
  return <MessageBubble class={`msg ${answered ? 'in' : 'out'} approval-message${access ? ' markdown access-approval-message' : ''}${reference ? ' approval-reference' : ''}`}
    data-msg-id={approval.id}
    from={from} timestamp={approval.resolvedAt ?? approval.createdAt}>
    {access ? <AccessRequestCard id={approval.id} disabled={busy || status === 'applying'} /> :
      <ApprovalCard approval={approval} busy={busy} onReview={onReview} onRespond={onRespond} />}
  </MessageBubble>;
}
