import { describe, expect, it } from 'vitest';
import { scrollEdges } from './src/scroll-edges';

const metrics = {
  scrollLeft: 0,
  scrollTop: 0,
  clientWidth: 320,
  clientHeight: 200,
  scrollWidth: 640,
  scrollHeight: 600,
};

describe('scroll edge fades', () => {
  it('fades only edges with scrollable content beyond them', () => {
    expect(scrollEdges(metrics)).toEqual({ left: false, right: true, top: false, bottom: true });
    expect(scrollEdges({ ...metrics, scrollLeft: 120, scrollTop: 100 })).toEqual({
      left: true,
      right: true,
      top: true,
      bottom: true,
    });
    expect(scrollEdges({ ...metrics, scrollLeft: 320, scrollTop: 400 })).toEqual({
      left: true,
      right: false,
      top: true,
      bottom: false,
    });
  });

  it('does not add fades to content that fits or at subpixel boundaries', () => {
    expect(scrollEdges({ ...metrics, scrollWidth: 320, scrollHeight: 200 })).toEqual({
      left: false,
      right: false,
      top: false,
      bottom: false,
    });
    expect(scrollEdges({ ...metrics, scrollLeft: 319.5, scrollTop: 399.5 })).toEqual({
      left: true,
      right: false,
      top: true,
      bottom: false,
    });
  });

  it('preserves horizontal-only table behavior', () => {
    expect(scrollEdges(metrics, { vertical: false })).toEqual({ left: false, right: true, top: false, bottom: false });
  });
});
