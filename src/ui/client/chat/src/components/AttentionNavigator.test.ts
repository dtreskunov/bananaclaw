import { afterEach, describe, expect, it, vi } from 'vitest';
vi.hoisted(() => {
  vi.stubGlobal('window', { matchMedia: () => ({ matches: false }) });
});
vi.mock('preact/hooks', async (original) => ({
  ...(await original<typeof import('preact/hooks')>()),
  useRef: <T>(current: T) => ({ current }),
  useEffect: vi.fn(),
}));
import { attentionError, attentionSelection, attentionTargets } from '../attention-state';
import { groupId, threadId, channelType, messagingGroupId } from '../state';
import { AttentionBadge } from './AttentionBadge';
import { AttentionNavigator } from './AttentionNavigator';
import { GroupStrip } from './GroupPicker';
import { groups } from '../state';

afterEach(() => {
  attentionTargets.value = null;
  attentionSelection.value = null;
  attentionError.value = null;
  groups.value = [];
  groupId.value = null;
  threadId.value = null;
});

function seed(count: number) {
  groupId.value = 'g';
  threadId.value = 't';
  channelType.value = 'web';
  messagingGroupId.value = 'm';
  attentionTargets.value = Array.from({ length: count }, (_, i) => ({
    id: `q${i}`,
    origin: { agentGroupId: 'g', threadId: 't', channelType: 'web', messagingGroupId: 'm' },
  }));
}

describe('compact shared input indicators', () => {
  it('shows position five in a neutral badge and total six in the same amber badge component', () => {
    seed(6);
    attentionSelection.value = { id: 'q4', navigation: 1 };
    const node = AttentionNavigator()!;
    const [position, of, total, previous, next] = node.props.children;
    expect(position.type).toBe(AttentionBadge);
    expect(position.props).toMatchObject({ value: 5, neutral: true });
    expect(of.props.children).toBe('of');
    expect(total.props.children.type).toBe(AttentionBadge);
    expect(total.props.children.props).toMatchObject({ value: 6 });
    expect(previous.props['aria-label']).toBe('Previous input request');
    expect(next.props['aria-label']).toBe('Next input request');
    expect(node.props['aria-haspopup']).toBeUndefined();
  });
  it('hides an empty control and keeps a one-request total clickable with arrows disabled', () => {
    seed(0);
    expect(AttentionNavigator()).toBeNull();
    seed(1);
    const [, , total, previous, next] = AttentionNavigator()!.props.children;
    expect(previous.props.disabled).toBe(true);
    expect(next.props.disabled).toBe(true);
    expect(total.props.disabled).toBe(false);
  });
  it('retains counts visibly marked stale and uses unknown rather than a fabricated zero', () => {
    seed(6);
    attentionError.value = 'Offline';
    expect(AttentionNavigator()!.props['data-stale']).toBe('true');
    expect(AttentionNavigator()!.props.children[2].props.children.props.value).toBe(6);
    attentionTargets.value = null;
    expect(AttentionNavigator()!.props.children[2].props.children.props.value).toBe('?');
  });
  it('supplies the same badge to agent tabs and mobile picker items', () => {
    seed(2);
    groups.value = [{ id: 'g', name: 'Group', isAdmin: false }];
    const strip = GroupStrip();
    const badge = strip?.props.items[0].badge;
    expect(badge.type).toBe(AttentionBadge);
    expect(badge.props.value).toBe(2);
  });
});
