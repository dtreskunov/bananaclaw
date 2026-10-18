import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  attachScrollNavigation,
  SCROLL_NAVIGATION_IDLE_MS,
  userMessageScrollTop,
  type ScrollDirection,
} from './scroll-navigation';
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
  button = false;
  parentElement: TestViewport | null = null;
  closest(selector = '') {
    return this.editable || (this.button && selector.includes('button')) ? this : null;
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
  it('reports actual user movement at boundaries, but not automatic scrolling or layout changes', () => {
    const viewport = new TestViewport();
    const moved = vi.fn();
    const navigation = attachScrollNavigation(viewport, (direction) => {
      if (direction) moved(direction);
    });
    cleanup.push(() => navigation.dispose());
    viewport.move(500);
    expect(moved).not.toHaveBeenCalled();
    viewport.dispatchEvent(new TestWheelEvent(-100));
    viewport.move(0);
    expect(moved).toHaveBeenLastCalledWith('up');
    navigation.reset();
    viewport.move(400);
    expect(moved).toHaveBeenCalledTimes(1);
    viewport.dispatchEvent(new TestWheelEvent());
    viewport.scrollHeight = 2500;
    viewport.move(500);
    expect(moved).toHaveBeenCalledTimes(1);
    viewport.move(2000);
    expect(moved).toHaveBeenLastCalledWith('down');
    expect(moved).toHaveBeenCalledTimes(2);
  });
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

  it('detects a first wheel movement even when the compositor reaches the top before passive input', () => {
    const viewport = new TestViewport();
    const moved = vi.fn();
    const navigation = attachScrollNavigation(viewport, (direction) => {
      if (direction) moved(direction);
    });
    cleanup.push(() => navigation.dispose());
    viewport.scrollTop = 0;
    viewport.dispatchEvent(new TestWheelEvent(-400));
    expect(moved).toHaveBeenCalledExactlyOnceWith('up');
    viewport.dispatchEvent(new Event('scroll'));
    expect(moved).toHaveBeenCalledExactlyOnceWith('up');
  });

  it.each([
    ['wheel', () => new TestWheelEvent(-100)],
    ['touch', () => new Event('touchmove')],
    ['keyboard', () => new TestKeyboardEvent('ArrowUp')],
  ])('detects a coalesced reversal during active %s scrolling', (_, reverseInput) => {
    const log = mount();
    log.viewport.dispatchEvent(new TestWheelEvent());
    log.viewport.move(600);
    expect(log.direction()).toBe('down');
    // The compositor moves before passive input and its queued scroll event arrive.
    log.viewport.scrollTop = 500;
    log.viewport.dispatchEvent(reverseInput());
    log.viewport.dispatchEvent(new Event('scroll'));
    expect(log.direction()).toBe('up');
    log.viewport.scrollTop = 550;
    log.viewport.dispatchEvent(new TestWheelEvent());
    log.viewport.dispatchEvent(new Event('scroll'));
    expect(log.direction()).toBe('down');
    expect(vi.getTimerCount()).toBe(1);
  });

  it('expires exactly 1 second after the last matching scroll, not the last input', () => {
    const log = mount();
    expect(SCROLL_NAVIGATION_IDLE_MS).toBe(1000);
    log.viewport.dispatchEvent(new TestWheelEvent());
    log.viewport.move(500);
    vi.advanceTimersByTime(600);
    log.viewport.move(600);
    vi.advanceTimersByTime(600);
    log.viewport.dispatchEvent(new TestWheelEvent());
    vi.advanceTimersByTime(399);
    expect(log.direction()).toBe('down');
    vi.advanceTimersByTime(1);
    expect(log.direction()).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('reverses immediately and cancels the old direction timeout', () => {
    const log = mount();
    log.viewport.dispatchEvent(new TestWheelEvent());
    log.viewport.move(600);
    vi.advanceTimersByTime(750);
    log.viewport.dispatchEvent(new TestWheelEvent(-100));
    log.viewport.move(500);
    expect(log.direction()).toBe('up');
    vi.advanceTimersByTime(250);
    expect(log.direction()).toBe('up');
    vi.advanceTimersByTime(750);
    expect(log.direction()).toBeNull();
  });

  it('does not discard fresh input when an older visibility timer expires before the scroll event', () => {
    const log = mount();
    log.viewport.dispatchEvent(new TestWheelEvent());
    log.viewport.move(500);
    vi.advanceTimersByTime(999);
    log.viewport.dispatchEvent(new TestWheelEvent());
    vi.advanceTimersByTime(11);
    expect(log.direction()).toBeNull();
    log.viewport.move(600);
    expect(log.direction()).toBe('down');
    vi.advanceTimersByTime(1000);
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

  it('reports scrolling at either edge without treating mobile overscroll bounce as a reversal', () => {
    const log = mount();
    log.viewport.dispatchEvent(new Event('touchmove'));
    log.viewport.move(200);
    expect(log.direction()).toBe('up');
    log.viewport.move(0);
    expect(log.direction()).toBe('up');
    log.viewport.move(-60);
    log.viewport.move(0);
    expect(log.direction()).toBe('up');
    log.viewport.move(200);
    expect(log.direction()).toBe('down');
    log.viewport.move(1500);
    expect(log.direction()).toBe('down');
    log.viewport.move(1550);
    log.viewport.move(1500);
    expect(log.direction()).toBe('down');
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
    vi.advanceTimersByTime(750);
    log.viewport.move(250);
    expect(log.direction()).toBe('up');
    vi.advanceTimersByTime(999);
    expect(log.direction()).toBe('up');
    vi.advanceTimersByTime(1);
    expect(log.direction()).toBeNull();
  });

  it('supports a held scrollbar drag even after pausing for more than 1 second', () => {
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
    vi.advanceTimersByTime(1000);
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
      const onPrevious = vi.fn();
      const onNext = vi.fn();
      const node = ScrollNavigationButtons({ direction, canPrevious: true, canNext: true, onPrevious, onNext });
      const [up, down] = node.props.children;
      expect(up.props.hidden).toBeUndefined();
      expect(down.props.hidden).toBeUndefined();
      expect(up.props['data-instant-hide']).toBe(direction === 'down');
      expect(down.props['data-instant-hide']).toBe(direction === 'up');
      for (const [button, label, target, bar] of [
        [up, 'Previous user message', 'up', 'M5 4h14'],
        [down, 'Next user message', 'down', 'M5 20h14'],
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
      expect(onPrevious).toHaveBeenCalledOnce();
      expect(onNext).toHaveBeenCalledOnce();
    },
  );

  it('keeps an unavailable direction visible but disabled after internal scrolling', () => {
    const node = ScrollNavigationButtons({
      direction: 'down',
      canPrevious: true,
      canNext: false,
      onPrevious() {},
      onNext() {},
    });
    const [up, down] = node.props.children;
    expect(up.props.disabled).toBe(true);
    expect(down.props['data-visible']).toBe(true);
    expect(down.props.disabled).toBe(true);
    expect(down.props['aria-label']).toBe('Next user message');
  });
});

describe('user message destinations', () => {
  it('chooses the nearest message before or after the reading-area top', () => {
    expect(userMessageScrollTop([0, 120, 650, 1420], 500, 1500, 'up')).toBe(120);
    expect(userMessageScrollTop([0, 120, 650, 1420], 500, 1500, 'down')).toBe(650);
    expect(userMessageScrollTop([0, 120, 650, 1420], 650, 1500, 'up')).toBe(120);
    expect(userMessageScrollTop([0, 120, 650, 1420], 650, 1500, 'down')).toBe(1420);
  });

  it('does not revisit an aligned message or invent a top/bottom fallback', () => {
    expect(userMessageScrollTop([120, 650], 120.5, 1500, 'up')).toBeNull();
    expect(userMessageScrollTop([120, 650], 120.5, 1500, 'down')).toBe(650);
    expect(userMessageScrollTop([], 500, 1500, 'up')).toBeNull();
    expect(userMessageScrollTop([0, 2000], 1500, 1500, 'down')).toBeNull();
    expect(userMessageScrollTop([-10, 500], 0, 0, 'down')).toBeNull();
  });
});

function dispatchFrom(viewport: TestViewport, target: TestViewport, event: Event): void {
  Object.defineProperty(event, 'target', { value: target });
  viewport.dispatchEvent(event);
}

describe('scrolling inside message bubbles', () => {
  it('recognizes scrolling keys on message actions without treating Space activation as scrolling', () => {
    const log = mount();
    const inner = Object.assign(new TestViewport(), { scrollTop: 0, parentElement: log.viewport });
    const button = Object.assign(new TestViewport(), {
      scrollHeight: 24,
      clientHeight: 24,
      parentElement: inner,
      button: true,
    });
    dispatchFrom(log.viewport, button, new Event('focusin'));
    dispatchFrom(log.viewport, button, new TestKeyboardEvent('PageDown'));
    inner.scrollTop = 100;
    dispatchFrom(log.viewport, inner, new Event('scroll'));
    expect(log.direction()).toBe('down');
    log.navigation.reset();
    dispatchFrom(log.viewport, button, new TestKeyboardEvent(' '));
    inner.scrollTop = 150;
    dispatchFrom(log.viewport, inner, new Event('scroll'));
    expect(log.direction()).toBeNull();
  });

  it.each(['pointerover', 'focusin'])('seeds a retained inner position on %s without inventing movement', (event) => {
    const log = mount();
    const inner = Object.assign(new TestViewport(), { scrollTop: 600, parentElement: log.viewport });
    dispatchFrom(log.viewport, inner, new Event(event));
    dispatchFrom(log.viewport, inner, new TestWheelEvent(-100));
    expect(log.direction()).toBeNull();
    inner.scrollTop = 550;
    dispatchFrom(log.viewport, inner, new Event('scroll'));
    expect(log.direction()).toBe('up');
  });

  it('reveals arrows for inner wheel scrolling while leaving the transcript stationary', () => {
    const log = mount();
    const inner = Object.assign(new TestViewport(), { scrollTop: 0, parentElement: log.viewport });
    dispatchFrom(log.viewport, inner, new TestWheelEvent());
    inner.scrollTop = 100;
    dispatchFrom(log.viewport, inner, new Event('scroll'));
    expect(log.direction()).toBe('down');
    expect(log.viewport.scrollTop).toBe(400);
    dispatchFrom(log.viewport, inner, new TestWheelEvent(-100));
    inner.scrollTop = 50;
    dispatchFrom(log.viewport, inner, new Event('scroll'));
    expect(log.direction()).toBe('up');
    vi.advanceTimersByTime(1000);
    expect(log.direction()).toBeNull();
  });

  it('ignores programmatic inner scrolling and content/viewport resizing', () => {
    const log = mount();
    const inner = Object.assign(new TestViewport(), { scrollTop: 0, parentElement: log.viewport });
    inner.scrollTop = 100;
    dispatchFrom(log.viewport, inner, new Event('scroll'));
    expect(log.direction()).toBeNull();
    dispatchFrom(log.viewport, inner, new TestWheelEvent());
    inner.scrollHeight += 100;
    inner.scrollTop = 150;
    dispatchFrom(log.viewport, inner, new Event('scroll'));
    expect(log.direction()).toBeNull();
    inner.clientHeight -= 100;
    inner.scrollTop = 200;
    dispatchFrom(log.viewport, inner, new Event('scroll'));
    expect(log.direction()).toBeNull();
  });

  it('preserves inner baselines across navigation resets', () => {
    const log = mount();
    const inner = Object.assign(new TestViewport(), { scrollTop: 0, parentElement: log.viewport });
    dispatchFrom(log.viewport, inner, new TestWheelEvent());
    inner.scrollTop = 200;
    dispatchFrom(log.viewport, inner, new Event('scroll'));
    log.navigation.reset();
    dispatchFrom(log.viewport, inner, new TestWheelEvent(-100));
    expect(log.direction()).toBeNull();
    inner.scrollTop = 150;
    dispatchFrom(log.viewport, inner, new Event('scroll'));
    expect(log.direction()).toBe('up');
  });

  it.each(['touch', 'keyboard', 'scrollbar'])('recognizes inner %s scrolling', (input) => {
    const log = mount();
    const inner = Object.assign(new TestViewport(), { scrollTop: 0, parentElement: log.viewport });
    dispatchFrom(
      log.viewport,
      inner,
      input === 'touch'
        ? new Event('touchmove')
        : input === 'keyboard'
          ? new TestKeyboardEvent('PageDown')
          : new TestPointerEvent('pointerdown'),
    );
    inner.scrollTop = 100;
    dispatchFrom(log.viewport, inner, new Event('scroll'));
    expect(log.direction()).toBe('down');
  });

  it('does not resume transcript following until input actually scrolls the transcript', () => {
    const viewport = new TestViewport();
    const onInput = vi.fn();
    const navigation = attachScrollNavigation(viewport, () => {}, onInput);
    cleanup.push(() => navigation.dispose());
    const inner = Object.assign(new TestViewport(), { scrollTop: 0, parentElement: viewport });
    dispatchFrom(viewport, inner, new TestWheelEvent());
    inner.scrollTop = 1500;
    dispatchFrom(viewport, inner, new Event('scroll'));
    expect(onInput).not.toHaveBeenCalled();
    viewport.move(500);
    expect(onInput).toHaveBeenCalledOnce();
  });
});
