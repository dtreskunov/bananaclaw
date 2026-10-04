import { describe, expect, it } from 'vitest';
import { activityDetailsScrollTop, latestActivityScrollTop } from './src/activity-trace-scroll';

describe('revealing the latest activity header', () => {
  it('scrolls a long trace to its latest header with room for the bottom fade', () => {
    expect(latestActivityScrollTop(0, 850, 50, 200)).toBe(612);
  });

  describe('revealing current activity details', () => {
    it('shows the entire expanded row when it fits, with space for both fades', () => {
      expect(activityDetailsScrollTop(300, 230, 320, 50, 200)).toBe(382);
      expect(activityDetailsScrollTop(382, 148, 238, 50, 200)).toBe(382);
    });

    it('aligns oversized details at their beginning instead of hiding the header', () => {
      expect(activityDetailsScrollTop(300, 200, 700, 50, 200)).toBe(438);
      expect(activityDetailsScrollTop(438, 62, 562, 50, 200)).toBe(438);
    });

    it('keeps an already visible row stationary and reveals one above the viewport', () => {
      expect(activityDetailsScrollTop(300, 80, 220, 50, 200)).toBe(300);
      expect(activityDetailsScrollTop(300, 40, 130, 50, 200)).toBe(278);
      expect(activityDetailsScrollTop(0, 40, 130, 50, 200)).toBe(0);
    });
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
