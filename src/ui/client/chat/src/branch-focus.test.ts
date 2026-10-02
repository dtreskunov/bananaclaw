import { beforeEach, describe, expect, it, vi } from 'vitest';
import { focusBranchComposerSoon } from './actions';
import { groupId, scrollToBottomTick, threadId } from './state';

vi.hoisted(() => {
  vi.stubGlobal('window', { matchMedia: () => ({ matches: false }) });
});

describe('branch destination focus', () => {
  beforeEach(() => {
    groupId.value = 'group';
    threadId.value = 'branch';
    scrollToBottomTick.value = 0;
  });

  it('scrolls to the end and focuses the visible branch composer', () => {
    const focus = vi.fn();
    const composer = {
      disabled: false,
      offsetParent: {},
      focus,
      value: '',
      dispatchEvent: vi.fn(),
      setSelectionRange: vi.fn(),
    };
    vi.stubGlobal('document', {
      getElementById: vi.fn().mockReturnValue(composer),
    });
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });

    focusBranchComposerSoon({ groupId: 'group', threadId: 'branch' });

    expect(scrollToBottomTick.value).toBe(1);
    expect(focus).toHaveBeenCalledOnce();
  });

  it('does nothing after navigation leaves the new branch', () => {
    const getElementById = vi.fn();
    vi.stubGlobal('document', { getElementById });
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    threadId.value = 'other';

    focusBranchComposerSoon({ groupId: 'group', threadId: 'branch' });

    expect(getElementById).not.toHaveBeenCalled();
    expect(scrollToBottomTick.value).toBe(0);
  });
});
