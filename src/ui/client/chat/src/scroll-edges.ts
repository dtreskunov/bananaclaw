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

const NO_EDGES = { start: false, end: false };

export function scrollEdges(element: ScrollMetrics, { horizontal = true, vertical = true }: ScrollAxes = {}) {
  const x = horizontal ? axisScrollEdges(element.scrollLeft, element.clientWidth, element.scrollWidth) : NO_EDGES;
  const y = vertical ? axisScrollEdges(element.scrollTop, element.clientHeight, element.scrollHeight) : NO_EDGES;
  return { left: x.start, right: x.end, top: y.start, bottom: y.end };
}

export function attachScrollEdges(
  element: HTMLElement,
  axes: ScrollAxes = {},
  onUpdate?: (edges: ReturnType<typeof scrollEdges>) => void,
): () => void {
  let previous: ReturnType<typeof scrollEdges> | null = null;
  const update = (): void => {
    const edges = scrollEdges(element, axes);
    let changed = false;
    for (const edge of ['left', 'right', 'top', 'bottom'] as const) {
      if (previous?.[edge] !== edges[edge]) {
        element.classList.toggle(`scroll-fade-${edge}`, edges[edge]);
        changed = true;
      }
    }
    previous = edges;
    if (changed) onUpdate?.(edges);
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
