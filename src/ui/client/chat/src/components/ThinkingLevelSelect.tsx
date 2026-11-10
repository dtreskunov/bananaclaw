import type { JSX } from 'preact';
import { thinkingLevelError, thinkingLevelLabel, thinkingLevels } from '../../../../shared/thinking-levels';
import { GroupAdminField as Field } from './GroupAdminField';

export function ThinkingLevelSelect({
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
  onChange: (value: string | null) => void;
}): JSX.Element {
  const levels = thinkingLevels(provider, model);
  const error = thinkingLevelError(provider, model, value ?? defaultEffort);
  return (
    <Field
      label="Thinking level"
      info="Agent-wide default for all conversations. More thinking may improve difficult answers, but increases latency and token usage. Saving schedules a restart after active responses finish."
    >
      <div class="group-admin-stack">
        <select
          aria-label="Thinking level"
          value={value ?? ''}
          disabled={busy || (levels.length === 0 && value === null)}
          onChange={(event) => onChange(event.currentTarget.value || null)}
        >
          <option value="">
            {defaultEffort ? `Default (inherited: ${thinkingLevelLabel(defaultEffort)})` : 'Default (provider setting)'}
          </option>
          {value && !levels.includes(value) ? (
            <option value={value} disabled>
              {value} (unsupported)
            </option>
          ) : null}
          {levels.map((level) => (
            <option key={level} value={level}>
              {thinkingLevelLabel(level)}
            </option>
          ))}
        </select>
        {levels.length === 0 ? (
          <p class="group-admin-help">This model/provider has no reviewed thinking-level control.</p>
        ) : null}
        {error ? (
          <p class="ga-confirm-warn" role="alert">
            {error}
          </p>
        ) : null}
      </div>
    </Field>
  );
}
