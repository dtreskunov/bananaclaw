import { afterEach, describe, expect, it, vi } from 'vitest';
import { attachDensityReflow, captureReadingPosition } from './density-reflow';
import { DEFAULT_APPEARANCE, type AppearanceController } from './appearance';

class Viewport extends EventTarget {
  scrollTop = 400;
  scrollHeight = 2000;
  clientHeight = 500;
  clientTop = 1;
  top = 50;
  starts = [0, 300, 600, 900];
  sizes = [280, 280, 280, 280];
  children = this.starts.map((_, index) => ({
    getBoundingClientRect: () => ({
      top: this.top + this.clientTop + this.starts[index] - this.scrollTop,
      bottom: this.top + this.clientTop + this.starts[index] + this.sizes[index] - this.scrollTop,
    }),
  }));
  getBoundingClientRect() {
    return { top: this.top };
  }
}

afterEach(() => vi.unstubAllGlobals());

describe('density reading position', () => {
  it('preserves the visible message offset rather than raw scrollTop through reflow', () => {
    const viewport = new Viewport();
    const restore = captureReadingPosition(viewport, false);
    viewport.starts = [0, 450, 850, 1250];
    viewport.scrollHeight = 2500;
    viewport.scrollTop = 420;
    viewport.top = 80;
    restore();
    expect(viewport.scrollTop).toBe(550);
    expect(viewport.children[1].getBoundingClientRect().top - viewport.top - viewport.clientTop).toBe(-100);
    restore();
    expect(viewport.scrollTop).toBe(550);
  });

  it.each([3000, 1300, 300])('keeps bottom-follow when content height becomes %i', (height) => {
    const viewport = new Viewport();
    viewport.scrollTop = 1500;
    const restore = captureReadingPosition(viewport, true);
    viewport.scrollHeight = height;
    restore();
    expect(viewport.scrollTop).toBe(Math.max(0, height - viewport.clientHeight));
  });

  it('preserves history through compaction and clamps when it no longer overflows', () => {
    const viewport = new Viewport();
    const restore = captureReadingPosition(viewport, false);
    viewport.starts = [0, 180, 400, 600];
    restore();
    expect(viewport.scrollTop).toBe(280);
    viewport.scrollHeight = 400;
    restore();
    expect(viewport.scrollTop).toBe(0);
  });

  it('handles an empty log or removed anchor without inventing a bottom jump', () => {
    const viewport = new Viewport();
    const restore = captureReadingPosition(viewport, false);
    viewport.children = [];
    viewport.scrollTop = 900;
    restore();
    expect(viewport.scrollTop).toBe(400);
    const emptyRestore = captureReadingPosition(viewport, false);
    viewport.scrollTop = 700;
    emptyRestore();
    expect(viewport.scrollTop).toBe(400);
  });
});

function mount() {
  const viewport = new Viewport();
  const frames = new Map<number, FrameRequestCallback>();
  let nextFrame = 0;
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    frames.set(++nextFrame, callback);
    return nextFrame;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
  let capture: (() => () => void) | null = null;
  const controller: AppearanceController = {
    getSnapshot: () => ({ preferences: DEFAULT_APPEARANCE, resolvedMode: 'light', error: null }),
    setPreferences: () => {},
    subscribe: () => () => {},
    beforeDensityChange: (listener) => {
      capture = listener;
      return () => {
        capture = null;
      };
    },
    dispose: () => {},
  };
  const beforeReflow = vi.fn();
  const afterReflow = vi.fn();
  const followingBottom = vi.fn(() => false);
  const dispose = attachDensityReflow(controller, viewport, { beforeReflow, afterReflow, followingBottom });
  return {
    viewport,
    frames,
    beforeReflow,
    afterReflow,
    followingBottom,
    dispose,
    change() {
      if (!capture) throw new Error('Density listener is not attached');
      const apply = capture();
      viewport.starts = [0, 450, 850, 1250];
      viewport.scrollHeight = 2500;
      apply();
    },
    flushFrame() {
      const pending = Array.from(frames.values());
      frames.clear();
      for (const callback of pending) callback(0);
    },
    attached: () => capture !== null,
  };
}

describe('density reflow lifecycle', () => {
  it('restores immediately and after composer reflow without enabling bottom-follow', () => {
    const log = mount();
    log.change();
    expect(log.beforeReflow).toHaveBeenCalledOnce();
    expect(log.afterReflow).not.toHaveBeenCalled();
    expect(log.viewport.scrollTop).toBe(550);
    log.viewport.top = 30;
    log.viewport.scrollTop = 580;
    log.flushFrame();
    expect(log.viewport.scrollTop).toBe(550);
    expect(log.afterReflow).toHaveBeenCalledOnce();
    log.dispose();
  });

  it('keeps following during a streaming/composer layout change', () => {
    const log = mount();
    log.followingBottom.mockReturnValue(true);
    log.change();
    expect(log.viewport.scrollTop).toBe(2000);
    log.viewport.clientHeight = 440;
    log.viewport.scrollHeight = 2700;
    log.flushFrame();
    expect(log.viewport.scrollTop).toBe(2260);
    log.dispose();
  });

  it.each(['wheel', 'touchmove', 'pointerdown', 'keydown'])('does not override new %s input', (input) => {
    const log = mount();
    log.change();
    log.viewport.dispatchEvent(new Event(input));
    log.viewport.scrollTop = 800;
    log.flushFrame();
    expect(log.viewport.scrollTop).toBe(800);
    expect(log.afterReflow).toHaveBeenCalledOnce();
    log.dispose();
  });

  it('cancels old frames on rapid toggles and detaches on thread change', () => {
    const log = mount();
    log.change();
    log.change();
    expect(log.frames.size).toBe(1);
    expect(log.beforeReflow).toHaveBeenCalledTimes(2);
    expect(log.afterReflow).toHaveBeenCalledOnce();
    log.dispose();
    expect(log.frames.size).toBe(0);
    expect(log.attached()).toBe(false);
    expect(log.afterReflow).toHaveBeenCalledTimes(2);
    log.viewport.dispatchEvent(new Event('wheel'));
    expect(log.afterReflow).toHaveBeenCalledTimes(2);
  });
});
