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
import { attentionError, attentionSelection, attentionTargets } from '../attention-state';
import { groupId, threadId, channelType, messagingGroupId } from '../state';
import { AttentionFocus } from './AttentionFocus';
import { conversationState } from '../conversation-state';
import { testSnapshot } from '../conversation-test-fixtures';

afterEach(() => {
  attentionTargets.value = null;
  attentionSelection.value = null;
  attentionError.value = null;
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
    const target = { scrollIntoView: vi.fn(), focus: vi.fn() };
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
    AttentionFocus();
    vi.mocked(useEffect).mock.lastCall![0]();
    expect(target.focus).toHaveBeenCalledOnce();
  });
});
