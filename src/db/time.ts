import { parseTimestamp } from '../time.js';

export const INSTANT_COLUMNS = new Set([
  'timestamp',
  'ts',
  'created_at',
  'updated_at',
  'expires_at',
  'last_active',
  'applied',
  'added_at',
  'resolved_at',
  'granted_at',
  'subscribed_at',
  'denied_at',
  'onboarded_at',
  'last_seen_at',
  'first_seen',
  'last_seen',
  'linked_at',
  'last_used_at',
  'last_used',
  'redeemed_at',
  'first_redeemed_at',
  'verified_at',
  'consumed_at',
  'responded_at',
  'delivered_at',
  'process_after',
  'deliver_after',
  'status_changed',
  'started_at',
  'ended_at',
  'completed_at',
  'tool_started_at',
  'parent_message_ts',
  'applied_at',
]);

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
