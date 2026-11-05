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
  navigateAttention: vi.fn().mockResolvedValue(true),
  selectGroup: vi.fn().mockResolvedValue(undefined),
}));
import { navigateAttention, selectGroup } from '../actions';
import { attentionError, attentionTargets } from '../attention-state';
import { agentActivity, groups, groupId, groupPickerMode, groupPickerOpen, isElevatedUser } from '../state';
import { ActivityIndicator } from './ActivityIndicator';
import { GroupStrip, GroupPickerModal } from './GroupPicker';

afterEach(() => {
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
  groups.value = [{ id: 'g', name: 'Group', isAdmin: false }];
  agentActivity.value = [{ id: 'g', activity: 'waiting' }];
  attentionTargets.value = [
    { id: 'q', origin: { agentGroupId: 'g', threadId: 't', channelType: 'web', messagingGroupId: 'm' } },
  ];
}

describe('agent activity status', () => {
  it('uses the existing badge slot for waiting, and opens the oldest pending request', () => {
    waitingGroup();
    const item = GroupStrip()!.props.items[0];
    expect(item.badge.type).toBe(ActivityIndicator);
    expect(ActivityIndicator(item.badge.props)!.props.children).toBe('waiting');
    expect(item.badgeLabel).toBe('Activity: Waiting. 1 request needs your input. Open oldest request in Group');
    expect(item.badgeDisabled).toBe(false);
    item.onBadgeClick();
    expect(navigateAttention).toHaveBeenCalledExactlyOnceWith('g');
    expect(selectGroup).not.toHaveBeenCalled();
  });

  it('keeps running labels non-interactive even if an old attention count remains', () => {
    waitingGroup();
    agentActivity.value = [{ id: 'g', activity: 'running' }];
    const item = GroupStrip()!.props.items[0];
    expect(ActivityIndicator(item.badge.props)!.props.children).toBe('running');
    expect(item.badgeLabel).toBe('Activity: Running');
    expect(item.onBadgeClick).toBeUndefined();
  });

  it.each([{ activity: [] }, { activity: [{ id: 'g', activity: 'idle' as const }] }])(
    'omits missing/idle status entirely (%j)',
    ({ activity }) => {
      waitingGroup();
      agentActivity.value = activity;
      const item = GroupStrip()!.props.items[0];
      expect(item.badge).toBeUndefined();
      expect(item.onBadgeClick).toBeUndefined();
      expect(item.sublabel).toBeTruthy();
    },
  );

  it.each(['unknown', 'empty', 'stale', 'offline'] as const)('disables waiting navigation when %s', (reason) => {
    waitingGroup();
    if (reason === 'unknown') attentionTargets.value = null;
    if (reason === 'empty') attentionTargets.value = [];
    if (reason === 'stale') agentActivity.value = [{ id: 'g', activity: 'waiting', activityStale: true }];
    if (reason === 'offline') attentionError.value = 'Offline';
    const item = GroupStrip()!.props.items[0];
    expect(item.badgeDisabled).toBe(true);
    expect(ActivityIndicator(item.badge.props)!.props.children).toBe('waiting');
    if (reason === 'stale' || reason === 'offline') {
      expect(item.badgeLabel).toContain('Last known activity: Waiting');
      expect(item.badgeLabel).toContain('1 last known request in Group');
    } else {
      expect(item.badgeLabel).toContain('No actionable requests');
    }
    item.onBadgeClick();
    expect(navigateAttention).not.toHaveBeenCalled();
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
    expect(ActivityIndicator(strip.props.mobileFallbackItem.badge.props)!.props.children).toBe('waiting');
  });
});

describe.each(['all', 'non-members'] as const)('agent picker (%s)', (mode) => {
  it('reuses activity labels and oldest-request navigation, retaining normal row selection', () => {
    waitingGroup();
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
    expect(row.props.badgeLabel).toContain('Open oldest request in Group');
    expect(row.props.badgeDisabled).toBe(false);
    row.props.onBadgeClick();
    expect(groupPickerOpen.value).toBe(false);
    expect(navigateAttention).toHaveBeenCalledExactlyOnceWith('g');
    expect(selectGroup).not.toHaveBeenCalled();
    row.props.onClick();
    expect(selectGroup).toHaveBeenCalledExactlyOnceWith('g');
  });

  it('keeps running passive and hides idle activity in the picker', () => {
    groups.value = [
      { id: 'running', name: 'Running agent', elevatedOnly: mode === 'non-members' },
      { id: 'idle', name: 'Idle agent', elevatedOnly: mode === 'non-members' },
    ];
    agentActivity.value = [
      { id: 'running', activity: 'running' },
      { id: 'idle', activity: 'idle' },
    ];
    isElevatedUser.value = true;
    groupPickerOpen.value = true;
    groupPickerMode.value = mode;
    const rows = GroupPickerModal()!.props.children.props.children;
    expect(ActivityIndicator(rows[0].props.badge.props)!.props.children).toBe('running');
    expect(rows[0].props.onBadgeClick).toBeUndefined();
    expect(rows[1].props.badge).toBeUndefined();
    expect(rows[1].props.onBadgeClick).toBeUndefined();
  });
});
