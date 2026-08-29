// Install-wide skill catalogs — Claude Code plugin marketplaces and plain
// Agent Skills repos. Owner / global admin only: installing adds code to the
// host, while picking an installed skill for a group does not.
//
// Three ways in, cheapest first: suggested catalogs (curated, one click),
// search across the skills.sh directory, or paste a repo yourself. Discovery
// only ever yields a `owner/repo` — the install itself still goes through our
// own git clone so provenance is ours, not the directory's.
import { useEffect, useState } from 'preact/hooks';
import type { JSX } from 'preact';

import { call, errMsg } from './GroupAdminApi';
import { GroupAdminField as Field } from './GroupAdminField';
import { InstallControl, type AuditDto } from './GroupAdminSkillInstall';
import { showToast } from './Toast';

export interface CatalogSkillDto {
  marketplaceId: string;
  plugin: string;
  slug: string;
  name: string;
  description: string;
  license: string | null;
  path: string;
  warnings: string[];
}

export interface CatalogPluginDto {
  name: string;
  description: string | null;
  skills: CatalogSkillDto[];
  unsupportedReason: string | null;
}

export interface CatalogDto {
  id: string;
  repo: string;
  source: string | null;
  ref: string;
  label: string | null;
  description: string | null;
  commit: string | null;
  refreshedAt: string | null;
  kind: 'plugin-marketplace' | 'skill-repo';
  plugins: CatalogPluginDto[];
  error: string | null;
}

export interface SuggestedCatalogDto {
  repo: string;
  ref: string;
  label: string;
  description: string;
}

interface DiscoverSkillDto {
  id: string;
  slug: string;
  name: string;
  source: string;
  installs: number | null;
  url: string | null;
}

interface DiscoverSourceDto {
  source: string;
  catalogId: string | null;
  skills: DiscoverSkillDto[];
}

interface DiscoverResponse {
  query: string;
  searchType: string | null;
  authenticated: boolean;
  sources: DiscoverSourceDto[];
}

const SKILLS_API = '/ui/chat/api/skills';

function formatInstalls(n: number | null): string | null {
  if (n === null) return null;
  if (n >= 1000) return `${Math.round(n / 100) / 10}k installs`;
  return `${n} installs`;
}

export function SkillCatalogSection({
  installedSlugs,
  onChanged,
}: {
  installedSlugs: Set<string>;
  onChanged: () => void;
}): JSX.Element {
  const [catalogs, setCatalogs] = useState<CatalogDto[] | null>(null);
  const [suggestions, setSuggestions] = useState<SuggestedCatalogDto[]>([]);
  const [busy, setBusy] = useState(false);
  const [repo, setRepo] = useState('');
  const [ref, setRef] = useState('');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState('');
  const [discover, setDiscover] = useState<DiscoverResponse | null>(null);
  const [searching, setSearching] = useState(false);

  async function load(): Promise<void> {
    const r = await call<{ catalogs: CatalogDto[]; suggestions: SuggestedCatalogDto[] }>(SKILLS_API);
    if (!r.ok) {
      showToast(errMsg(r.data, `HTTP ${r.status}`), 'err');
      setCatalogs([]);
      return;
    }
    setCatalogs(r.data.catalogs);
    setSuggestions(r.data.suggestions ?? []);
  }

  useEffect(() => {
    load();
  }, []);

  async function mutate(url: string, method: string, body: unknown, okMessage: string): Promise<void> {
    setBusy(true);
    try {
      const r = await call<unknown>(url, method, body);
      if (!r.ok) {
        showToast(errMsg(r.data, `HTTP ${r.status}`), 'err');
        return;
      }
      showToast(okMessage, 'ok');
      await load();
      onChanged();
    } finally {
      setBusy(false);
    }
  }

  /** Shared by both install paths so audits and refresh behave identically. */
  async function install(
    url: string,
    body: Record<string, unknown>,
    slug: string,
    acknowledgeRisk: boolean,
  ): Promise<{ ok: boolean; audits?: AuditDto[] | null }> {
    setBusy(true);
    try {
      const r = await call<{ audits?: AuditDto[]; error?: string }>(url, 'POST', { ...body, acknowledgeRisk });
      if (!r.ok) {
        if (r.status === 409 && r.data?.error === 'audit_blocked') {
          return { ok: false, audits: r.data.audits ?? null };
        }
        showToast(errMsg(r.data, `HTTP ${r.status}`), 'err');
        return { ok: false };
      }
      showToast(`Installed ${slug}.`, 'ok');
      await load();
      onChanged();
      if (query.trim().length >= 2) await runSearch(query);
      return { ok: true };
    } finally {
      setBusy(false);
    }
  }

  async function runSearch(q: string): Promise<void> {
    const trimmed = q.trim();
    if (trimmed.length < 2) {
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

  function toggle(id: string): void {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  return (
    <>
      <div class="group-admin-toolbar">
        <p class="group-admin-help">
          Add a Claude Code plugin marketplace (a repo with <code>.claude-plugin/marketplace.json</code>) or
          any repo of{' '}
          <a href="https://agentskills.io/specification" target="_blank" rel="noreferrer noopener">
            Agent Skills
          </a>
          . Installing makes a skill selectable by every group; it does not enable it anywhere. Nothing from
          a catalog runs at install time.
        </p>
      </div>

      <Field label="Find a skill" info="Searches the skills.sh directory. Installs still clone from GitHub.">
        <div class="ga-catalog-add">
          <input
            type="search"
            placeholder="pdf, spreadsheets, react native…"
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
          <button type="button" disabled={busy || searching || query.trim().length < 2} onClick={() => runSearch(query)}>
            {searching ? 'Searching…' : 'Search'}
          </button>
        </div>
      </Field>

      {/* Outside the field row: `.group-admin-control` lays its children out in a
          row, which squeezed the result list into a column beside the input. */}
      {discover ? (
        discover.sources.length === 0 ? (
          <p class="group-admin-help">No matches for “{discover.query}”.</p>
        ) : (
          <div class="ga-discover-results">
            <p class="ga-catalog-meta">
              {discover.searchType === 'semantic' ? 'Semantic' : 'Fuzzy'} match ·{' '}
              {discover.authenticated ? 'skills.sh API' : 'skills.sh (unauthenticated)'} · install counts are
              popularity, not safety
            </p>
            <ul class="ga-discover-list">
              {discover.sources.map((entry) => (
                <li key={entry.source} class="ga-discover-source">
                  <p class="ga-catalog-plugin-name">
                    {entry.source}
                    {entry.catalogId ? <span class="ga-skills-badge">catalog added</span> : null}
                  </p>
                  <ul class="ga-skills-catalog">
                    {entry.skills.map((skill) => (
                      <li key={skill.id} class="ga-skills-catalog-item">
                        <span class="ga-skills-details">
                          <span class="ga-skills-title">
                            <strong>{skill.name}</strong>
                            <code>{skill.slug}</code>
                            {formatInstalls(skill.installs) ? (
                              <span class="ga-skills-license">{formatInstalls(skill.installs)}</span>
                            ) : null}
                          </span>
                        </span>
                        <InstallControl
                          source={entry.source}
                          slug={skill.slug}
                          installed={installedSlugs.has(skill.slug)}
                          disabled={busy}
                          label={entry.catalogId ? 'Install' : 'Add & install'}
                          onInstall={(ack) =>
                            install(
                              `${SKILLS_API}/install-from-repo`,
                              { repo: entry.source, slug: skill.slug },
                              skill.slug,
                              ack,
                            )
                          }
                        />
                      </li>
                    ))}
                  </ul>
                </li>
              ))}
            </ul>
          </div>
        )
      ) : null}

      {suggestions.length > 0 ? (
        <Field label="Suggested catalogs">
          <ul class="ga-suggested-list">
            {suggestions.map((entry) => (
              <li key={entry.repo} class="ga-suggested">
                <span class="ga-skills-details">
                  <span class="ga-skills-title">
                    <strong>{entry.label}</strong>
                    <code>{entry.repo}</code>
                  </span>
                  <span class="ga-skills-description">{entry.description}</span>
                </span>
                <button
                  type="button"
                  class="ga-catalog-install"
                  disabled={busy}
                  onClick={() =>
                    mutate(`${SKILLS_API}/catalogs`, 'POST', { repo: entry.repo, ref: entry.ref }, 'Catalog added.')
                  }
                >
                  Add
                </button>
              </li>
            ))}
          </ul>
        </Field>
      ) : null}

      <Field label="Add a catalog" info="owner/repo, or an https clone URL.">
        <div class="ga-catalog-add">
          <input
            type="text"
            placeholder="anthropics/skills"
            value={repo}
            disabled={busy}
            onInput={(event) => setRepo(event.currentTarget.value)}
          />
          <input
            type="text"
            class="ga-catalog-ref"
            placeholder="main"
            value={ref}
            disabled={busy}
            onInput={(event) => setRef(event.currentTarget.value)}
          />
          <button
            type="button"
            disabled={busy || repo.trim() === ''}
            onClick={async () => {
              await mutate(`${SKILLS_API}/catalogs`, 'POST', { repo: repo.trim(), ref: ref.trim() }, 'Catalog added.');
              setRepo('');
              setRef('');
            }}
          >
            Add
          </button>
        </div>
      </Field>

      {catalogs === null ? (
        <p class="group-admin-help">Loading catalogs…</p>
      ) : catalogs.length === 0 ? (
        <p class="group-admin-help">No catalogs configured yet.</p>
      ) : (
        <ul class="ga-catalog-list">
          {catalogs.map((catalog) => (
            <li key={catalog.id} class="ga-catalog">
              <div class="ga-catalog-head">
                <button type="button" class="ga-catalog-toggle" onClick={() => toggle(catalog.id)}>
                  <span class="ga-catalog-caret">{expanded.has(catalog.id) ? '▾' : '▸'}</span>
                  <span class="ga-catalog-title">
                    <strong>{catalog.label ?? catalog.id}</strong>
                    <code>{catalog.repo}</code>
                  </span>
                </button>
                <span class="ga-catalog-actions">
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() =>
                      mutate(
                        `${SKILLS_API}/catalogs/${encodeURIComponent(catalog.id)}/refresh`,
                        'POST',
                        {},
                        'Catalog refreshed.',
                      )
                    }
                  >
                    Refresh
                  </button>
                  <button
                    type="button"
                    class="ga-catalog-remove"
                    disabled={busy}
                    onClick={() =>
                      mutate(
                        `${SKILLS_API}/catalogs/${encodeURIComponent(catalog.id)}`,
                        'DELETE',
                        undefined,
                        'Catalog removed.',
                      )
                    }
                  >
                    Remove
                  </button>
                </span>
              </div>

              <p class="ga-catalog-meta">
                {catalog.kind === 'plugin-marketplace' ? 'Plugin marketplace' : 'Skills repo'} · {catalog.ref}
                {catalog.commit ? ` · ${catalog.commit.slice(0, 7)}` : ''}
              </p>
              {catalog.description ? <p class="ga-catalog-meta">{catalog.description}</p> : null}
              {catalog.error ? <p class="ga-skills-unavailable">{catalog.error}</p> : null}

              {expanded.has(catalog.id)
                ? catalog.plugins.map((plugin) => (
                    <div key={plugin.name} class="ga-catalog-plugin">
                      <p class="ga-catalog-plugin-name">
                        {plugin.name}
                        {plugin.description ? <span class="ga-catalog-meta"> — {plugin.description}</span> : null}
                      </p>
                      {plugin.unsupportedReason ? (
                        <p class="ga-skills-unavailable">{plugin.unsupportedReason}</p>
                      ) : (
                        <ul class="ga-skills-catalog">
                          {plugin.skills.map((skill) => (
                            <li key={skill.slug} class="ga-skills-catalog-item">
                              <span class="ga-skills-details">
                                <span class="ga-skills-title">
                                  <strong>{skill.name}</strong>
                                  <code>{skill.slug}</code>
                                  {skill.license ? <span class="ga-skills-license">{skill.license}</span> : null}
                                </span>
                                <span class="ga-skills-description">{skill.description}</span>
                                {skill.warnings.map((warning) => (
                                  <span key={warning} class="ga-skills-unavailable">
                                    {warning}
                                  </span>
                                ))}
                              </span>
                              <InstallControl
                                source={catalog.source}
                                slug={skill.slug}
                                installed={installedSlugs.has(skill.slug)}
                                disabled={busy}
                                onInstall={(ack) =>
                                  install(
                                    `${SKILLS_API}/install`,
                                    { marketplaceId: catalog.id, plugin: plugin.name, slug: skill.slug },
                                    skill.slug,
                                    ack,
                                  )
                                }
                              />
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  ))
                : null}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

/** Uninstall an installed skill. Exposed so the selection list can offer it. */
export async function uninstallSkill(slug: string): Promise<boolean> {
  const r = await call<unknown>(`${SKILLS_API}/${encodeURIComponent(slug)}`, 'DELETE');
  if (!r.ok) {
    showToast(errMsg(r.data, `HTTP ${r.status}`), 'err');
    return false;
  }
  showToast(`Removed ${slug}.`, 'ok');
  return true;
}
