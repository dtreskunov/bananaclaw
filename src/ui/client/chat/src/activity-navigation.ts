import { signal } from '@preact/signals';
import type { ActivityTarget } from '../../../shared/activity-target';
import type { AttentionLocation } from './attention-state';

export const activitySelection = signal<{ target: ActivityTarget; request: number } | null>(null);
export const activityNavigationPending = signal<{
  request: number;
  scope: string | AttentionLocation;
  target?: ActivityTarget;
} | null>(null);
let requestSequence = 0;

export function beginActivityNavigation(scope: string | AttentionLocation): number {
  const request = ++requestSequence;
  activitySelection.value = null;
  activityNavigationPending.value = { request, scope };
  return request;
}

export function cancelActivityNavigation(): void {
  requestSequence++;
  activitySelection.value = null;
  activityNavigationPending.value = null;
}

export function isCurrentActivityNavigation(request: number): boolean {
  return request === requestSequence;
}

export function setActivityDestination(request: number, target: ActivityTarget): void {
  const pending = activityNavigationPending.value;
  if (pending?.request === request) activityNavigationPending.value = { ...pending, target };
}

export function finishActivityNavigation(request: number): void {
  if (activityNavigationPending.value?.request === request) activityNavigationPending.value = null;
}

export function isActivityNavigating(scope: string | AttentionLocation): boolean {
  const pending = activityNavigationPending.value;
  if (!pending) return false;
  const source = pending.target?.origin ?? pending.scope;
  const gid = typeof source === 'string' ? source : source.agentGroupId;
  if ((typeof scope === 'string' ? scope : scope.agentGroupId) !== gid) return false;
  if (typeof scope === 'string') return true;
  return (
    typeof source !== 'string' &&
    scope.threadId === source.threadId &&
    (scope.channelType || 'web') === (source.channelType || 'web') &&
    (!scope.messagingGroupId || !source.messagingGroupId || scope.messagingGroupId === source.messagingGroupId)
  );
}

export function selectActivity(target: ActivityTarget): void {
  activitySelection.value = { target, request: requestSequence };
}
