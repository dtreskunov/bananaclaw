import { INSTANT_COLUMNS } from '../db/storage-lifecycle.js';
import { formatTimestamp } from '../time.js';

const CLI_DATE_FIELDS = new Set([...INSTANT_COLUMNS, 'createdAt', 'expiresAt', 'resolvedAt']);

function serializeRecord(data: unknown): unknown {
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return data;
  return Object.fromEntries(
    Object.entries(data).map(([key, value]) => [
      key,
      CLI_DATE_FIELDS.has(key) && typeof value === 'number' ? formatTimestamp(value) : value,
    ]),
  );
}

/** Only top-level record dates are formatted; nested payloads remain opaque. */
export function serializeCliTimestamps(data: unknown): unknown {
  return Array.isArray(data) ? data.map(serializeRecord) : serializeRecord(data);
}
