import { afterEach, describe, expect, it, vi } from 'vitest';
import { useEffect } from 'preact/hooks';
const hooks = vi.hoisted(() => ({ reference: undefined as { current: unknown } | undefined }));
vi.hoisted(() => {
  vi.stubGlobal('window', { matchMedia: () => ({ matches: false }) });
});
vi.mock('preact/hooks', async (original) => ({
  ...(await original<typeof import('preact/hooks')>()),
  useRef: <T>(current: T) => hooks.reference ?? { current },
  useEffect: vi.fn(),
}));
import { attentionError, attentionSelection, attentionTargets } from '../attention-state';
import { groupId, threadId, channelType, messagingGroupId, chatReady } from '../state';
import { AttentionFocus } from './AttentionFocus';
import { conversationState } from '../conversation-state';
import { testSnapshot } from '../conversation-test-fixtures';
import {
  activitySelection,
  selectActivity,
  beginActivityNavigation,
  setActivityDestination,
  activityNavigationPending,
  cancelActivityNavigation,
} from '../activity-navigation';
import { showToast } from './Toast';
import { highlightMessage } from '../message-highlight';
import { attachJumpReadTracking } from '../read-state';

vi.mock('./Toast', () => ({ showToast: vi.fn() }));
vi.mock('../message-highlight', () => ({ highlightMessage: vi.fn() }));
vi.mock('../read-state', () => ({ attachJumpReadTracking: vi.fn(() => vi.fn()) }));

afterEach(() => {
  cancelActivityNavigation();
  attentionTargets.value = null;
  attentionSelection.value = null;
  attentionError.value = null;
  activitySelection.value = null;
  chatReady.value = false;
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

describe('nonvisual input request focus', () => {
  it('renders no floating control', () => {
    seed(6);
    expect(AttentionFocus()).toBeNull();
  });
  it('waits for a replacement snapshot to reveal the request and focuses only once per navigation', () => {
    seed(2);
    attentionSelection.value = { id: 'q1', navigation: 1 };
    hooks.reference = { current: null };
    const target = { scrollIntoView: vi.fn(), focus: vi.fn(), hasAttribute: () => true };
    const find = vi.fn().mockReturnValue(null);
    vi.stubGlobal('document', { getElementById: find });
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    conversationState.value = testSnapshot({}, 'old-stream');
    AttentionFocus();
    const first = vi.mocked(useEffect).mock.lastCall!;
    first[0]();
    expect(hooks.reference.current).toBeNull();

    conversationState.value = testSnapshot({}, 'replacement-stream');
    find.mockReturnValue(target);
    AttentionFocus();
    const replacement = vi.mocked(useEffect).mock.lastCall!;
    expect(replacement[1]).toContain(conversationState.value);
    expect(replacement[1]).not.toEqual(first[1]);
    replacement[0]();
    expect(find).toHaveBeenLastCalledWith('attention-q1');
    expect(target.scrollIntoView).toHaveBeenCalledOnce();
    expect(target.focus).toHaveBeenCalledWith({ preventScroll: true });
    expect(highlightMessage).toHaveBeenCalledExactlyOnceWith(target);
    AttentionFocus();
    vi.mocked(useEffect).mock.lastCall![0]();
    expect(target.focus).toHaveBeenCalledOnce();
    expect(highlightMessage).toHaveBeenCalledOnce();
  });

  it.each(['message', 'interaction'] as const)('jumps to a %s, including resolved requests, once per click', (kind) => {
    seed(0);
    hooks.reference = { current: null };
    const target = { scrollIntoView: vi.fn(), focus: vi.fn(), hasAttribute: () => false, tabIndex: 0 };
    const find = vi.fn().mockReturnValue(target);
    vi.stubGlobal('CSS', { escape: (value: string) => value });
    vi.stubGlobal('document', { querySelector: find });
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    const destination = {
      origin: { agentGroupId: 'g', threadId: 't', channelType: 'web', messagingGroupId: 'm' },
      anchor: { kind, id: 'newest' },
    };
    const render = () => {
      AttentionFocus();
      vi.mocked(useEffect).mock.lastCall![0]();
    };
    selectActivity(destination);
    render();
    expect(find).toHaveBeenCalledWith('#chat-log [data-msg-id="newest"]');
    expect(target.scrollIntoView).toHaveBeenCalledWith({ block: 'center', behavior: 'auto' });
    expect(target.tabIndex).toBe(-1);
    expect(highlightMessage).toHaveBeenCalledExactlyOnceWith(target);
    render();
    expect(target.focus).toHaveBeenCalledOnce();
    selectActivity(destination);
    render();
    expect(target.focus).toHaveBeenCalledTimes(2);
    expect(highlightMessage).toHaveBeenCalledTimes(2);
  });

  it('does not jump in another route and reports sources missing from a ready transcript', () => {
    seed(0);
    hooks.reference = { current: null };
    vi.stubGlobal('CSS', { escape: (value: string) => value });
    const find = vi.fn().mockReturnValue(null);
    vi.stubGlobal('document', { querySelector: find });
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    selectActivity({
      origin: { agentGroupId: 'g', threadId: 'elsewhere', channelType: 'web', messagingGroupId: 'm' },
      anchor: { kind: 'message', id: 'missing' },
    });
    const render = () => {
      AttentionFocus();
      vi.mocked(useEffect).mock.lastCall![0]();
    };
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
    vi.restoreAllMocks();
  });

  it.each(['message', 'waiting'] as const)(
    'tracks the exact %s target until navigating away, without resetting on snapshots',
    (kind) => {
      seed(1);
      hooks.reference = { current: null };
      const cursor = { sessionId: 's', key: '0123456789abcdef0123456789abcdef' };
      const stop = vi.fn();
      vi.mocked(attachJumpReadTracking).mockReturnValue(stop);
      const log = {};
      const target = {
        scrollIntoView: vi.fn(),
        focus: vi.fn(),
        hasAttribute: () => true,
        closest: vi.fn(() => log),
      };
      vi.stubGlobal('CSS', { escape: (value: string) => value });
      vi.stubGlobal('document', { querySelector: () => target, getElementById: () => target });
      vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
        callback(0);
        return 1;
      });
      if (kind === 'message')
        selectActivity({
          origin: { agentGroupId: 'g', threadId: 't', channelType: 'web', messagingGroupId: 'm' },
          anchor: { kind: 'message', id: 'target' },
          readCursor: cursor,
        });
      else {
        attentionTargets.value = [{ ...attentionTargets.value![0], readCursor: cursor }];
        attentionSelection.value = { id: 'q0', navigation: 1 };
      }
      const request = beginActivityNavigation('g');
      setActivityDestination(request, {
        origin: { agentGroupId: 'g', threadId: 't', channelType: 'web', messagingGroupId: 'm' },
        anchor: { kind: kind === 'message' ? 'message' : 'interaction', id: kind === 'message' ? 'target' : 'q0' },
      });
      AttentionFocus();
      const calls = vi.mocked(useEffect).mock.calls;
      const cleanup = calls.at(-2)![0]();
      calls.at(-1)![0]();
      expect(activityNavigationPending.value).toBeNull();
      expect(attachJumpReadTracking).toHaveBeenCalledExactlyOnceWith(log, target, {
        groupId: 'g',
        threadId: 't',
        channelType: 'web',
        messagingGroupId: 'm',
        cursor,
      });
      conversationState.value = testSnapshot({}, 'updated-stream');
      AttentionFocus();
      vi.mocked(useEffect).mock.lastCall![0]();
      expect(attachJumpReadTracking).toHaveBeenCalledOnce();
      expect(stop).not.toHaveBeenCalled();
      expect(typeof cleanup).toBe('function');
      if (typeof cleanup === 'function') cleanup();
      expect(stop).toHaveBeenCalledOnce();
    },
  );
});
