/**
 * Host-wide skill administration — catalogs (Claude Code plugin marketplaces
 * and plain Agent Skills repos) and installed skills.
 *
 * Catalog registration and browsing caches are install-wide; each skill
 * installation is a revision-pinned checkout owned by one agent group.
 * Mutations are reserved for owners and global admins; scoped admins can
 * select available skills but cannot add new code to the host.
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
  assertCatalogSnapshot,
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
import { listSkills, groupSkillRoots, BUILTIN_CATALOG_ID, WORKSPACE_CATALOG_ID } from '../../../skills/registry.js';
import { readMarketplaceRecords, type MarketplaceRecord } from '../../../skills/store.js';
import { getAgentGroup } from '../../../db/agent-groups.js';
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

function expectedCommitOf(body: Record<string, unknown>): string | undefined {
  if (body.expectedCommit === undefined) return undefined;
  if (typeof body.expectedCommit !== 'string' || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(body.expectedCommit)) {
    throw new SkillInstallError('expectedCommit must be a full catalog commit hash');
  }
  return body.expectedCommit;
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

/**
 * Skills the agent wrote in its own workspace (`groups/<folder>/skills`).
 * Group-scoped, always active, and not installable or removable from here —
 * the agent owns this directory.
 */
function workspaceCatalog(gid: string): MarketplaceCatalog | null {
  const group = getAgentGroup(gid);
  if (!group) return null;

  const skills = listSkills(groupSkillRoots(group.folder))
    .filter((skill) => skill.origin === 'workspace')
    .map((skill) => ({
      marketplaceId: WORKSPACE_CATALOG_ID,
      plugin: WORKSPACE_CATALOG_ID,
      slug: skill.slug,
      name: skill.name,
      description: skill.description,
      license: skill.license,
      path: `groups/${group.folder}/skills/${skill.slug}`,
      warnings: skill.warnings,
    }));
  if (skills.length === 0) return null;

  return {
    id: WORKSPACE_CATALOG_ID,
    repo: `groups/${group.folder}/skills`,
    source: null,
    ref: '',
    label: 'Workspace',
    description: 'Written by this agent in its own workspace. Always active, and only for this group.',
    commit: null,
    refreshedAt: null,
    kind: 'workspace',
    plugins: [{ name: WORKSPACE_CATALOG_ID, description: null, skills, unsupportedReason: null }],
    error: null,
  };
}

export function getSkillsOverview(gid?: string): SkillsAdminResult {
  const group = gid ? getAgentGroup(gid) : null;
  const workspace = gid ? workspaceCatalog(gid) : null;
  return {
    status: 200,
    body: {
      skills: listAvailableSkills(group ? groupSkillRoots(group.folder) : undefined),
      catalogs: [builtinCatalog(), ...(workspace ? [workspace] : []), ...listCatalogs()],
    },
  };
}

/** Resolve the group folder installs are vendored into, or throw a 400. */
function groupFolderOf(gid: string): string {
  const group = getAgentGroup(gid);
  if (!group) throw new SkillInstallError(`unknown agent group "${gid}"`);
  return group.folder;
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
  const gid = str(body.gid);
  const marketplaceId = str(body.marketplaceId);
  const plugin = str(body.plugin);
  const slug = str(body.slug);
  const acknowledgeRisk = body.acknowledgeRisk === true;
  if (!gid || !marketplaceId || !plugin || !slug) {
    return { status: 400, body: { error: 'gid, marketplaceId, plugin and slug are required' } };
  }
  try {
    const expectedCommit = expectedCommitOf(body);
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

    const record = installCatalogSkill({
      groupFolder: groupFolderOf(gid),
      marketplaceId,
      plugin,
      slug,
      expectedCommit,
    });
    recordAdminAction({
      actorUserId,
      action: 'skill_install',
      targetKind: 'skill',
      targetId: slug,
      payload: {
        agentGroupId: gid,
        repo: record.repo,
        ref: record.ref,
        commit: record.commit,
        path: record.sourcePath,
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
    const configured = new Map(readMarketplaceRecords().map((record) => [record.repo, record]));
    const bySource = new Map<
      string,
      {
        source: string;
        catalogId: string | null;
        snapshot: { commit: string; ref: string } | null;
        skills: typeof result.skills;
      }
    >();

    for (const skill of result.skills) {
      let group = bySource.get(skill.source);
      if (!group) {
        let catalog: MarketplaceRecord | undefined;
        try {
          catalog = configured.get(normalizeRepoSource(skill.source));
        } catch {
          continue; // A source we could never turn into a catalog (e.g. a bare domain).
        }
        group = {
          source: skill.source,
          catalogId: catalog?.id ?? null,
          snapshot: catalog?.commit ? { commit: catalog.commit, ref: catalog.ref } : null,
          skills: [],
        };
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
  const gid = str(body.gid);
  const repo = str(body.repo);
  const slug = str(body.slug);
  const acknowledgeRisk = body.acknowledgeRisk === true;
  if (!gid || !repo || !slug) return { status: 400, body: { error: 'gid, repo and slug are required' } };

  let audits: AuditEntry[] | null = null;
  try {
    const expectedCommit = expectedCommitOf(body);
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
      record = addMarketplace({ repo, ref: str(body.ref) || undefined, expectedCommit });
      recordAdminAction({
        actorUserId,
        action: 'skill_catalog_add',
        targetKind: 'skill_catalog',
        targetId: record.id,
        payload: { repo: record.repo, ref: record.ref, via: 'discover' },
      });
    }

    assertCatalogSnapshot(record, expectedCommit ?? record.commit);
    const plugin = readCatalog(record).plugins.find((entry) => entry.skills.some((s) => s.slug === slug));
    if (!plugin) {
      return { status: 404, body: { error: `"${slug}" is not in ${record.repo}` } };
    }

    const installed = installCatalogSkill({
      groupFolder: groupFolderOf(gid),
      marketplaceId: record.id,
      plugin: plugin.name,
      slug,
      expectedCommit,
    });
    recordAdminAction({
      actorUserId,
      action: 'skill_install',
      targetKind: 'skill',
      targetId: slug,
      payload: {
        agentGroupId: gid,
        repo: installed.repo,
        ref: installed.ref,
        commit: installed.commit,
        path: installed.sourcePath,
        via: 'discover',
        auditAcknowledged: acknowledgeRisk && audits !== null && auditIsBlocking(audits),
      },
    });
    return { status: 200, body: { skill: installed } };
  } catch (err) {
    return fail(err);
  }
}

export function removeSkill(gid: string, slug: string, actorUserId: string, force = false): SkillsAdminResult {
  if (!gid) return { status: 400, body: { error: 'gid is required' } };
  try {
    uninstallSkill(groupFolderOf(gid), slug, force);
    recordAdminAction({
      actorUserId,
      action: 'skill_uninstall',
      targetKind: 'skill',
      targetId: slug,
      payload: { agentGroupId: gid, force },
    });
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
