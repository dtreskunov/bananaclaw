import type { JSX } from 'preact';
import { defaultThinkingLevel, thinkingLevelError, thinkingLevels } from '../../../../shared/thinking-levels';
import { ThinkingLevelSlider } from './ThinkingLevelSlider';
import { GroupAdminField as Field } from './GroupAdminField';

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
    <Field
      label="Thinking"
      info="Agent-wide thinking setting for all conversations. More thinking may improve difficult answers, but increases latency and token usage. Saving schedules a restart after active responses finish."
    >
      <div class="group-admin-stack group-admin-thinking">
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
    </Field>
  );
}
