const EDGE_EPSILON = 1;

export function tableScrollEdges(
  scrollLeft: number,
  clientWidth: number,
  scrollWidth: number,
): { left: boolean; right: boolean } {
  const maxScrollLeft = Math.max(0, scrollWidth - clientWidth);
  return {
    left: scrollLeft > EDGE_EPSILON,
    right: scrollLeft < maxScrollLeft - EDGE_EPSILON,
  };
}

function attachTableScrollEdge(table: HTMLTableElement): () => void {
  const update = (): void => {
    const edges = tableScrollEdges(table.scrollLeft, table.clientWidth, table.scrollWidth);
    table.classList.toggle('scroll-fade-left', edges.left);
    table.classList.toggle('scroll-fade-right', edges.right);
  };
  table.addEventListener('scroll', update, { passive: true });
  const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(update);
  observer?.observe(table);
  update();
  return () => {
    table.removeEventListener('scroll', update);
    observer?.disconnect();
  };
}

export function observeTableScrollEdges(root: HTMLElement): () => void {
  const attached = new Map<HTMLTableElement, () => void>();
  const sync = (): void => {
    const tables = new Set(root.querySelectorAll<HTMLTableElement>('table:not([data-table-scroll="off"])'));
    for (const table of tables) {
      if (!attached.has(table)) attached.set(table, attachTableScrollEdge(table));
    }
    for (const [table, cleanup] of attached) {
      if (tables.has(table)) continue;
      cleanup();
      attached.delete(table);
    }
  };
  const observer = new MutationObserver(sync);
  observer.observe(root, { childList: true, subtree: true });
  sync();
  return () => {
    observer.disconnect();
    for (const cleanup of attached.values()) cleanup();
    attached.clear();
  };
}
