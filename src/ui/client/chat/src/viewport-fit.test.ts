import { describe, expect, it, vi } from 'vitest';
import { fitVisualViewport } from './viewport-fit';

describe('visual viewport fit', () => {
  it('shrinks for the mobile keyboard and expands back when it is dismissed', () => {
    const viewport = Object.assign(new EventTarget(), { height: 844 });
    const style = { setProperty: vi.fn() };
    const dispose = fitVisualViewport(viewport, style);
    expect(style.setProperty).toHaveBeenLastCalledWith('--app-height', '844px');
    viewport.height = 420;
    viewport.dispatchEvent(new Event('resize'));
    expect(style.setProperty).toHaveBeenLastCalledWith('--app-height', '420px');
    viewport.height = 844;
    viewport.dispatchEvent(new Event('resize'));
    expect(style.setProperty).toHaveBeenLastCalledWith('--app-height', '844px');
    viewport.height = 800;
    viewport.dispatchEvent(new Event('scroll'));
    expect(style.setProperty).toHaveBeenLastCalledWith('--app-height', '800px');
    dispose();
    viewport.dispatchEvent(new Event('resize'));
    expect(style.setProperty).toHaveBeenCalledTimes(4);
  });

  it('leaves the CSS viewport fallback intact when VisualViewport is unavailable', () => {
    const style = { setProperty: vi.fn() };
    fitVisualViewport(null, style)();
    expect(style.setProperty).not.toHaveBeenCalled();
  });
});
