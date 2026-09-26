export function parseTimelinePosition(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

/** New records use durable consumption/emission order; legacy records keep chronology. */
export function timelineSortKey(timestamp: string, timelinePosition?: number): number {
  const position = parseTimelinePosition(timelinePosition);
  if (position !== undefined) return position;
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(timestamp)
    ? timestamp.replace(' ', 'T') + 'Z'
    : timestamp;
  const milliseconds = Date.parse(normalized);
  return Number.isFinite(milliseconds) ? milliseconds * 1000 : 0;
}
