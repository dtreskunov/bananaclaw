import './GroupAdminSkills.css';
import type { JSX } from 'preact';

import { GroupAdminField as Field } from './GroupAdminField';
import { SkillCatalogSection, uninstallSkill } from './GroupAdminSkillCatalog';

export interface SkillProvenanceDto {
  marketplaceId: string | null;
  plugin: string | null;
  repo: string;
  ref: string;
  commit: string;
  path: string;
  installedAt: string;
}

export interface AvailableSkillDto {
  slug: string;
  name: string;
  description: string;
  available: boolean;
  unavailableReason: string | null;
  origin: 'builtin' | 'installed';
  catalogId: string | null;
  catalogLabel: string;
  license: string | null;
  warnings: string[];
  source: SkillProvenanceDto | null;
  updateAvailable: boolean | null;
}

export function SkillsSection({
  value,
  selectedSkills,
  availableSkills,
  busy,
  elevated,
  onChange,
  onCatalogChanged,
}: {
  value: string[] | 'all';
  selectedSkills: string[] | null;
  availableSkills: AvailableSkillDto[];
  busy: boolean;
  elevated: boolean;
  onChange: (next: string[] | 'all') => void;
  onCatalogChanged: () => void;
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
          Every skill comes from a catalog — the built-in one ships with this install, the rest you add
          below. Restart required to take effect: skill mounts are computed at container spawn.
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

      <Field label="Available skills">
        {availableSkills.length === 0 ? (
          <p class="group-admin-help">No skills found.</p>
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
                        <span class="ga-skills-badge">{skill.catalogLabel}</span>
                        {skill.updateAvailable ? (
                          <span class="ga-skills-badge ga-skills-badge-update">update</span>
                        ) : null}
                        {skill.license ? <span class="ga-skills-license">{skill.license}</span> : null}
                      </span>
                      {skill.description ? <span class="ga-skills-description">{skill.description}</span> : null}
                      {skill.source ? (
                        <span class="ga-skills-source">
                          {skill.source.repo} · {skill.source.ref} · {skill.source.commit.slice(0, 7)} ·{' '}
                          {skill.source.path}
                        </span>
                      ) : null}
                      {skill.unavailableReason ? (
                        <span class="ga-skills-unavailable">{skill.unavailableReason}</span>
                      ) : null}
                      {skill.warnings.map((warning) => (
                        <span key={warning} class="ga-skills-unavailable">
                          {warning}
                        </span>
                      ))}
                    </span>
                  </label>
                  {elevated && skill.origin === 'installed' ? (
                    <button
                      type="button"
                      class="ga-catalog-remove"
                      disabled={busy}
                      onClick={async () => {
                        if (await uninstallSkill(skill.slug)) {
                          setSkill(skill.slug, false);
                          onCatalogChanged();
                        }
                      }}
                    >
                      Uninstall
                    </button>
                  ) : null}
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

      {elevated ? <SkillCatalogSection installedSlugs={installedSlugs} onChanged={onCatalogChanged} /> : null}
    </>
  );
}
