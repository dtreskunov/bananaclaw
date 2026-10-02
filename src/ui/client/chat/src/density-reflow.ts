import type { AppearanceController } from './appearance';

interface ReadingAnchor {
  getBoundingClientRect(): { top: number; bottom: number };
}

interface ReadingViewport {
  scrollTop: number;
  readonly scrollHeight: number;
  readonly clientHeight: number;
  readonly clientTop: number;
  readonly children: ArrayLike<ReadingAnchor>;
  getBoundingClientRect(): { top: number };
}

export function captureReadingPosition(viewport: ReadingViewport, followingBottom: boolean): () => void {
  const top = () => viewport.getBoundingClientRect().top + viewport.clientTop;
  const viewportTop = top();
  const anchor = Array.from(viewport.children).find((child) => {
    const rect = child.getBoundingClientRect();
    return rect.bottom > viewportTop && rect.top < viewportTop + viewport.clientHeight;
  });
  const offset = anchor ? anchor.getBoundingClientRect().top - viewportTop : 0;
  const originalTop = viewport.scrollTop;
  return () => {
    const maximum = Math.max(0, viewport.scrollHeight - viewport.clientHeight);
    const next = followingBottom
      ? maximum
      : anchor && Array.from(viewport.children).includes(anchor)
        ? viewport.scrollTop + anchor.getBoundingClientRect().top - top() - offset
        : originalTop;
    viewport.scrollTop = Math.max(0, Math.min(maximum, next));
  };
}

interface DensityReflowOptions {
  followingBottom(): boolean;
  beforeReflow(): void;
  afterReflow(): void;
}

export function attachDensityReflow(
  controller: AppearanceController,
  viewport: ReadingViewport & EventTarget,
  options: DensityReflowOptions,
): () => void {
  let frame: number | null = null;
  const finish = () => {
    if (frame === null) return;
    cancelAnimationFrame(frame);
    frame = null;
    options.afterReflow();
  };
  const unsubscribe = controller.beforeDensityChange(() => {
    finish();
    const restore = captureReadingPosition(viewport, options.followingBottom());
    options.beforeReflow();
    return () => {
      restore();
      // Composer autosizing and reactive settings finish during this frame.
      frame = requestAnimationFrame(() => {
        restore();
        frame = null;
        options.afterReflow();
      });
    };
  });
  const inputs = ['wheel', 'touchmove', 'pointerdown', 'keydown'] as const;
  for (const name of inputs) viewport.addEventListener(name, finish, { passive: true });
  return () => {
    unsubscribe();
    finish();
    for (const name of inputs) viewport.removeEventListener(name, finish);
  };
}
