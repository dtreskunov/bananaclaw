import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { attachScrollNavigation, SCROLL_NAVIGATION_IDLE_MS, type ScrollDirection } from './scroll-navigation';
import { ScrollNavigationButtons } from './components/ScrollNavigationButtons';

class TestWheelEvent extends Event {
  deltaY: number;
  ctrlKey: boolean;
  constructor(deltaY = 100, ctrlKey = false) {
    super('wheel', { cancelable: true });
    this.deltaY = deltaY;
    this.ctrlKey = ctrlKey;
  }
}

class TestPointerEvent extends Event {
  pointerId: number;
  pointerType: string;
  button = 0;
  constructor(type: string, pointerId = 1, pointerType = 'mouse') {
    super(type);
    this.pointerId = pointerId;
    this.pointerType = pointerType;
  }
}

class TestKeyboardEvent extends Event {
  key: string;
  ctrlKey = false;
  metaKey = false;
  altKey = false;
  constructor(key: string) {
    super('keydown', { cancelable: true });
    this.key = key;
  }
}

class TestViewport extends EventTarget {
  scrollTop = 400;
  scrollHeight = 2000;
  clientHeight = 500;
  ownerDocument = new EventTarget();
  editable = false;
  closest() {
    return this.editable ? this : null;
  }
  move(top: number) {
    this.scrollTop = top;
    this.dispatchEvent(new Event('scroll'));
  }
}

const cleanup: (() => void)[] = [];

function mount() {
  const viewport = new TestViewport();
  let direction: ScrollDirection | null = null;
  const changed = vi.fn((value: ScrollDirection | null) => {
    direction = value;
  });
  const navigation = attachScrollNavigation(viewport, changed);
  cleanup.push(() => navigation.dispose());
  return { viewport, navigation, changed, direction: () => direction };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  vi.stubGlobal('WheelEvent', TestWheelEvent);
  vi.stubGlobal('PointerEvent', TestPointerEvent);
  vi.stubGlobal('KeyboardEvent', TestKeyboardEvent);
  vi.stubGlobal('Element', TestViewport);
});

afterEach(() => {
  cleanup.splice(0).forEach((dispose) => dispose());
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('directional scroll navigation', () => {
  it('starts hidden and does not reveal arrows for automatic scrolling', () => {
    const log = mount();
    log.viewport.move(300);
    log.viewport.move(800);
    expect(log.direction()).toBeNull();
    expect(log.changed).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('waits for actual movement after input and follows the viewport direction', () => {
    const log = mount();
    log.viewport.dispatchEvent(new TestWheelEvent());
    expect(log.direction()).toBeNull();
    log.viewport.move(450);
    expect(log.direction()).toBe('down');
    log.viewport.dispatchEvent(new TestWheelEvent(-100));
    log.viewport.move(300);
    expect(log.direction()).toBe('up');
    expect(vi.getTimerCount()).toBe(1);
  });

  it('expires exactly 3 seconds after the last matching scroll, not the last input', () => {
    const log = mount();
    expect(SCROLL_NAVIGATION_IDLE_MS).toBe(3000);
    log.viewport.dispatchEvent(new TestWheelEvent());
    log.viewport.move(500);
    vi.advanceTimersByTime(2000);
    log.viewport.move(600);
    vi.advanceTimersByTime(2000);
    log.viewport.dispatchEvent(new TestWheelEvent());
    vi.advanceTimersByTime(999);
    expect(log.direction()).toBe('down');
    vi.advanceTimersByTime(1);
    expect(log.direction()).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('reverses immediately and cancels the old direction timeout', () => {
    const log = mount();
    log.viewport.dispatchEvent(new TestWheelEvent());
    log.viewport.move(600);
    vi.advanceTimersByTime(2500);
    log.viewport.dispatchEvent(new TestWheelEvent(-100));
    log.viewport.move(500);
    expect(log.direction()).toBe('up');
    vi.advanceTimersByTime(500);
    expect(log.direction()).toBe('up');
    vi.advanceTimersByTime(2500);
    expect(log.direction()).toBeNull();
  });

  it('does not discard fresh input when an older visibility timer expires before the scroll event', () => {
    const log = mount();
    log.viewport.dispatchEvent(new TestWheelEvent());
    log.viewport.move(500);
    vi.advanceTimersByTime(2999);
    log.viewport.dispatchEvent(new TestWheelEvent());
    vi.advanceTimersByTime(11);
    expect(log.direction()).toBeNull();
    log.viewport.move(600);
    expect(log.direction()).toBe('down');
    vi.advanceTimersByTime(3000);
    expect(log.direction()).toBeNull();
  });

  it('does not interpret a touch tap or a click on message content as a scroll gesture', () => {
    const log = mount();
    log.viewport.dispatchEvent(new TestPointerEvent('pointerdown', 1, 'touch'));
    log.viewport.move(350);
    expect(log.direction()).toBeNull();
    const click = new TestPointerEvent('pointerdown');
    Object.defineProperty(click, 'target', { value: new TestViewport() });
    log.viewport.dispatchEvent(click);
    log.viewport.move(300);
    expect(log.direction()).toBeNull();
    log.viewport.dispatchEvent(new Event('touchmove'));
    log.viewport.move(250);
    expect(log.direction()).toBe('up');
  });

  it('hides at the destination and clamps mobile overscroll bounce', () => {
    const log = mount();
    log.viewport.dispatchEvent(new Event('touchmove'));
    log.viewport.move(200);
    expect(log.direction()).toBe('up');
    log.viewport.move(0);
    expect(log.direction()).toBeNull();
    log.viewport.move(-60);
    log.viewport.move(0);
    expect(log.direction()).toBeNull();
    log.viewport.move(200);
    expect(log.direction()).toBe('down');
    log.viewport.move(1500);
    expect(log.direction()).toBeNull();
    log.viewport.move(1550);
    log.viewport.move(1500);
    expect(log.direction()).toBeNull();
  });

  it('does not show arrows for non-scrollable content', () => {
    const log = mount();
    log.viewport.scrollHeight = log.viewport.clientHeight;
    log.viewport.dispatchEvent(new TestWheelEvent());
    log.viewport.move(100);
    expect(log.direction()).toBeNull();
  });

  it('supports touch momentum after pointer cancellation', () => {
    const log = mount();
    log.viewport.dispatchEvent(new TestPointerEvent('pointerdown', 1, 'touch'));
    log.viewport.dispatchEvent(new Event('touchmove'));
    log.viewport.move(350);
    log.viewport.ownerDocument.dispatchEvent(new TestPointerEvent('pointercancel'));
    vi.advanceTimersByTime(2500);
    log.viewport.move(250);
    expect(log.direction()).toBe('up');
    vi.advanceTimersByTime(2999);
    expect(log.direction()).toBe('up');
    vi.advanceTimersByTime(1);
    expect(log.direction()).toBeNull();
  });

  it('supports a held scrollbar drag even after pausing for more than 3 seconds', () => {
    const log = mount();
    log.viewport.dispatchEvent(new TestPointerEvent('pointerdown'));
    log.viewport.move(600);
    vi.advanceTimersByTime(4000);
    expect(log.direction()).toBeNull();
    log.viewport.move(800);
    expect(log.direction()).toBe('down');
    log.viewport.ownerDocument.dispatchEvent(new TestPointerEvent('pointerup'));
    vi.advanceTimersByTime(4000);
    log.viewport.move(900);
    expect(log.direction()).toBeNull();
  });

  it.each(['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '])(
    'recognizes native keyboard scrolling with %s',
    (key) => {
      const log = mount();
      log.viewport.dispatchEvent(new TestKeyboardEvent(key));
      log.viewport.move(500);
      expect(log.direction()).toBe('down');
    },
  );

  it('ignores editing keys, unrelated keys, shortcuts, prevented input and wheel zoom', () => {
    const log = mount();
    const ignored = [
      new TestKeyboardEvent('Enter'),
      Object.assign(new TestKeyboardEvent('ArrowDown'), { ctrlKey: true }),
      new TestWheelEvent(100, true),
      new TestWheelEvent(0),
    ];
    const prevented = new TestWheelEvent();
    prevented.preventDefault();
    ignored.push(prevented);
    for (const event of ignored) {
      log.viewport.dispatchEvent(event);
      log.viewport.move(log.viewport.scrollTop + 10);
      expect(log.direction()).toBeNull();
    }
    log.viewport.editable = true;
    log.viewport.dispatchEvent(new TestKeyboardEvent('ArrowDown'));
    log.viewport.move(800);
    expect(log.direction()).toBeNull();
  });

  it('does not mistake layout anchoring or resizing for user scrolling', () => {
    const log = mount();
    log.viewport.dispatchEvent(new TestWheelEvent());
    log.viewport.scrollHeight += 100;
    log.viewport.move(450);
    expect(log.direction()).toBeNull();
    log.viewport.clientHeight -= 100;
    log.viewport.move(500);
    expect(log.direction()).toBeNull();
    log.viewport.move(600);
    expect(log.direction()).toBe('down');
  });

  it('reset suppresses jump, search, auto-follow and thread-switch scrolls', () => {
    const log = mount();
    log.viewport.dispatchEvent(new TestWheelEvent());
    log.viewport.move(600);
    expect(log.direction()).toBe('down');
    log.navigation.reset();
    expect(log.direction()).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
    log.viewport.move(0);
    log.viewport.move(1500);
    expect(log.direction()).toBeNull();
    log.viewport.dispatchEvent(new TestWheelEvent(-100));
    log.viewport.move(1200);
    expect(log.direction()).toBe('up');
  });

  it('scrollend closes the input window without prematurely hiding the arrow', () => {
    const log = mount();
    log.viewport.dispatchEvent(new TestWheelEvent());
    log.viewport.move(600);
    log.viewport.dispatchEvent(new Event('scrollend'));
    log.viewport.move(400);
    expect(log.direction()).toBe('down');
    vi.advanceTimersByTime(3000);
    expect(log.direction()).toBeNull();
  });

  it('dispose removes event listeners and pending timers without updating an unmounted view', () => {
    const log = mount();
    log.viewport.dispatchEvent(new TestWheelEvent());
    log.viewport.move(600);
    log.navigation.dispose();
    const count = log.changed.mock.calls.length;
    log.viewport.dispatchEvent(new TestWheelEvent(-100));
    log.viewport.move(400);
    log.viewport.ownerDocument.dispatchEvent(new TestPointerEvent('pointerup'));
    vi.advanceTimersByTime(5000);
    expect(log.changed).toHaveBeenCalledTimes(count);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('icon-only scroll controls', () => {
  it.each([null, 'up', 'down'] as const)(
    'shows only the %s direction with accessible labels and symbols',
    (direction) => {
      const onTop = vi.fn();
      const onBottom = vi.fn();
      const node = ScrollNavigationButtons({ direction, newMessageBelow: false, onTop, onBottom });
      const [up, down] = node.props.children;
      expect(up.props.hidden).toBeUndefined();
      expect(down.props.hidden).toBeUndefined();
      expect(up.props['data-instant-hide']).toBe(direction === 'down');
      expect(down.props['data-instant-hide']).toBe(direction === 'up');
      for (const [button, label, target, bar] of [
        [up, 'Scroll to top', 'up', 'M5 4h14'],
        [down, 'Scroll to bottom', 'down', 'M5 20h14'],
      ]) {
        expect(button.props['data-visible']).toBe(direction === target);
        expect(button.props['aria-hidden']).toBe(direction !== target);
        expect(button.props.disabled).toBe(direction !== target);
        expect(button.props['aria-label']).toBe(label);
        expect(button.props.children.type).toBe('svg');
        expect(button.props.children.props.viewBox).toBe('0 0 24 24');
        expect(button.props.children.props['aria-hidden']).toBe('true');
        expect(button.props.children.props.focusable).toBe('false');
        expect(button.props.children.props.children[0].props.d).toBe(bar);
      }
      up.props.onClick();
      down.props.onClick();
      expect(onTop).toHaveBeenCalledOnce();
      expect(onBottom).toHaveBeenCalledOnce();
    },
  );

  it('keeps unread-message styling and accessible context on the Down arrow', () => {
    const node = ScrollNavigationButtons({ direction: 'down', newMessageBelow: true, onTop() {}, onBottom() {} });
    const [up, down] = node.props.children;
    expect(up.props.class).not.toContain('new-message');
    expect(down.props.class).toContain('new-message');
    expect(down.props['aria-label']).toBe('New message below; scroll to bottom');
  });
});
