import { thinkingLevelLabel } from '../../../../shared/thinking-levels';
import './ThinkingLevelSlider.css';

export interface ThinkingLevelSliderProps {
  levels: readonly string[];
  value: string | null;
  disabled: boolean;
  onChange: (level: string) => void;
}

export function ThinkingLevelSlider({ levels, value, disabled, onChange }: ThinkingLevelSliderProps) {
  const index = value === null ? -1 : levels.indexOf(value);
  const unresolved = index < 0;
  const locked = disabled || levels.length === 0;
  const caption = value === null ? '\u2014' : `${thinkingLevelLabel(value)}${unresolved ? ' (unsupported)' : ''}`;
  const description =
    levels.length === 0
      ? 'Not supported by this model.'
      : value === null
        ? 'Initial setting unavailable. Choose a level.'
        : caption;
  return (
    <label class={`thinking-level-slider${unresolved ? ' unresolved' : ''}`} title={description}>
      <span class="thinking-level-slider-heading">
        <span>Thinking</span>
        <span class="thinking-level-slider-value">{caption}</span>
      </span>
      <input
        type="range"
        min={0}
        max={Math.max(1, levels.length - 1)}
        step={1}
        value={Math.max(0, index)}
        disabled={locked}
        aria-label="Thinking"
        aria-valuetext={description}
        onInput={(event) => onChange(levels[event.currentTarget.valueAsNumber])}
        onPointerUp={(event) => {
          if (unresolved && !locked) onChange(levels[event.currentTarget.valueAsNumber]);
        }}
        onKeyDown={(event) => {
          if (!unresolved || locked) return;
          if (['Home', 'End', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) {
            event.preventDefault();
            onChange(
              levels[
                event.key === 'End'
                  ? levels.length - 1
                  : ['ArrowRight', 'ArrowUp'].includes(event.key)
                    ? Math.min(1, levels.length - 1)
                    : 0
              ],
            );
          }
        }}
      />
    </label>
  );
}
