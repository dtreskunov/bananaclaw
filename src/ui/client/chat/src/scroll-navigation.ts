export type ScrollDirection = 'up' | 'down';
export const SCROLL_NAVIGATION_IDLE_MS = 1000;

type ScrollBox = EventTarget & {
  scrollTop: number;
  readonly scrollHeight: number;
  readonly clientHeight: number;
};
type ScrollViewport = ScrollBox & {
  readonly ownerDocument: EventTarget;
};

export function transcriptReadingTop(viewport: HTMLElement): number {
  const clearance =
    parseFloat(getComputedStyle(viewport, '::before').height) + parseFloat(getComputedStyle(viewport).rowGap);
  return viewport.getBoundingClientRect().top + viewport.clientTop + clearance;
}

export function userMessageScrollTop(
  positions: readonly number[],
  current: number,
  maximum: number,
  direction: ScrollDirection,
): number | null {
  let previous: number | null = null;
  for (const position of positions) {
    const target = Math.max(0, Math.min(maximum, position));
    if (direction === 'down' && target > current + 1) return target;
    if (target < current - 1) previous = target;
  }
  return direction === 'up' ? previous : null;
}

export interface ScrollNavigation {
  reset(): void;
  dispose(): void;
}

export function attachScrollNavigation(
  viewport: ScrollViewport,
  onDirection: (direction: ScrollDirection | null) => void,
  onUserInput?: () => void,
): ScrollNavigation {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let inputUntil: number | null = null;
  let active: ScrollBox = viewport;
  const pointers = new Set<number>();
  const snapshot = (element: ScrollBox) => {
    const maximum = Math.max(0, element.scrollHeight - element.clientHeight);
    return {
      top: Math.max(0, Math.min(maximum, element.scrollTop)),
      height: element.scrollHeight,
      viewportHeight: element.clientHeight,
    };
  };
  const positions = new WeakMap<ScrollBox, ReturnType<typeof snapshot>>();
  positions.set(viewport, snapshot(viewport));

  function clearTimer(): void {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  }

  function hide(): void {
    clearTimer();
    onDirection(null);
  }

  function inputScroller(event: Event): ScrollBox {
    let element = event.target instanceof Element ? event.target : null;
    while (element && element !== viewport) {
      if (element.scrollHeight > element.clientHeight + 1) return element;
      element = element.parentElement;
    }
    return viewport;
  }

  function arm(event: Event): void {
    const now = Date.now();
    active = inputScroller(event);
    if (active === viewport) onUserInput?.();
    inputUntil = now + SCROLL_NAVIGATION_IDLE_MS;
    // Passive input may arrive after the compositor moves but before scroll.
    // Observe that movement before a streaming update can reset the position.
    onScroll();
  }

  function rememberScroller(event: Event): void {
    const element = inputScroller(event);
    if (!positions.has(element)) positions.set(element, snapshot(element));
  }

  function onScroll(event?: Event): void {
    const element = event ? (event.target instanceof Element ? event.target : viewport) : active;
    const position = snapshot(element);
    const previous = positions.get(element) ?? { ...position, top: 0 };
    const delta = position.top - previous.top;
    const resized = position.height !== previous.height || position.viewportHeight !== previous.viewportHeight;
    positions.set(element, position);
    // Native scroll chaining can move the transcript after a bubble reaches an edge.
    if (
      element !== active &&
      (element !== viewport ||
        (active.scrollTop > 1 && active.scrollTop < active.scrollHeight - active.clientHeight - 1))
    )
      return;
    // Layout anchoring and streaming content can move the viewport without
    // the user scrolling. Only actual movement after user input reveals arrows.
    if (resized || delta === 0 || (!pointers.size && (inputUntil === null || Date.now() > inputUntil))) return;
    if (element === viewport && active !== viewport) {
      active = viewport;
      onUserInput?.();
    }
    inputUntil = Date.now() + SCROLL_NAVIGATION_IDLE_MS;
    const next = delta < 0 ? 'up' : 'down';
    onDirection(next);
    clearTimer();
    timer = setTimeout(() => {
      timer = null;
      if (inputUntil !== null && Date.now() >= inputUntil) inputUntil = null;
      onDirection(null);
    }, SCROLL_NAVIGATION_IDLE_MS);
  }

  function onWheel(event: Event): void {
    if (event instanceof WheelEvent && !event.defaultPrevented && !event.ctrlKey && event.deltaY !== 0) arm(event);
  }

  function onTouchMove(event: Event): void {
    if (!event.defaultPrevented) arm(event);
  }

  function onPointerDown(event: Event): void {
    // A tap or a click inside a message may focus/zoom content, not scroll.
    // Track direct scrollbar drags; touch scrolling is armed by touchmove.
    if (!(event instanceof PointerEvent) || event.defaultPrevented) return;
    const element = inputScroller(event);
    positions.set(element, snapshot(element));
    if (event.target !== element || event.button !== 0 || !['mouse', 'pen'].includes(event.pointerType)) return;
    pointers.add(event.pointerId);
    arm(event);
  }

  function onPointerEnd(event: Event): void {
    if (event instanceof PointerEvent) pointers.delete(event.pointerId);
  }

  function onKeyDown(event: Event): void {
    if (!(event instanceof KeyboardEvent) || event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey)
      return;
    if (!['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key)) return;
    if (event.target instanceof Element) {
      if (event.target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])')) return;
      if (event.key === ' ' && event.target.closest('button')) return;
    }
    arm(event);
  }

  function onScrollEnd(event: Event): void {
    if (event.target === active) inputUntil = null;
  }

  const listeners: [string, EventListener, boolean?][] = [
    ['scroll', onScroll, true],
    ['scrollend', onScrollEnd, true],
    ['wheel', onWheel],
    ['touchmove', onTouchMove],
    ['pointerdown', onPointerDown],
    ['keydown', onKeyDown],
    ['pointerover', rememberScroller],
    ['focusin', rememberScroller],
  ];
  for (const [name, listener, capture = false] of listeners)
    viewport.addEventListener(name, listener, { passive: true, capture });
  viewport.ownerDocument.addEventListener('pointerup', onPointerEnd);
  viewport.ownerDocument.addEventListener('pointercancel', onPointerEnd);
  onDirection(null);

  return {
    reset() {
      inputUntil = null;
      pointers.clear();
      active = viewport;
      positions.set(viewport, snapshot(viewport));
      hide();
    },
    dispose() {
      clearTimer();
      for (const [name, listener, capture = false] of listeners)
        viewport.removeEventListener(name, listener, { capture });
      viewport.ownerDocument.removeEventListener('pointerup', onPointerEnd);
      viewport.ownerDocument.removeEventListener('pointercancel', onPointerEnd);
    },
  };
}
