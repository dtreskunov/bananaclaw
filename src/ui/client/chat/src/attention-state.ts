import { signal } from '@preact/signals';
import type { AttentionTarget } from '../../../shared/attention';

export const attentionTargets = signal<AttentionTarget[] | null>(null);
export const attentionError = signal<string | null>(null);
export interface AttentionLocation {
  agentGroupId: string | null;
  threadId: string | null;
  channelType: string | null;
  messagingGroupId: string | null;
}

export function matchesAttentionLocation(
  target: Pick<AttentionTarget, 'origin'>,
  location: AttentionLocation,
): boolean {
  const origin = target.origin;
  return (
    origin.agentGroupId === location.agentGroupId &&
    origin.threadId === location.threadId &&
    origin.channelType === (location.channelType || 'web') &&
    (origin.messagingGroupId === location.messagingGroupId ||
      (origin.channelType === 'web' && location.messagingGroupId === null))
  );
}

export function groupAttentionCount(groupId: string): number {
  return attentionTargets.value?.filter((target) => target.origin.agentGroupId === groupId).length ?? 0;
}

export function threadAttentionCount(location: AttentionLocation): number {
  return attentionTargets.value?.filter((target) => matchesAttentionLocation(target, location)).length ?? 0;
}
