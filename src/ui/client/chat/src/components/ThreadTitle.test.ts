import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ThreadTitle } from './ThreadsRail';

class TitleViewport {
  tabIndex = -1;
}

const hooks = vi.hoisted(() => ({
  element: null as TitleViewport | null,
  effects: [] as (() => void | (() => void))[],
  attach: vi.fn(),
}));
vi.hoisted(() => vi.stubGlobal('window', { matchMedia: () => ({ matches: false }) }));
vi.mock('preact/hooks', async (original) => ({
  ...(await original<typeof import('preact/hooks')>()),
  useRef: () => ({ current: hooks.element }),
  useLayoutEffect: (effect: () => void | (() => void)) => hooks.effects.push(effect),
}));
vi.mock('../scroll-edges', () => ({ attachScrollEdges: hooks.attach }));

beforeEach(() => {
  hooks.element = new TitleViewport();
  hooks.effects = [];
  hooks.attach.mockReset();
});

describe('full thread titles', () => {
  it('keeps the complete title and unread label inside a measured content span', () => {
    const title = 'Detailed household expense categorization and reconciliation across multiple credit accounts';
    const node = ThreadTitle({ title, unread: true });
    expect(node.props.class).toBe('title-text scroll-edge-fade');
    expect(node.props.title).toBe(title);
    expect(node.props.tabIndex).toBe(-1);
    expect(node.props.children.props.class).toBe('thread-title-content');
    expect(node.props.children.props.children).toEqual([
      expect.objectContaining({ props: { class: 'unread-label', children: 'Unread. ' } }),
      title,
    ]);
  });

  it('uses the table edge tracker and makes only overflowing titles keyboard scrollable', () => {
    const dispose = vi.fn();
    hooks.attach.mockReturnValue(dispose);
    ThreadTitle({ title: 'A complete conversation title' });
    expect(hooks.effects[0]()).toBe(dispose);
    const [element, axes, update] = hooks.attach.mock.calls[0];
    expect(element).toBe(hooks.element);
    expect(axes).toEqual({ vertical: false });
    for (const edges of [
      { left: false, right: true },
      { left: true, right: true },
      { left: true, right: false },
    ]) {
      update(edges);
      expect(hooks.element?.tabIndex).toBe(0);
    }
    update({ left: false, right: false });
    expect(hooks.element?.tabIndex).toBe(-1);
  });

  it('does not attach observers without a mounted viewport', () => {
    hooks.element = null;
    ThreadTitle({ title: 'A short title' });
    expect(hooks.effects[0]()).toBeUndefined();
    expect(hooks.attach).not.toHaveBeenCalled();
  });
});
