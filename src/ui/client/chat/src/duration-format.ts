export function formatDuration(ms: number | null): string {
  if (ms === null) return '';
  if (ms < 1000) return `${ms}ms`;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

/** Stopwatch text: tenths below 10s when `fine`, then whole seconds, minutes and hours (truncated, never rounded up). */
export function formatStopwatch(ms: number, fine = true): string {
  const value = Math.max(0, ms);
  if (fine && value < 10_000) return `${(Math.floor(value / 100) / 10).toFixed(1)}s`;
  const seconds = Math.floor(value / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}
