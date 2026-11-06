import { describe, expect, it } from 'vitest';
import { epochMs, formatTimestamp, importTimestamp, parseTimestamp } from './time.js';
import { isTimestamp } from './session-link-validate.js';

describe('canonical host timestamp boundaries', () => {
  it('validates the unchanged decimal-string runner boundary before creating numeric live records', () => {
    expect(isTimestamp('0')).toBe(true);
    expect(isTimestamp('8640000000000000')).toBe(true);
    for (const value of [0, '8640000000000001', '9999999999999999', '0.5', 'invalid'])
      expect(isTimestamp(value)).toBe(false);
  });

  it('preserves epoch zero and null without coercing ordinary internal values', () => {
    expect(epochMs(0)).toBe(0);
    expect(formatTimestamp(0)).toBe('1970-01-01T00:00:00.000Z');
    expect(formatTimestamp(null)).toBeNull();
    expect(() => epochMs('0')).toThrow('Invalid epoch-millisecond timestamp');
  });

  it('imports ISO JSON dates only at the file/archive boundary and returns numeric records', () => {
    expect(importTimestamp('2026-11-06T02:00:00.123+02:00')).toBe(1793923200123);
    expect(importTimestamp(1793923200123)).toBe(1793923200123);
    expect(importTimestamp(null)).toBeNull();
    expect(parseTimestamp(formatTimestamp(1793923200123))).toBe(1793923200123);
  });

  it.each([undefined, 'not-a-date', '2026-02-30T00:00:00Z', '1793923200123', 0.1, Infinity, 8640000000000001])
    ('rejects invalid imported timestamps %s instead of guessing or rounding', (value) => {
      expect(() => importTimestamp(value)).toThrow();
    });
});
