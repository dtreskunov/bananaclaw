// Install-wide skill catalogs — Claude Code plugin marketplaces and plain
// Agent Skills repos. Owner / global admin only: installing adds code to the
// host, while picking an installed skill for a group does not.
//
// Search lives with the skill list above; this section is the catalog side of
// it — what's configured, what each one ships, add and remove.
import { useEffect, useState } from 'preact/hooks';
import type { JSX } from 'preact';

import { call, errMsg } from './GroupAdminApi';
import { GroupAdminField as Field } from './GroupAdminField';
import { slugIsRedundant } from './GroupAdminSkillDirectory';
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
  kind: 'plugin-marketplace' | 'skill-repo' | 'built-in' | 'workspace';
  plugins: CatalogPluginDto[];
  error: string | null;
}

const SKILLS_API = '/ui/chat/api/skills';

export function SkillCatalogSection({
  gid,
  installedSlugs,
  reloadKey,
  onChanged,
}: {
  gid: string;
  installedSlugs: Set<string>;
  /** Bump to re-read catalogs after an install elsewhere added one. */
  reloadKey: number;
  onChanged: () => void;
}): JSX.Element {
  const [catalogs, setCatalogs] = useState<CatalogDto[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [repo, setRepo] = useState('');
  const [ref, setRef] = useState('');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  async function load(): Promise<void> {
    const r = await call<{ catalogs: CatalogDto[] }>(`${SKILLS_API}?gid=${encodeURIComponent(gid)}`);
    if (!r.ok) {
      showToast(errMsg(r.data, `HTTP ${r.status}`), 'err');
      setCatalogs([]);
      return;
    }
    setCatalogs(r.data.catalogs);
  }

  useEffect(() => {
    load();
  }, [gid, reloadKey]);

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

  /** Install from a configured catalog, retaining the audit gate's response. */
  async function install(
    body: Record<string, unknown>,
    slug: string,
    acknowledgeRisk: boolean,
  ): Promise<{ ok: boolean; audits?: AuditDto[] | null }> {
    setBusy(true);
    try {
      const r = await call<{ audits?: AuditDto[]; error?: string }>(`${SKILLS_API}/install`, 'POST', {
        ...body,
        acknowledgeRisk,
      });
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
      return { ok: true };
    } finally {
      setBusy(false);
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
      ) : (
        <ul class="ga-catalog-list">
          {catalogs.map((catalog) => {
            const readOnly = catalog.kind === 'built-in' || catalog.kind === 'workspace';
            return (
              <li key={catalog.id} class="ga-catalog">
                <div class="ga-catalog-head">
                  <button type="button" class="ga-catalog-toggle" onClick={() => toggle(catalog.id)}>
                    <span class="ga-catalog-caret">{expanded.has(catalog.id) ? '▾' : '▸'}</span>
                    <span class="ga-catalog-title">
                      <strong>{catalog.label ?? catalog.id}</strong>
                      <code>{catalog.repo}</code>
                    </span>
                  </button>
                  {readOnly ? null : (
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
                  )}
                </div>

                <p class="ga-catalog-meta">
                  {readOnly
                    ? `${catalog.kind === 'workspace' ? 'Agent workspace' : 'Built in'} · ${
                        catalog.plugins[0]?.skills.length ?? 0
                      } skill${(catalog.plugins[0]?.skills.length ?? 0) === 1 ? '' : 's'}`
                    : `${catalog.kind === 'plugin-marketplace' ? 'Plugin marketplace' : 'Skills repo'} · ${catalog.ref}${
                        catalog.commit ? ` · ${catalog.commit.slice(0, 7)}` : ''
                      }`}
                </p>
                {catalog.description ? <p class="ga-catalog-meta">{catalog.description}</p> : null}
                {catalog.error ? <p class="ga-skills-unavailable">{catalog.error}</p> : null}

                {expanded.has(catalog.id)
                  ? catalog.plugins.map((plugin) => (
                      <div key={plugin.name} class="ga-catalog-plugin">
                        {readOnly ? null : (
                          <p class="ga-catalog-plugin-name">
                            {plugin.name}
                            {plugin.description ? <span class="ga-catalog-meta"> — {plugin.description}</span> : null}
                          </p>
                        )}
                        {plugin.unsupportedReason ? (
                          <p class="ga-skills-unavailable">{plugin.unsupportedReason}</p>
                        ) : (
                          <ul class="ga-skills-catalog">
                            {plugin.skills.map((skill) => (
                              <li key={skill.slug} class="ga-skills-catalog-item">
                                <span class="ga-skills-details">
                                  <span class="ga-skills-title">
                                    <strong>{skill.name}</strong>
                                    {slugIsRedundant(skill.name, skill.slug) ? null : <code>{skill.slug}</code>}
                                    {skill.license ? <span class="ga-skills-license">{skill.license}</span> : null}
                                  </span>
                                  <span class="ga-skills-description">{skill.description}</span>
                                  {skill.warnings.map((warning) => (
                                    <span key={warning} class="ga-skills-unavailable">
                                      {warning}
                                    </span>
                                  ))}
                                </span>
                                {readOnly ? null : (
                                  <InstallControl
                                    source={catalog.source}
                                    slug={skill.slug}
                                    installed={installedSlugs.has(skill.slug)}
                                    disabled={busy}
                                    onInstall={(ack) =>
                                      install(
                                        { marketplaceId: catalog.id, plugin: plugin.name, slug: skill.slug },
                                        skill.slug,
                                        ack,
                                      )
                                    }
                                  />
                                )}
                              </li>
                            ))}
                          </ul>
                        )}
                      </div>
                    ))
                  : null}
              </li>
            );
          })}
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
