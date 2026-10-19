import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { FilePreviewDialog } from './FilePreviewDialog';
import { MobileDialog } from './MobileDialog';

class TestDialog {
  open = true;
  modal = false;
  close = vi.fn(() => {
    this.open = false;
    this.modal = false;
  });
  show = vi.fn(() => {
    this.open = true;
  });
  showModal = vi.fn(() => {
    if (this.open) throw new Error('Nonmodal dialog must be closed before showModal');
    this.open = true;
    this.modal = true;
  });
  matches(selector: string) {
    return selector === ':modal' && this.modal;
  }
}

class FocusTarget {
  isConnected = true;
  focus = vi.fn();
}

const hooks = vi.hoisted(() => ({
  dialog: { current: null as TestDialog | null },
  opener: { current: null as FocusTarget | null },
  refs: 0,
  layoutIndex: 0,
  dependencies: [] as unknown[][],
  effects: [] as (() => void | (() => void))[],
  back: vi.fn(),
}));
vi.mock('preact/hooks', () => ({
  useRef: () => (hooks.refs++ === 0 ? hooks.dialog : hooks.opener),
  useLayoutEffect: (effect: () => void | (() => void), deps: unknown[]) => {
    const index = hooks.layoutIndex++;
    if (!hooks.dependencies[index] || deps.some((value, i) => value !== hooks.dependencies[index][i])) {
      hooks.dependencies[index] = deps;
      hooks.effects.push(effect);
    }
  },
}));
vi.mock('../modalBackButton', () => ({ useBackButtonCloses: hooks.back }));

let focus: FocusTarget;
const onClose = vi.fn();
const cleanups: (() => void)[] = [];
function render(expanded: boolean) {
  hooks.refs = 0;
  hooks.layoutIndex = 0;
  const node = FilePreviewDialog({ expanded, title: 'report.md', onClose, children: 'Same preview' });
  for (const effect of hooks.effects.splice(0)) {
    const dispose = effect();
    if (dispose) cleanups.push(dispose);
  }
  return node;
}

beforeEach(() => {
  hooks.dialog.current = new TestDialog();
  hooks.opener.current = null;
  hooks.dependencies = [];
  hooks.effects = [];
  hooks.back.mockReset();
  onClose.mockReset();
  focus = new FocusTarget();
  vi.stubGlobal('HTMLElement', FocusTarget);
  vi.stubGlobal('document', { activeElement: focus });
});
afterEach(() => {
  cleanups.splice(0).forEach((dispose) => dispose());
  vi.unstubAllGlobals();
});

describe('persistent fullscreen file preview', () => {
  it('keeps the inline preview open and uses the shared dialog chrome without remounting its children', () => {
    const inline = render(false);
    expect(inline.type).toBe('dialog');
    expect(inline.props.open).toBe(true);
    expect(inline.props.role).toBe('presentation');
    expect(hooks.dialog.current?.showModal).not.toHaveBeenCalled();
    const expanded = render(true);
    expect(expanded.type).toBe(inline.type);
    expect(expanded.props.children.type).toBe(MobileDialog);
    expect(expanded.props.children.props.children).toBe(inline.props.children.props.children);
    expect(expanded.props.children.props.role).toBe('presentation');
    expect(expanded.props.role).toBe('dialog');
    expect(expanded.props['aria-modal']).toBe('true');
    expect(expanded.props['aria-label']).toBe('Full screen preview: report.md');
  });

  it('switches native modality and restores the opener without scrolling on collapse', () => {
    render(false);
    render(true);
    expect(hooks.dialog.current?.close).toHaveBeenCalledOnce();
    expect(hooks.dialog.current?.showModal).toHaveBeenCalledOnce();
    render(false);
    expect(hooks.dialog.current?.close).toHaveBeenCalledTimes(2);
    expect(hooks.dialog.current?.show).toHaveBeenCalledOnce();
    expect(focus.focus).toHaveBeenCalledWith({ preventScroll: true });
    expect(hooks.back).toHaveBeenLastCalledWith(false, onClose);
  });

  it('does not focus an opener removed by file navigation', () => {
    render(true);
    focus.isConnected = false;
    render(false);
    expect(focus.focus).not.toHaveBeenCalled();
  });

  it('routes native Escape to collapsing the preview rather than closing the file', () => {
    const node = render(true);
    const event = { preventDefault: vi.fn(), stopPropagation: vi.fn() };
    node.props.onCancel(event);
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(event.stopPropagation).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledOnce();
    expect(hooks.back).toHaveBeenCalledWith(true, onClose);
  });

  it('keeps modal pointer and wheel events out of the sidebar without changing inline events', () => {
    for (const expanded of [false, true]) {
      const node = render(expanded);
      for (const name of ['onClick', 'onWheel', 'onTouchMove', 'onPointerDown'] as const) {
        const stopPropagation = vi.fn();
        node.props[name]({ stopPropagation });
        expect(stopPropagation).toHaveBeenCalledTimes(expanded ? 1 : 0);
      }
    }
  });
});
