export function latestActivityScrollTop(
  scrollTop: number,
  entryBottom: number,
  viewportTop: number,
  viewportHeight: number,
): number {
  return Math.max(0, scrollTop + entryBottom - viewportTop - viewportHeight + 12);
}

export function revealLatestActivity(viewport: HTMLElement): void {
  // The last row can be inside an expanded chapter or directly on the rail.
  const rows = viewport.querySelectorAll<HTMLButtonElement>('.trace-row-toggle');
  const target = rows[rows.length - 1];
  if (!target) return;
  const bounds = viewport.getBoundingClientRect();
  const entry = target.getBoundingClientRect();
  viewport.scrollTop = latestActivityScrollTop(
    viewport.scrollTop,
    entry.bottom,
    bounds.top + viewport.clientTop,
    viewport.clientHeight,
  );
}
