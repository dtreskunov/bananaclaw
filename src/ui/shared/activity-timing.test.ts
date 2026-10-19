import { describe, expect, it } from 'vitest';
import { activityTimestamp, executionTime } from './activity-timing.js';

describe('activity timestamps', () => {
  it.each(['', ' ', '\n\t', 'unknown', 'Infinity', '-Infinity'])('does not treat %j as a usable start', (ts) => {
    expect(Number.isFinite(activityTimestamp(ts))).toBe(false);
  });

  describe('execution interval union', () => {
    it('handles empty, identical, nested and touching intervals without mutating the input', () => {
      expect(executionTime([])).toEqual({ ms: 0 });
      const spans = [
        [2000, 3000],
        [1000, 4000],
        [4000, 5000],
        [1000, 4000],
      ] as const;
      const before = JSON.stringify(spans);
      expect(executionTime(spans)).toEqual({ ms: 4000 });
      expect(JSON.stringify(spans)).toBe(before);
    });

    it('counts separated intervals but excludes idle gaps', () => {
      expect(
        executionTime([
          [4000, 6000],
          [1000, 2000],
        ]),
      ).toEqual({ ms: 3000 });
      expect(
        executionTime([
          [0, 0],
          [1000, 1000],
        ]),
      ).toEqual({ ms: 0 });
    });

    it('represents overlapping and separate live tails without double-counting finished work', () => {
      expect(
        executionTime([
          [1000, 4000],
          [2000, Infinity],
        ]),
      ).toEqual({ ms: 1000, since: 2000 });
      expect(
        executionTime([
          [1000, Infinity],
          [2000, 4000],
          [3000, Infinity],
        ]),
      ).toEqual({ ms: 0, since: 1000 });
      expect(
        executionTime([
          [1000, 2000],
          [4000, Infinity],
        ]),
      ).toEqual({ ms: 1000, since: 4000 });
      expect(executionTime([[0, Infinity]])).toEqual({ ms: 0, since: 0 });
    });

    it('agrees with clamping the live interval at the current time', () => {
      const live = executionTime([
        [1000, 4000],
        [2000, Infinity],
        [6000, Infinity],
      ]);
      for (const now of [5000, 7000, 10000]) {
        const finished = executionTime([
          [1000, 4000],
          [2000, now],
          [6000, Math.max(now, 6000)],
        ]);
        expect(live.ms + Math.max(0, now - live.since!)).toBe(finished.ms);
      }
    });
  });

  it.each([
    ['0', 0],
    ['1000', 1000],
    [' 1000 ', 1000],
  ] as const)('preserves the numeric timestamp %j', (ts, expected) => {
    expect(activityTimestamp(ts)).toBe(expected);
  });
});
