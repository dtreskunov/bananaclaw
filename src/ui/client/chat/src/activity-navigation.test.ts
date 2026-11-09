import { afterEach, describe, expect, it } from 'vitest';
import {
  activityNavigationPending,
  beginActivityNavigation,
  cancelActivityNavigation,
  finishActivityNavigation,
  isActivityNavigating,
  isCurrentActivityNavigation,
  setActivityDestination,
} from './activity-navigation';

const origin = { agentGroupId: 'g', threadId: 't', channelType: 'web', messagingGroupId: 'm' };
afterEach(cancelActivityNavigation);

describe('immediate navigation feedback', () => {
  it('starts synchronously and scopes progress across agent, rail and header presentations', () => {
    const request = beginActivityNavigation(origin);
    expect(activityNavigationPending.value?.request).toBe(request);
    expect(isActivityNavigating('g')).toBe(true);
    expect(isActivityNavigating(origin)).toBe(true);
    expect(isActivityNavigating({ ...origin, threadId: 'other' })).toBe(false);
    expect(isActivityNavigating({ ...origin, messagingGroupId: 'other' })).toBe(false);
  });
  it('adds the destination thread once lookup completes, then finishes only that request', () => {
    const first = beginActivityNavigation('g');
    expect(isActivityNavigating(origin)).toBe(false);
    setActivityDestination(first, { origin, anchor: { kind: 'message', id: 'target' } });
    expect(isActivityNavigating(origin)).toBe(true);
    const second = beginActivityNavigation('other');
    finishActivityNavigation(first);
    expect(activityNavigationPending.value?.request).toBe(second);
    expect(isCurrentActivityNavigation(first)).toBe(false);
    finishActivityNavigation(second);
    expect(activityNavigationPending.value).toBeNull();
  });
  it('invalidates delayed results when the user cancels or navigates normally', () => {
    const request = beginActivityNavigation('g');
    cancelActivityNavigation();
    expect(isCurrentActivityNavigation(request)).toBe(false);
    expect(isActivityNavigating('g')).toBe(false);
  });
});
