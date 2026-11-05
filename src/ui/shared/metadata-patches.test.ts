import { describe, expect, it } from 'vitest';
import {
  diffGlobal,
  parseSyncFrame,
  reduceGlobal,
  SYNC_PROTOCOL_VERSION,
  threadKey,
  type GlobalProjection,
  type GlobalSyncState,
  type GlobalUpdate,
  type SyncGroupState,
} from './sync.js';
import { testGlobalSnapshot } from './sync-test-fixtures.js';
import type { ConversationApproval } from './approval.js';

const approval: ConversationApproval = {
  kind: 'confirmation',
  id: 'approval',
  agentGroupId: 'g',
  agentGroupName: 'Group',
  createdAt: 'now',
  action: 'test',
  title: 'Review',
  details: null,
  packages: null,
  options: [],
  supportsResponseMessage: true,
  status: 'pending',
};
const group: SyncGroupState = {
  threads: Array.from({ length: 1000 }, (_, index) => ({
    threadId: `thread-${index}`,
    channelType: 'web',
    messagingGroupId: 'mg',
    sessionId: `s-${index}`,
    platformId: 'group:g',
    title: 'Conversation',
    lastActivityAt: 'now',
    sessionMode: 'per-thread',
    messageCount: 1,
    activity: 'idle',
  })),
  voiceInput: { backend: 'disabled', ready: false },
};
const data: GlobalSyncState = { approvals: [approval], attention: [], agentActivity: [], group };
const state: GlobalProjection = { ...testGlobalSnapshot(data), groupId: 'g' };
const patch = (next: GlobalSyncState, groupId: string | null = 'g'): GlobalUpdate => ({
  kind: 'update',
  streamId: state.streamId,
  baseRevision: 0,
  revision: 1,
  changes: diffGlobal(state, next, groupId),
});
const wire = <T>(value: T): T => JSON.parse(JSON.stringify(value));

describe('incremental metadata projections', () => {
  it('sends an approval replacement without including any of the 1000 threads', () => {
    const next = { ...data, approvals: [{ ...approval, title: 'Changed' }] };
    const frame = wire(patch(next));
    expect(frame.changes).toEqual({ approvals: { upserts: next.approvals, removeIds: [] } });
    expect(JSON.stringify(frame).length).toBeLessThan(512);
    const reduced = reduceGlobal(state, frame, 'g');
    expect(reduced.data).toEqual(next);
    expect(reduced.data.group).toBe(group);
  });
  it('sends one thread and omits unchanged order, approvals and voice', () => {
    const changed = { ...group.threads[999], messageCount: 2 };
    const next = { ...data, group: { ...group, threads: [...group.threads.slice(0, -1), changed] } };
    const frame = wire(patch(next));
    expect(frame.changes).toEqual({ group: { kind: 'update', threads: { upserts: [changed], removeIds: [] } } });
    expect(JSON.stringify(frame).length).toBeLessThan(512);
    const reduced = reduceGlobal(state, frame, 'g');
    expect(reduced.data).toEqual(next);
    expect(reduced.data.group?.threads[0]).toBe(group.threads[0]);
    expect(reduced.data.approvals).toBe(data.approvals);
  });
  it('patches one agent status independently of the selected group and its 1000 threads', () => {
    const before = {
      ...state,
      data: {
        ...data,
        agentActivity: [
          { id: 'g', activity: 'idle' as const },
          { id: 'other', activity: 'running' as const },
        ],
      },
    };
    const next = {
      ...before.data,
      agentActivity: [before.data.agentActivity[0], { id: 'other', activity: 'running' as const, waiting: true }],
    };
    const changes = wire(diffGlobal(before, next, 'g'));
    expect(changes).toEqual({ agentActivity: { upserts: [{ id: 'other', activity: 'running', waiting: true }], removeIds: [] } });
    const reduced = reduceGlobal(before, { ...patch(data), changes }, 'g');
    expect(reduced.data).toEqual(next);
    expect(reduced.data.group).toBe(before.data.group);
    expect(JSON.stringify(changes).length).toBeLessThan(128);
    const cleared = { ...next, agentActivity: before.data.agentActivity };
    const clearedChanges = diffGlobal(reduced, cleared, 'g');
    expect(clearedChanges.agentActivity?.upserts).toEqual([{ id: 'other', activity: 'running' }]);
    expect(reduceGlobal(reduced, {
      kind: 'update', streamId: reduced.streamId, baseRevision: 1, revision: 2, changes: clearedChanges,
    }, 'g').data).toEqual(cleared);
    const removed = diffGlobal(reduced, { ...next, agentActivity: [next.agentActivity[0]] }, 'g');
    expect(removed.agentActivity?.removeIds).toEqual(['other']);
  });
  it.each([
    { activity: 'waiting' }, { activity: 'running', waiting: 'yes' },
  ])('rejects obsolete or malformed overlay status %j', (status) => {
    expect(() => parseSyncFrame({
      kind: 'sync', protocolVersion: SYNC_PROTOCOL_VERSION, groupId: null, subscriptionId: 1,
      global: { ...patch(data), changes: { agentActivity: { upserts: [{ id: 'g', ...status }], removeIds: [] } } },
    })).toThrow('Invalid');
  });
  it('rejects invalid or duplicate agent status records without replacing metadata', () => {
    expect(() =>
      reduceGlobal(
        null,
        testGlobalSnapshot({
          ...data,
          agentActivity: [
            { id: 'g', activity: 'idle' },
            { id: 'g', activity: 'idle', waiting: true },
          ],
        }),
        'g',
      ),
    ).toThrow('invalid_frame');
    expect(() =>
      parseSyncFrame({
        kind: 'sync',
        protocolVersion: SYNC_PROTOCOL_VERSION,
        groupId: null,
        subscriptionId: 1,
        global: {
          ...patch(data),
          changes: { agentActivity: { upserts: [{ id: 'g', activity: 'unknown' }], removeIds: [] } },
        },
      }),
    ).toThrow('Invalid');
  });
  it('sends only voice capability and acknowledges unchanged refreshes with an empty patch', () => {
    const next = { ...data, group: { ...group, voiceInput: { ...group.voiceInput, reason: 'Disabled' } } };
    const frame = wire(patch(next));
    expect(frame.changes).toEqual({ group: { kind: 'update', voiceInput: next.group.voiceInput } });
    expect(reduceGlobal(state, frame, 'g').data.group?.threads).toBe(group.threads);
    const empty = wire(patch(data));
    expect(empty.changes).toEqual({});
    expect(reduceGlobal(state, empty, 'g').revision).toBe(1);
    expect(reduceGlobal(state, empty, 'g').data.group).toBe(group);
  });
  it('replaces only the group on navigation and explicitly clears revoked state', () => {
    const next = { ...data, group: { ...group, threads: [] } };
    const frame = wire(patch(next, 'other'));
    expect(frame.changes).toEqual({ group: { kind: 'replace', value: next.group } });
    expect(reduceGlobal(state, frame, 'other').data.approvals).toBe(data.approvals);
    const cleared = wire(patch({ ...data, group: null }));
    expect(cleared.changes.group).toEqual({ kind: 'replace', value: null });
    expect(reduceGlobal(state, cleared, 'g').data.group).toBeNull();
    expect(() => reduceGlobal(state, { ...frame, changes: {} }, 'other')).toThrow('invalid_frame');
    expect(() => reduceGlobal(null, testGlobalSnapshot(data), null)).toThrow('invalid_frame');
  });
  it('keys threads by full conversation context, not just thread ID', () => {
    const web = group.threads[0];
    const mail = { ...web, channelType: 'resend', messagingGroupId: 'mail' };
    const before = { ...state, data: { ...data, group: { ...group, threads: [web, mail] } } };
    const next = { ...before.data, group: { ...group, threads: [web, { ...mail, title: 'Mail changed' }] } };
    const changes = diffGlobal(before, next, 'g');
    expect(changes.group?.kind === 'update' && changes.group.threads?.upserts).toEqual([next.group.threads[1]]);
    expect(threadKey(web)).not.toBe(threadKey(mail));
    expect(reduceGlobal(before, { ...patch(data), changes }, 'g').data).toEqual(next);
  });
  it('rejects corrupt nested data, missing baselines and revision gaps without mutating state', () => {
    const frame = patch(data);
    expect(() => reduceGlobal(null, frame, 'g')).toThrow('unknown_stream');
    expect(() => reduceGlobal(state, { ...frame, streamId: 'other' }, 'g')).toThrow('unknown_stream');
    expect(() => reduceGlobal(state, { ...frame, baseRevision: 3, revision: 4 }, 'g')).toThrow('revision_gap');
    const reduced = reduceGlobal(state, frame, 'g');
    expect(reduceGlobal(reduced, frame, 'g')).toBe(reduced);
    expect(reduceGlobal(reduced, testGlobalSnapshot(data), 'g')).toBe(reduced);
    const snapshot = testGlobalSnapshot({
      ...data,
      group: { ...group, threads: [group.threads[0], group.threads[0]] },
    });
    expect(() => reduceGlobal(null, snapshot, 'g')).toThrow('invalid_frame');
    expect(() =>
      parseSyncFrame({
        kind: 'sync',
        protocolVersion: SYNC_PROTOCOL_VERSION,
        groupId: 'g',
        subscriptionId: 1,
        global: { ...frame, changes: { group: { kind: 'update', voiceInput: { backend: 'unknown' } } } },
      }),
    ).toThrow('Invalid');
    expect(state.data.group?.threads).toHaveLength(1000);
  });
});
