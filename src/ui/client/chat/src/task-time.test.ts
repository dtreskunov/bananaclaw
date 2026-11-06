import { afterEach, describe, expect, it, vi } from 'vitest';
import { fmtNextRun, fromDatetimeLocal, toDatetimeLocal } from './task-time';

afterEach(() => vi.restoreAllMocks());

describe('task schedule local inputs', () => {
  it.each([0, -1, 1791220234123, 1791220200000])(
    'preserves the instant and millisecond precision for %s',
    (timestamp) => {
      vi.spyOn(Date, 'parse').mockImplementation(() => {
        throw new Error('No API timestamp parsing');
      });
      expect(fromDatetimeLocal(toDatetimeLocal(timestamp))).toBe(timestamp);
      expect(toDatetimeLocal(timestamp)).toMatch(/\d{2}:\d{2}:\d{2}\.\d{3}$/);
    },
  );

  it('uses the current instant only when next run is missing', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1791220234123);
    expect(toDatetimeLocal(null)).toBe(toDatetimeLocal(1791220234123));
    expect(toDatetimeLocal(0)).not.toBe(toDatetimeLocal(null));
  });

  it.each(['', 'invalid', '2026-02-30T12:00', '2026-01-01T25:00', '2026-01-01T12:00Z'])(
    'rejects invalid or non-local date input %j',
    (value) => expect(fromDatetimeLocal(value)).toBeNull(),
  );

  it('interprets local inputs in the browser timezone rather than appending Z', () => {
    const local = '2026-10-05T17:10:34.123';
    const date = new Date(2026, 9, 5, 17, 10, 34, 123);
    expect(fromDatetimeLocal(local)).toBe(date.getTime());
    expect(toDatetimeLocal(date.getTime())).toBe(local);
  });

  it('preserves the original instant when an unchanged local input is ambiguous', () => {
    const timestamp = Date.UTC(2026, 10, 1, 6, 30, 0, 123);
    expect(fromDatetimeLocal(toDatetimeLocal(timestamp), timestamp)).toBe(timestamp);
  });

  it('rejects a local time skipped by daylight saving rather than silently changing the schedule', () => {
    const local = new Date(2026, 2, 8, 2, 30);
    const expected = local.getHours() === 2 ? local.getTime() : null;
    expect(fromDatetimeLocal('2026-03-08T02:30')).toBe(expected);
  });

  it('formats numeric next-run instants including epoch zero', () => {
    vi.spyOn(Date, 'now').mockReturnValue(0);
    expect(fmtNextRun(0)).toBe('now');
    expect(fmtNextRun(120_000)).toBe('in 2m');
    expect(fmtNextRun(7_200_000)).toBe('in 2h');
  });
});
