import { describe, expect, it } from 'vitest';
import { isSyncSubscription, parseSyncFrame, SYNC_PROTOCOL_VERSION } from './sync.js';

describe('global sync protocol', () => {
  const global = {
    kind: 'sync',
    protocolVersion: SYNC_PROTOCOL_VERSION,
    subscriptionId: 1,
    groupId: null,
    data: { approvals: [], attention: [] },
  };
  it('accepts authoritative empty state but rejects missing attention and malformed approvals', () => {
    expect(parseSyncFrame(global)).toEqual(global);
    expect(() => parseSyncFrame({ ...global, data: { approvals: [] } })).toThrow('Invalid');
    expect(() => parseSyncFrame({ ...global, data: { approvals: [{}], attention: [] } })).toThrow('Invalid');
  });
  it('requires explicit group visibility and complete group state', () => {
    expect(() => parseSyncFrame({ ...global, groupId: 'g' })).toThrow('Invalid');
    expect(
      parseSyncFrame({
        ...global,
        groupId: 'g',
        data: { ...global.data, groupAccess: false, threads: [], voiceInput: { backend: 'disabled', ready: false } },
      }).data.groupAccess,
    ).toBe(false);
  });
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
  });
});
