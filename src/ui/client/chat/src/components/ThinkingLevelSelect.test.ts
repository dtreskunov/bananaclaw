import { toChildArray, isValidElement, type ComponentChild, type ComponentChildren } from 'preact';
import { describe, expect, it, vi } from 'vitest';
import { ThinkingLevelSelect } from './ThinkingLevelSelect';

const defaults = {
  provider: 'native',
  model: 'minimax/MiniMax-M3.1-Flash',
  value: null,
  defaultEffort: null,
  busy: false,
  onChange: vi.fn(),
};

function render(overrides: Partial<Parameters<typeof ThinkingLevelSelect>[0]> = {}) {
  const field = ThinkingLevelSelect({ ...defaults, ...overrides });
  const children = toChildArray(field.props.children.props.children);
  const select = children.find((child) => isValidElement(child) && child.type === 'select');
  if (!isValidElement(select)) throw new Error('Missing thinking-level select');
  const selectProps = elementProps(select);
  const options = toChildArray(selectProps.children).flatMap((child) =>
    isValidElement(child)
      ? [{ value: elementProps(child).value, text: toChildArray(elementProps(child).children).join('') }]
      : [],
  );
  return { field, select: selectProps, options, children };
}

function elementProps(child: ComponentChild): { [key: string]: unknown; children?: ComponentChildren } {
  return isValidElement(child) ? child.props : {};
}

describe('ThinkingLevelSelect', () => {
  it('emits selected levels and clears the override for Default', () => {
    const onChange = vi.fn();
    const { select } = render({ onChange });
    if (typeof select.onChange !== 'function') throw new Error('Missing change handler');
    for (const value of ['high', 'max', '']) select.onChange({ currentTarget: { value } });
    expect(onChange.mock.calls).toEqual([['high'], ['max'], [null]]);
  });

  it('offers the five MiniMax levels without an unsupported Off option', () => {
    const { field, select, options } = render();
    expect(field.props.label).toBe('Thinking level');
    expect(field.props.info).toContain('Agent-wide');
    expect(field.props.info).toContain('restart');
    expect(select.disabled).toBe(false);
    expect(options.map((option) => option.value)).toEqual(['', 'low', 'medium', 'high', 'xhigh', 'max']);
  });

  it('offers Off only for reviewed models and labels inheritance clearly', () => {
    const { options } = render({ model: 'openai/gpt-5.1', defaultEffort: 'high' });
    expect(options[0].text).toBe('Default (inherited: High)');
    expect(options.find((option) => option.value === 'none')?.text).toBe('Off');
  });

  it('preserves unsupported saved levels visibly and lets the user choose Default', () => {
    const { select, options, children } = render({ model: 'local/unknown', value: 'high' });
    expect(select.value).toBe('high');
    expect(select.disabled).toBe(false);
    expect(options.map((option) => option.value)).toEqual(['', 'high']);
    expect(children.some((child) => elementProps(child).role === 'alert')).toBe(true);
  });

  it('disables controls for unknown models and while saving', () => {
    expect(render({ model: 'local/unknown' }).select.disabled).toBe(true);
    expect(render({ busy: true }).select.disabled).toBe(true);
  });

  it('shows inherited unsupported effort as an error instead of silently ignoring it', () => {
    const { children } = render({ defaultEffort: 'none' });
    expect(children.some((child) => elementProps(child).role === 'alert')).toBe(true);
  });
});
