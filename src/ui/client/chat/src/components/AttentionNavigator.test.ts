import { afterEach, describe, expect, it, vi } from 'vitest';
import { toChildArray } from 'preact';
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

describe('compact shared input indicators', () => {
  it('shows position five in a neutral badge and total six in the same amber badge component', () => {
    seed(6);
    attentionSelection.value = { id: 'q4', navigation: 1 };
    const node = AttentionNavigator()!;
    const [position, of, total, previous, next] = toChildArray(node.props.children);
    expect(position).toMatchObject({ type: AttentionBadge, props: { value: 5, neutral: true } });
    expect(of).toMatchObject({ props: { children: 'of' } });
    expect(total).toMatchObject({ props: { children: { type: AttentionBadge, props: { value: 6 } } } });
    expect(previous).toMatchObject({ props: { 'aria-label': 'Previous input request', disabled: false } });
    expect(next).toMatchObject({ props: { 'aria-label': 'Next input request', disabled: false } });
    expect(node.props['aria-haspopup']).toBeUndefined();
  });
  it('hides an empty control and keeps a one-request total clickable with arrows disabled', () => {
    seed(0);
    expect(AttentionNavigator()).toBeNull();
    seed(1);
    const [, , total, previous, next] = toChildArray(AttentionNavigator()!.props.children);
    expect(previous).toMatchObject({ props: { disabled: true } });
    expect(next).toMatchObject({ props: { disabled: true } });
    expect(total).toMatchObject({ props: { disabled: false } });
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
