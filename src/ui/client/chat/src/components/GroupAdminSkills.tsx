import './GroupAdminSkills.css';
import { useState } from 'preact/hooks';
import type { JSX } from 'preact';

import { call, errMsg } from './GroupAdminApi';
import { GroupAdminField as Field } from './GroupAdminField';
import { SkillCatalogSection, uninstallSkill } from './GroupAdminSkillCatalog';
import {
  SkillDirectoryResults,
  slugIsRedundant,
  type DiscoverResponse,
} from './GroupAdminSkillDirectory';
import type { AuditDto } from './GroupAdminSkillInstall';
import { showToast } from './Toast';

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

const SKILLS_API = '/ui/chat/api/skills';

function matches(skill: AvailableSkillDto, query: string): boolean {
  const q = query.toLowerCase();
  return (
    skill.name.toLowerCase().includes(q) ||
    skill.slug.toLowerCase().includes(q) ||
    skill.description.toLowerCase().includes(q)
  );
}

export function SkillsSection({
  value,
  availableSkills,
  busy,
  elevated,
  onChange,
  onCatalogChanged,
}: {
  value: string[] | 'all';
  availableSkills: AvailableSkillDto[];
  busy: boolean;
  elevated: boolean;
  onChange: (next: string[] | 'all') => void;
  onCatalogChanged: () => void;
}): JSX.Element {
  const [query, setQuery] = useState('');
  const [discover, setDiscover] = useState<DiscoverResponse | null>(null);
  const [searching, setSearching] = useState(false);
  const [catalogReloads, setCatalogReloads] = useState(0);

  // A group can still be stored as `'all'` (the CLI sets it, and older configs
  // use it). There's no toggle for it any more, so it reads as "everything
  // available is checked" and materializes into an explicit list on first edit
  // — which keeps an unrelated save from silently rewriting the selection.
  const isAll = value === 'all';
  const list = isAll ? availableSkills.filter((skill) => skill.available).map((skill) => skill.slug) : value;
  const installedSlugs = new Set(availableSkills.map((skill) => skill.slug));
  const missingSkills = list.filter((slug) => !installedSlugs.has(slug));
  const shown = query.trim() === '' ? availableSkills : availableSkills.filter((skill) => matches(skill, query.trim()));

  function setSkill(slug: string, enabled: boolean): void {
    onChange(enabled ? [...list.filter((item) => item !== slug), slug] : list.filter((item) => item !== slug));
  }

  async function runSearch(q: string): Promise<void> {
    const trimmed = q.trim();
    if (!elevated || trimmed.length < 2) {
      setDiscover(null);
      return;
    }
    setSearching(true);
    try {
      const r = await call<DiscoverResponse>(`${SKILLS_API}/discover?q=${encodeURIComponent(trimmed)}`);
      if (!r.ok) {
        showToast(errMsg(r.data, `HTTP ${r.status}`), 'err');
        setDiscover(null);
        return;
      }
      setDiscover(r.data);
    } finally {
      setSearching(false);
    }
  }

  async function installFromRepo(
    repo: string,
    slug: string,
    acknowledgeRisk: boolean,
  ): Promise<{ ok: boolean; audits?: AuditDto[] | null }> {
    const r = await call<{ audits?: AuditDto[]; error?: string }>(`${SKILLS_API}/install-from-repo`, 'POST', {
      repo,
      slug,
      acknowledgeRisk,
    });
    if (!r.ok) {
      if (r.status === 409 && r.data?.error === 'audit_blocked') return { ok: false, audits: r.data.audits ?? null };
      showToast(errMsg(r.data, `HTTP ${r.status}`), 'err');
      return { ok: false };
    }
    showToast(`Installed ${slug}.`, 'ok');
    // Installed skills move into the checkbox list above, and the repo may have
    // just become a configured catalog below.
    onCatalogChanged();
    setCatalogReloads((n) => n + 1);
    await runSearch(query);
    return { ok: true };
  }

  return (
    <>
      <div class="group-admin-toolbar">
        <p class="group-admin-help">
          Tick the skills this agent should have. Every skill comes from a catalog — the built-in one ships
          with this install, the rest you add below. Restart required to take effect: skill mounts are
          computed at container spawn.
        </p>
      </div>

      <Field
        label="Search"
        info={elevated ? 'Filters the list below, and searches the skills.sh directory.' : 'Filters the list below.'}
      >
        <div class="ga-catalog-add">
          <input
            type="search"
            placeholder={elevated ? 'pdf, spreadsheets, react native…' : 'Filter skills…'}
            value={query}
            disabled={busy}
            onInput={(event) => setQuery(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                runSearch(query);
              }
            }}
          />
          {elevated ? (
            <button
              type="button"
              disabled={busy || searching || query.trim().length < 2}
              onClick={() => runSearch(query)}
            >
              {searching ? 'Searching…' : 'Search directory'}
            </button>
          ) : null}
        </div>
      </Field>

      {shown.length === 0 ? (
        <p class="group-admin-help">
          {availableSkills.length === 0 ? 'No skills found.' : `Nothing installed matches “${query.trim()}”.`}
        </p>
      ) : (
        <ul class="ga-skills-catalog">
          {shown.map((skill) => {
            const checked = list.includes(skill.slug);
            return (
              <li key={skill.slug} class="ga-skills-catalog-item">
                <label class="ga-skills-option">
                  <input
                    type="checkbox"
                    checked={checked}
                    disabled={busy || (!skill.available && !checked)}
                    onChange={(event) => setSkill(skill.slug, event.currentTarget.checked)}
                  />
                  <span class="ga-skills-details">
                    <span class="ga-skills-title">
                      <strong>{skill.name}</strong>
                      {slugIsRedundant(skill.name, skill.slug) ? null : <code>{skill.slug}</code>}
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

      {discover ? (
        <SkillDirectoryResults
          discover={discover}
          installedSlugs={installedSlugs}
          busy={busy}
          onInstall={installFromRepo}
        />
      ) : null}

      {missingSkills.length > 0 ? (
        <Field
          label="Missing skills"
          info="These skills are configured for the group but are not installed on this host."
        >
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

      {elevated ? (
        <SkillCatalogSection
          installedSlugs={installedSlugs}
          reloadKey={catalogReloads}
          onChanged={onCatalogChanged}
        />
      ) : null}
    </>
  );
}
