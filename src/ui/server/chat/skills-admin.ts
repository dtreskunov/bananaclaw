/**
 * Host-wide skill administration — catalogs (Claude Code plugin marketplaces
 * and plain Agent Skills repos) and installed skills.
 *
 * These are install-wide, not per-group: installing a skill only makes it
 * *offerable*, and each agent group still opts in through its own Skills
 * selection. Reserved for owners and global admins for that reason — a scoped
 * admin can pick from what's installed but cannot add new code to the host.
 */
import http from 'http';

import { log } from '../../../log.js';
import {
  auditIsBlocking,
  fetchAudits,
  searchDirectory,
  DirectoryError,
  type AuditEntry,
} from '../../../skills/directory.js';
import { installCatalogSkill, uninstallSkill, SkillInstallError } from '../../../skills/install.js';
import {
  addMarketplace,
  githubSourceOf,
  listCatalogs,
  normalizeRepoSource,
  previewCatalog,
  readCatalog,
  refreshMarketplace,
  removeMarketplace,
  MarketplaceError,
  type MarketplaceCatalog,
} from '../../../skills/marketplace.js';
import { listSkills, BUILTIN_CATALOG_ID } from '../../../skills/registry.js';
import { readMarketplaceRecords } from '../../../skills/store.js';
import { recordAdminAction } from './audit.js';
import { listAvailableSkills } from './skill-catalog.js';

export interface SkillsAdminResult {
  status: number;
  body: unknown;
}

function fail(err: unknown): SkillsAdminResult {
  if (err instanceof MarketplaceError || err instanceof SkillInstallError || err instanceof DirectoryError) {
    return { status: 400, body: { error: err.message } };
  }
  log.error('skills-admin handler threw', { err });
  return { status: 500, body: { error: 'internal_error' } };
}

function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * The skills shipped with this install, shaped like any other catalog so the
 * UI has one representation of "where a skill came from". Read-only: there is
 * nothing to fetch, refresh or remove.
 */
function builtinCatalog(): MarketplaceCatalog {
  const skills = listSkills()
    .filter((skill) => skill.origin === 'builtin')
    .map((skill) => ({
      marketplaceId: BUILTIN_CATALOG_ID,
      plugin: BUILTIN_CATALOG_ID,
      slug: skill.slug,
      name: skill.name,
      description: skill.description,
      license: skill.license,
      path: `container/skills/${skill.slug}`,
      warnings: skill.warnings,
    }));

  return {
    id: BUILTIN_CATALOG_ID,
    repo: 'container/skills',
    source: null,
    ref: '',
    label: 'Built-in',
    description: 'Ships with this install. Always available to select; nothing to add or refresh.',
    commit: null,
    refreshedAt: null,
    kind: 'built-in',
    plugins:
      skills.length > 0 ? [{ name: BUILTIN_CATALOG_ID, description: null, skills, unsupportedReason: null }] : [],
    error: null,
  };
}

export function getSkillsOverview(): SkillsAdminResult {
  return {
    status: 200,
    body: { skills: listAvailableSkills(), catalogs: [builtinCatalog(), ...listCatalogs()] },
  };
}

export function addCatalog(body: Record<string, unknown>, actorUserId: string): SkillsAdminResult {
  const repo = str(body.repo);
  if (!repo) return { status: 400, body: { error: 'repo is required' } };
  try {
    const record = addMarketplace({ repo, ref: str(body.ref) || undefined, id: str(body.id) || undefined });
    recordAdminAction({
      actorUserId,
      action: 'skill_catalog_add',
      targetKind: 'skill_catalog',
      targetId: record.id,
      payload: { repo: record.repo, ref: record.ref },
    });
    return { status: 200, body: { catalog: record } };
  } catch (err) {
    return fail(err);
  }
}

export function refreshCatalog(id: string, actorUserId: string): SkillsAdminResult {
  try {
    const record = refreshMarketplace(id);
    recordAdminAction({
      actorUserId,
      action: 'skill_catalog_refresh',
      targetKind: 'skill_catalog',
      targetId: id,
      payload: { commit: record.commit },
    });
    return { status: 200, body: { catalog: record } };
  } catch (err) {
    return fail(err);
  }
}

export function deleteCatalog(id: string, actorUserId: string): SkillsAdminResult {
  try {
    removeMarketplace(id);
    recordAdminAction({ actorUserId, action: 'skill_catalog_remove', targetKind: 'skill_catalog', targetId: id });
    return { status: 200, body: { ok: true } };
  } catch (err) {
    return fail(err);
  }
}

export async function installSkill(body: Record<string, unknown>, actorUserId: string): Promise<SkillsAdminResult> {
  const marketplaceId = str(body.marketplaceId);
  const plugin = str(body.plugin);
  const slug = str(body.slug);
  const acknowledgeRisk = body.acknowledgeRisk === true;
  if (!marketplaceId || !plugin || !slug) {
    return { status: 400, body: { error: 'marketplaceId, plugin and slug are required' } };
  }
  try {
    // Audits are keyed by the directory's `owner/repo`, which is the catalog's
    // repo minus the git URL wrapper.
    const catalog = readMarketplaceRecords().find((entry) => entry.id === marketplaceId);
    const source = catalog ? githubSourceOf(catalog.repo) : null;
    const audits = source ? await fetchAudits(source, slug) : null;
    if (audits && auditIsBlocking(audits) && !acknowledgeRisk) {
      return {
        status: 409,
        body: { error: 'audit_blocked', message: `Security audits flagged ${slug}.`, audits },
      };
    }

    const record = installCatalogSkill({ marketplaceId, plugin, slug, actorUserId });
    recordAdminAction({
      actorUserId,
      action: 'skill_install',
      targetKind: 'skill',
      targetId: slug,
      payload: {
        repo: record.repo,
        ref: record.ref,
        commit: record.commit,
        path: record.path,
        auditAcknowledged: acknowledgeRisk && audits !== null && auditIsBlocking(audits),
      },
    });
    return { status: 200, body: { skill: record } };
  } catch (err) {
    return fail(err);
  }
}

// ── discovery (skills.sh) ─────────────────────────────────────────────────

/** Search the directory and group hits by the repo we'd add as a catalog. */
export async function discoverSkills(query: string): Promise<SkillsAdminResult> {
  try {
    const result = await searchDirectory(query);
    const configured = new Map(readMarketplaceRecords().map((record) => [record.repo, record.id]));
    const bySource = new Map<string, { source: string; catalogId: string | null; skills: typeof result.skills }>();

    for (const skill of result.skills) {
      let group = bySource.get(skill.source);
      if (!group) {
        let catalogId: string | null = null;
        try {
          catalogId = configured.get(normalizeRepoSource(skill.source)) ?? null;
        } catch {
          continue; // A source we could never turn into a catalog (e.g. a bare domain).
        }
        group = { source: skill.source, catalogId, skills: [] };
        bySource.set(skill.source, group);
      }
      group.skills.push(skill);
    }

    return {
      status: 200,
      body: {
        query: result.query,
        searchType: result.searchType,
        authenticated: result.authenticated,
        sources: [...bySource.values()],
      },
    };
  } catch (err) {
    return fail(err);
  }
}

/**
 * Read a repo's skills without registering it as a catalog. Backs expanding a
 * search result: the directory only returns names, so descriptions have to
 * come from the repo itself.
 */
export function previewRepo(repo: string): SkillsAdminResult {
  if (!repo) return { status: 400, body: { error: 'repo is required' } };
  try {
    return { status: 200, body: { catalog: previewCatalog({ repo }) } };
  } catch (err) {
    return fail(err);
  }
}

/**
 * Audits for one skill. `audits: null` means unknown (nobody has audited it,
 * or the directory is unreachable) — the UI must not present that as safe.
 */
export async function getSkillAudits(source: string, slug: string): Promise<SkillsAdminResult> {
  if (!source || !slug) return { status: 400, body: { error: 'source and slug are required' } };
  const audits = await fetchAudits(source, slug);
  return {
    status: 200,
    body: { source, slug, audits, blocking: audits ? auditIsBlocking(audits) : false },
  };
}

/**
 * Install straight from a `owner/repo` + slug, adding the catalog first if it
 * isn't configured yet. This is what the discovery flow calls, where the user
 * picked a skill and never saw a plugin name.
 *
 * Audits gate the install: a `fail` verdict or HIGH/CRITICAL risk from any
 * partner requires `acknowledgeRisk`, and the acknowledgement is recorded.
 * Enforced here rather than only in the UI so the API can't be walked past.
 */
export async function installFromRepo(body: Record<string, unknown>, actorUserId: string): Promise<SkillsAdminResult> {
  const repo = str(body.repo);
  const slug = str(body.slug);
  const acknowledgeRisk = body.acknowledgeRisk === true;
  if (!repo || !slug) return { status: 400, body: { error: 'repo and slug are required' } };

  let audits: AuditEntry[] | null = null;
  try {
    const normalized = normalizeRepoSource(repo);
    audits = await fetchAudits(repo, slug);
    if (audits && auditIsBlocking(audits) && !acknowledgeRisk) {
      return {
        status: 409,
        body: { error: 'audit_blocked', message: `Security audits flagged ${slug}.`, audits },
      };
    }

    let record = readMarketplaceRecords().find((entry) => entry.repo === normalized);
    if (!record) {
      record = addMarketplace({ repo, ref: str(body.ref) || undefined });
      recordAdminAction({
        actorUserId,
        action: 'skill_catalog_add',
        targetKind: 'skill_catalog',
        targetId: record.id,
        payload: { repo: record.repo, ref: record.ref, via: 'discover' },
      });
    }

    const plugin = readCatalog(record).plugins.find((entry) => entry.skills.some((s) => s.slug === slug));
    if (!plugin) {
      return { status: 404, body: { error: `"${slug}" is not in ${record.repo}` } };
    }

    const installed = installCatalogSkill({
      marketplaceId: record.id,
      plugin: plugin.name,
      slug,
      actorUserId,
    });
    recordAdminAction({
      actorUserId,
      action: 'skill_install',
      targetKind: 'skill',
      targetId: slug,
      payload: {
        repo: installed.repo,
        ref: installed.ref,
        commit: installed.commit,
        path: installed.path,
        via: 'discover',
        auditAcknowledged: acknowledgeRisk && audits !== null && auditIsBlocking(audits),
      },
    });
    return { status: 200, body: { skill: installed } };
  } catch (err) {
    return fail(err);
  }
}

export function removeSkill(slug: string, actorUserId: string): SkillsAdminResult {
  try {
    uninstallSkill(slug);
    recordAdminAction({ actorUserId, action: 'skill_uninstall', targetKind: 'skill', targetId: slug });
    return { status: 200, body: { ok: true } };
  } catch (err) {
    return fail(err);
  }
}

/** Parse a JSON request body, capped small — these are tiny control messages. */
export async function readSkillsAdminBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 16 * 1024) throw new SkillInstallError('request body too large');
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return {};
  const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
}
