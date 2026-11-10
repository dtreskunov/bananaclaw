import type { JSX } from 'preact';
import { defaultThinkingLevel, thinkingLevelError, thinkingLevels } from '../../../../shared/thinking-levels';
import { ThinkingLevelSlider } from './ThinkingLevelSlider';

export function ThinkingLevelField({
  provider,
  model,
  value,
  defaultEffort,
  busy,
  onChange,
}: {
  provider: string | null;
  model: string | null;
  value: string | null;
  defaultEffort: string | null;
  busy: boolean;
  onChange: (value: string) => void;
}): JSX.Element {
  const levels = thinkingLevels(provider, model);
  const error = thinkingLevelError(provider, model, value ?? defaultEffort);
  return (
    <div
      class="group-admin-stack"
      title="Agent-wide setting. Saving schedules a restart after active responses finish."
    >
      <ThinkingLevelSlider
        levels={levels}
        value={value ?? defaultEffort ?? defaultThinkingLevel(provider, model)}
        disabled={busy}
        onChange={onChange}
      />
      {error ? (
        <p class="ga-confirm-warn" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
