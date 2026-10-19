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
  content: null as Bubble | null,
  refs: 0,
  effects: [] as (() => void | (() => void))[],
  attach: vi.fn(),
}));
vi.mock('preact/hooks', () => ({
  useRef: () => ({ current: hooks.refs++ === 0 ? hooks.bubble : hooks.content }),
  useLayoutEffect: (effect: () => void | (() => void)) => hooks.effects.push(effect),
}));
vi.mock('../scroll-edges', () => ({ attachScrollEdges: hooks.attach }));

beforeEach(() => {
  hooks.bubble = new Bubble();
  hooks.content = new Bubble();
  hooks.refs = 0;
  hooks.effects = [];
  hooks.attach.mockReset();
});

describe('scrollable message bubble', () => {
  it('uses shared edge tracking and makes only overflowing messages keyboard focusable', () => {
    const dispose = vi.fn();
    hooks.attach.mockReturnValue(dispose);
    const node = MessageBubble({ class: 'msg out', 'data-msg-id': 'reply', children: 'Complete response' });
    expect(node.props.class).toBe('msg out');
    expect(node.props['data-msg-id']).toBe('reply');
    expect(node.ref).toEqual({ current: hooks.bubble });
    expect(node.props.children.props.class).toBe('message-scroll scroll-edge-fade');
    expect(node.props.children.props.children).toBe('Complete response');
    expect(hooks.effects[0]()).toBe(dispose);
    const [element, axes, update] = hooks.attach.mock.calls[0];
    expect(element).toBe(hooks.content);
    expect(axes).toEqual({ horizontal: false });
    update({ top: false, bottom: true });
    expect(hooks.content?.tabIndex).toBe(0);
    expect(hooks.content?.attrs.get('aria-label')).toBe('Scrollable message');
    expect(hooks.bubble?.tabIndex).toBe(-1);
    expect(hooks.bubble?.attrs.size).toBe(0);
    update({ top: false, bottom: false });
    expect(hooks.content?.tabIndex).toBe(-1);
    expect(hooks.content?.attrs.has('role')).toBe(false);
  });

  it('reveals a selected search match inside the bubble without opening a reader', () => {
    MessageBubble({ class: 'msg out', 'data-msg-id': 'reply', children: 'Complete response', reveal: 'match' });
    hooks.effects[1]();
    expect(hooks.content?.scrollTop).toBe(400);
    expect(hooks.bubble?.scrollTop).toBe(100);
  });

  it('preserves internal reading position when no search reveal was requested', () => {
    MessageBubble({ class: 'msg out', 'data-msg-id': 'reply', children: 'Complete response' });
    hooks.effects[1]();
    expect(hooks.bubble?.scrollTop).toBe(100);
    expect(hooks.content?.scrollTop).toBe(100);
  });

  it('keeps a supplied message ref on the outer frame for copying and transcript positioning', () => {
    const elementRef = { current: null };
    const node = MessageBubble({ class: 'msg out', children: 'Reply', elementRef });
    expect(node.ref).toBe(elementRef);
    hooks.effects[0]();
    expect(hooks.attach.mock.calls[0][0]).toBe(hooks.content);
  });
});
