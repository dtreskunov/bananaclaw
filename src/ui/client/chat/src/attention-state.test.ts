import { afterEach, describe, expect, it } from 'vitest';
import type { AttentionTarget } from '../../../shared/attention';
import { isAttentionTargets } from '../../../shared/attention';
import { attentionTargets, groupAttentionCount, threadAttentionCount } from './attention-state';

const targets: AttentionTarget[] = [
  {
    id: 'a',
    origin: { agentGroupId: 'g', threadId: 't', channelType: 'web', messagingGroupId: 'm' },
  },
  {
    id: 'b',
    origin: { agentGroupId: 'g', threadId: 't', channelType: 'web', messagingGroupId: 'm' },
  },
  {
    id: 'c',
    origin: { agentGroupId: 'g', threadId: 't', channelType: 'resend', messagingGroupId: 'mail' },
  },
  {
    id: 'd',
    origin: { agentGroupId: 'other', threadId: 't', channelType: 'web', messagingGroupId: 'm2' },
  },
];
const location = { agentGroupId: 'g', threadId: 't', channelType: 'web', messagingGroupId: 'm' };
afterEach(() => {
  attentionTargets.value = null;
});

describe('one canonical attention snapshot', () => {
  it('derives agent and thread counts without conflating matching thread IDs or channels', () => {
    attentionTargets.value = targets;
    expect(groupAttentionCount('g')).toBe(3);
    expect(groupAttentionCount('other')).toBe(1);
    expect(threadAttentionCount(location)).toBe(2);
    expect(threadAttentionCount({ ...location, channelType: 'resend', messagingGroupId: 'mail' })).toBe(1);
    expect(threadAttentionCount({ ...location, agentGroupId: 'other' })).toBe(0);
    expect(threadAttentionCount({ ...location, messagingGroupId: null })).toBe(2);
    expect(attentionTargets.value).toBe(targets);
  });

  it('accepts empty snapshots but rejects missing, duplicate or conflicting destinations', () => {
    expect(isAttentionTargets([])).toBe(true);
    expect(isAttentionTargets(targets)).toBe(true);
    expect(isAttentionTargets(undefined)).toBe(false);
    expect(isAttentionTargets([targets[1], targets[1]])).toBe(false);
    expect(isAttentionTargets([{ id: 'bad', origin: null }])).toBe(false);
    expect(isAttentionTargets([{ id: 'missing-origin', agentGroupId: 'g' }])).toBe(false);
  });
  it('validates optional publication cursors on waiting targets', () => {
    expect(
      isAttentionTargets([
        {
          ...targets[0],
          readCursor: {
            sessionId: 's',
            key: '0123456789abcdef0123456789abcdef',
          },
        },
      ]),
    ).toBe(true);
    expect(isAttentionTargets([{ ...targets[0], readCursor: { sessionId: 's', key: 'invalid' } }])).toBe(false);
    expect(isAttentionTargets([{ ...targets[0], readCursor: null }])).toBe(false);
  });
});
