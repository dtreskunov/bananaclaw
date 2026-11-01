import type { ComponentProps } from 'preact';
import { ApprovalCard } from './ApprovalCard';
import { MessageBubble } from './MessageBubble';
import { isApprovalThread } from '../approval-origin';
import { AccessRequestCard } from './AccessRequestCard';

type Props = ComponentProps<typeof ApprovalCard> & { messageId?: string; reference?: boolean };

export function ApprovalBubble({ approval, busy, onReview, onRespond, messageId, reference }: Props) {
  const status = approval.status ?? approval.stage ?? 'pending';
  const access = approval.action === 'request_access' && approval.reviewRequired && isApprovalThread(approval.origin) &&
    ['pending', 'applying', 'failed'].includes(status);
  return <MessageBubble class={`msg out approval-message${access ? ' markdown access-approval-message' : ''}${reference ? ' approval-reference' : ''}`}
    data-msg-id={messageId ?? `approval:${approval.approvalId}`}
    from={approval.agentGroupName || 'Global'} timestamp={approval.resolvedAt ?? approval.createdAt}>
    {access ? <AccessRequestCard id={approval.approvalId} disabled={busy || status === 'applying'} /> :
      <ApprovalCard approval={approval} busy={busy} onReview={onReview} onRespond={onRespond} />}
  </MessageBubble>;
}
