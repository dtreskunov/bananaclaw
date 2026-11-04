import { afterEach, describe, expect, it, vi } from 'vitest';
import { useEffect } from 'preact/hooks';
const hooks = vi.hoisted(() => ({ reference: undefined as { current: number | null } | undefined }));
vi.hoisted(() => {
  vi.stubGlobal('window', { matchMedia: () => ({ matches: false }) });
});
vi.mock('preact/hooks', async (original) => ({
  ...(await original<typeof import('preact/hooks')>()),
  useRef: <T>(current: T) => hooks.reference ?? { current },
  useEffect: vi.fn(),
}));
vi.mock('../actions', async (original) => ({
  ...(await original<typeof import('../actions')>()),
  navigateAttention: vi.fn().mockResolvedValue(true),
}));
import { navigateAttention } from '../actions';
import { attentionError, attentionSelection, attentionTargets } from '../attention-state';
import { groupId, threadId, channelType, messagingGroupId } from '../state';
import { AttentionBadge } from './AttentionBadge';
import { AttentionNavigator } from './AttentionNavigator';
import { GroupStrip } from './GroupPicker';
import { groups } from '../state';
import { conversationState } from '../conversation-state';
import { testSnapshot } from '../conversation-test-fixtures';

afterEach(() => {
  attentionTargets.value = null;
  attentionSelection.value = null;
  attentionError.value = null;
  groups.value = [];
  groupId.value = null;
  threadId.value = null;
  conversationState.value = null;
  hooks.reference = undefined;
  vi.clearAllMocks();
  vi.unstubAllGlobals();
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

describe('floating shared input indicator', () => {
  it('renders only the amber total, even when no request is selected', () => {
    seed(6);
    const node = AttentionNavigator()!;
    expect(node.type).toBe('button');
    expect(node.props.children).toMatchObject({ type: AttentionBadge, props: { value: 6 } });
    expect(node.props.disabled).toBe(false);
    expect(node.props.children.props.neutral).toBeUndefined();
    expect(Array.isArray(node.props.children)).toBe(false);
    expect(node.props['aria-haspopup']).toBeUndefined();
  });
  it('hides an empty control and keeps a one-request total clickable', () => {
    seed(0);
    expect(AttentionNavigator()).toBeNull();
    seed(1);
    expect(AttentionNavigator()!.props.disabled).toBe(false);
  });
  it('advances to the next newest request through its only button', () => {
    seed(2);
    AttentionNavigator()!.props.onClick();
    expect(navigateAttention).toHaveBeenCalledExactlyOnceWith();
  });
  it('retains counts visibly marked stale and uses unknown rather than a fabricated zero', () => {
    seed(6);
    attentionError.value = 'Offline';
    expect(AttentionNavigator()!.props['data-stale']).toBe('true');
    expect(AttentionNavigator()!.props.children.props.value).toBe(6);
    attentionTargets.value = null;
    expect(AttentionNavigator()!.props.children.props.value).toBe('?');
  });
  it('supplies the same badge to agent tabs and mobile picker items', () => {
    seed(2);
    groups.value = [{ id: 'g', name: 'Group', isAdmin: false }];
    const strip = GroupStrip();
    const badge = strip?.props.items[0].badge;
    expect(badge.type).toBe(AttentionBadge);
    expect(badge.props.value).toBe(2);
  });
  it('waits for a replacement snapshot to reveal the request and focuses only once per navigation', () => {
    seed(2);
    attentionSelection.value = { id: 'q1', navigation: 1 };
    hooks.reference = { current: null };
    const target = { scrollIntoView: vi.fn(), focus: vi.fn() };
    const find = vi.fn().mockReturnValue(null);
    vi.stubGlobal('document', { getElementById: find });
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    conversationState.value = testSnapshot({}, 'old-stream');
    AttentionNavigator();
    const first = vi.mocked(useEffect).mock.lastCall!;
    first[0]();
    expect(hooks.reference.current).toBeNull();

    conversationState.value = testSnapshot({}, 'replacement-stream');
    find.mockReturnValue(target);
    AttentionNavigator();
    const replacement = vi.mocked(useEffect).mock.lastCall!;
    expect(replacement[1]).toContain(conversationState.value);
    expect(replacement[1]).not.toEqual(first[1]);
    replacement[0]();
    expect(find).toHaveBeenLastCalledWith('attention-q1');
    expect(target.scrollIntoView).toHaveBeenCalledOnce();
    expect(target.focus).toHaveBeenCalledWith({ preventScroll: true });
    AttentionNavigator();
    vi.mocked(useEffect).mock.lastCall![0]();
    expect(target.focus).toHaveBeenCalledOnce();
  });
});
