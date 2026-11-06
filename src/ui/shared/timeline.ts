export function parseTimelinePosition(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

/** Consumed/emitted records use durable order; unconsumed inputs and host events use arrival chronology. */
export function timelineSortKey(timestamp: number, timelinePosition?: number): number {
  const position = parseTimelinePosition(timelinePosition);
  if (position !== undefined) return position;
  return timestamp * 1000;
}
