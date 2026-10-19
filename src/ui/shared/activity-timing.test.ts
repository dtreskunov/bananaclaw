import { describe, expect, it } from 'vitest';
import { activityTimestamp } from './activity-timing.js';

describe('activity timestamps', () => {
  it.each(['', ' ', '\n\t', 'unknown', 'Infinity', '-Infinity'])('does not treat %j as a usable start', (ts) => {
    expect(Number.isFinite(activityTimestamp(ts))).toBe(false);
  });

  it.each([
    ['0', 0],
    ['1000', 1000],
    [' 1000 ', 1000],
  ] as const)('preserves the numeric timestamp %j', (ts, expected) => {
    expect(activityTimestamp(ts)).toBe(expected);
  });
});
