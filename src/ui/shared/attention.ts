import type { ApprovalOrigin } from './approval.js';

export interface AttentionTarget {
  id: string;
  origin: ApprovalOrigin;
}

export function isAttentionTargets(value: unknown): value is AttentionTarget[] {
  if (!Array.isArray(value)) return false;
  const ids = new Set<string>();
  const text = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
  return value.every((target: unknown) => {
    if (!target || typeof target !== 'object' || !('id' in target) || !text(target.id) || ids.has(target.id))
      return false;
    ids.add(target.id);
    if (!('origin' in target)) return false;
    const origin = target.origin;
    return (
      !!origin &&
      typeof origin === 'object' &&
      'agentGroupId' in origin &&
      text(origin.agentGroupId) &&
      'threadId' in origin &&
      text(origin.threadId) &&
      'channelType' in origin &&
      text(origin.channelType) &&
      'messagingGroupId' in origin &&
      text(origin.messagingGroupId)
    );
  });
}
