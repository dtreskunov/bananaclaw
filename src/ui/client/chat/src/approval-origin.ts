import { channelType, groupId, messagingGroupId, threadId } from './state';
import type { ApprovalOrigin } from '../../../shared/approval';

export function isApprovalThread(origin: ApprovalOrigin | null | undefined): boolean {
  return (
    !!origin &&
    origin.agentGroupId === groupId.value &&
    origin.threadId === threadId.value &&
    origin.channelType === (channelType.value || 'web') &&
    (origin.channelType === 'web' || origin.messagingGroupId === messagingGroupId.value)
  );
}

export function approvalThreadHref(origin: ApprovalOrigin): string {
  return `#g/${encodeURIComponent(origin.agentGroupId)}/t/${encodeURIComponent(origin.threadId)}`;
}
