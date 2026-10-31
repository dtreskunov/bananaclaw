import type { ComponentProps } from 'preact';
import { ApprovalCard } from './ApprovalCard';
import { MessageBubble } from './MessageBubble';

type Props = ComponentProps<typeof ApprovalCard> & { messageId?: string; reference?: boolean };

export function ApprovalBubble({ approval, busy, onReview, onRespond, messageId, reference }: Props) {
  return <MessageBubble class={`msg out approval-message${reference ? ' approval-reference' : ''}`}
    data-msg-id={messageId ?? `approval:${approval.approvalId}`}
    from={approval.agentGroupName || 'Global'} timestamp={approval.resolvedAt ?? approval.createdAt}>
    <ApprovalCard approval={approval} busy={busy} onReview={onReview} onRespond={onRespond} />
  </MessageBubble>;
}
