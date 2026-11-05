import { describe, expect, it } from 'vitest';
import { isSyncSubscription, parseSyncFrame, SYNC_PROTOCOL_VERSION } from './sync.js';
import { conversationSnapshot } from '../server/chat/conversation-stream.js';

describe('global sync protocol', () => {
  const global = {
    kind: 'sync',
    protocolVersion: SYNC_PROTOCOL_VERSION,
    subscriptionId: 1,
    groupId: null,
    conversation: null,
    global: { approvals: [], attention: [], group: null },
  };
  it('accepts authoritative empty state but rejects missing attention and malformed approvals', () => {
    expect(parseSyncFrame(global)).toEqual(global);
    expect(() => parseSyncFrame({ ...global, global: { approvals: [] } })).toThrow('Invalid');
    expect(() => parseSyncFrame({ ...global, global: { approvals: [{}], attention: [] } })).toThrow('Invalid');
  });
  it('requires complete group state and explicitly represents revoked access', () => {
    expect(() => parseSyncFrame({ ...global, global: { approvals: [], attention: [] } })).toThrow('Invalid');
    expect(
      parseSyncFrame({
        ...global,
        groupId: 'g',
      }).global!.group,
    ).toBeNull();
    const group = { threads: [], voiceInput: { backend: 'disabled', ready: false } };
    expect(parseSyncFrame({ ...global, groupId: 'g', global: { ...global.global!, group } }).global!.group).toEqual(
      group,
    );
    expect(() => parseSyncFrame({ ...global, global: { ...global.global!, group } })).toThrow('Invalid');
    expect(() =>
      parseSyncFrame({ ...global, groupId: 'g', global: { ...global.global!, group: { threads: [] } } }),
    ).toThrow('Invalid');
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
          global: {
            ...global.global!,
            group: { threads: [thread], voiceInput: { backend: 'disabled', ready: false } },
          },
        }),
      ).toThrow('Invalid');
    },
  );
  it('validates conversation-only frames and distinguishes omitted state from a clear', () => {
    const snapshot = conversationSnapshot({
      threadId: 'thread',
      messages: [],
      turns: [],
      interactions: [],
      timeline: [],
      connection: { connected: false, activeTurnId: null },
      capabilities: { canSend: false, stop: false, steer: false, editInput: false, cancelInput: false },
    });
    const frame = { ...global, global: undefined, groupId: 'g', conversation: snapshot };
    expect(parseSyncFrame(frame).conversation).toEqual(snapshot);
    expect(parseSyncFrame({ ...frame, conversation: null }).conversation).toBeNull();
    expect(parseSyncFrame({ ...global, conversation: undefined }).conversation).toBeUndefined();
    expect(() => parseSyncFrame({ ...frame, conversation: undefined })).toThrow('Invalid');
    expect(() => parseSyncFrame({ ...frame, conversation: { ...snapshot, protocolVersion: 999 } })).toThrow(
      'protocol changed',
    );
    expect(() => parseSyncFrame({ ...frame, conversation: { ...snapshot, revision: -1 } })).toThrow();
  });
  it('requires a group and a complete non-web context for conversation subscriptions', () => {
    const request = {
      kind: 'subscribe',
      protocolVersion: SYNC_PROTOCOL_VERSION,
      subscriptionId: 1,
      groupId: 'g',
      conversation: { threadId: 'thread', channelType: 'telegram', messagingGroupId: 'mg' },
    };
    expect(isSyncSubscription(request)).toBe(true);
    expect(isSyncSubscription({ ...request, groupId: null })).toBe(false);
    expect(isSyncSubscription({ ...request, conversation: { ...request.conversation, messagingGroupId: null } })).toBe(
      false,
    );
    expect(
      isSyncSubscription({ ...request, conversation: { ...request.conversation, threadId: 't'.repeat(513) } }),
    ).toBe(false);
    expect(
      isSyncSubscription({
        ...request,
        conversation: { ...request.conversation, channelType: 'web', messagingGroupId: null },
      }),
    ).toBe(true);
  });
  it('bounds subscription input and rejects protocol mismatches', () => {
    expect(
      isSyncSubscription({
        kind: 'subscribe',
        protocolVersion: SYNC_PROTOCOL_VERSION,
        subscriptionId: 1,
        groupId: null,
        conversation: null,
      }),
    ).toBe(true);
    expect(
      isSyncSubscription({
        kind: 'subscribe',
        protocolVersion: SYNC_PROTOCOL_VERSION,
        subscriptionId: -1,
        groupId: 'g',
        conversation: null,
      }),
    ).toBe(false);
    expect(
      isSyncSubscription({
        kind: 'subscribe',
        protocolVersion: SYNC_PROTOCOL_VERSION,
        subscriptionId: 1,
        groupId: 'g'.repeat(513),
        conversation: null,
      }),
    ).toBe(false);
    expect(() => parseSyncFrame({ ...global, protocolVersion: 999 })).toThrow('protocol changed');
    expect(() => parseSyncFrame({ kind: 'protocol_mismatch', protocolVersion: SYNC_PROTOCOL_VERSION })).toThrow(
      'protocol changed',
    );
  });
});
