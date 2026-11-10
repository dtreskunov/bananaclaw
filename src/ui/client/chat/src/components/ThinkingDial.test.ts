import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ThinkingDial } from './ThinkingDial';

const hooks = vi.hoisted(() => ({
  open: false,
  effects: [] as Array<() => void | (() => void)>,
  root: { current: null as null | { querySelectorAll: () => unknown[] } },
  trigger: { current: null as null | { focus: () => void } },
  cursor: 0,
}));
vi.mock('preact/hooks', () => ({
  useState: () => [
    hooks.open,
    (next: boolean | ((current: boolean) => boolean)) => {
      hooks.open = typeof next === 'function' ? next(hooks.open) : next;
    },
  ],
  useRef: () => (hooks.cursor++ === 0 ? hooks.root : hooks.trigger),
  useEffect: (effect: () => void | (() => void)) => hooks.effects.push(effect),
}));

const props = {
  levels: ['low', 'medium', 'high', 'xhigh', 'max'],
  defaultLevel: 'medium',
  value: undefined as string | undefined,
  disabled: false,
  onChange: vi.fn(),
};
function draw(overrides: Partial<typeof props> = {}) {
  hooks.cursor = 0;
  const tree = ThinkingDial({ ...props, ...overrides });
  const [trigger, menu] = tree.props.children;
  return { tree, trigger, menu };
}
beforeEach(() => {
  hooks.open = false;
  hooks.root.current = null;
  hooks.trigger.current = { focus: vi.fn() };
  props.onChange.mockClear();
});

describe('thinking dial', () => {
  it('is an icon-only menu trigger with a readable default tooltip', () => {
    const { trigger, menu } = draw();
    expect(trigger.props.type).toBe('button');
    expect(trigger.props['aria-label']).toBe('Thinking: Agent default (Medium)');
    expect(trigger.props['aria-haspopup']).toBe('menu');
    expect(trigger.props.children.type).toBe('svg');
    expect(menu).toBeNull();
    trigger.props.onClick();
    expect(draw().trigger.props['aria-expanded']).toBe(true);
  });

  it('shows only supported levels and emits an explicit selection or Default', () => {
    hooks.open = true;
    const { menu } = draw({ value: 'high' });
    const buttons = menu.props.children;
    expect(buttons.map((button: { props: { children: string } }) => button.props.children)).toEqual([
      'Agent default',
      'Low',
      'Medium',
      'High',
      'Extra high',
      'Maximum',
    ]);
    expect(buttons[3].props['aria-checked']).toBe(true);
    buttons[1].props.onClick();
    expect(props.onChange).toHaveBeenLastCalledWith('low');
    expect(hooks.open).toBe(false);
    hooks.open = true;
    draw().menu.props.children[0].props.onClick();
    expect(props.onChange).toHaveBeenLastCalledWith(undefined);
  });

  it('supports keyboard opening, arrow navigation and Escape focus restoration', () => {
    const preventDefault = vi.fn();
    draw().trigger.props.onKeyDown({ key: 'ArrowDown', preventDefault, stopPropagation: vi.fn() });
    expect(hooks.open).toBe(true);
    const buttons = [{ focus: vi.fn() }, { focus: vi.fn() }];
    hooks.root.current = { querySelectorAll: () => buttons };
    vi.stubGlobal('document', { activeElement: buttons[0] });
    draw().tree.props.onKeyDown({ key: 'ArrowDown', preventDefault });
    expect(buttons[1].focus).toHaveBeenCalledOnce();
    draw().tree.props.onKeyDown({ key: 'Escape', preventDefault });
    expect(hooks.open).toBe(false);
    expect(hooks.trigger.current?.focus).toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('uses accent only for overrides and suppresses the menu while disabled', () => {
    hooks.open = true;
    const { trigger, menu } = draw({ value: 'high', disabled: true });
    expect(trigger.props.class).toContain('overridden');
    expect(trigger.props.title).toBe('Thinking: High · next message');
    expect(trigger.props.disabled).toBe(true);
    expect(trigger.props['aria-expanded']).toBe(false);
    expect(menu).toBeNull();
  });

  it('lets the user clear an override after switching to an unsupported model', () => {
    hooks.open = true;
    const { trigger, menu } = draw({ value: 'high', levels: [] });
    expect(trigger.props.title).toContain('(unsupported)');
    expect(menu.props.children).toHaveLength(1);
    menu.props.children[0].props.onClick();
    expect(props.onChange).toHaveBeenLastCalledWith(undefined);
  });
});
