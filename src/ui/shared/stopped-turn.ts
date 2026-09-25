export interface StoppedTurnStats {
  durationMs: number;
  model: string | null;
}

export function readStoppedTurnStats(content: unknown): StoppedTurnStats | undefined {
  if (
    !content ||
    typeof content !== 'object' ||
    !('stopped' in content) ||
    content.stopped !== true ||
    !('stopped_stats' in content)
  )
    return undefined;
  const stats = content.stopped_stats;
  if (
    !stats ||
    typeof stats !== 'object' ||
    !('durationMs' in stats) ||
    typeof stats.durationMs !== 'number' ||
    !Number.isSafeInteger(stats.durationMs) ||
    stats.durationMs < 0 ||
    !('model' in stats) ||
    (stats.model !== null && (typeof stats.model !== 'string' || stats.model.length > 256))
  ) {
    return undefined;
  }
  return { durationMs: stats.durationMs, model: stats.model };
}
