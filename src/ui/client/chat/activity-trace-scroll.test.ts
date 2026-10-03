import { describe, expect, it } from 'vitest';
import { latestActivityScrollTop } from './src/activity-trace-scroll';

describe('revealing the latest activity header', () => {
  it('scrolls a long trace to its latest header with room for the bottom fade', () => {
    expect(latestActivityScrollTop(0, 850, 50, 200)).toBe(612);
  });

  it('keeps the header visible even when its expanded details extend below the viewport', () => {
    expect(latestActivityScrollTop(500, 150, 50, 200)).toBe(412);
  });

  it('never scrolls above the beginning of a short trace', () => {
    expect(latestActivityScrollTop(0, 100, 50, 200)).toBe(0);
  });

  it('does not move a header already at the reveal position', () => {
    expect(latestActivityScrollTop(612, 238, 50, 200)).toBe(612);
  });
});
