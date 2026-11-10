import { describe, expect, it, vi } from 'vitest';
import { ThinkingLevelSlider, type ThinkingLevelSliderProps } from './ThinkingLevelSlider';

const props: ThinkingLevelSliderProps = {
  levels: ['low', 'medium', 'high', 'xhigh', 'max'],
  value: 'max',
  disabled: false,
  onChange: vi.fn(),
};

function render(overrides: Partial<ThinkingLevelSliderProps> = {}) {
  const slider = ThinkingLevelSlider({ ...props, ...overrides });
  const [heading, input] = slider.props.children;
  return { slider, input: input.props, caption: heading.props.children[1].props.children, heading };
}

describe('ThinkingLevelSlider', () => {
  it('shows only Thinking and the actual level, with no default stop or initialization write', () => {
    const onChange = vi.fn();
    const { input, caption, heading } = render({ onChange });
    expect(input).toMatchObject({ type: 'range', min: 0, max: 4, step: 1, value: 4, disabled: false });
    expect(input['aria-label']).toBe('Thinking');
    expect(input['aria-valuetext']).toBe('Maximum');
    expect(heading.props.children[0].props.children).toBe('Thinking');
    expect(caption).toBe('Maximum');
    expect(onChange).not.toHaveBeenCalled();
  });

  it('maps every stop to a real supported level, never null/default', () => {
    const onChange = vi.fn();
    const { input } = render({ onChange });
    for (let valueAsNumber = 0; valueAsNumber < props.levels.length; valueAsNumber++) {
      input.onInput({ currentTarget: { valueAsNumber } });
    }
    expect(onChange.mock.calls).toEqual([['low'], ['medium'], ['high'], ['xhigh'], ['max']]);
  });

  it('initializes Off only for models that support it', () => {
    const { input, caption } = render({ levels: ['none', 'low', 'medium', 'high'], value: 'none' });
    expect(input).toMatchObject({ max: 3, value: 0, 'aria-valuetext': 'Off' });
    expect(caption).toBe('Off');
  });

  it('shows unknown or invalid settings explicitly instead of pretending they are Low', () => {
    const unknown = render({ value: null });
    expect(unknown.caption).toBe('\u2014');
    expect(unknown.slider.props.class).toContain('unresolved');
    expect(unknown.input['aria-valuetext']).toContain('unavailable');
    expect(render({ value: 'invalid' }).caption).toBe('Invalid (unsupported)');
  });

  it('can select the first stop by pointer even when the unresolved range was clamped there', () => {
    const onChange = vi.fn();
    const { input } = render({ value: null, onChange });
    input.onPointerUp({ currentTarget: { valueAsNumber: 0 } });
    expect(onChange).toHaveBeenCalledWith('low');
    render({ onChange }).input.onPointerUp({ currentTarget: { valueAsNumber: 0 } });
    expect(onChange).toHaveBeenCalledOnce();
  });

  it.each([
    ['Home', 'low'],
    ['End', 'max'],
    ['ArrowLeft', 'low'],
    ['ArrowRight', 'medium'],
  ])('can resolve an unknown setting with %s to %s', (key, expected) => {
    const onChange = vi.fn(),
      preventDefault = vi.fn();
    render({ value: null, onChange }).input.onKeyDown({ key, preventDefault });
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(onChange).toHaveBeenCalledWith(expected);
  });

  it('leaves normal range keyboard interaction to the browser and disables unavailable/busy controls', () => {
    const preventDefault = vi.fn();
    render().input.onKeyDown({ key: 'Home', preventDefault });
    expect(preventDefault).not.toHaveBeenCalled();
    expect(render({ levels: [], value: null }).input.disabled).toBe(true);
    expect(render({ levels: [], value: null }).input['aria-valuetext']).toBe('Not supported by this model.');
    expect(render({ disabled: true }).input.disabled).toBe(true);
  });
});
