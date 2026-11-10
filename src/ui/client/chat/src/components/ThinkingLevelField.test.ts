import { toChildArray, isValidElement } from 'preact';
import { describe, expect, it, vi } from 'vitest';
import { ThinkingLevelField } from './ThinkingLevelField';
import { ThinkingLevelSlider } from './ThinkingLevelSlider';

const defaults = {
  provider: 'native',
  model: 'minimax/MiniMax-M3.1-Flash',
  value: null,
  defaultEffort: null,
  busy: false,
  onChange: vi.fn(),
};

function render(overrides: Partial<Parameters<typeof ThinkingLevelField>[0]> = {}) {
  const field = ThinkingLevelField({ ...defaults, ...overrides });
  const children = toChildArray(field.props.children);
  return { field, children, slider: field.props.children[0] };
}

describe('ThinkingLevelField', () => {
  it('uses the shared slider for the agent-wide default and retains restart guidance', () => {
    const onChange = vi.fn();
    const { field, slider } = render({ onChange, defaultEffort: 'high' });
    expect(field.props.title).toContain('Agent-wide');
    expect(field.props.title).toContain('restart');
    expect(slider.type).toBe(ThinkingLevelSlider);
    expect(slider.props).toMatchObject({
      levels: ['low', 'medium', 'high', 'xhigh', 'max'],
      value: 'high',
      disabled: false,
    });
    slider.props.onChange('low');
    expect(onChange.mock.calls).toEqual([['low']]);
  });

  it('shows model defaults without writing an agent override on mount and keeps saved effort first', () => {
    const onChange = vi.fn();
    expect(render({ onChange }).slider.props.value).toBe('max');
    expect(onChange).not.toHaveBeenCalled();
    expect(render({ defaultEffort: 'medium' }).slider.props.value).toBe('medium');
    expect(render({ defaultEffort: 'medium', value: 'low' }).slider.props.value).toBe('low');
  });

  it('preserves unsupported saved values with a warning instead of silently clearing them', () => {
    const { slider, children } = render({ model: 'local/unknown', value: 'high' });
    expect(slider.props).toMatchObject({ levels: [], value: 'high' });
    expect(ThinkingLevelSlider(slider.props).props.children[1].props.disabled).toBe(true);
    expect(
      children.some((child) => isValidElement(child) && 'role' in child.props && child.props.role === 'alert'),
    ).toBe(true);
  });

  it('passes busy state and inherited invalid defaults through with an explicit error', () => {
    const { slider, children } = render({ busy: true, defaultEffort: 'none' });
    expect(slider.props.disabled).toBe(true);
    expect(
      children.some((child) => isValidElement(child) && 'role' in child.props && child.props.role === 'alert'),
    ).toBe(true);
  });
});
