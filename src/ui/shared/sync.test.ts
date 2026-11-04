import { describe, expect, it } from 'vitest';
import { isSyncSubscription, parseSyncFrame, SYNC_PROTOCOL_VERSION } from './sync.js';

describe('global sync protocol', () => {
  const global = {
    kind: 'sync',
    protocolVersion: SYNC_PROTOCOL_VERSION,
    subscriptionId: 1,
    groupId: null,
    data: { approvals: [], attention: [], group: null },
  };
  it('accepts authoritative empty state but rejects missing attention and malformed approvals', () => {
    expect(parseSyncFrame(global)).toEqual(global);
    expect(() => parseSyncFrame({ ...global, data: { approvals: [] } })).toThrow('Invalid');
    expect(() => parseSyncFrame({ ...global, data: { approvals: [{}], attention: [] } })).toThrow('Invalid');
  });
  it('requires complete group state and explicitly represents revoked access', () => {
    expect(() => parseSyncFrame({ ...global, data: { approvals: [], attention: [] } })).toThrow('Invalid');
    expect(
      parseSyncFrame({
        ...global,
        groupId: 'g',
      }).data.group,
    ).toBeNull();
    const group = { threads: [], voiceInput: { backend: 'disabled', ready: false } };
    expect(parseSyncFrame({ ...global, groupId: 'g', data: { ...global.data, group } }).data.group).toEqual(group);
    expect(() => parseSyncFrame({ ...global, data: { ...global.data, group } })).toThrow('Invalid');
    expect(() => parseSyncFrame({ ...global, groupId: 'g', data: { ...global.data, group: { threads: [] } } })).toThrow(
      'Invalid',
    );
  });
  it.each([{ sessionId: null }, { messageCount: -1 }, { liveTasks: [{}] }, { forkedFrom: {} }])(
    'rejects malformed nested thread data: %s',
    (invalid) => {
      const thread = {
        threadId: 't',
        sessionId: 's',
        channelType: 'web',
        messagingGroupId: 'mg',
        platformId: 'group:g',
        title: '',
        lastActivityAt: '',
        sessionMode: 'per-thread',
        messageCount: 0,
        ...invalid,
      };
      expect(() =>
        parseSyncFrame({
          ...global,
          groupId: 'g',
          data: { ...global.data, group: { threads: [thread], voiceInput: { backend: 'disabled', ready: false } } },
        }),
      ).toThrow('Invalid');
    },
  );
  it('bounds subscription input and rejects protocol mismatches', () => {
    expect(
      isSyncSubscription({
        kind: 'subscribe',
        protocolVersion: SYNC_PROTOCOL_VERSION,
        subscriptionId: 1,
        groupId: null,
      }),
    ).toBe(true);
    expect(
      isSyncSubscription({
        kind: 'subscribe',
        protocolVersion: SYNC_PROTOCOL_VERSION,
        subscriptionId: -1,
        groupId: 'g',
      }),
    ).toBe(false);
    expect(
      isSyncSubscription({
        kind: 'subscribe',
        protocolVersion: SYNC_PROTOCOL_VERSION,
        subscriptionId: 1,
        groupId: 'g'.repeat(513),
      }),
    ).toBe(false);
    expect(() => parseSyncFrame({ ...global, protocolVersion: 999 })).toThrow('protocol changed');
    expect(() => parseSyncFrame({ kind: 'protocol_mismatch', protocolVersion: SYNC_PROTOCOL_VERSION })).toThrow(
      'protocol changed',
    );
  });
});
