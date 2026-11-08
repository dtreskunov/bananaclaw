import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useBackButtonCloses } from './modalBackButton';

const hooks = vi.hoisted(() => ({
  refs: [] as { current: unknown }[],
  cursor: 0,
  index: 0,
  deps: [] as unknown[][],
  effects: [] as { index: number; effect: () => void | (() => void) }[],
}));
vi.mock('preact/hooks', () => ({
  useRef: (value: unknown) => (hooks.refs[hooks.cursor++] ??= { current: value }),
  useLayoutEffect: (effect: () => void | (() => void), deps: unknown[]) => {
    const index = hooks.index++;
    if (!hooks.deps[index] || deps.some((dep, i) => dep !== hooks.deps[index][i])) {
      hooks.deps[index] = deps;
      hooks.effects.push({ index, effect });
    }
  },
}));
let windowEvents: EventTarget;
let history: { state: object; pushState: ReturnType<typeof vi.fn>; back: ReturnType<typeof vi.fn> };
let disposers: ((() => void) | undefined)[];
function render(open: boolean, onClose: () => void, afterClose?: () => void) {
  hooks.cursor = 0;
  hooks.index = 0;
  useBackButtonCloses(open, onClose, afterClose);
  for (const { index, effect } of hooks.effects.splice(0)) {
    disposers[index]?.();
    disposers[index] = effect() || undefined;
  }
}
beforeEach(() => {
  hooks.refs = [];
  hooks.deps = [];
  hooks.effects = [];
  disposers = [];
  windowEvents = new EventTarget();
  history = { state: {}, pushState: vi.fn(), back: vi.fn() };
  history.pushState.mockImplementation((state: object) => {
    history.state = state;
  });
  vi.stubGlobal('window', windowEvents);
  vi.stubGlobal('history', history);
  vi.stubGlobal('location', { href: 'https://example.test/ui/chat/#thread' });
});
afterEach(() => {
  disposers.forEach((dispose) => dispose?.());
  vi.unstubAllGlobals();
});
describe('modal browser history', () => {
  it('pushes its entry before paint and does not push again for live updates', () => {
    render(true, vi.fn());
    render(true, vi.fn());
    expect(history.pushState).toHaveBeenCalledExactlyOnceWith(
      { __modal_back__: true },
      '',
      'https://example.test/ui/chat/#thread',
    );
  });
  it('uses the latest close callback after paging rather than the opening message callback', () => {
    const first = vi.fn();
    const latest = vi.fn();
    render(true, first);
    render(true, latest);
    windowEvents.dispatchEvent(new Event('popstate'));
    expect(first).not.toHaveBeenCalled();
    expect(latest).toHaveBeenCalledOnce();
  });
  it('waits for its history entry to be consumed before handing off to another workflow', () => {
    const afterClose = vi.fn();
    render(false, vi.fn(), afterClose);
    expect(afterClose).not.toHaveBeenCalled();
    render(true, vi.fn(), afterClose);
    render(false, vi.fn(), afterClose);
    expect(history.back).toHaveBeenCalledOnce();
    expect(afterClose).not.toHaveBeenCalled();
    windowEvents.dispatchEvent(new Event('popstate'));
    expect(afterClose).toHaveBeenCalledOnce();
  });
  it('does not pop a second entry after Browser Back and runs handoff after closing effects', async () => {
    const afterClose = vi.fn();
    render(true, vi.fn(), afterClose);
    windowEvents.dispatchEvent(new Event('popstate'));
    render(false, vi.fn(), afterClose);
    expect(history.back).not.toHaveBeenCalled();
    expect(afterClose).not.toHaveBeenCalled();
    await Promise.resolve();
    expect(afterClose).toHaveBeenCalledOnce();
  });
  it('consumes its own entry when the modal unmounts while open', () => {
    render(true, vi.fn());
    disposers.forEach((dispose) => dispose?.());
    expect(history.back).toHaveBeenCalledOnce();
  });
  it('does not pop an unrelated entry created while the modal was open', async () => {
    const afterClose = vi.fn();
    render(true, vi.fn(), afterClose);
    history.state = {};
    render(false, vi.fn(), afterClose);
    await Promise.resolve();
    expect(history.back).not.toHaveBeenCalled();
    expect(afterClose).toHaveBeenCalledOnce();
  });
});
