import { afterEach, describe, expect, it, vi } from 'vitest';
vi.hoisted(() => {
  vi.stubGlobal('window', { matchMedia: () => ({ matches: false }) });
});
vi.mock('preact/hooks', async (original) => ({
  ...(await original<typeof import('preact/hooks')>()),
  useEffect: vi.fn(),
}));
vi.mock('../actions', async (original) => ({
  ...(await original<typeof import('../actions')>()),
  navigateActivity: vi.fn().mockResolvedValue(true),
  selectGroup: vi.fn().mockResolvedValue(undefined),
}));
import { navigateActivity, selectGroup } from '../actions';
import { attentionError, attentionTargets } from '../attention-state';
import { agentActivity, groups, groupId, groupPickerMode, groupPickerOpen, isElevatedUser } from '../state';
import { ActivityIndicator } from './ActivityIndicator';
import { GroupStrip, GroupPickerModal } from './GroupPicker';
import { beginActivityNavigation, cancelActivityNavigation } from '../activity-navigation';

afterEach(() => {
  cancelActivityNavigation();
  attentionTargets.value = null;
  attentionError.value = null;
  agentActivity.value = [];
  groups.value = [];
  groupId.value = null;
  groupPickerOpen.value = false;
  groupPickerMode.value = 'all';
  isElevatedUser.value = false;
  vi.clearAllMocks();
});

function waitingGroup() {
  groups.value = [{ id: 'g', name: 'Group', isAdmin: false, lastActivityAt: null }];
  agentActivity.value = [{ id: 'g', activity: 'idle', waiting: true }];
  attentionTargets.value = [
    { id: 'q', origin: { agentGroupId: 'g', threadId: 't', channelType: 'web', messagingGroupId: 'm' } },
  ];
}

describe('agent activity status', () => {
  it('keeps the picker visible while the destination is being located', async () => {
    waitingGroup();
    groupPickerOpen.value = true;
    let resolve!: (opened: boolean) => void;
    vi.mocked(navigateActivity).mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const row = GroupPickerModal()!.props.children.props.children[0];
    const opening = row.props.onBadgeClick();
    expect(groupPickerOpen.value).toBe(true);
    resolve(true);
    await opening;
    expect(groupPickerOpen.value).toBe(false);
  });
  it('immediately exposes an independent busy control in desktop, dropdown and picker rows', () => {
    waitingGroup();
    beginActivityNavigation('g');
    const item = GroupStrip()!.props.items[0];
    expect(item.badgeBusy).toBe(true);
    expect(item.badgeDisabled).toBe(true);
    expect(item.badgeLabel).toBe('Opening message in Group\u2026');
    expect(item.badge.props.navigating).toBe(true);
    groupPickerOpen.value = true;
    const row = GroupPickerModal()!.props.children.props.children[0];
    expect(row.props.badgeBusy).toBe(true);
    expect(row.props.badgeDisabled).toBe(true);
  });
  it('shares unread styling and descriptions across tabs and the admin-only mobile fallback', () => {
    waitingGroup();
    agentActivity.value = [{ id: 'g', activity: 'idle', waiting: true, unreadThreadCount: 2 }];
    const item = GroupStrip()!.props.items[0];
    expect(item.className).toContain('is-unread');
    expect(item.title).toContain('2 unread conversations');
    expect(item.badge.props.status.waiting).toBe(true);
    expect(item.badge.props.unread).toBe(true);
    groups.value = [{ ...groups.value[0], elevatedOnly: true }];
    groupId.value = 'g';
    expect(GroupStrip()!.props.mobileFallbackItem.className).toContain('is-unread');
    expect(GroupStrip()!.props.mobileFallbackItem.badge.props.unread).toBe(true);
  });
  it('joins thread counts to last activity with the same dot separator as thread metadata', () => {
    waitingGroup();
    groups.value = [{ id: 'g', name: 'Group', isAdmin: true, lastActivityAt: 1793836800000 }];
    const before = GroupStrip()!.props.items[0].sublabel;
    agentActivity.value = [{ id: 'g', activity: 'idle', threadCount: 12 }];
    expect(GroupStrip()!.props.items[0].sublabel).toBe(`${before} \u00b7 12 thr`);
  });

  it.each([undefined, 0, 1, 23])('renders count %s without a dangling separator or plural variant', (threadCount) => {
    groups.value = [{ id: 'g', name: 'Group', isAdmin: true, lastActivityAt: null }];
    agentActivity.value = [{ id: 'g', activity: 'idle', threadCount }];
    expect(GroupStrip()!.props.items[0].sublabel).toBe(threadCount ? `${threadCount} thr` : undefined);
  });

  it('uses the shared icon for waiting, and opens the newest pending request', () => {
    waitingGroup();
    const item = GroupStrip()!.props.items[0];
    expect(item.badge.type).toBe(ActivityIndicator);
    expect(ActivityIndicator(item.badge.props)!.props.class).toBe('activity-indicator idle waiting');
    expect(item.badgeLabel).toBe(
      'Activity: Idle. Waiting for input. 1 request needs your input. Open newest request in Group',
    );
    expect(item.badgeDisabled).toBe(false);
    item.onBadgeClick();
    expect(navigateActivity).toHaveBeenCalledExactlyOnceWith('g', expect.objectContaining({ waiting: true }), false);
    expect(selectGroup).not.toHaveBeenCalled();
  });

  it('makes running labels navigate to their source even if old attention remains', () => {
    waitingGroup();
    agentActivity.value = [{ id: 'g', activity: 'running' }];
    const item = GroupStrip()!.props.items[0];
    expect(ActivityIndicator(item.badge.props)!.props.class).toBe('activity-indicator running');
    expect(item.badgeLabel).toBe('Activity: Running. Open newest originating message in Group');
    item.onBadgeClick();
    expect(navigateActivity).toHaveBeenCalledWith('g', expect.objectContaining({ activity: 'running' }), false);
  });

  it('omits unknown status rather than inventing idle', () => {
    waitingGroup();
    agentActivity.value = [];
    const item = GroupStrip()!.props.items[0];
    expect(item.badge).toBeUndefined();
    expect(item.onBadgeClick).toBeUndefined();
    expect(item.sublabel).toBeTruthy();
  });

  it('shows idle even when no requests exist', () => {
    waitingGroup();
    agentActivity.value = [{ id: 'g', activity: 'idle' }];
    const item = GroupStrip()!.props.items[0];
    expect(ActivityIndicator(item.badge.props).props.class).toBe('activity-indicator idle');
    item.onBadgeClick();
    expect(navigateActivity).toHaveBeenCalledWith('g', expect.objectContaining({ activity: 'idle' }), false);
  });

  it.each(['unknown', 'empty', 'offline'] as const)('disables waiting navigation when %s', (reason) => {
    waitingGroup();
    if (reason === 'unknown') attentionTargets.value = null;
    if (reason === 'empty') attentionTargets.value = [];
    if (reason === 'offline') attentionError.value = 'Offline';
    const item = GroupStrip()!.props.items[0];
    expect(item.badgeDisabled).toBe(true);
    expect(ActivityIndicator(item.badge.props)!.props.class).toContain('waiting');
    if (reason === 'offline') {
      expect(item.badgeLabel).toContain('Last known activity: Idle');
      expect(item.badgeLabel).toContain('1 last known request in Group');
    } else {
      expect(item.badgeLabel).toContain('No actionable requests');
    }
    item.onBadgeClick();
    expect(navigateActivity).not.toHaveBeenCalled();
  });

  it('does not navigate to another agent’s request', () => {
    waitingGroup();
    attentionTargets.value = [
      { id: 'q', origin: { agentGroupId: 'other', threadId: 't', channelType: 'web', messagingGroupId: 'm' } },
    ];
    expect(GroupStrip()!.props.items[0].badgeDisabled).toBe(true);
  });

  it('preserves selected admin-only activity in the mobile dropdown without adding a desktop tab', () => {
    waitingGroup();
    groups.value = [{ ...groups.value[0], elevatedOnly: true }];
    groupId.value = 'g';
    const strip = GroupStrip()!;
    expect(strip.props.items).toHaveLength(0);
    expect(strip.props.mobileFallbackItem.label).toBe('Group');
    expect(ActivityIndicator(strip.props.mobileFallbackItem.badge.props)!.props.class).toContain('waiting');
  });
});

describe.each(['all', 'non-members'] as const)('agent picker (%s)', (mode) => {
  it('reuses activity icons and newest-source navigation, retaining normal row selection', async () => {
    waitingGroup();
    agentActivity.value = [{ id: 'g', activity: 'idle', waiting: true, threadCount: 3, unreadThreadCount: 1 }];
    if (mode === 'non-members') {
      isElevatedUser.value = true;
      groups.value = [{ ...groups.value[0], elevatedOnly: true }];
    }
    groupPickerOpen.value = true;
    groupPickerMode.value = mode;
    const dialog = GroupPickerModal()!;
    expect(dialog.props.title).toBe(mode === 'non-members' ? 'More agents' : 'Agent groups');
    const row = dialog.props.children.props.children[0];
    expect(row.props.badge.type).toBe(ActivityIndicator);
    expect(row.props.badge.props.unread).toBe(true);
    expect(row.props.sublabel).toMatch(/ \u00b7 3 thr$/);
    expect(row.props.badgeLabel).toContain('Open newest request in Group');
    expect(row.props.badgeDisabled).toBe(false);
    await row.props.onBadgeClick();
    expect(groupPickerOpen.value).toBe(false);
    expect(navigateActivity).toHaveBeenCalledExactlyOnceWith('g', expect.objectContaining({ waiting: true }), true);
    expect(selectGroup).not.toHaveBeenCalled();
    row.props.onClick();
    expect(selectGroup).toHaveBeenCalledExactlyOnceWith('g');
  });

  it('makes both running and idle icons actionable in the picker', () => {
    groups.value = [
      { id: 'running', name: 'Running agent', elevatedOnly: mode === 'non-members', lastActivityAt: null },
      { id: 'idle', name: 'Idle agent', elevatedOnly: mode === 'non-members', lastActivityAt: null },
    ];
    agentActivity.value = [
      { id: 'running', activity: 'running' },
      { id: 'idle', activity: 'idle' },
    ];
    isElevatedUser.value = true;
    groupPickerOpen.value = true;
    groupPickerMode.value = mode;
    const rows = GroupPickerModal()!.props.children.props.children;
    expect(ActivityIndicator(rows[0].props.badge.props)!.props.class).toBe('activity-indicator running');
    rows[0].props.onBadgeClick();
    expect(navigateActivity).toHaveBeenCalledWith('running', expect.objectContaining({ activity: 'running' }), false);
    expect(ActivityIndicator(rows[1].props.badge.props).props.class).toBe('activity-indicator idle');
    rows[1].props.onBadgeClick();
    expect(navigateActivity).toHaveBeenCalledWith('idle', expect.objectContaining({ activity: 'idle' }), false);
  });
});
