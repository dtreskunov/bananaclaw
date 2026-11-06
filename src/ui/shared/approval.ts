import type { EpochMs } from './time.js';
export interface ApprovalOrigin {
  agentGroupId: string;
  threadId: string;
  channelType: string;
  messagingGroupId: string;
}

interface InteractionIdentity {
  id: string;
  agentGroupId: string | null;
  agentGroupName: string | null;
  createdAt: EpochMs;
}

interface InteractionContext {
  origin?: ApprovalOrigin | null;
  decision?: string | null;
  respondedBy?: { userId: string; displayName: string } | null;
  responseMessage?: string | null;
}

export interface ConfirmationInteraction extends InteractionIdentity, InteractionContext {
  kind: 'confirmation';
  action: string;
  title: string;
  details: string | null;
  packages: { apt: string[]; npm: string[]; pip: string[] } | null;
  options: { label: string; selectedLabel: string; value: string }[];
  supportsResponseMessage: boolean;
  status: 'pending' | 'applying' | 'approved' | 'rejected' | 'failed' | 'cancelled' | 'expired';
  outcomeMessage?: string | null;
  resolvedAt?: EpochMs | null;
}

export interface AccountRequirements extends AccessRequirements {
  reason: string;
}

export type AccountRequestStatus =
  | 'pending'
  | 'applying'
  | 'completed'
  | 'rejected'
  | 'cancelled'
  | 'expired'
  | 'failed';

export interface AccountRequestData extends Omit<InteractionIdentity, 'createdAt'> {
  createdAt: string;
  kind: 'account_setup' | 'access_grant';
  requirements: AccountRequirements;
  status: AccountRequestStatus;
  revision: number;
  retryable: boolean;
  agentGroupId: string;
  agentGroupName: string;
  expiresAt: string | null;
  outcomeMessage: string | null;
  resolvedAt: string | null;
}

export type AccountInteraction = Omit<AccountRequestData, 'createdAt' | 'expiresAt' | 'resolvedAt'> &
  InteractionContext & {
    createdAt: EpochMs;
    expiresAt: EpochMs | null;
    resolvedAt: EpochMs | null;
  };
export type ConversationApproval = ConfirmationInteraction | AccountInteraction;
import type { AccessRequirements } from './access-authentication.js';
