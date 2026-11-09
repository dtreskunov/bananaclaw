import { afterEach, describe, expect, it, vi } from 'vitest';
import { toChildArray, type ComponentProps, type VNode } from 'preact';
import { attentionError, attentionTargets } from '../attention-state';
import { testThread, testSnapshot, testWebSubmission, testTurn } from '../conversation-test-fixtures';
import { groupId, threadId, channelType, messagingGroupId, pendingWebSends } from '../state';
import { conversationState, withPendingActivity } from '../conversation-state';
import { reconcileWebSubmissions, withWebSendState } from '../web-submissions';
import { navigateActivity, openChat } from '../actions';
import type { Thread } from '../types';
import { DmRow, ThreadRow } from './ThreadsRail';
import { ActivityIndicator, activityDetails } from './ActivityIndicator';
import { beginActivityNavigation, cancelActivityNavigation } from '../activity-navigation';

vi.hoisted(() => vi.stubGlobal('window', { matchMedia: () => ({ matches: false }) }));
vi.mock('../actions', async (original) => ({
  ...(await original<typeof import('../actions')>()),
  navigateActivity: vi.fn().mockResolvedValue(true),
  openChat: vi.fn().mockResolvedValue(undefined),
}));

afterEach(() => {
  cancelActivityNavigation();
  attentionError.value = null;
  attentionTargets.value = null;
  groupId.value = null;
  threadId.value = null;
  channelType.value = 'web';
  messagingGroupId.value = null;
  pendingWebSends.value = [];
  conversationState.value = null;
  vi.clearAllMocks();
});

describe('immediate activity presentation', () => {
  const idle = { activity: 'idle' as const };
  it('shows both thread and agent busy before the send request completes, without changing metadata', () => {
    pendingWebSends.value = [testWebSubmission];
    const saved = testThread();
    expect(withPendingActivity(idle, 'group').activity).toBe('running');
    expect(withPendingActivity(saved, 'group', saved).activity).toBe('running');
    expect(idle.activity).toBe('idle');
    expect(saved.activity).toBe('idle');
    const { indicator } = rowParts(ThreadRow, saved);
    expect(indicator.props.children.props.status?.activity).toBe('idle');
    groupId.value = 'group';
    expect(rowParts(ThreadRow, saved).indicator.props.children.props.status?.activity).toBe('running');
  });

  it('scopes local feedback by group, thread and web channel, and clears on failure', () => {
    pendingWebSends.value = [testWebSubmission];
    expect(withPendingActivity(idle, 'other').activity).toBe('idle');
    expect(withPendingActivity(idle, 'group', testThread({ threadId: 'other' })).activity).toBe('idle');
    expect(withPendingActivity(idle, 'group', testThread({ channelType: 'resend' })).activity).toBe('idle');
    pendingWebSends.value = [{ ...testWebSubmission, status: 'failed', error: 'Rejected' }];
    expect(withPendingActivity(idle, 'group').activity).toBe('idle');
  });

  it('retains accepted startup feedback only for the current conversation, not indefinitely offscreen', () => {
    pendingWebSends.value = [withWebSendState(testWebSubmission, { status: 'accepted' })];
    expect(withPendingActivity(idle, 'group').activity).toBe('idle');
    groupId.value = 'group';
    threadId.value = 'thread';
    expect(withPendingActivity(idle, 'group').activity).toBe('running');
    groupId.value = 'other';
    expect(withPendingActivity(idle, 'group').activity).toBe('idle');
  });

  it('hands off queued echoes and turns without an idle gap, then clears on settlement/cancellation', () => {
    groupId.value = 'group';
    threadId.value = 'thread';
    const message = {
      id: testWebSubmission.messageId,
      direction: 'in' as const,
      text: 'Queued',
      timestamp: 0,
      inputState: { messageId: testWebSubmission.messageId, status: 'queued' as const },
    };
    conversationState.value = testSnapshot({ messages: [message] });
    expect(withPendingActivity(idle, 'group').activity).toBe('idle');
    expect(withPendingActivity(idle, 'group', testThread({ messagingGroupId: 'other' })).activity).toBe('idle');
    pendingWebSends.value = [withWebSendState(testWebSubmission, { status: 'accepted' })];
    expect(withPendingActivity(idle, 'group').activity).toBe('running');
    for (const phase of ['running', 'settled'] as const) {
      conversationState.value = testSnapshot({
        messages: [message],
        turns: [{ ...testTurn, phase, inputIds: [message.id] }],
      });
      pendingWebSends.value = reconcileWebSubmissions(
        pendingWebSends.value,
        conversationState.value.conversation,
        'group',
      );
      expect(withPendingActivity(idle, 'group').activity).toBe(phase === 'running' ? 'running' : 'idle');
    }
    conversationState.value = testSnapshot({
      messages: [{ ...message, inputState: { ...message.inputState, status: 'cancelled' } }],
    });
    expect(withPendingActivity(idle, 'group').activity).toBe('idle');
  });

  it('preserves waiting while a local input is being submitted', () => {
    pendingWebSends.value = [testWebSubmission];
    expect(withPendingActivity({ activity: 'idle', waiting: true }, 'group')).toMatchObject({
      activity: 'running',
      waiting: true,
    });
  });
});

function rowParts(Row: typeof ThreadRow, thread: Thread) {
  const row = Row({ t: thread });
  const children = toChildArray(row.props.children) as VNode<{ class?: string }>[];
  const title = children.find((node) => node.props.class === 'title')!;
  const meta = children.find((node) => node.props.class === 'meta')!;
  const marker = toChildArray(meta.props.children)[0] as VNode<{ thread: Thread }>;
  const indicator = (
    marker.type as (props: { thread: Thread }) => VNode<{
      children: VNode<ComponentProps<typeof ActivityIndicator>>;
      disabled: boolean;
      'aria-label': string;
      'aria-busy'?: boolean;
      description: string;
      status?: ComponentProps<typeof ActivityIndicator>['status'];
      onClick: (event: { stopPropagation: () => void }) => void;
    }>
  )(marker.props);
  return { row, title, indicator, meta };
}

describe('shared activity presentation', () => {
  it.each(['idle', 'running'] as const)(
    'reports navigation without adding a spinner or changing %s activity',
    (activity) => {
      const node = ActivityIndicator({ status: { activity }, navigating: true });
      expect(node.props.class).toBe(`activity-indicator ${activity}`);
      expect(node.props['aria-busy']).toBe(true);
      expect(node.props['aria-live']).toBe('polite');
      expect(toChildArray(node.props.children)).toEqual([
        expect.objectContaining({ props: { class: 'activity-indicator-base', 'aria-hidden': 'true' } }),
      ]);
    },
  );
  it.each(['idle', 'running'] as const)('renders the %s base without a text label', (activity) => {
    const node = ActivityIndicator({ status: { activity } })!;
    expect(node.props.class).toBe(`activity-indicator ${activity}`);
    expect(node.props.role).toBe('status');
    expect(node.props['aria-live']).toBe('off');
    expect(toChildArray(node.props.children)).toMatchObject([
      { type: 'span', props: { class: 'activity-indicator-base', 'aria-hidden': 'true' } },
    ]);
  });

  it.each(['idle', 'running'] as const)('overlays a stationary dot on %s when waiting', (activity) => {
    const node = ActivityIndicator({ status: { activity, waiting: true } })!;
    expect(node.props.class).toBe(`activity-indicator ${activity} waiting`);
    expect(toChildArray(node.props.children)).toMatchObject([
      { props: { class: 'activity-indicator-base' } },
      { type: 'span', props: { class: 'activity-indicator-dot', 'aria-hidden': 'true' } },
    ]);
    const dot = toChildArray(node.props.children)[1] as VNode;
    expect(toChildArray(dot.props.children)).toEqual([]);
    expect(node.props['aria-label']).toContain('Waiting for input');
  });

  it.each(['idle', 'running'] as const)('keeps stale %s explanation accessible', (activity) => {
    const node = ActivityIndicator({ status: { activity, activityStale: true } })!;
    expect(node.props.class).toBe(`activity-indicator ${activity} stale`);
    expect(node.props['aria-label']).toContain('Last known activity:');
    expect(node.props.title).toBe(node.props['aria-label']);
  });

  it.each([
    { activity: 'idle' as const },
    { activity: 'running' as const },
    { activity: 'idle' as const, waiting: true },
    { activity: 'running' as const, waiting: true },
    { activity: 'idle' as const, activityStale: true },
    { activity: 'running' as const, activityStale: true },
  ])('shares one centered dot for unread $activity/$waiting/$activityStale', (status) => {
    const node = ActivityIndicator({ status, unread: true })!;
    expect(node.props.class).toContain(' unread');
    expect(node.props['aria-label']).toBe(`Unread. ${activityDetails(status).description}`);
    expect(node.props.title).toBe(node.props['aria-label']);
    expect(toChildArray(node.props.children)).toMatchObject([
      { props: { class: 'activity-indicator-base' } },
      { props: { class: 'activity-indicator-dot', 'aria-hidden': 'true' } },
    ]);
    expect(toChildArray(node.props.children)).toHaveLength(2);
  });

  it('uses shared sync connectivity without replacing last-known activity', () => {
    attentionError.value = 'Connection lost';
    const status = { activity: 'running' } as const;
    expect(ActivityIndicator({ status })!.props.class).toBe('activity-indicator running stale');
    expect(activityDetails(status).stale).toBe(true);
    attentionError.value = null;
    expect(ActivityIndicator({ status })!.props.class).toBe('activity-indicator running');
  });
});

describe.each([ThreadRow, DmRow])('thread/DM status activity (%s)', (Row) => {
  it('immediately disables and labels a pending jump in the thread/header control', () => {
    groupId.value = 'group';
    const thread = testThread();
    beginActivityNavigation({
      agentGroupId: 'group',
      threadId: thread.threadId,
      channelType: thread.channelType,
      messagingGroupId: thread.messagingGroupId,
    });
    const { indicator } = rowParts(Row, thread);
    expect(indicator.props.disabled).toBe(true);
    expect(indicator.props['aria-busy']).toBe(true);
    expect(indicator.props['aria-label']).toBe(`Opening message in ${thread.title}\u2026`);
  });
  it.each([false, true])('passes unread state to the status indicator while waiting=%s', (waiting) => {
    const { indicator } = rowParts(Row, testThread({ unread: true, waiting }));
    const component = indicator.props.children as VNode<ComponentProps<typeof ActivityIndicator>>;
    expect(component.type).toBe(ActivityIndicator);
    expect(component.props.unread).toBe(true);
    expect(ActivityIndicator(component.props).props.class).toContain(' unread');
  });

  it.each([
    { activity: 'idle' as const },
    { activity: 'running' as const },
    { activity: 'idle' as const, waiting: true },
    { activity: 'running' as const, waiting: true },
  ])('places $activity/$waiting before the time/count metadata, not in the title', (status) => {
    const { indicator, title, meta } = rowParts(Row, testThread(status));
    const [marker, metadata] = toChildArray(meta.props.children) as [VNode<{ thread: Thread }>, VNode];
    expect(marker.props.thread).toMatchObject(status);
    expect(metadata.type).toBe('span');
    expect(toChildArray(meta.props.children)).toHaveLength(2);
    expect(
      toChildArray(title.props.children).some(
        (child) => typeof child === 'object' && child !== null && child.type === marker.type,
      ),
    ).toBe(false);
    const component = indicator.props.children as VNode<ComponentProps<typeof ActivityIndicator>>;
    expect(component.type).toBe(ActivityIndicator);
    expect(ActivityIndicator(component.props).props.class).toContain(status.activity);
  });

  it('navigates to the newest originating request without opening the default thread', () => {
    groupId.value = 'group';
    const thread = testThread({ activity: 'idle', waiting: true });
    const location = {
      agentGroupId: 'group',
      threadId: thread.threadId,
      channelType: 'web',
      messagingGroupId: thread.messagingGroupId,
    };
    attentionTargets.value = [{ id: 'request', origin: location }];
    const { row, indicator } = rowParts(Row, thread);
    expect(indicator.type).toBe('button');
    expect(indicator.props.disabled).toBe(false);
    expect(indicator.props['aria-label']).toBe(
      `Activity: Idle. Waiting for input. 1 request needs your input. Open newest request in ${thread.title}`,
    );
    const event = { stopPropagation: vi.fn() };
    indicator.props.onClick(event);
    expect(event.stopPropagation).toHaveBeenCalledOnce();
    expect(navigateActivity).toHaveBeenCalledExactlyOnceWith(location, thread, false);
    expect(openChat).not.toHaveBeenCalled();
    row.props.onClick({ target: { classList: { contains: () => false } } });
    expect(openChat).toHaveBeenCalledOnce();
  });

  it.each(['unknown', 'empty', 'offline'] as const)('disables waiting actions when %s', (reason) => {
    groupId.value = 'group';
    const thread = testThread({ activity: 'idle', waiting: true });
    if (reason !== 'unknown')
      attentionTargets.value =
        reason === 'empty'
          ? []
          : [
              {
                id: 'request',
                origin: {
                  agentGroupId: 'group',
                  threadId: thread.threadId,
                  channelType: 'web',
                  messagingGroupId: thread.messagingGroupId,
                },
              },
            ];
    if (reason === 'offline') attentionError.value = 'Connection lost';
    const { indicator } = rowParts(Row, thread);
    expect(indicator.props.disabled).toBe(true);
    indicator.props.onClick({ stopPropagation: vi.fn() });
    expect(navigateActivity).not.toHaveBeenCalled();
  });

  it('keeps a current request actionable while execution is stale', () => {
    groupId.value = 'group';
    const thread = testThread({ activity: 'running', waiting: true, activityStale: true });
    attentionTargets.value = [
      {
        id: 'request',
        origin: {
          agentGroupId: 'group',
          threadId: thread.threadId,
          channelType: 'web',
          messagingGroupId: thread.messagingGroupId,
        },
      },
    ];
    expect(rowParts(Row, thread).indicator.props.disabled).toBe(false);
  });

  it('navigates a running indicator to its source, not a lingering request', () => {
    groupId.value = 'group';
    const thread = testThread({ activity: 'running' });
    attentionTargets.value = [
      {
        id: 'request',
        origin: {
          agentGroupId: 'group',
          threadId: thread.threadId,
          channelType: 'web',
          messagingGroupId: thread.messagingGroupId,
        },
      },
    ];
    const { indicator } = rowParts(Row, thread);
    expect(indicator.type).toBe('button');
    expect(indicator.props['aria-label']).toBe(`Activity: Running. Open newest originating message in ${thread.title}`);
    indicator.props.onClick({ stopPropagation: vi.fn() });
    expect(navigateActivity).toHaveBeenCalledWith(
      expect.objectContaining({ threadId: thread.threadId }),
      thread,
      false,
    );
  });

  it.each(['idle', 'running'] as const)('makes %s unread indicators independently actionable', (activity) => {
    groupId.value = 'group';
    const thread = testThread({ activity, unread: true });
    const { indicator } = rowParts(Row, thread);
    expect(indicator.props['aria-label']).toContain('Unread.');
    expect(indicator.props['aria-label']).toContain('Open newest unread message');
    indicator.props.onClick({ stopPropagation: vi.fn() });
    expect(navigateActivity).toHaveBeenCalledWith(expect.objectContaining({ threadId: thread.threadId }), thread, true);
  });

  it('suppresses unread dots, bold titles and labels in non-web channels', () => {
    const thread = testThread({ channelType: 'telegram', unread: true });
    const { row, title, indicator } = rowParts(Row, thread);
    expect(row.props.class).not.toContain('is-unread');
    const label = (toChildArray(title.props.children) as VNode<{ unread?: boolean }>[]).find(
      (node) => typeof node.type !== 'string',
    )!;
    expect(label.props.unread).toBe(false);
    expect(indicator.props.children.props.unread).toBe(false);
    expect(indicator.props['aria-label']).not.toContain('Unread');
  });

  it('scopes request navigation to the full channel and messaging-group identity', () => {
    groupId.value = 'group';
    const thread = testThread({ activity: 'idle', waiting: true, channelType: 'telegram', messagingGroupId: 'm' });
    attentionTargets.value = [
      {
        id: 'request',
        origin: {
          agentGroupId: 'group',
          threadId: thread.threadId,
          channelType: 'web',
          messagingGroupId: 'other',
        },
      },
    ];
    expect(rowParts(Row, thread).indicator.props.disabled).toBe(true);
  });
});
