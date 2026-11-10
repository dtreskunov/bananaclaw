import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ComposerPlusMenu } from './ComposerPlusMenu';
import { ThinkingLevelSlider } from './ThinkingLevelSlider';

const hooks = vi.hoisted(() => ({
  open: false,
  cursor: 0,
  root: { current: null },
  trigger: { current: { focus: vi.fn() } },
  effect: undefined as (() => void | (() => void)) | undefined,
  dependencies: [] as unknown[],
}));
vi.mock('preact/hooks', () => ({
  useState: () => [
    hooks.open,
    (next: boolean | ((current: boolean) => boolean)) => {
      hooks.open = typeof next === 'function' ? next(hooks.open) : next;
    },
  ],
  useRef: () => (hooks.cursor++ === 0 ? hooks.root : hooks.trigger),
  useEffect: (effect: () => void | (() => void), dependencies: unknown[]) => {
    hooks.effect = effect;
    hooks.dependencies = dependencies;
  },
}));

const thinking = {
  levels: ['low', 'medium', 'high'],
  value: 'medium',
  disabled: false,
  onChange: vi.fn(),
};
const defaults = {
  showRecordAudio: true,
  showQuickCapture: true,
  onUploadFile: vi.fn(),
  onQuickCapture: vi.fn(),
  onRecordAudio: vi.fn(),
  thinking,
};
function render(overrides: Partial<Parameters<typeof ComposerPlusMenu>[0]> = {}) {
  hooks.cursor = 0;
  const tree = ComposerPlusMenu({ ...defaults, ...overrides });
  return { tree, trigger: tree.props.children[0], panel: tree.props.children[1] };
}
beforeEach(() => {
  hooks.open = false;
  vi.clearAllMocks();
});
afterEach(() => vi.unstubAllGlobals());

describe('composer plus menu', () => {
  it('opens a mixed-controls popover rather than mislabelling a slider as a menu item', () => {
    const { trigger, panel } = render();
    expect(trigger.props['aria-haspopup']).toBe('dialog');
    expect(trigger.props['aria-label']).toBe('Add');
    expect(panel).toBeNull();
    trigger.props.onClick({ stopPropagation: vi.fn() });
    const opened = render();
    expect(opened.panel.props).toMatchObject({ role: 'dialog', 'aria-label': 'Add to message' });
    expect(opened.trigger.props['aria-expanded']).toBe(true);
  });

  it('puts the same thinking slider last, without closing the popover when tuning it', () => {
    hooks.open = true;
    const { panel } = render();
    const footer = panel.props.children.at(-1);
    expect(footer.props.class).toBe('composer-plus-thinking');
    expect(footer.props.title).toBe('Next message only');
    const slider = footer.props.children;
    expect(slider.type).toBe(ThinkingLevelSlider);
    expect(slider.props).toMatchObject(thinking);
    slider.props.onChange('high');
    expect(thinking.onChange).toHaveBeenCalledWith('high');
    expect(hooks.open).toBe(true);
  });

  it('keeps upload/capture actions working and closes after an action', () => {
    for (const [index, action] of [
      [0, defaults.onQuickCapture],
      [1, defaults.onUploadFile],
      [2, defaults.onRecordAudio],
    ] as const) {
      hooks.open = true;
      render().panel.props.children[index].props.onClick({ stopPropagation: vi.fn() });
      expect(action).toHaveBeenCalledOnce();
      expect(hooks.open).toBe(false);
    }
    expect(hooks.trigger.current.focus).toHaveBeenCalledTimes(3);
  });

  it('omits unsupported thinking controls and suppresses disabled popovers', () => {
    hooks.open = true;
    expect(render({ thinking: undefined }).panel.props.children.at(-1)).toBeNull();
    const disabled = render({ disabled: true });
    expect(disabled.panel).toBeNull();
    expect(disabled.trigger.props['aria-expanded']).toBe(false);
    expect(
      render({ thinking: { ...thinking, disabled: true } }).panel.props.children.at(-1).props.children.props.disabled,
    ).toBe(true);
  });

  it('uses actual visibility for document listeners and cleans them up when disabled', () => {
    const addEventListener = vi.fn(),
      removeEventListener = vi.fn();
    vi.stubGlobal('document', { addEventListener, removeEventListener });
    hooks.open = true;
    render();
    expect(hooks.dependencies).toEqual([true]);
    const cleanup = hooks.effect?.();
    expect(addEventListener).toHaveBeenCalledTimes(2);
    if (typeof cleanup !== 'function') throw new Error('Missing expanded popover cleanup');
    render({ disabled: true });
    expect(hooks.dependencies).toEqual([false]);
    cleanup();
    expect(removeEventListener.mock.calls).toEqual(addEventListener.mock.calls);
    expect(hooks.effect?.()).toBeUndefined();
    expect(addEventListener).toHaveBeenCalledTimes(2);
  });
});
