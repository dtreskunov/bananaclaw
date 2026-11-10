import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MessageBubble } from './MessageBubble';
import { RelativeTime } from './RelativeTime';
import { openTranscriptReader } from '../transcript-reader';
vi.hoisted(() => vi.stubGlobal('window', { matchMedia: () => ({ matches: false }) }));

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
  visible: false,
}));
vi.mock('preact/hooks', () => ({
  useRef: () => ({ current: hooks.refs++ === 0 ? hooks.bubble : hooks.content }),
  useLayoutEffect: (effect: () => void | (() => void)) => hooks.effects.push(effect),
  useState: () => [
    hooks.visible,
    (update: boolean | ((visible: boolean) => boolean)) => {
      hooks.visible = typeof update === 'function' ? update(hooks.visible) : update;
    },
  ],
}));
vi.mock('../scroll-edges', () => ({ attachScrollEdges: hooks.attach }));
vi.mock('../transcript-reader', () => ({ openTranscriptReader: vi.fn() }));

class ClickTarget {
  constructor(
    private text = true,
    private control = false,
  ) {}
  closest(selector: string) {
    return (selector.startsWith('a,') ? this.control : this.text) ? this : null;
  }
}
const selection = vi.fn();

beforeEach(() => {
  vi.stubGlobal('window', { matchMedia: () => ({ matches: false }), getSelection: selection });
  vi.stubGlobal('Element', ClickTarget);
  vi.stubGlobal('document', new EventTarget());
  selection.mockReset();
  hooks.bubble = new Bubble();
  hooks.content = new Bubble();
  hooks.refs = 0;
  hooks.effects = [];
  hooks.attach.mockReset();
  hooks.visible = false;
  vi.mocked(openTranscriptReader).mockClear();
});
afterEach(() => vi.unstubAllGlobals());

function renderReadableBubble() {
  hooks.refs = 0;
  hooks.effects = [];
  return MessageBubble({
    class: 'msg out',
    read: { kind: 'message', id: 'reply' },
    children: 'Complete response',
  });
}

describe('scrollable message bubble', () => {
  it('owns the same sender label and RelativeTime footer for every bubble body', () => {
    const node = MessageBubble({
      class: 'msg out',
      from: 'Research agent',
      timestamp: 1793408400000,
      metadata: 'Extra status',
      children: 'Request body',
    });
    const [sender, body, footer] = node.props.children[0].props.children.props.children;
    expect(sender.props).toEqual({ class: 'message-author', children: 'Research agent' });
    expect(body).toBe('Request body');
    expect(footer.props.class).toBe('meta turn-info');
    expect(footer.props.children[0].type).toBe(RelativeTime);
    expect(footer.props.children[0].props.ts).toBe(1793408400000);
    expect(footer.props.children[1]).toBe('Extra status');
  });
  it('uses shared edge tracking and makes only overflowing messages keyboard focusable', () => {
    const dispose = vi.fn();
    hooks.attach.mockReturnValue(dispose);
    const node = MessageBubble({ class: 'msg out', 'data-msg-id': 'reply', children: 'Complete response' });
    expect(node.props.class).toBe('msg out');
    expect(node.props['data-msg-id']).toBe('reply');
    expect(node.ref).toEqual({ current: hooks.bubble });
    expect(node.props.children[0].props.class).toBe('message-scroll');
    expect(node.props.children[0].props.children).toBe('Complete response');
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

  it('writes accessibility attributes only when scrollability changes', () => {
    const content = hooks.content!;
    const setAttribute = vi.spyOn(content, 'setAttribute');
    const removeAttribute = vi.spyOn(content, 'removeAttribute');
    const setTabIndex = vi.fn();
    Object.defineProperty(content, 'tabIndex', { set: setTabIndex });
    MessageBubble({ class: 'msg out', children: 'Complete response' });
    hooks.effects[0]();
    const update = hooks.attach.mock.calls[0][2];
    update({ top: false, bottom: true });
    update({ top: true, bottom: true });
    update({ top: true, bottom: false });
    expect(setTabIndex).toHaveBeenCalledExactlyOnceWith(0);
    expect(setAttribute.mock.calls).toEqual([
      ['role', 'region'],
      ['aria-label', 'Scrollable message'],
    ]);
    expect(removeAttribute).not.toHaveBeenCalled();
    update({ top: false, bottom: false });
    update({ top: false, bottom: false });
    expect(setTabIndex.mock.calls).toEqual([[0], [-1]]);
    expect(removeAttribute.mock.calls).toEqual([['role'], ['aria-label']]);
    update({ top: false, bottom: true });
    expect(setTabIndex.mock.calls).toEqual([[0], [-1], [0]]);
    expect(setAttribute).toHaveBeenCalledTimes(4);
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

describe('floating full-screen reader entry', () => {
  it('keeps the footer unchanged and places the button outside the scrolling text', () => {
    const metadata = 'Footer actions';
    const node = MessageBubble({
      class: 'msg out',
      timestamp: 1793408400000,
      metadata,
      read: { kind: 'message', id: 'reply' },
      children: 'Reply',
    });
    const [scroller, button] = node.props.children;
    const footer = scroller.props.children.props.children[2];
    expect(footer.props.children).toHaveLength(2);
    expect(footer.props.children[1]).toBe(metadata);
    expect(button.props.class).toBe('msg-action-btn message-reader-button');
    expect(button.props['aria-label']).toBe('Read full screen');
    expect(button.props['aria-haspopup']).toBe('dialog');
  });

  it('does not add an empty footer just to host the reader entry', () => {
    const node = renderReadableBubble();
    expect(node.props.children[0].props.children).toBe('Complete response');
  });

  it('reveals the reader entry on keyboard focus without opening it', () => {
    const node = renderReadableBubble();
    node.props.children[1].props.onFocus();
    expect(hooks.visible).toBe(true);
    expect(openTranscriptReader).not.toHaveBeenCalled();
  });

  it('starts hidden and toggles only when message text is clicked', () => {
    let node = renderReadableBubble();
    expect(node.props.children[1].props.class).not.toContain(' visible');
    const click = { target: new ClickTarget(), defaultPrevented: false };
    node.props.children[0].props.onClick(click);
    node = renderReadableBubble();
    expect(node.props.children[1].props.class).toContain(' visible');
    node.props.children[0].props.onClick(click);
    expect(renderReadableBubble().props.children[1].props.class).not.toContain(' visible');
  });

  it.each([
    ['links and embedded controls', new ClickTarget(true, true), false, undefined],
    ['metadata and non-text content', new ClickTarget(false), false, undefined],
    ['handled navigation', new ClickTarget(), true, undefined],
    ['text selection', new ClickTarget(), false, { isCollapsed: false }],
    ['non-element targets', null, false, undefined],
  ])('does not toggle for %s', (_label, target, defaultPrevented, selected) => {
    selection.mockReturnValue(selected);
    const node = renderReadableBubble();
    node.props.children[0].props.onClick({ target, defaultPrevented });
    expect(hooks.visible).toBe(false);
  });

  it('does not reveal a reader for a non-readable bubble', () => {
    const node = MessageBubble({ class: 'msg out', children: 'Status' });
    node.props.children[0].props.onClick({ target: new ClickTarget() });
    expect(hooks.visible).toBe(false);
    expect(node.props.children[1]).toBeNull();
  });

  it('hides on captured scroll events and removes the listener on cleanup', () => {
    const add = vi.spyOn(document, 'addEventListener');
    const remove = vi.spyOn(document, 'removeEventListener');
    renderReadableBubble();
    expect(hooks.effects[2]()).toBeUndefined();
    expect(add).not.toHaveBeenCalled();
    hooks.visible = true;
    renderReadableBubble();
    const dispose = hooks.effects[2]();
    expect(add).toHaveBeenCalledWith('scroll', expect.any(Function), true);
    document.dispatchEvent(new Event('scroll'));
    expect(hooks.visible).toBe(false);
    expect(dispose).toBeTypeOf('function');
    if (dispose) dispose();
    expect(remove).toHaveBeenCalledWith('scroll', add.mock.calls[0][1], true);
  });

  it('opens the selected reader without bubbling and hides the floating button', () => {
    hooks.visible = true;
    const node = renderReadableBubble();
    const stopPropagation = vi.fn();
    node.props.children[1].props.onClick({ stopPropagation });
    expect(stopPropagation).toHaveBeenCalledOnce();
    expect(openTranscriptReader).toHaveBeenCalledExactlyOnceWith({ kind: 'message', id: 'reply' });
    expect(hooks.visible).toBe(false);
  });
});
