import { describe, expect, it } from 'vitest';
import { formatStopwatch } from './duration-format';

describe('formatStopwatch', () => {
  it('shows truncated tenths below ten seconds, then whole units', () => {
    expect(formatStopwatch(0)).toBe('0.0s');
    expect(formatStopwatch(1290)).toBe('1.2s');
    expect(formatStopwatch(9999)).toBe('9.9s');
    expect(formatStopwatch(10_000)).toBe('10s');
    expect(formatStopwatch(795_900)).toBe('13m 15s');
    expect(formatStopwatch(3_725_000)).toBe('1h 2m');
  });

  it('uses whole seconds throughout when coarse', () => {
    expect(formatStopwatch(1290, false)).toBe('1s');
    expect(formatStopwatch(-5, false)).toBe('0s');
  });
});
