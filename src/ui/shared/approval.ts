export interface ApprovalOrigin {
  agentGroupId: string;
  threadId: string;
  channelType: string;
  messagingGroupId: string;
}

export interface ConversationApproval {
  approvalId: string;
  action: string;
  title: string;
  details: string | null;
  packages: { apt: string[]; npm: string[]; pip: string[] } | null;
  options: { label: string; selectedLabel: string; value: string }[];
  agentGroupId: string | null;
  agentGroupName: string | null;
  createdAt: string;
  supportsResponseMessage?: boolean;
  reviewRequired?: boolean;
  stage?: string;
  origin?: ApprovalOrigin | null;
  status?: 'pending' | 'applying' | 'approved' | 'rejected' | 'failed' | 'cancelled' | 'expired';
  decision?: string | null;
  respondedBy?: { userId: string; displayName: string } | null;
  responseMessage?: string | null;
  outcomeMessage?: string | null;
  resolvedAt?: string | null;
}
