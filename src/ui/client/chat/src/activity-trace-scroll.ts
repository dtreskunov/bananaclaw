export function latestActivityScrollTop(
  scrollTop: number,
  entryBottom: number,
  viewportTop: number,
  viewportHeight: number,
): number {
  return Math.max(0, scrollTop + entryBottom - viewportTop - viewportHeight + 12);
}

export function activityDetailsScrollTop(
  scrollTop: number,
  entryTop: number,
  entryBottom: number,
  viewportTop: number,
  viewportHeight: number,
): number {
  const top = viewportTop + 12;
  const bottom = viewportTop + viewportHeight - 12;
  if (entryBottom - entryTop > viewportHeight - 24 || entryTop < top) {
    return Math.max(0, scrollTop + entryTop - top);
  }
  return Math.max(0, scrollTop + Math.max(0, entryBottom - bottom));
}

export function revealLatestActivity(viewport: HTMLElement, details = false): void {
  // A collapsed chapter is the visible representative of its latest step.
  const rows = viewport.querySelectorAll<HTMLButtonElement>('.trace-row-toggle, .trace-chapter-toggle');
  const target = rows[rows.length - 1];
  if (!target) return;
  const bounds = viewport.getBoundingClientRect();
  const row = details && target.getAttribute('aria-expanded') === 'true' ? target.closest('.trace-row') : null;
  if (row) {
    const entry = row.getBoundingClientRect();
    viewport.scrollTop = activityDetailsScrollTop(
      viewport.scrollTop,
      entry.top,
      entry.bottom,
      bounds.top + viewport.clientTop,
      viewport.clientHeight,
    );
    return;
  }
  const entry = target.getBoundingClientRect();
  viewport.scrollTop = latestActivityScrollTop(
    viewport.scrollTop,
    entry.bottom,
    bounds.top + viewport.clientTop,
    viewport.clientHeight,
  );
}
