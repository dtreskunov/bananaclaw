import { attachScrollEdges, axisScrollEdges } from './scroll-edges';

export function tableScrollEdges(
  scrollLeft: number,
  clientWidth: number,
  scrollWidth: number,
): { left: boolean; right: boolean } {
  const edges = axisScrollEdges(scrollLeft, clientWidth, scrollWidth);
  return { left: edges.start, right: edges.end };
}

export function observeTableScrollEdges(root: HTMLElement): () => void {
  const attached = new Map<HTMLTableElement, () => void>();
  const sync = (): void => {
    const tables = new Set(root.querySelectorAll<HTMLTableElement>('table:not([data-table-scroll="off"])'));
    for (const table of tables) {
      if (!attached.has(table)) attached.set(table, attachScrollEdges(table, { vertical: false }));
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
