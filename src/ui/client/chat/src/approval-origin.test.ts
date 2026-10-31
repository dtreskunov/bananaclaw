import { afterEach, beforeEach, expect, it, vi } from 'vitest';
vi.hoisted(() => vi.stubGlobal('window', { matchMedia: () => ({ matches: false }) }));
import { approvalThreadHref, isApprovalThread } from './approval-origin';
import { channelType, groupId, messagingGroupId, threadId } from './state';
const origin = { agentGroupId: 'g', threadId: 'thread', channelType: 'web', messagingGroupId: 'web' };
beforeEach(() => {
  groupId.value = 'g';
  threadId.value = 'thread';
  channelType.value = 'web';
  messagingGroupId.value = null;
});
afterEach(() => {
  groupId.value = null;
  threadId.value = null;
  channelType.value = 'web';
  messagingGroupId.value = null;
});
it('matches web conversations without requiring a browser-only messaging-group override', () => {
  expect(isApprovalThread(origin)).toBe(true);
  expect(isApprovalThread({ ...origin, threadId: 'other' })).toBe(false);
  expect(isApprovalThread({ ...origin, agentGroupId: 'other' })).toBe(false);
  expect(isApprovalThread(null)).toBe(false);
  expect(isApprovalThread(undefined)).toBe(false);
});
it('requires the exact adapter conversation for non-web threads', () => {
  channelType.value = 'telegram';
  messagingGroupId.value = 'telegram';
  const remote = { ...origin, channelType: 'telegram', messagingGroupId: 'telegram' };
  expect(isApprovalThread(remote)).toBe(true);
  expect(isApprovalThread({ ...remote, messagingGroupId: 'different' })).toBe(false);
  expect(isApprovalThread({ ...remote, channelType: 'web' })).toBe(false);
});
it('encodes the source group and thread into an actual chat route', () => {
  expect(approvalThreadHref({ ...origin, agentGroupId: 'g/one', threadId: '__dm:chat' })).toBe(
    '#g/g%2Fone/t/__dm%3Achat',
  );
});
