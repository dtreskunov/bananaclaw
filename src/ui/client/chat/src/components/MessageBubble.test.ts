import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MessageBubble } from './MessageBubble';

class Bubble {
  tabIndex = -1;
  scrollTop = 100;
  clientHeight = 200;
  attrs = new Map<string, string>();
  match = true;
  setAttribute(name: string, value: string) {
    this.attrs.set(name, value);
  }
  removeAttribute(name: string) {
    this.attrs.delete(name);
  }
  getBoundingClientRect() {
    return { top: 40 };
  }
  querySelector() {
    return this.match ? { getBoundingClientRect: () => ({ top: 440 }) } : null;
  }
}
const hooks = vi.hoisted(() => ({
  bubble: null as Bubble | null,
  effects: [] as (() => void | (() => void))[],
  attach: vi.fn(),
}));
vi.mock('preact/hooks', () => ({
  useRef: () => ({ current: hooks.bubble }),
  useLayoutEffect: (effect: () => void | (() => void)) => hooks.effects.push(effect),
}));
vi.mock('../scroll-edges', () => ({ attachScrollEdges: hooks.attach }));

beforeEach(() => {
  hooks.bubble = new Bubble();
  hooks.effects = [];
  hooks.attach.mockReset();
});

describe('scrollable message bubble', () => {
  it('uses shared edge tracking and makes only overflowing messages keyboard focusable', () => {
    const dispose = vi.fn();
    hooks.attach.mockReturnValue(dispose);
    const node = MessageBubble({ class: 'msg out', 'data-msg-id': 'reply', children: 'Complete response' });
    expect(node.props.class).toBe('msg out scroll-edge-fade');
    expect(node.props['data-msg-id']).toBe('reply');
    expect(hooks.effects[0]()).toBe(dispose);
    const [element, axes, update] = hooks.attach.mock.calls[0];
    expect(element).toBe(hooks.bubble);
    expect(axes).toEqual({ horizontal: false });
    update({ top: false, bottom: true });
    expect(hooks.bubble?.tabIndex).toBe(0);
    expect(hooks.bubble?.attrs.get('aria-label')).toBe('Scrollable message');
    update({ top: false, bottom: false });
    expect(hooks.bubble?.tabIndex).toBe(-1);
    expect(hooks.bubble?.attrs.has('role')).toBe(false);
  });

  it('reveals a selected search match inside the bubble without opening a reader', () => {
    MessageBubble({ class: 'msg out', 'data-msg-id': 'reply', children: 'Complete response', reveal: 'match' });
    hooks.effects[1]();
    expect(hooks.bubble?.scrollTop).toBe(400);
  });

  it('preserves internal reading position when no search reveal was requested', () => {
    MessageBubble({ class: 'msg out', 'data-msg-id': 'reply', children: 'Complete response' });
    hooks.effects[1]();
    expect(hooks.bubble?.scrollTop).toBe(100);
  });
});
