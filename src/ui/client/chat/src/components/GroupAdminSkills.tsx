import './GroupAdminSkills.css';
import type { JSX } from 'preact';

import { GroupAdminField as Field } from './GroupAdminField';

export interface AvailableSkillDto {
  slug: string;
  name: string;
  description: string;
  available: boolean;
  unavailableReason: string | null;
}

export function SkillsSection({
  value,
  selectedSkills,
  availableSkills,
  busy,
  onChange,
}: {
  value: string[] | 'all';
  selectedSkills: string[] | null;
  availableSkills: AvailableSkillDto[];
  busy: boolean;
  onChange: (next: string[] | 'all') => void;
}): JSX.Element {
  const isAll = value === 'all';
  const list = isAll ? [] : value;
  const installedSlugs = new Set(availableSkills.map((skill) => skill.slug));
  const missingSkills = list.filter((slug) => !installedSlugs.has(slug));

  function setSkill(slug: string, enabled: boolean): void {
    if (isAll) return;
    onChange(enabled ? [...list, slug] : list.filter((item) => item !== slug));
  }

  return (
    <>
      <div class="group-admin-toolbar">
        <p class="group-admin-help">
          Installed skills are read from <code>container/skills/</code>. Restart required to take
          effect — skill mounts are computed at container spawn.
        </p>
      </div>

      <Field label="Selection">
        <label class="group-admin-check">
          <input
            type="checkbox"
            checked={isAll}
            disabled={busy}
            onChange={(event) => onChange(
              event.currentTarget.checked
                ? 'all'
                : selectedSkills
                  ?? availableSkills.filter((skill) => skill.available).map((skill) => skill.slug),
            )}
          />
          <span>Enable all available skills</span>
        </label>
      </Field>

      <Field label="Installed skills">
        {availableSkills.length === 0 ? (
          <p class="group-admin-help">No installed skills found.</p>
        ) : (
          <ul class="ga-skills-catalog">
            {availableSkills.map((skill) => {
              const checked = isAll ? skill.available : list.includes(skill.slug);
              return (
                <li key={skill.slug} class="ga-skills-catalog-item">
                  <label class="ga-skills-option">
                    <input
                      type="checkbox"
                      checked={checked}
                      disabled={busy || isAll || (!skill.available && !checked)}
                      onChange={(event) => setSkill(skill.slug, event.currentTarget.checked)}
                    />
                    <span class="ga-skills-details">
                      <span class="ga-skills-title">
                        <strong>{skill.name}</strong>
                        {skill.name !== skill.slug ? <code>{skill.slug}</code> : null}
                      </span>
                      {skill.description ? <span class="ga-skills-description">{skill.description}</span> : null}
                      {skill.unavailableReason ? (
                        <span class="ga-skills-unavailable">{skill.unavailableReason}</span>
                      ) : null}
                    </span>
                  </label>
                </li>
              );
            })}
          </ul>
        )}
      </Field>

      {!isAll && missingSkills.length > 0 ? (
        <Field label="Missing skills" info="These skills are configured for the group but are not installed on this host.">
          <ul class="ga-skills-chips">
            {missingSkills.map((slug) => (
              <li key={slug} class="ga-skills-chip">
                <span class="ga-skills-chip-label">{slug}</span>
                <button
                  type="button"
                  class="ga-skills-chip-remove"
                  aria-label={`Remove ${slug}`}
                  disabled={busy}
                  onClick={() => setSkill(slug, false)}
                >
                  {'\u2715'}
                </button>
              </li>
            ))}
          </ul>
        </Field>
      ) : null}
    </>
  );
}