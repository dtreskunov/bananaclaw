import './AppearanceSettings.css';
import { THEMES, APPEARANCE_MODES, TEXT_DENSITIES } from '../appearance';
import { appearance, setAppearance } from '../appearance-state';

export function AppearanceSettings() {
  const { preferences, resolvedMode, error } = appearance.value;
  return (
    <section aria-labelledby="appearance-heading">
      <h3 id="appearance-heading">Appearance</h3>
      <fieldset class="appearance-fieldset">
        <legend>Theme</legend>
        <div class="appearance-themes">
          {THEMES.map((theme) => (
            <label class="appearance-theme" key={theme.id}>
              <span class="appearance-choice">
                <input
                  type="radio"
                  name="appearance-theme"
                  value={theme.id}
                  checked={preferences.theme === theme.id}
                  onChange={() => setAppearance({ ...preferences, theme: theme.id })}
                />
                <span>{theme.name}</span>
                <span class="appearance-check" aria-hidden="true">{preferences.theme === theme.id ? '\u2713' : ''}</span>
              </span>
              <span class="appearance-preview" data-theme={theme.id} data-mode={resolvedMode} aria-hidden="true">
                <span class="appearance-preview-header" />
                <span class="appearance-preview-sidebar"><i /><i /><i /></span>
                <span class="appearance-preview-chat"><i /><i /><b /></span>
              </span>
              <span class="appearance-description">{theme.description}</span>
            </label>
          ))}
        </div>
      </fieldset>
      <fieldset class="appearance-fieldset">
        <legend>Mode</legend>
        <div class="appearance-modes">
          {APPEARANCE_MODES.map((mode) => (
            <label class="appearance-mode" key={mode.id}>
              <input
                type="radio"
                name="appearance-mode"
                value={mode.id}
                checked={preferences.mode === mode.id}
                onChange={() => setAppearance({ ...preferences, mode: mode.id })}
              />
              <span>{mode.name}</span>
            </label>
          ))}
        </div>
      </fieldset>
      <fieldset class="appearance-fieldset" aria-describedby="density-description">
        <legend>Text density</legend>
        <div class="appearance-densities">
          {TEXT_DENSITIES.map((density) => (
            <label class="appearance-density" key={density.id}>
              <input
                type="radio"
                name="appearance-density"
                value={density.id}
                checked={preferences.density === density.id}
                onChange={() => setAppearance({ ...preferences, density: density.id })}
              />
              <span>{density.name}</span>
            </label>
          ))}
        </div>
        <p class="appearance-density-description" id="density-description">
          {TEXT_DENSITIES.find((density) => density.id === preferences.density)!.description}
        </p>
        <div class="appearance-density-preview" aria-hidden="true">
          <div class="appearance-density-preview-message">Here is a little more detail.</div>
          <div class="appearance-density-preview-row"><span>Example thread</span><span>Just now</span></div>
        </div>
      </fieldset>
      <fieldset class="appearance-fieldset" aria-describedby="status-details-description">
        <legend>Transcript details</legend>
        <label class="appearance-toggle">
          <input
            type="checkbox"
            checked={preferences.showTechnicalStatus}
            onChange={() => setAppearance({
              ...preferences,
              showTechnicalStatus: !preferences.showTechnicalStatus,
            })}
          />
          <span>
            <strong>Show status details</strong>
            <small id="status-details-description">
              Activity trace, cost, duration, model, and context use.
            </small>
          </span>
        </label>
      </fieldset>
      <p class="muted">
        Applies immediately and is saved in this browser.
        {preferences.mode === 'system' ? ` System is currently using ${resolvedMode} mode.` : ''}
      </p>
      {error ? <p class="appearance-error" role="alert">{error}</p> : null}
    </section>
  );
}
