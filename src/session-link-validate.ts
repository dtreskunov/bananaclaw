/**
 * Pure validators for runner → host session-link frames. The runner container
 * is untrusted: every record is checked against a closed field list, and the
 * sanitized copy is rebuilt in spec order (activity steps are stored as
 * `JSON.stringify(step)`, so field order is part of the stored format).
 */
import type { ActivityStep } from './activity.js';
import type { UsageSnapshot } from './channels/adapter.js';
import type { SessionActiveTurn } from './session-link.js';

const MAX_ID_CHARS = 256;
const MAX_TEXT_CHARS = 2_000;
const MAX_PATCH_FILES = 100;
const MAX_COST_USD = 1_000_000;

export type Check = (value: unknown) => boolean;
export type FieldSpec = readonly [key: string, check: Check, presence: 'required' | 'optional'];

export const required = (key: string, check: Check): FieldSpec => [key, check, 'required'];
export const optional = (key: string, check: Check): FieldSpec => [key, check, 'optional'];

export function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Returns a copy containing only the spec's fields, in spec order, or null if
 * the input has an unknown key, lacks a required field, or fails a check.
 */
export function sanitizeFields(
  input: Record<string, unknown>,
  fields: readonly FieldSpec[],
): Record<string, unknown> | null {
  if (!Object.keys(input).every((key) => fields.some(([name]) => name === key))) return null;
  const output: Record<string, unknown> = {};
  for (const [key, check, presence] of fields) {
    const value = input[key];
    if (value === undefined) {
      if (presence === 'required') return null;
      continue;
    }
    if (!check(value)) return null;
    output[key] = value;
  }
  return output;
}

export const isAny: Check = () => true;
export const isString: Check = (value) => typeof value === 'string';
export const isBoolean: Check = (value) => typeof value === 'boolean';
export const isTrue: Check = (value) => value === true;
export const isRecordValue: Check = isRecord;
export const isSafeInteger: Check = (value) => Number.isSafeInteger(value);
export const isCount: Check = (value) => Number.isSafeInteger(value) && (value as number) >= 0;
/** Millisecond epoch encoded as a decimal string. */
export const isTimestamp: Check = (value) => typeof value === 'string' && /^\d{1,16}$/.test(value);

/** Non-empty string of at most `max` characters. */
const text =
  (max = MAX_TEXT_CHARS): Check =>
  (value) =>
    typeof value === 'string' && value.length > 0 && value.length <= max;
/** String of at most MAX_TEXT_CHARS characters; empty is allowed. */
const optionalText: Check = (value) => typeof value === 'string' && value.length <= MAX_TEXT_CHARS;
const oneOf =
  (...allowed: string[]): Check =>
  (value) =>
    typeof value === 'string' && allowed.includes(value);
const isNonNegativeNumber: Check = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const isNonNegativeInteger: Check = (value) => Number.isInteger(value) && (value as number) >= 0;
const isFileList: Check = (value) =>
  Array.isArray(value) && value.length <= MAX_PATCH_FILES && value.every((file) => text()(file));

export function isSessionTurnId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
}

export const isTurnIdOrNull: Check = (value) => value === null || isSessionTurnId(value);

function isTurnRoutingText(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 1024 &&
    [...value].every((char) => char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127)
  );
}

const STEP_HEAD = [required('kind', isString), required('id', text(MAX_ID_CHARS))];

const ACTIVITY_STEP_FIELDS = new Map<string, readonly FieldSpec[]>(
  Object.entries({
    tool: [
      required('tool', text(MAX_ID_CHARS)),
      required('status', oneOf('pending', 'running', 'completed', 'error', 'interrupted', 'unknown')),
      optional('detail', optionalText),
      optional('description', optionalText),
      optional('title', optionalText),
      optional('error', optionalText),
      optional('durationMs', isNonNegativeNumber),
      optional('rejectedBeforeExecution', isBoolean),
    ],
    internal: [required('text', text())],
    notification: [required('text', text()), optional('detail', optionalText)],
    file: [optional('path', optionalText), optional('name', optionalText), optional('mime', optionalText)],
    patch: [required('files', isFileList)],
    retry: [required('attempt', isNonNegativeInteger), optional('error', optionalText)],
    compaction: [optional('auto', isBoolean)],
    subtask: [optional('agent', optionalText), optional('description', optionalText)],
  }).map(([kind, fields]) => [kind, [...STEP_HEAD, ...fields]]),
);

export function sanitizeActivityStep(value: unknown): ActivityStep | null {
  if (!isRecord(value) || typeof value.kind !== 'string') return null;
  const fields = ACTIVITY_STEP_FIELDS.get(value.kind);
  return fields ? (sanitizeFields(value, fields) as ActivityStep | null) : null;
}

const USAGE_FIELDS: readonly FieldSpec[] = [
  required('cost_usd', (value) => isNonNegativeNumber(value) && (value as number) <= MAX_COST_USD),
  required('input_tokens', isCount),
  required('output_tokens', isCount),
  required('cache_read_tokens', isCount),
  required('cache_write_tokens', isCount),
  required('model', text(MAX_ID_CHARS)),
  optional('reasoning_tokens', isCount),
  optional('num_turns', isCount),
  optional('duration_ms', isCount),
  optional('duration_api_ms', isCount),
  optional('context_window', isCount),
  optional('max_output_tokens', isCount),
  optional('context_tokens', isCount),
];

export function sanitizeUsage(value: unknown): UsageSnapshot | null {
  return isRecord(value) ? (sanitizeFields(value, USAGE_FIELDS) as UsageSnapshot | null) : null;
}

const TURN_FIELDS: readonly FieldSpec[] = [
  required('id', isSessionTurnId),
  required('status', oneOf('running', 'stopping')),
  required('channelType', isTurnRoutingText),
  required('platformId', isTurnRoutingText),
  required('threadId', (value) => value === null || isTurnRoutingText(value)),
  optional('supportsSteering', isBoolean),
  optional('supportsInputEditing', isBoolean),
  optional('supportsInputCancellation', isBoolean),
];

/** A `turn.state` payload: the active turn, null for idle, or false if invalid. */
export function parseTurnState(value: unknown): SessionActiveTurn | null | false {
  if (value === null) return null;
  if (!isRecord(value)) return false;
  return (sanitizeFields(value, TURN_FIELDS) as SessionActiveTurn | null) ?? false;
}
