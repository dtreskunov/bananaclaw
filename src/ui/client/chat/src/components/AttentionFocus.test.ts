import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useEffect } from 'preact/hooks';
const hooks = vi.hoisted(() => ({ reference: undefined as { current: unknown } | undefined }));
vi.hoisted(() => vi.stubGlobal('window', { matchMedia: () => ({ matches: false }) }));
vi.mock('preact/hooks', async (original) => ({
  ...(await original<typeof import('preact/hooks')>()),
  useRef: <T>(current: T) => hooks.reference ?? { current },
  useEffect: vi.fn(),
}));
vi.mock('./Toast', () => ({ showToast: vi.fn() }));
vi.mock('../message-highlight', () => ({ highlightMessage: vi.fn() }));
vi.mock('../read-state', () => ({ attachJumpReadTracking: vi.fn(() => vi.fn()) }));
import { groupId, threadId, channelType, messagingGroupId, chatReady } from '../state';
import { AttentionFocus } from './AttentionFocus';
import { conversationState } from '../conversation-state';
import { testSnapshot } from '../conversation-test-fixtures';
import {
  activityNavigationPending,
  beginActivityNavigation,
  cancelActivityNavigation,
  selectActivity,
  setActivityDestination,
} from '../activity-navigation';
import { showToast } from './Toast';
import { highlightMessage } from '../message-highlight';
import { attachJumpReadTracking } from '../read-state';
import { attentionTargets } from '../attention-state';

const origin = { agentGroupId: 'g', threadId: 't', channelType: 'web', messagingGroupId: 'm' };
const find = vi.fn();
beforeEach(() => {
  vi.clearAllMocks();
  hooks.reference = { current: null };
  groupId.value = 'g';
  threadId.value = 't';
  channelType.value = 'web';
  messagingGroupId.value = 'm';
  vi.stubGlobal('CSS', { escape: (value: string) => value });
  vi.stubGlobal('document', { querySelector: find });
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    callback(0);
    return 1;
  });
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
  find.mockReturnValue(null);
});
afterEach(() => {
  cancelActivityNavigation();
  attentionTargets.value = null;
  chatReady.value = false;
  groupId.value = null;
  threadId.value = null;
  conversationState.value = null;
  hooks.reference = undefined;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
function element() {
  return { scrollIntoView: vi.fn(), focus: vi.fn(), hasAttribute: () => false, tabIndex: 0 };
}
function render() {
  AttentionFocus();
  return vi.mocked(useEffect).mock.lastCall![0]();
}

describe('unified jump focus', () => {
  it('renders no floating control', () => {
    expect(AttentionFocus()).toBeNull();
  });
  it('waits for a replacement snapshot to reveal the request and focuses only once', () => {
    selectActivity({ origin, anchor: { kind: 'interaction', id: 'request' } });
    conversationState.value = testSnapshot({}, 'old-stream');
    render();
    expect(hooks.reference!.current).toBeNull();
    const target = element();
    find.mockReturnValue(target);
    conversationState.value = testSnapshot({}, 'replacement-stream');
    render();
    expect(find).toHaveBeenLastCalledWith('#chat-log [data-msg-id="request"]');
    expect(target.scrollIntoView).toHaveBeenCalledOnce();
    expect(target.focus).toHaveBeenCalledWith({ preventScroll: true });
    expect(highlightMessage).toHaveBeenCalledExactlyOnceWith(target);
    render();
    expect(target.focus).toHaveBeenCalledOnce();
  });

  it.each(['message', 'interaction'] as const)(
    'jumps to a %s once per click, independent of pending-request refreshes',
    (kind) => {
      const target = element();
      find.mockReturnValue(target);
      const destination = { origin, anchor: { kind, id: 'newest' } };
      selectActivity(destination);
      attentionTargets.value = [];
      render();
      expect(target.tabIndex).toBe(-1);
      expect(target.scrollIntoView).toHaveBeenCalledWith({ block: 'center', behavior: 'auto' });
      expect(highlightMessage).toHaveBeenCalledExactlyOnceWith(target);
      render();
      expect(target.focus).toHaveBeenCalledOnce();
      selectActivity(destination);
      render();
      expect(target.focus).toHaveBeenCalledTimes(2);
      expect(highlightMessage).toHaveBeenCalledTimes(2);
    },
  );

  it.each(['cancel', 'supersede'] as const)('does not reveal a queued target after %s', (operation) => {
    let reveal!: FrameRequestCallback;
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      reveal = callback;
      return 1;
    });
    beginActivityNavigation('g');
    selectActivity({ origin, anchor: { kind: 'message', id: 'old' } });
    render();
    if (operation === 'cancel') cancelActivityNavigation();
    else beginActivityNavigation('other');
    reveal(0);
    expect(find).not.toHaveBeenCalled();
    expect(highlightMessage).not.toHaveBeenCalled();
    if (operation === 'supersede') expect(activityNavigationPending.value?.scope).toBe('other');
  });

  it('does not jump in another route and reports sources missing from a ready transcript', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    selectActivity({ origin: { ...origin, threadId: 'elsewhere' }, anchor: { kind: 'message', id: 'missing' } });
    render();
    expect(find).not.toHaveBeenCalled();
    threadId.value = 'elsewhere';
    render();
    expect(showToast).not.toHaveBeenCalled();
    chatReady.value = true;
    render();
    expect(showToast).toHaveBeenCalledExactlyOnceWith('This activity source is no longer available.', 'err', 5000, {
      transient: true,
    });
    render();
    expect(showToast).toHaveBeenCalledOnce();
  });

  it.each(['message', 'interaction'] as const)('tracks the exact %s cursor without resetting on snapshots', (kind) => {
    const cursor = { sessionId: 's', key: '0123456789abcdef0123456789abcdef' };
    const stop = vi.fn();
    vi.mocked(attachJumpReadTracking).mockReturnValue(stop);
    const log = {};
    const target = { ...element(), closest: () => log };
    find.mockReturnValue(target);
    const request = beginActivityNavigation('g');
    const destination = { origin, anchor: { kind, id: 'target' }, readCursor: cursor };
    setActivityDestination(request, destination);
    selectActivity(destination);
    AttentionFocus();
    const cleanup = vi.mocked(useEffect).mock.calls.at(-2)![0]();
    vi.mocked(useEffect).mock.lastCall![0]();
    expect(activityNavigationPending.value).toBeNull();
    expect(attachJumpReadTracking).toHaveBeenCalledExactlyOnceWith(log, target, {
      groupId: 'g',
      threadId: 't',
      channelType: 'web',
      messagingGroupId: 'm',
      cursor,
    });
    conversationState.value = testSnapshot({}, 'updated-stream');
    render();
    expect(attachJumpReadTracking).toHaveBeenCalledOnce();
    expect(stop).not.toHaveBeenCalled();
    if (typeof cleanup !== 'function') throw new Error('Expected navigation cleanup');
    cleanup();
    expect(stop).toHaveBeenCalledOnce();
  });
});
