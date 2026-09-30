export interface TurnStats {
  durationMs: number;
  model: string | null;
}

export type StoppedTurnStats = TurnStats;

export function readStoppedTurnStats(content: unknown): StoppedTurnStats | undefined {
  if (
    !content ||
    typeof content !== 'object' ||
    !('stopped' in content) ||
    content.stopped !== true ||
    !('stopped_stats' in content)
  )
    return undefined;
  return parseTurnStats(content.stopped_stats);
}

export function readTurnStats(content: unknown): TurnStats | undefined {
  return content && typeof content === 'object' && 'turn_stats' in content
    ? parseTurnStats(content.turn_stats)
    : undefined;
}

function parseTurnStats(stats: unknown): TurnStats | undefined {
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
