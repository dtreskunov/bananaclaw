import type { ComponentProps } from 'preact';
import { ApprovalCard } from './ApprovalCard';
import { MessageBubble } from './MessageBubble';
import { isApprovalThread } from '../approval-origin';
import { AccessRequestCard, AccountRequestSummary } from './AccessRequestCard';
import type { ConversationApproval } from '../../../../shared/approval';
import { currentUserId, groupId } from '../state';

type Props = Omit<ComponentProps<typeof ApprovalCard>, 'approval'> & { approval: ConversationApproval; reference?: boolean };

export function ApprovalBubble({ approval, busy, onRespond, reference }: Props) {
  const status = approval.status;
  const answered = approval.decision === 'approve' || approval.decision === 'reject' ||
    status === 'approved' || status === 'completed' || status === 'rejected';
  const from = answered
    ? approval.respondedBy && approval.respondedBy.userId !== currentUserId.value
      ? approval.respondedBy.displayName : undefined
    : approval.agentGroupId !== groupId.value ? approval.agentGroupName || 'Global' : undefined;
  const access = approval.kind !== 'confirmation' && isApprovalThread(approval.origin) &&
    (status === 'pending' || status === 'applying' || approval.retryable);
  return <MessageBubble class={`msg ${answered ? 'in' : 'out'} approval-message${access ? ' markdown access-approval-message' : ''}${reference ? ' approval-reference' : ''}`}
    data-msg-id={approval.id}
    from={from} timestamp={approval.resolvedAt ?? approval.createdAt}>
    {approval.kind === 'confirmation'
      ? <ApprovalCard approval={approval} busy={busy} onRespond={onRespond} />
      : access ? <AccessRequestCard request={approval} disabled={busy || status === 'applying'} />
      : <AccountRequestSummary request={approval} />}
  </MessageBubble>;
}
