/** Activity timestamps are epoch milliseconds; missing legacy values are not epoch zero. */
export function activityTimestamp(ts: string): number {
  return ts.trim() ? Number(ts) : NaN;
}

/** Union of execution intervals; an Infinity end leaves a live tail from `since`. */
export function executionTime(spans: readonly (readonly [number, number])[]): { ms: number; since?: number } {
  let ms = 0;
  let covered = -Infinity;
  for (const [start, end] of [...spans].sort((a, b) => a[0] - b[0])) {
    if (end <= covered) continue;
    if (end === Infinity) return { ms: ms - Math.max(0, covered - start), since: start };
    ms += end - Math.max(start, covered);
    covered = end;
  }
  return { ms };
}
