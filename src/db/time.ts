import { parseTimestamp } from '../ui/shared/time.js';

/** Provider/admin record boundaries remain ISO; UI-owned records use epoch milliseconds. */
export function toEpoch(value: string): number;
export function toEpoch(value: string | null | undefined): number | null;
export function toEpoch(value: string | null | undefined): number | null {
  return parseTimestamp(value);
}

export function fromEpoch(value: number): string;
export function fromEpoch(value: number | null): string | null;
export function fromEpoch(value: number | null): string | null {
  if (value === null) return null;
  if (!Number.isSafeInteger(value)) throw new Error(`Invalid stored timestamp: ${value}`);
  return new Date(value).toISOString();
}

export function encodeTimes<T extends object>(row: T, keys: readonly (keyof T)[]): Record<string, unknown> {
  const result: Record<string, unknown> = Object.fromEntries(Object.entries(row));
  for (const key of keys) {
    if (result[String(key)] !== undefined)
      result[String(key)] =
        key === 'ts' ? activityEpoch(result[String(key)] as string) : toEpoch(result[String(key)] as string | null);
  }
  return result;
}

export function decodeTimes<T>(row: unknown, keys: readonly (keyof NonNullable<T>)[]): T {
  if (row === undefined || row === null) return row as T;
  const result = { ...(row as Record<string, unknown>) };
  for (const key of keys) {
    if (result[String(key)] !== undefined)
      result[String(key)] =
        key === 'ts' ? String(result[String(key)]) : fromEpoch(result[String(key)] as number | null);
  }

  return result as T;
}

/** Activity frames historically use decimal epoch strings, not ISO strings. */
export function activityEpoch(value: string): number {
  const epoch = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(epoch) || epoch > 8640000000000000) {
    throw new Error(`Invalid activity timestamp: ${value}`);
  }
  return epoch;
}

export function decodeTimeRows<T>(rows: unknown[], keys: readonly (keyof T)[]): T[] {
  return rows.map((row) => decodeTimes<T>(row, keys));
}
