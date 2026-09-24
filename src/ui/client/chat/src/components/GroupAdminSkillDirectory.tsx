// Directory search results, grouped by the repo we'd add as a catalog.
//
// A search hit carries only a name and a slug, so a collapsed group shows just
// that. Expanding clones the repo into the catalog cache and reads its real
// SKILL.md metadata, which is also what an install would use — the preview and
// the install see the same tree.
import { useEffect, useRef, useState } from 'preact/hooks';
import type { JSX } from 'preact';

import { currentPreview, type CatalogRefreshMetadata, type CatalogRefreshState, type VersionedPreview } from '../catalog-refresh';
import { call, errMsg } from './GroupAdminApi';
import { InstallControl, type AuditDto } from './GroupAdminSkillInstall';
import { CatalogRefreshStatus } from './GroupAdminSkillRefresh';
import { showToast } from './Toast';

export interface DiscoverSkillDto {
  id: string;
  slug: string;
  name: string;
  source: string;
  installs: number | null;
  url: string | null;
}

export interface DiscoverSourceDto extends CatalogRefreshMetadata {
  source: string;
  catalogId: string | null;
  snapshot: CatalogSnapshot | null;
  skills: DiscoverSkillDto[];
}

export interface CatalogSnapshot {
  commit: string;
  ref: string;
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

interface PreviewCatalog extends CatalogRefreshMetadata {
  commit: string | null;
  ref: string;
  skills: PreviewSkill[];
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
  refreshState,
  onRefresh,
}: {
  discover: DiscoverResponse;
  installedSlugs: Set<string>;
  busy: boolean;
  refreshState: CatalogRefreshState;
  onRefresh: (id: string) => Promise<void>;
  onInstall: (
    repo: string, slug: string, ack: boolean, snapshot?: CatalogSnapshot,
  ) => Promise<{ ok: boolean; audits?: AuditDto[] | null }>;
}): JSX.Element {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [previews, setPreviews] = useState<Record<string, VersionedPreview<PreviewCatalog>>>({});
  const requests = useRef<Record<string, number>>({});
  const latest = useRef({ discover, refreshState });
  latest.current = { discover, refreshState };

  function versionFor(source: string): number {
    const id = latest.current.discover.sources.find((entry) => entry.source === source)?.catalogId;
    return id ? latest.current.refreshState.versions[id] ?? 0 : 0;
  }

  async function loadPreview(source: string, version: number): Promise<void> {
    const request = (requests.current[source] ?? 0) + 1;
    requests.current[source] = request;
    const current = () => requests.current[source] === request && versionFor(source) === version;
    setPreviews((prev) => ({ ...prev, [source]: { version, value: 'loading' } }));
    try {
      const r = await call<{ catalog: CatalogRefreshMetadata & { commit: string | null; ref: string; plugins: { skills: PreviewSkill[] }[] } }>(
        `${SKILLS_API}/preview?repo=${encodeURIComponent(source)}`,
      );
      if (!current()) return;
      if (!r.ok) throw new Error(errMsg(r.data, `HTTP ${r.status}`));
      setPreviews((prev) => ({
        ...prev,
        [source]: {
          version,
          value: {
            commit: r.data.catalog.commit,
            ref: r.data.catalog.ref,
            refreshedAt: r.data.catalog.refreshedAt,
            lastRefreshAttemptAt: r.data.catalog.lastRefreshAttemptAt,
            lastRefreshError: r.data.catalog.lastRefreshError,
            skills: r.data.catalog.plugins.flatMap((plugin) => plugin.skills),
          },
        },
      }));
    } catch (error) {
      if (!current()) return;
      showToast(`Couldn’t read ${source}: ${error instanceof Error ? error.message : String(error)}`, 'err');
      setPreviews((prev) => ({ ...prev, [source]: { version, value: 'error' } }));
    }
  }

  // Only expanded, invalidated previews are re-read. This uses the host cache;
  // refreshing never repeats the skills.sh search or starts a periodic fetch.
  useEffect(() => {
    for (const entry of discover.sources) {
      if (!expanded.has(entry.source) || (entry.catalogId && refreshState.refreshing.has(entry.catalogId))) continue;
      const version = versionFor(entry.source);
      if (!currentPreview(previews[entry.source], version)) void loadPreview(entry.source, version);
    }
  }, [discover, expanded, previews, refreshState]);

  useEffect(() => () => { requests.current = {}; }, []);

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
    const version = versionFor(source);
    const preview = currentPreview(previews[source], version);
    const entry = discover.sources.find((item) => item.source === source);
    if (open || (preview && preview !== 'error')
      || (entry?.catalogId && refreshState.refreshing.has(entry.catalogId))) return;
    await loadPreview(source, version);
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
          const version = entry.catalogId ? refreshState.versions[entry.catalogId] ?? 0 : 0;
          const preview = currentPreview(previews[entry.source], version);
          const refreshing = !!entry.catalogId && refreshState.refreshing.has(entry.catalogId);
          const open = expanded.has(entry.source);
          const catalog = preview && typeof preview === 'object' ? preview : null;
          const loaded = open && catalog !== null;
          const snapshot = catalog
            ? (catalog.commit ? { commit: catalog.commit, ref: catalog.ref } : null)
            : entry.snapshot;
          const installsBySlug = new Map(entry.skills.map((skill) => [skill.slug, skill.installs] as const));

          // Collapsed shows the search hits; expanded shows everything the repo
          // actually ships, with the descriptions the directory doesn't return.
          const rows: PreviewSkill[] = loaded
            ? catalog.skills.filter((skill) => !installedSlugs.has(skill.slug))
            : entry.skills.map((skill) => ({
                slug: skill.slug,
                name: skill.name,
                description: '',
                license: null,
              }));

          return (
            <li key={entry.source} class="ga-discover-source">
              <div class="ga-catalog-head">
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
                    {snapshot ? <code title={snapshot.commit}>{snapshot.commit.slice(0, 7)}</code> : null}
                  </span>
                </button>
                {entry.catalogId ? (
                  <span class="ga-catalog-actions">
                    <button
                      type="button"
                      disabled={busy || refreshing}
                      onClick={() => onRefresh(entry.catalogId!)}
                    >
                      {refreshing ? 'Refreshing…' : 'Refresh'}
                    </button>
                  </span>
                ) : null}
              </div>
              {entry.catalogId ? (
                <CatalogRefreshStatus catalog={{ ...entry, ...(catalog ?? {}), ...refreshState.updates[entry.catalogId] }} />
              ) : null}

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
                        key={snapshot?.commit ?? 'unpinned'}
                        source={entry.source}
                        slug={skill.slug}
                        installed={installedSlugs.has(skill.slug)}
                        disabled={busy || refreshing || (open && !preview) || preview === 'loading' || (!!catalog && !snapshot)}
                        label={entry.catalogId ? 'Install' : 'Add & install'}
                        onInstall={(ack) => onInstall(entry.source, skill.slug, ack, snapshot ?? undefined)}
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
