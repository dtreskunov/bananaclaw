export type EpochMs = number;

export function isEpochMs(value: unknown): value is EpochMs {
  return typeof value === 'number' && Number.isSafeInteger(value) && Math.abs(value) <= 8640000000000000;
}

export function epochMs(value: unknown): EpochMs {
  if (!isEpochMs(value)) throw new Error('Invalid epoch-millisecond timestamp');
  return value;
}

export function formatTimestamp(value: EpochMs): string;
export function formatTimestamp(value: EpochMs | null): string | null;
export function formatTimestamp(value: EpochMs | null): string | null {
  return value === null ? null : new Date(epochMs(value)).toISOString();
}

/** Only external ISO/SQLite UTC boundaries parse strings; UI state never does. */
export function parseTimestamp(value: string): EpochMs;
export function parseTimestamp(value: string | null | undefined): EpochMs | null;
export function parseTimestamp(value: string | null | undefined): EpochMs | null {
  if (value == null) return null;
  const normalized = /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d(?:\.\d{1,3})?$/.test(value)
    ? `${value.replace(' ', 'T')}Z`
    : value;
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?(?:Z|[+-]\d\d:\d\d)$/.test(normalized))
    throw new Error('Invalid timestamp');
  const wall = normalized.slice(0, 19);
  const wallTime = Date.parse(`${wall}Z`);
  const result = Date.parse(normalized);
  if (!isEpochMs(wallTime) || !isEpochMs(result) || new Date(wallTime).toISOString().slice(0, 19) !== wall)
    throw new Error('Invalid timestamp');
  return result;
}
