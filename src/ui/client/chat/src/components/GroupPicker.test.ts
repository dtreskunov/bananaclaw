import { afterEach, describe, expect, it, vi } from 'vitest';
vi.hoisted(() => {
  vi.stubGlobal('window', { matchMedia: () => ({ matches: false }) });
});
vi.mock('../actions', async (original) => ({
  ...(await original<typeof import('../actions')>()),
  navigateAttention: vi.fn().mockResolvedValue(true),
  selectGroup: vi.fn(),
}));
import { navigateAttention, selectGroup } from '../actions';
import { attentionError, attentionTargets } from '../attention-state';
import { groups } from '../state';
import { AttentionBadge } from './AttentionBadge';
import { GroupStrip } from './GroupPicker';

afterEach(() => {
  attentionTargets.value = null;
  attentionError.value = null;
  groups.value = [];
  vi.clearAllMocks();
});

describe('agent attention buttons', () => {
  it('opens the oldest pending request rather than the default thread in the agent', () => {
    groups.value = [{ id: 'g', name: 'Group', isAdmin: false }];
    attentionTargets.value = [
      { id: 'q', origin: { agentGroupId: 'g', threadId: 't', channelType: 'web', messagingGroupId: 'm' } },
    ];
    const item = GroupStrip()!.props.items[0];
    expect(item.badge.type).toBe(AttentionBadge);
    expect(item.badge.props.value).toBe(1);
    expect(item.badge.props.label).toContain('Open oldest request');
    item.onBadgeClick();
    expect(navigateAttention).toHaveBeenCalledExactlyOnceWith('g');
    expect(selectGroup).not.toHaveBeenCalled();
  });
  it('keeps stale counts visible but disables their navigation action', () => {
    groups.value = [{ id: 'g', name: 'Group', isAdmin: false }];
    attentionTargets.value = [
      { id: 'q', origin: { agentGroupId: 'g', threadId: 't', channelType: 'web', messagingGroupId: 'm' } },
    ];
    attentionError.value = 'Offline';
    const item = GroupStrip()!.props.items[0];
    expect(item.badge.props.value).toBe(1);
    expect(item.badgeDisabled).toBe(true);
    expect(item.badge.props.label).toContain('Input status unavailable');
  });
});
