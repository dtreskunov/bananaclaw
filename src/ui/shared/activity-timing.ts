/** Activity timestamps are epoch milliseconds; missing legacy values are not epoch zero. */
export function activityTimestamp(ts: string): number {
  return ts.trim() ? Number(ts) : NaN;
}
