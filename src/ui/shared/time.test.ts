import { describe, expect, it } from 'vitest';
import { epochMs, isEpochMs, parseTimestamp } from './time.js';

describe('UI epoch millisecond timestamps', () => {
  it.each([0, -1, 1793934000123, 8640000000000000, -8640000000000000])('preserves valid timestamp %s', (value) => {
    expect(isEpochMs(value)).toBe(true);
    expect(epochMs(value)).toBe(value);
  });
  it.each([null, undefined, '', '1793934000123', '2026-11-06T03:00:00Z', 1.5, NaN, Infinity, 8640000000000001])(
    'rejects invalid UI timestamp %s without coercion',
    (value) => {
      expect(isEpochMs(value)).toBe(false);
      expect(() => epochMs(value)).toThrow('Invalid epoch-millisecond timestamp');
    },
  );
  it('parses only external dates and preserves offsets and millisecond precision', () => {
    expect(parseTimestamp(null)).toBeNull();
    expect(parseTimestamp(undefined)).toBeNull();
    expect(parseTimestamp('2026-11-06T05:00:00.123+02:00')).toBe(1793934000123);
    expect(parseTimestamp('2026-11-06 03:00:00.123')).toBe(1793934000123);
    for (const value of ['2026-02-30T00:00:00Z', '2026-11-06T03:00:00', '2026-11-06', '1793934000123'])
      expect(() => parseTimestamp(value)).toThrow('Invalid timestamp');
  });
});
