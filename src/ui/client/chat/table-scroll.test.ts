import { describe, expect, it } from 'vitest';
import { tableScrollEdges } from './src/table-scroll';

describe('tableScrollEdges', () => {
  it('shows no fades when the table fits', () => {
    expect(tableScrollEdges(0, 320, 320)).toEqual({ left: false, right: false });
  });

  it('tracks the hidden edges throughout horizontal scrolling', () => {
    expect(tableScrollEdges(0, 320, 640)).toEqual({ left: false, right: true });
    expect(tableScrollEdges(120, 320, 640)).toEqual({ left: true, right: true });
    expect(tableScrollEdges(320, 320, 640)).toEqual({ left: true, right: false });
  });

  it('ignores subpixel noise at either edge', () => {
    expect(tableScrollEdges(0.5, 320, 640)).toEqual({ left: false, right: true });
    expect(tableScrollEdges(319.5, 320, 640)).toEqual({ left: true, right: false });
  });
});
