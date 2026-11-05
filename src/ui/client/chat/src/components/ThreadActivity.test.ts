import { afterEach, describe, expect, it, vi } from 'vitest';
import { toChildArray, type VNode } from 'preact';
import { attentionError, attentionTargets } from '../attention-state';
import { testThread } from '../conversation-test-fixtures';
import { groupId } from '../state';
import type { Thread } from '../types';
import { DmRow, ThreadRow } from './ThreadsRail';
import { ThreadActivity } from './ThreadActivity';

vi.hoisted(() => vi.stubGlobal('window', { matchMedia: () => ({ matches: false }) }));

afterEach(() => {
  attentionError.value = null;
  attentionTargets.value = null;
  groupId.value = null;
});

function rowMetadata(Row: typeof ThreadRow, thread: Thread) {
  return (toChildArray(Row({ t: thread }).props.children) as VNode<{ class?: string }>[]).find(
    (node) => node.props.class === 'meta',
  )!;
}

describe('thread activity indicators', () => {
  it.each(['idle', 'running', 'waiting'] as const)('shows textual %s activity', (activity) => {
    const node = ThreadActivity({ thread: testThread({ activity }) });
    const label = activity[0].toUpperCase() + activity.slice(1);
    expect(node.props.class).toBe(`thread-activity ${activity}`);
    expect(node.props.role).toBe('status');
    expect(node.props['aria-live']).toBe('off');
    expect(node.props['aria-label']).toBe(`Activity: ${label}`);
    expect(toChildArray(node.props.children)).toContain(label);
  });

  it.each(['idle', 'running', 'waiting'] as const)('marks last-known host %s activity as stale', (activity) => {
    const node = ThreadActivity({ thread: testThread({ activity, activityStale: true }) });
    expect(node.props.class).toBe(`thread-activity ${activity} stale`);
    expect(node.props['aria-label']).toContain('Last known activity:');
    expect(node.props['aria-label']).toContain('Live activity status is unavailable');
    expect(node.props.title).toBe(node.props['aria-label']);
    expect(toChildArray(node.props.children)).toContain(' (last known)');
  });

  it('uses shared sync connectivity without replacing the last-known activity', () => {
    const thread = testThread({ activity: 'running' });
    attentionError.value = 'Connection lost';
    const offline = ThreadActivity({ thread });
    expect(offline.props.class).toBe('thread-activity running stale');
    expect(offline.props['aria-label']).toContain('Last known activity: Running');
    attentionError.value = null;
    expect(ThreadActivity({ thread }).props.class).toBe('thread-activity running');
    expect(ThreadActivity({ thread: { ...thread, activityStale: true } }).props.class).toContain('stale');
  });

  it.each([
    ['idle', false],
    ['running', false],
    ['waiting', false],
    ['running', true],
    ['waiting', true],
  ] as const)('uses the same metadata indicator for ordinary and DM rows (%s, stale %s)', (activity, activityStale) => {
    for (const Row of [ThreadRow, DmRow]) {
      const thread = testThread({ activity, activityStale });
      const children = toChildArray(rowMetadata(Row, thread).props.children) as VNode<{ thread: Thread }>[];
      expect(children[1].type).toBe(ThreadActivity);
      expect(children[1].props.thread).toBe(thread);
      expect(children[2].type).not.toBe(ThreadActivity);
    }
  });

  it.each([ThreadRow, DmRow])('keeps running activity separate from outstanding input requests (%s)', (Row) => {
    groupId.value = 'group';
    const thread = testThread({ activity: 'running' });
    attentionTargets.value = [{ id: 'request', origin: {
      agentGroupId: 'group', threadId: thread.threadId, channelType: 'web', messagingGroupId: thread.messagingGroupId,
    } }];
    const children = toChildArray(rowMetadata(Row, thread).props.children) as VNode<{ thread: Thread }>[];
    expect(ThreadActivity({ thread: children[1].props.thread }).props['aria-label']).toBe('Activity: Running');
    const attention = (children[2].type as (props: { thread: Thread }) => VNode)({ thread });
    const button = (toChildArray(attention.props.children) as VNode<{
      'aria-label': string; children: VNode<{ value: number }>; onClick: () => void;
    }>[])[1];
    expect(button.props['aria-label']).toContain('1 requests need your input');
    expect(button.props.children.props.value).toBe(1);
    expect(button.props.onClick).toBeTypeOf('function');
  });
});
