// Directory search results, grouped by the repo we'd add as a catalog.
//
// A search hit carries only a name and a slug, so a collapsed group shows just
// that. Expanding clones the repo into the catalog cache and reads its real
// SKILL.md metadata, which is also what an install would use — the preview and
// the install see the same tree.
import { useState } from 'preact/hooks';
import type { JSX } from 'preact';

import { call, errMsg } from './GroupAdminApi';
import { InstallControl, type AuditDto } from './GroupAdminSkillInstall';
import { showToast } from './Toast';

export interface DiscoverSkillDto {
  id: string;
  slug: string;
  name: string;
  source: string;
  installs: number | null;
  url: string | null;
}

export interface DiscoverSourceDto {
  source: string;
  catalogId: string | null;
  skills: DiscoverSkillDto[];
}

export interface DiscoverResponse {
  query: string;
  searchType: string | null;
  authenticated: boolean;
  sources: DiscoverSourceDto[];
}

interface PreviewSkill {
  slug: string;
  name: string;
  description: string;
  license: string | null;
}

const SKILLS_API = '/ui/chat/api/skills';

/** True when the slug adds nothing the display name doesn't already say. */
export function slugIsRedundant(name: string, slug: string): boolean {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') === slug.toLowerCase();
}

export function formatInstalls(n: number | null): string | null {
  if (n === null) return null;
  if (n >= 1000) return `${Math.round(n / 100) / 10}k installs`;
  return `${n} installs`;
}

export function SkillDirectoryResults({
  discover,
  installedSlugs,
  busy,
  onInstall,
}: {
  discover: DiscoverResponse;
  installedSlugs: Set<string>;
  busy: boolean;
  onInstall: (repo: string, slug: string, ack: boolean) => Promise<{ ok: boolean; audits?: AuditDto[] | null }>;
}): JSX.Element {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [previews, setPreviews] = useState<Record<string, PreviewSkill[] | 'loading' | 'error'>>({});

  // Anything already installed is shown above with a checkbox; repeating it
  // here as "Installed" is noise.
  const sources = discover.sources
    .map((entry) => ({ ...entry, skills: entry.skills.filter((skill) => !installedSlugs.has(skill.slug)) }))
    .filter((entry) => entry.skills.length > 0);

  async function toggle(source: string): Promise<void> {
    const open = expanded.has(source);
    setExpanded((prev) => {
      const next = new Set(prev);
      if (open) next.delete(source);
      else next.add(source);
      return next;
    });
    if (open || previews[source]) return;

    setPreviews((prev) => ({ ...prev, [source]: 'loading' }));
    const r = await call<{ catalog: { plugins: { skills: PreviewSkill[] }[] } }>(
      `${SKILLS_API}/preview?repo=${encodeURIComponent(source)}`,
    );
    if (!r.ok) {
      showToast(errMsg(r.data, `HTTP ${r.status}`), 'err');
      setPreviews((prev) => ({ ...prev, [source]: 'error' }));
      return;
    }
    setPreviews((prev) => ({ ...prev, [source]: r.data.catalog.plugins.flatMap((plugin) => plugin.skills) }));
  }

  if (sources.length === 0) {
    return <p class="group-admin-help">No further matches in the directory.</p>;
  }

  return (
    <div class="ga-discover-results">
      <p class="ga-catalog-meta">
        {discover.searchType === 'semantic' ? 'Semantic' : 'Fuzzy'} match ·{' '}
        {discover.authenticated ? 'skills.sh API' : 'skills.sh (unauthenticated)'} · install counts are
        popularity, not safety
      </p>
      <ul class="ga-discover-list">
        {sources.map((entry) => {
          const preview = previews[entry.source];
          const open = expanded.has(entry.source);
          const loaded = open && Array.isArray(preview);
          const installsBySlug = new Map(entry.skills.map((skill) => [skill.slug, skill.installs] as const));

          // Collapsed shows the search hits; expanded shows everything the repo
          // actually ships, with the descriptions the directory doesn't return.
          const rows: PreviewSkill[] = loaded
            ? (preview as PreviewSkill[]).filter((skill) => !installedSlugs.has(skill.slug))
            : entry.skills.map((skill) => ({
                slug: skill.slug,
                name: skill.name,
                description: '',
                license: null,
              }));

          return (
            <li key={entry.source} class="ga-discover-source">
              <button type="button" class="ga-catalog-toggle" onClick={() => toggle(entry.source)}>
                <span class="ga-catalog-caret">{open ? '▾' : '▸'}</span>
                <span class="ga-catalog-title">
                  <strong>{entry.source}</strong>
                  {entry.catalogId ? <span class="ga-skills-badge">catalog added</span> : null}
                  <span class="ga-catalog-meta">
                    {loaded
                      ? `${rows.length} skill${rows.length === 1 ? '' : 's'}`
                      : `${entry.skills.length} match${entry.skills.length === 1 ? '' : 'es'}`}
                  </span>
                </span>
              </button>

              {preview === 'loading' ? <p class="ga-catalog-meta">Reading {entry.source}…</p> : null}
              {preview === 'error' ? <p class="ga-skills-unavailable">Couldn’t read this repository.</p> : null}

              <ul class="ga-skills-catalog">
                {rows.map((skill) => {
                  const installs = formatInstalls(installsBySlug.get(skill.slug) ?? null);
                  return (
                    <li key={skill.slug} class="ga-skills-catalog-item">
                      <span class="ga-skills-details">
                        <span class="ga-skills-title">
                          <strong>{skill.name}</strong>
                          {slugIsRedundant(skill.name, skill.slug) ? null : <code>{skill.slug}</code>}
                          {skill.license ? <span class="ga-skills-license">{skill.license}</span> : null}
                          {installs ? <span class="ga-skills-license">{installs}</span> : null}
                        </span>
                        {skill.description ? <span class="ga-skills-description">{skill.description}</span> : null}
                      </span>
                      <InstallControl
                        source={entry.source}
                        slug={skill.slug}
                        installed={installedSlugs.has(skill.slug)}
                        disabled={busy}
                        label={entry.catalogId ? 'Install' : 'Add & install'}
                        onInstall={(ack) => onInstall(entry.source, skill.slug, ack)}
                      />
                    </li>
                  );
                })}
              </ul>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
