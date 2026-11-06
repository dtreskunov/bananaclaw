import { epochMs } from '../time.js';

/** Validate supplied instants without changing records or traversing opaque JSON. */
export function assertTimestampFields<T extends object>(row: T, fields: readonly (keyof T)[]): void {
  for (const field of fields) {
    const value = row[field];
    if (value !== null && value !== undefined) epochMs(value);
  }
}
