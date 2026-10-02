export type ScrollDirection = 'up' | 'down';
export const SCROLL_NAVIGATION_IDLE_MS = 3000;

type ScrollViewport = EventTarget & {
  scrollTop: number;
  readonly scrollHeight: number;
  readonly clientHeight: number;
  readonly ownerDocument: EventTarget;
};

export interface ScrollNavigation {
  reset(): void;
  dispose(): void;
}

export function attachScrollNavigation(
  viewport: ScrollViewport,
  onDirection: (direction: ScrollDirection | null) => void,
  onUserInput?: () => void,
): ScrollNavigation {
  let direction: ScrollDirection | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let inputUntil: number | null = null;
  const pointers = new Set<number>();
  const snapshot = () => {
    const maximum = Math.max(0, viewport.scrollHeight - viewport.clientHeight);
    return {
      top: Math.max(0, Math.min(maximum, viewport.scrollTop)),
      maximum,
      height: viewport.scrollHeight,
      viewportHeight: viewport.clientHeight,
    };
  };
  let previous = snapshot();

  function publish(next: ScrollDirection | null): void {
    if (direction === next) return;
    direction = next;
    onDirection(next);
  }

  function clearTimer(): void {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  }

  function hide(): void {
    clearTimer();
    publish(null);
  }

  function arm(): void {
    onUserInput?.();
    inputUntil = Date.now() + SCROLL_NAVIGATION_IDLE_MS;
    previous = snapshot();
  }

  function available(next: ScrollDirection, position: ReturnType<typeof snapshot>): boolean {
    return position.maximum > 1 && (next === 'up' ? position.top > 1 : position.top < position.maximum - 1);
  }

  function onScroll(): void {
    const position = snapshot();
    const delta = position.top - previous.top;
    const resized = position.height !== previous.height || position.viewportHeight !== previous.viewportHeight;
    previous = position;
    if (direction && !available(direction, position)) hide();
    // Layout anchoring and streaming content can move the viewport without
    // the user scrolling. Only actual movement after user input reveals arrows.
    if (resized || delta === 0 || (!pointers.size && (inputUntil === null || Date.now() > inputUntil))) return;
    inputUntil = Date.now() + SCROLL_NAVIGATION_IDLE_MS;
    const next = delta < 0 ? 'up' : 'down';
    if (!available(next, position)) {
      hide();
      return;
    }
    publish(next);
    clearTimer();
    timer = setTimeout(() => {
      timer = null;
      if (inputUntil !== null && Date.now() >= inputUntil) inputUntil = null;
      publish(null);
    }, SCROLL_NAVIGATION_IDLE_MS);
  }

  function onWheel(event: Event): void {
    if (event instanceof WheelEvent && !event.defaultPrevented && !event.ctrlKey && event.deltaY !== 0) arm();
  }

  function onTouchMove(event: Event): void {
    if (!event.defaultPrevented) arm();
  }

  function onPointerDown(event: Event): void {
    // A tap or a click inside a message may focus/zoom content, not scroll.
    // Track direct scrollbar drags; touch scrolling is armed by touchmove.
    if (
      !(event instanceof PointerEvent) ||
      event.defaultPrevented ||
      event.target !== viewport ||
      event.button !== 0 ||
      !['mouse', 'pen'].includes(event.pointerType)
    )
      return;
    pointers.add(event.pointerId);
    arm();
  }

  function onPointerEnd(event: Event): void {
    if (event instanceof PointerEvent) pointers.delete(event.pointerId);
  }

  function onKeyDown(event: Event): void {
    if (!(event instanceof KeyboardEvent) || event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey)
      return;
    if (!['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key)) return;
    if (
      event.target instanceof Element &&
      event.target.closest('input, textarea, select, button, a[href], [contenteditable]:not([contenteditable="false"])')
    )
      return;
    arm();
  }

  function onScrollEnd(): void {
    inputUntil = null;
  }

  const listeners: [string, EventListener][] = [
    ['scroll', onScroll],
    ['scrollend', onScrollEnd],
    ['wheel', onWheel],
    ['touchmove', onTouchMove],
    ['pointerdown', onPointerDown],
    ['keydown', onKeyDown],
  ];
  for (const [name, listener] of listeners) viewport.addEventListener(name, listener, { passive: true });
  viewport.ownerDocument.addEventListener('pointerup', onPointerEnd);
  viewport.ownerDocument.addEventListener('pointercancel', onPointerEnd);
  onDirection(null);

  return {
    reset() {
      inputUntil = null;
      pointers.clear();
      previous = snapshot();
      hide();
    },
    dispose() {
      clearTimer();
      for (const [name, listener] of listeners) viewport.removeEventListener(name, listener);
      viewport.ownerDocument.removeEventListener('pointerup', onPointerEnd);
      viewport.ownerDocument.removeEventListener('pointercancel', onPointerEnd);
    },
  };
}
