import { afterEach, describe, expect, it, vi } from 'vitest';
import { attachScrollEdges, scrollEdges } from './src/scroll-edges';

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

  it('does not read geometry for disabled axes', () => {
    const horizontal = { ...metrics };
    for (const key of ['scrollTop', 'clientHeight', 'scrollHeight']) {
      Object.defineProperty(horizontal, key, {
        get: () => {
          throw new Error(`Unexpected ${key} read`);
        },
      });
    }
    expect(scrollEdges(horizontal, { vertical: false })).toEqual({
      left: false,
      right: true,
      top: false,
      bottom: false,
    });
    const vertical = { ...metrics };
    for (const key of ['scrollLeft', 'clientWidth', 'scrollWidth']) {
      Object.defineProperty(vertical, key, {
        get: () => {
          throw new Error(`Unexpected ${key} read`);
        },
      });
    }
    expect(scrollEdges(vertical, { horizontal: false })).toEqual({
      left: false,
      right: false,
      top: false,
      bottom: true,
    });
  });
});

function mount(axes = {}) {
  const toggle = vi.fn();
  const remove = vi.fn();
  const element = Object.assign(new EventTarget(), metrics, {
    classList: { toggle, remove },
    children: [],
  }) as HTMLElement;
  let resizeUpdate = () => {};
  let mutationUpdate = () => {};
  const resizeDisconnect = vi.fn();
  const mutationDisconnect = vi.fn();
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(update: () => void) {
        resizeUpdate = update;
      }
      observe() {}
      disconnect = resizeDisconnect;
    },
  );
  vi.stubGlobal(
    'MutationObserver',
    class {
      constructor(update: () => void) {
        mutationUpdate = update;
      }
      observe() {}
      disconnect = mutationDisconnect;
    },
  );
  const update = vi.fn();
  const dispose = attachScrollEdges(element, axes, update);
  return {
    element,
    toggle,
    remove,
    update,
    dispose,
    resizeDisconnect,
    mutationDisconnect,
    resize: () => resizeUpdate(),
    mutate: () => mutationUpdate(),
    scroll: () => element.dispatchEvent(new Event('scroll')),
  };
}

afterEach(() => vi.unstubAllGlobals());

describe('scroll edge listeners', () => {
  it('does no DOM writes or callbacks for 120 scroll events with unchanged edges', () => {
    const { element, toggle, update, scroll } = mount({ horizontal: false });
    expect(toggle).toHaveBeenCalledTimes(4);
    expect(update).toHaveBeenCalledExactlyOnceWith({
      left: false,
      right: false,
      top: false,
      bottom: true,
    });
    element.scrollTop = 20;
    scroll();
    toggle.mockClear();
    update.mockClear();
    for (let offset = 21; offset <= 140; offset++) {
      element.scrollTop = offset;
      scroll();
    }
    expect(toggle).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });

  it('changes only the affected classes when crossing an edge', () => {
    const { element, toggle, update, scroll } = mount({ horizontal: false });
    toggle.mockClear();
    update.mockClear();
    for (const offset of [2, 200, 400, 0]) {
      element.scrollTop = offset;
      scroll();
    }
    expect(toggle.mock.calls).toEqual([
      ['scroll-fade-top', true],
      ['scroll-fade-bottom', false],
      ['scroll-fade-top', false],
      ['scroll-fade-bottom', true],
    ]);
    expect(update).toHaveBeenCalledTimes(3);
    expect(update).toHaveBeenLastCalledWith({
      left: false,
      right: false,
      top: false,
      bottom: true,
    });
  });

  it('preserves horizontal-only tables and two-axis scrollers', () => {
    for (const axes of [{ vertical: false }, {}]) {
      const { element, toggle, update, scroll } = mount(axes);
      toggle.mockClear();
      update.mockClear();
      element.scrollLeft = 320;
      scroll();
      expect(toggle.mock.calls).toEqual([
        ['scroll-fade-left', true],
        ['scroll-fade-right', false],
      ]);
      expect(update).toHaveBeenLastCalledWith({
        left: true,
        right: false,
        top: false,
        bottom: !('vertical' in axes),
      });
    }
  });

  it('updates on resize and content changes even without scrolling', () => {
    const { element, toggle, update, resize, mutate } = mount({ horizontal: false });
    toggle.mockClear();
    update.mockClear();
    Object.defineProperty(element, 'scrollHeight', { value: element.clientHeight, configurable: true });
    resize();
    expect(toggle).toHaveBeenCalledExactlyOnceWith('scroll-fade-bottom', false);
    expect(update).toHaveBeenCalledExactlyOnceWith({
      left: false,
      right: false,
      top: false,
      bottom: false,
    });
    toggle.mockClear();
    update.mockClear();
    resize();
    mutate();
    expect(toggle).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
    Object.defineProperty(element, 'scrollHeight', { value: 800 });
    mutate();
    expect(toggle).toHaveBeenCalledExactlyOnceWith('scroll-fade-bottom', true);
    expect(update).toHaveBeenCalledExactlyOnceWith({
      left: false,
      right: false,
      top: false,
      bottom: true,
    });
  });

  it('removes listeners, observers, and fade classes on cleanup', () => {
    const { element, toggle, remove, update, dispose, resizeDisconnect, mutationDisconnect, scroll } = mount();
    resizeDisconnect.mockClear();
    toggle.mockClear();
    update.mockClear();
    dispose();
    expect(resizeDisconnect).toHaveBeenCalledOnce();
    expect(mutationDisconnect).toHaveBeenCalledOnce();
    expect(remove.mock.calls).toEqual([
      ['scroll-fade-left'],
      ['scroll-fade-right'],
      ['scroll-fade-top'],
      ['scroll-fade-bottom'],
    ]);
    element.scrollTop = 400;
    scroll();
    expect(toggle).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });
});
