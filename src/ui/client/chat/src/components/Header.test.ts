import { afterEach, describe, expect, it, vi } from 'vitest';
import type { VNode } from 'preact';
import { credentialsOpen, groupId } from '../state';
import { startNewThread } from '../actions';
import { GroupStrip } from './GroupPicker';
import { Header } from './Header';
import { UserMenu } from './UserMenu';

vi.hoisted(() => {
  vi.stubGlobal('window', { matchMedia: () => ({ matches: false }) });
});

vi.mock('../actions', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../actions')>()),
  startNewThread: vi.fn(),
}));

function newThreadButton() {
  return Header().props.children.find(
    (child: VNode<{ 'aria-label'?: string }>) => child?.props['aria-label'] === 'New thread',
  );
}

afterEach(() => {
  groupId.value = null;
  credentialsOpen.value = false;
  vi.clearAllMocks();
});

describe('mobile header new thread', () => {
  it.each([false, true])('keeps account navigation in the user menu when Credentials is open=%s', (open) => {
    credentialsOpen.value = open;
    const children = Header().props.children;
    expect(children.some((child: VNode) => child?.type === UserMenu)).toBe(true);
    expect(children.some((child: VNode<{ 'aria-label'?: string }>) => child?.props['aria-label'] === 'Primary')).toBe(
      false,
    );
  });
  it('places a mobile-only plus button immediately before the agent selector', () => {
    groupId.value = 'agent';
    const children = Header().props.children;
    const index = children.findIndex(
      (child: VNode<{ 'aria-label'?: string }>) => child?.props['aria-label'] === 'New thread',
    );
    expect(index).toBeGreaterThan(0);
    expect(children[index + 1].type).toBe(GroupStrip);
    expect(children[index].props).toMatchObject({
      type: 'button',
      class: 'icon-btn mobile-only',
      title: 'New thread',
      disabled: false,
    });
    expect(children[index].props.children.props).toMatchObject({
      class: 'plus-glyph',
      'aria-hidden': 'true',
      children: '+',
    });
  });

  it('uses the shared new-thread action', () => {
    groupId.value = 'agent';
    newThreadButton().props.onClick();
    expect(startNewThread).toHaveBeenCalledOnce();
  });

  it('disables new thread until an agent group is selected', () => {
    expect(newThreadButton().props.disabled).toBe(true);
  });
});
