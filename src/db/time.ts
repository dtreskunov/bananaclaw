import { parseTimestamp } from '../time.js';

/** Batch parser for genuine runner wire records, never for ordinary DB CRUD. */
export function encodeTimes<T extends object>(row: T, keys: readonly (keyof T)[]): Record<string, unknown> {
  const result: Record<string, unknown> = Object.fromEntries(Object.entries(row));
  for (const key of keys) {
    if (result[String(key)] !== undefined)
      result[String(key)] =
        key === 'ts'
          ? activityEpoch(result[String(key)] as string)
          : parseTimestamp(result[String(key)] as string | null);
  }
  return result;
}

/** Activity frames historically use decimal epoch strings, not ISO strings. */
export function activityEpoch(value: string): number {
  const epoch = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(epoch) || epoch > 8640000000000000) {
    throw new Error(`Invalid activity timestamp: ${value}`);
  }
  return epoch;
}
