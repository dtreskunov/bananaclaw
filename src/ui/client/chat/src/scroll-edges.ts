const EDGE_EPSILON = 1;

export function axisScrollEdges(
  offset: number,
  clientSize: number,
  scrollSize: number,
): { start: boolean; end: boolean } {
  const maxOffset = Math.max(0, scrollSize - clientSize);
  return { start: offset > EDGE_EPSILON, end: offset < maxOffset - EDGE_EPSILON };
}

type ScrollMetrics = Pick<
  HTMLElement,
  'scrollLeft' | 'scrollTop' | 'clientWidth' | 'clientHeight' | 'scrollWidth' | 'scrollHeight'
>;
interface ScrollAxes {
  horizontal?: boolean;
  vertical?: boolean;
}

export function scrollEdges(element: ScrollMetrics, { horizontal = true, vertical = true }: ScrollAxes = {}) {
  const x = axisScrollEdges(element.scrollLeft, element.clientWidth, element.scrollWidth);
  const y = axisScrollEdges(element.scrollTop, element.clientHeight, element.scrollHeight);
  return {
    left: horizontal && x.start,
    right: horizontal && x.end,
    top: vertical && y.start,
    bottom: vertical && y.end,
  };
}

export function attachScrollEdges(element: HTMLElement, axes: ScrollAxes = {}): () => void {
  const update = (): void => {
    const edges = scrollEdges(element, axes);
    for (const edge of ['left', 'right', 'top', 'bottom'] as const) {
      element.classList.toggle(`scroll-fade-${edge}`, edges[edge]);
    }
  };
  element.addEventListener('scroll', update, { passive: true });
  const resize = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(update);
  const observeSize = (): void => {
    resize?.disconnect();
    resize?.observe(element);
    for (const child of element.children) {
      resize?.observe(child);
      if (child.firstElementChild) resize?.observe(child.firstElementChild);
    }
    update();
  };
  const mutations = new MutationObserver(observeSize);
  mutations.observe(element, { childList: true, subtree: true, characterData: true });
  observeSize();
  return () => {
    element.removeEventListener('scroll', update);
    resize?.disconnect();
    mutations.disconnect();
    for (const edge of ['left', 'right', 'top', 'bottom']) element.classList.remove(`scroll-fade-${edge}`);
  };
}
