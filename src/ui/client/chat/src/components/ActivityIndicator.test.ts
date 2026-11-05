import { afterEach, describe, expect, it, vi } from 'vitest';
import { toChildArray, type ComponentProps, type VNode } from 'preact';
import { attentionError, attentionTargets } from '../attention-state';
import { testThread } from '../conversation-test-fixtures';
import { groupId } from '../state';
import { navigateAttention, openChat } from '../actions';
import type { Thread } from '../types';
import { DmRow, ThreadRow } from './ThreadsRail';
import { ActivityIndicator, activityDetails } from './ActivityIndicator';

vi.hoisted(() => vi.stubGlobal('window', { matchMedia: () => ({ matches: false }) }));
vi.mock('../actions', async (original) => ({
  ...(await original<typeof import('../actions')>()),
  navigateAttention: vi.fn().mockResolvedValue(true),
  openChat: vi.fn().mockResolvedValue(undefined),
}));

afterEach(() => {
  attentionError.value = null;
  attentionTargets.value = null;
  groupId.value = null;
  vi.clearAllMocks();
});

function rowParts(Row: typeof ThreadRow, thread: Thread) {
  const row = Row({ t: thread });
  const children = toChildArray(row.props.children) as VNode<{ class?: string }>[];
  const title = children.find((node) => node.props.class === 'title')!;
  const marker = toChildArray(title.props.children)[0] as VNode<{ thread: Thread }>;
  const indicator = (marker.type as (props: { thread: Thread }) => VNode<{
    children: VNode<ComponentProps<typeof ActivityIndicator>>;
    disabled: boolean;
    'aria-label': string;
    description: string;
    onClick: (event: { stopPropagation: () => void }) => void;
  }>)(marker.props);
  return { row, title, indicator, meta: children.find((node) => node.props.class === 'meta')! };
}

describe('shared activity presentation', () => {
  it('omits idle entirely, including stale idle', () => {
    expect(ActivityIndicator({ status: { activity: 'idle' } })).toBeNull();
    expect(ActivityIndicator({ status: { activity: 'idle', activityStale: true } })).toBeNull();
  });

  it.each(['running', 'waiting'] as const)('shows only lowercase %s for group labels', (activity) => {
    const node = ActivityIndicator({ status: { activity } })!;
    expect(node.props.class).toBe(`activity-indicator label ${activity}`);
    expect(node.props.role).toBe('status');
    expect(node.props['aria-live']).toBe('off');
    expect(node.props.children).toBe(activity);
  });

  it.each(['running', 'waiting'] as const)('shows %s dots with no visible text', (activity) => {
    const node = ActivityIndicator({ status: { activity }, variant: 'dot' })!;
    expect(node.props.class).toBe(`activity-indicator dot ${activity}`);
    expect(node.props.children).toBeNull();
    expect(node.props['aria-label']).toBe(`Activity: ${activity === 'running' ? 'Running' : 'Waiting'}`);
  });

  it.each(['running', 'waiting'] as const)('keeps stale %s explanation out of visible labels', (activity) => {
    const node = ActivityIndicator({ status: { activity, activityStale: true } })!;
    expect(node.props.class).toBe(`activity-indicator label ${activity} stale`);
    expect(node.props.children).toBe(activity);
    expect(node.props['aria-label']).toContain('Last known activity:');
    expect(node.props.title).toBe(node.props['aria-label']);
  });

  it('uses shared sync connectivity without replacing last-known activity', () => {
    attentionError.value = 'Connection lost';
    const status = { activity: 'running' } as const;
    expect(ActivityIndicator({ status })!.props.class).toBe('activity-indicator label running stale');
    expect(activityDetails(status).stale).toBe(true);
    attentionError.value = null;
    expect(ActivityIndicator({ status })!.props.class).toBe('activity-indicator label running');
  });
});

describe.each([ThreadRow, DmRow])('thread/DM title activity (%s)', (Row) => {
  it.each(['idle', 'running', 'waiting'] as const)('places %s before lineage/channel/title, never in metadata', (activity) => {
    const { indicator, meta } = rowParts(Row, testThread({ activity }));
    expect(toChildArray(meta.props.children)).toHaveLength(1);
    const component = (activity === 'waiting' ? indicator.props.children : indicator) as VNode<ComponentProps<typeof ActivityIndicator>>;
    expect(component.type).toBe(ActivityIndicator);
    expect(component.props.variant).toBe('dot');
    const result = ActivityIndicator(component.props);
    if (activity === 'idle') expect(result).toBeNull();
    else expect(result!.props.children).toBeNull();
  });

  it('navigates to oldest known request without opening the default thread', () => {
    groupId.value = 'group';
    const thread = testThread({ activity: 'waiting' });
    const location = {
      agentGroupId: 'group', threadId: thread.threadId, channelType: 'web', messagingGroupId: thread.messagingGroupId,
    };
    attentionTargets.value = [{ id: 'request', origin: location }];
    const { row, indicator } = rowParts(Row, thread);
    expect(indicator.type).toBe('button');
    expect(indicator.props.disabled).toBe(false);
    expect(indicator.props['aria-label']).toBe(
      `Activity: Waiting. 1 request needs your input. Open oldest request in ${thread.title}`,
    );
    const event = { stopPropagation: vi.fn() };
    indicator.props.onClick(event);
    expect(event.stopPropagation).toHaveBeenCalledOnce();
    expect(navigateAttention).toHaveBeenCalledExactlyOnceWith(location);
    expect(openChat).not.toHaveBeenCalled();
    row.props.onClick({ target: { classList: { contains: () => false } } });
    expect(openChat).toHaveBeenCalledOnce();
  });

  it.each(['unknown', 'empty', 'stale', 'offline'] as const)('disables waiting actions when %s', (reason) => {
    groupId.value = 'group';
    const thread = testThread({ activity: 'waiting', activityStale: reason === 'stale' });
    if (reason !== 'unknown') attentionTargets.value = reason === 'empty' ? [] : [{
      id: 'request', origin: {
        agentGroupId: 'group', threadId: thread.threadId, channelType: 'web', messagingGroupId: thread.messagingGroupId,
      },
    }];
    if (reason === 'offline') attentionError.value = 'Connection lost';
    const { indicator } = rowParts(Row, thread);
    expect(indicator.props.disabled).toBe(true);
    indicator.props.onClick({ stopPropagation: vi.fn() });
    expect(navigateAttention).not.toHaveBeenCalled();
  });

  it('does not turn running into an additional request control even if old requests remain', () => {
    groupId.value = 'group';
    const thread = testThread({ activity: 'running' });
    attentionTargets.value = [{ id: 'request', origin: {
      agentGroupId: 'group', threadId: thread.threadId, channelType: 'web', messagingGroupId: thread.messagingGroupId,
    } }];
    const { indicator } = rowParts(Row, thread);
    expect(indicator.type).toBe(ActivityIndicator);
    expect(indicator.props.description).toBe('Activity: Running');
  });

  it('scopes request navigation to the full channel and messaging-group identity', () => {
    groupId.value = 'group';
    const thread = testThread({ activity: 'waiting', channelType: 'telegram', messagingGroupId: 'm' });
    attentionTargets.value = [{ id: 'request', origin: {
      agentGroupId: 'group', threadId: thread.threadId, channelType: 'web', messagingGroupId: 'other',
    } }];
    expect(rowParts(Row, thread).indicator.props.disabled).toBe(true);
  });
});
