import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MobileDialog } from './MobileDialog';
import { ModalDialog } from './ModalDialog';

interface TestDialog {
  showModal(): void;
  close(): void;
  querySelector(): FocusTarget;
}

const hooks = vi.hoisted(() => ({
  dialog: null as TestDialog | null,
  effects: [] as (() => void | (() => void))[],
}));
vi.mock('preact/hooks', () => ({
  useRef: () => ({ current: hooks.dialog }),
  useLayoutEffect: (effect: () => void | (() => void)) => hooks.effects.push(effect),
}));

class FocusTarget {
  isConnected = true;
  parentElement: { closest: () => FocusTarget } | null = null;
  focus = vi.fn();
}

let initial: FocusTarget;
let opener: FocusTarget;
const close = vi.fn();
const showModal = vi.fn();
beforeEach(() => {
  hooks.effects = [];
  close.mockReset();
  showModal.mockReset();
  initial = new FocusTarget();
  opener = new FocusTarget();
  vi.stubGlobal('HTMLElement', FocusTarget);
  vi.stubGlobal('document', { body: {}, activeElement: opener });
  hooks.dialog = { showModal, close, querySelector: () => initial };
});
afterEach(() => vi.unstubAllGlobals());

describe('native modal dialog shell', () => {
  it('uses the browser modal lifecycle and restores focus before restoring the reading position', () => {
    const restore = vi.fn(() => expect(opener.focus).toHaveBeenCalledWith({ preventScroll: true }));
    const node = ModalDialog({
      title: 'Message',
      ariaLabel: 'Full message',
      onClose: vi.fn(),
      children: 'Body',
      initialFocus: '.message-reader-body',
      onAfterClose: restore,
    });
    expect(node.type).toBe('dialog');
    expect(node.props['aria-label']).toBe('Full message');
    expect(node.props.children.type).toBe(MobileDialog);
    expect(node.props.children.props.role).toBe('presentation');
    const dispose = hooks.effects[0]();
    expect(showModal).toHaveBeenCalledOnce();
    expect(initial.focus).toHaveBeenCalledWith({ preventScroll: true });
    expect(dispose).toBeTypeOf('function');
    if (typeof dispose === 'function') dispose();
    expect(close).toHaveBeenCalledOnce();
    expect(restore).toHaveBeenCalledOnce();
  });

  it('routes Escape only to the active modal and respects disabled closing', () => {
    const onClose = vi.fn();
    for (const closeDisabled of [false, true]) {
      const node = ModalDialog({ title: 'Message', onClose, closeDisabled, children: 'Body' });
      const event = { preventDefault: vi.fn(), stopPropagation: vi.fn() };
      node.props.onCancel(event);
      expect(event.preventDefault).toHaveBeenCalledOnce();
      expect(event.stopPropagation).toHaveBeenCalledOnce();
    }
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('does not focus an opener removed during navigation', () => {
    opener.isConnected = false;
    ModalDialog({ title: 'Message', onClose: vi.fn(), children: 'Body' });
    const dispose = hooks.effects[0]();
    if (typeof dispose === 'function') dispose();
    expect(opener.focus).not.toHaveBeenCalled();
  });

  it('keeps reader input out of the surrounding transcript navigation', () => {
    const node = ModalDialog({ title: 'Message', onClose: vi.fn(), children: 'Body' });
    for (const name of ['onClick', 'onKeyDown', 'onWheel', 'onTouchMove', 'onPointerDown'] as const) {
      const event = { stopPropagation: vi.fn() };
      node.props[name](event);
      expect(event.stopPropagation).toHaveBeenCalledOnce();
    }
  });

  it('returns focus to the transcript if resizing removed the need for the reader button', () => {
    const viewport = new FocusTarget();
    opener.parentElement = { closest: () => viewport };
    ModalDialog({ title: 'Message', onClose: vi.fn(), children: 'Body' });
    const dispose = hooks.effects[0]();
    vi.stubGlobal('document', { activeElement: initial });
    if (typeof dispose === 'function') dispose();
    expect(viewport.focus).toHaveBeenCalledWith({ preventScroll: true });
  });
});
