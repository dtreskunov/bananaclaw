/**
 * Installing a catalog skill into an agent group's workspace.
 *
 * A skill is vendored from the browsing cache into an independent sparse
 * checkout at `<group>/skills/.catalogs/<id>@<commit>`. Revisions are isolated
 * so a newer install cannot update existing skills. Unmodified checkouts at
 * the same revision are reused; an edited checkout gets a separate sibling.
 *
 * Nothing custom is written into the repo — `git remote`, `git rev-parse` and
 * `git sparse-checkout list` already record everything we need, so provenance
 * travels with the directory and can't drift out of sync with the files.
 */
import fs from 'fs';
import path from 'path';

import { readSkillManifest, SKILL_NAME_RE, MAX_SKILL_NAME_LEN } from './frontmatter.js';
import { git, gitErrorDetail, gitOrNull } from './git.js';
import { assertCatalogSnapshot, findCatalogSkill, MarketplaceError, resolveWithin } from './marketplace.js';
import { defaultSkillRoots, groupCatalogsDir, groupSkillsDir, listSkills } from './registry.js';
import { getMarketplaceRecord, marketplaceCacheDir } from './store.js';

export class SkillInstallError extends Error {}

function assertInstallableSlug(slug: string, groupFolder: string): void {
  if (!SKILL_NAME_RE.test(slug) || slug.length > MAX_SKILL_NAME_LEN) {
    throw new SkillInstallError(`"${slug}" is not a valid skill name`);
  }
  const builtin = listSkills(defaultSkillRoots()).find((skill) => skill.slug === slug);
  if (builtin) {
    throw new SkillInstallError(`"${slug}" is a built-in skill and cannot be replaced`);
  }
  // One namespace per group: an authored skill and an installed one can't
  // share a slug, so refuse rather than clobbering the agent's own work.
  const target = path.join(groupSkillsDir(groupFolder), slug);
  if (entryExists(target)) {
    throw new SkillInstallError(`"${slug}" already exists in this agent's skills`);
  }
}

/** True for any existing entry, including a dangling symlink. */
function entryExists(p: string): boolean {
  try {
    fs.lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Copy Git objects from the cache, never borrow them: removing or refreshing
 * the browsing cache must not affect installed skills.
 */
function ensureCatalogCheckout(
  groupFolder: string,
  catalogId: string,
  repo: string,
  commit: string,
  sourcePath: string,
): string {
  const baseDir = path.join(groupCatalogsDir(groupFolder), `${catalogId}@${commit}`);
  let stagingDir: string | null = null;

  try {
    if (
      fs.existsSync(path.join(baseDir, '.git')) &&
      git(['rev-parse', 'HEAD'], baseDir) === commit &&
      git(['remote', 'get-url', 'origin'], baseDir) === repo &&
      git(
        ['--literal-pathspecs', 'status', '--porcelain', '--untracked-files=all', '--ignored', '--', sourcePath],
        baseDir,
      ) === ''
    ) {
      git(['sparse-checkout', 'add', '--', sourcePath], baseDir);
      return baseDir;
    }

    fs.mkdirSync(path.dirname(baseDir), { recursive: true });
    stagingDir = fs.mkdtempSync(`${baseDir}-`);
    git([
      'clone',
      '--no-local',
      '--no-checkout',
      '--depth',
      '1',
      '--single-branch',
      '--no-tags',
      '--',
      marketplaceCacheDir(catalogId),
      stagingDir,
    ]);
    git(['sparse-checkout', 'init', '--cone'], stagingDir);
    git(['sparse-checkout', 'set', '--', sourcePath], stagingDir);
    git(['checkout', '--detach', commit], stagingDir);
    git(['remote', 'set-url', 'origin', repo], stagingDir);

    // Never reset or replace an existing checkout, including legacy layouts.
    const repoDir = entryExists(baseDir) ? stagingDir : baseDir;
    if (repoDir !== stagingDir) fs.renameSync(stagingDir, repoDir);
    stagingDir = null;
    return repoDir;
  } catch (err) {
    throw new SkillInstallError(`git checkout failed: ${gitErrorDetail(err)}`);
  } finally {
    if (stagingDir) fs.rmSync(stagingDir, { recursive: true, force: true });
  }
}

function assertValidSkillSource(dir: string, slug: string): void {
  const manifest = readSkillManifest(dir, slug);
  if (!manifest) throw new SkillInstallError('source has no SKILL.md');
  if (!manifest.frontmatter || manifest.errors.length > 0) {
    throw new SkillInstallError(`invalid SKILL.md: ${manifest.errors.join('; ') || 'unparseable frontmatter'}`);
  }
}

export interface InstallRequest {
  groupFolder: string;
  marketplaceId: string;
  plugin: string;
  slug: string;
  /** Commit displayed by the UI. Omission selects the current cached snapshot. */
  expectedCommit?: string;
}

export interface InstalledSkill {
  slug: string;
  catalogId: string;
  repo: string;
  ref: string;
  commit: string;
  sourcePath: string;
}

export function installCatalogSkill(request: InstallRequest): InstalledSkill {
  const record = getMarketplaceRecord(request.marketplaceId);
  if (!record) throw new MarketplaceError(`unknown catalog "${request.marketplaceId}"`);

  const commit = assertCatalogSnapshot(record, request.expectedCommit ?? record.commit);
  const entry = findCatalogSkill(request.marketplaceId, request.plugin, request.slug);
  if (!entry) throw new SkillInstallError(`"${request.slug}" is not in ${request.marketplaceId}/${request.plugin}`);

  assertInstallableSlug(entry.slug, request.groupFolder);

  const repoDir = ensureCatalogCheckout(request.groupFolder, record.id, record.repo, commit, entry.path);
  const contentDir = resolveWithin(repoDir, entry.path);
  if (!contentDir || !fs.existsSync(contentDir)) {
    throw new SkillInstallError(`"${entry.path}" is missing from ${record.repo}`);
  }
  assertValidSkillSource(contentDir, entry.slug);

  // Relative so the link resolves identically on the host and at
  // /workspace/agent/skills inside the container.
  const linkPath = path.join(groupSkillsDir(request.groupFolder), entry.slug);
  fs.symlinkSync(path.relative(groupSkillsDir(request.groupFolder), contentDir), linkPath);

  return {
    slug: entry.slug,
    catalogId: record.id,
    repo: record.repo,
    ref: record.ref,
    commit,
    sourcePath: entry.path,
  };
}

/**
 * Remove an installed skill. Only the symlink goes; the catalog checkout stays
 * for the other skills sharing it. Refuses when the agent has uncommitted work
 * in the skill unless forced, so an uninstall can't silently discard it.
 */
export function uninstallSkill(groupFolder: string, slug: string, force = false): void {
  const linkPath = path.join(groupSkillsDir(groupFolder), slug);
  if (!entryExists(linkPath)) throw new SkillInstallError(`"${slug}" is not installed for this agent`);
  if (!fs.lstatSync(linkPath).isSymbolicLink()) {
    throw new SkillInstallError(`"${slug}" is an authored skill — delete it from the workspace instead`);
  }

  if (!force) {
    const dirty = gitOrNull(['status', '--porcelain', '--', '.'], fs.realpathSync(linkPath));
    if (dirty !== null && dirty !== '') {
      throw new SkillInstallError(`"${slug}" has uncommitted local changes — pass force to remove it anyway`);
    }
  }

  fs.rmSync(linkPath, { force: true });
}
