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
import { randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';

import { readSkillManifest, SKILL_NAME_RE, MAX_SKILL_NAME_LEN } from './frontmatter.js';
import { git, gitErrorDetail, gitOrNull } from './git.js';
import {
  assertCatalogSnapshot,
  findCatalogSkill,
  MarketplaceError,
  readCatalog,
  resolveWithin,
} from './marketplace.js';
import { CATALOGS_DIRNAME, defaultSkillRoots, groupCatalogsDir, groupSkillsDir, listSkills } from './registry.js';
import { findRepoRoot } from './skill-git.js';
import { getMarketplaceRecord, marketplaceCacheDir } from './store.js';

export class SkillInstallError extends Error {}

function assertReplaceableSlug(slug: string): void {
  if (!SKILL_NAME_RE.test(slug) || slug.length > MAX_SKILL_NAME_LEN) {
    throw new SkillInstallError(`"${slug}" is not a valid skill name`);
  }
  const builtin = listSkills(defaultSkillRoots()).find((skill) => skill.slug === slug);
  if (builtin) {
    throw new SkillInstallError(`"${slug}" is a built-in skill and cannot be replaced`);
  }
}

function assertInstallableSlug(slug: string, groupFolder: string): void {
  assertReplaceableSlug(slug);
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
      fs.lstatSync(baseDir).isDirectory() &&
      fs.lstatSync(path.join(baseDir, '.git')).isDirectory() &&
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
  /** Reviewed commit. Optional for install (current cache); required for update. */
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

function resolveManagedSkill(groupFolder: string, slug: string) {
  assertReplaceableSlug(slug);
  if (!groupFolder || path.basename(groupFolder) !== groupFolder || groupFolder === '.' || groupFolder === '..') {
    throw new SkillInstallError('invalid group folder');
  }
  const linkPath = path.join(groupSkillsDir(groupFolder), slug);
  if (!entryExists(linkPath)) throw new SkillInstallError(`"${slug}" is not installed for this agent`);
  if (!fs.lstatSync(linkPath).isSymbolicLink()) {
    throw new SkillInstallError(`"${slug}" is an authored skill and cannot be updated from a catalog`);
  }

  const unmanaged = () => new SkillInstallError(`"${slug}" is not a managed catalog symlink for this agent`);
  let contentDir: string;
  let catalogs: string;
  try {
    contentDir = fs.realpathSync(linkPath);
    const skillsDir = fs.realpathSync(groupSkillsDir(groupFolder));
    catalogs = path.join(skillsDir, CATALOGS_DIRNAME);
    if (fs.realpathSync(catalogs) !== catalogs) throw unmanaged();
    // Refuse intermediate symlinks, including a checkout redirected outside
    // this group. Only the skill's top-level managed link may be a symlink.
    const relative = path.relative(
      path.dirname(linkPath),
      path.resolve(path.dirname(linkPath), fs.readlinkSync(linkPath)),
    );
    if (path.resolve(skillsDir, relative) !== contentDir) throw unmanaged();
  } catch {
    throw unmanaged();
  }
  const repoDir = findRepoRoot(contentDir);
  if (!repoDir || path.dirname(repoDir) !== catalogs) throw unmanaged();
  if (
    !fs.lstatSync(path.join(repoDir, '.git')).isDirectory() ||
    gitOrNull(['rev-parse', '--show-toplevel'], repoDir) !== repoDir
  ) {
    throw unmanaged();
  }
  const identity = /^([a-z0-9][a-z0-9._-]{0,63})(?:@([a-f0-9]{40}|[a-f0-9]{64})(?:-[A-Za-z0-9]+)?)?$/.exec(
    path.basename(repoDir),
  );
  if (!identity) throw unmanaged();
  const record = getMarketplaceRecord(identity[1]);
  if (!record) throw new SkillInstallError(`catalog "${identity[1]}" is no longer registered`);
  if (gitOrNull(['remote', 'get-url', 'origin'], repoDir) !== record.repo) {
    throw new SkillInstallError('installed skill origin does not match the registered catalog repository');
  }
  const sourcePath = path.relative(repoDir, contentDir).split(path.sep).join('/');
  if (!sourcePath) throw unmanaged();
  return { linkPath, repoDir, sourcePath, record, revision: identity[2] };
}

/**
 * Resolve an installed skill against the local browsing snapshot, never the
 * upstream, rejecting local work before an audit is started. The returned
 * commit must be retained across any asynchronous audit.
 */
export function resolveSkillUpdate(groupFolder: string, slug: string): InstallRequest {
  const installed = resolveManagedSkill(groupFolder, slug);
  assertUnmodifiedSkill(installed);
  const { sourcePath, record } = installed;
  const expectedCommit = assertCatalogSnapshot(record);
  const entries = readCatalog(record).plugins.flatMap((plugin) => plugin.skills);
  const matches = entries.filter((entry) => entry.slug === slug && entry.path === sourcePath);
  if (matches.length === 0) {
    throw new SkillInstallError(`"${slug}" at "${sourcePath}" is missing from the cached catalog; it may have moved`);
  }
  if (
    matches.length !== 1 ||
    entries.filter((entry) => entry.slug === slug && entry.plugin === matches[0].plugin).length !== 1
  ) {
    throw new SkillInstallError(`"${slug}" at "${sourcePath}" is ambiguous in the cached catalog`);
  }
  return { groupFolder, marketplaceId: record.id, plugin: matches[0].plugin, slug, expectedCommit };
}

function assertUnmodifiedSkill(installed: ReturnType<typeof resolveManagedSkill>): string {
  const { repoDir, sourcePath, revision, record } = installed;
  const status = gitOrNull(
    ['--literal-pathspecs', 'status', '--porcelain', '--untracked-files=all', '--ignored', '--', sourcePath],
    repoDir,
  );
  if (status === null) throw new SkillInstallError('cannot determine installed skill local changes');
  if (status !== '')
    throw new SkillInstallError('installed skill has uncommitted local changes (including ignored files)');

  // Revision checkouts pin their original base in the directory name. Legacy
  // clones have only their original remote-tracking refs; never fetch to infer it.
  const base = revision
    ? gitOrNull(['rev-parse', '--verify', `${revision}^{commit}`], repoDir)
    : (gitOrNull(['rev-parse', '--verify', 'refs/remotes/origin/HEAD^{commit}'], repoDir) ??
      gitOrNull(['rev-parse', '--verify', `refs/remotes/origin/${record.ref}^{commit}`], repoDir));
  const head = gitOrNull(['rev-parse', '--verify', 'HEAD^{commit}'], repoDir);
  if (!base || !head || gitOrNull(['merge-base', '--is-ancestor', base, head], repoDir) === null) {
    throw new SkillInstallError('cannot determine installed skill original base; refusing to discard local commits');
  }
  const local = gitOrNull(
    ['--literal-pathspecs', 'rev-list', '--full-history', `${base}..${head}`, '--', sourcePath],
    repoDir,
  );
  if (local === null) throw new SkillInstallError('cannot determine installed skill local commits');
  if (local !== '') throw new SkillInstallError('installed skill has local commits; preserve them before updating');
  return head;
}

/**
 * Replace only the selected link, after validating the pinned request and
 * preparing an independent checkout. Selection/disabled state is not changed.
 */
export function updateCatalogSkill(request: InstallRequest): InstalledSkill {
  const resolved = resolveSkillUpdate(request.groupFolder, request.slug);
  if (
    !request.expectedCommit ||
    request.expectedCommit !== resolved.expectedCommit ||
    request.marketplaceId !== resolved.marketplaceId ||
    request.plugin !== resolved.plugin
  ) {
    throw new SkillInstallError('skill update request changed or is stale; resolve and review again');
  }
  const installed = resolveManagedSkill(request.groupFolder, request.slug);
  const head = assertUnmodifiedSkill(installed);
  const { record, sourcePath, linkPath } = installed;
  const commit = request.expectedCommit;
  const result = { slug: request.slug, catalogId: record.id, repo: record.repo, ref: record.ref, commit, sourcePath };
  if (head === commit) return result;

  const repoDir = ensureCatalogCheckout(request.groupFolder, record.id, record.repo, commit, sourcePath);
  const contentDir = resolveWithin(repoDir, sourcePath);
  if (
    !contentDir ||
    !fs.existsSync(contentDir) ||
    fs.realpathSync(contentDir) !== path.resolve(fs.realpathSync(repoDir), sourcePath)
  ) {
    throw new SkillInstallError(`"${sourcePath}" is missing or redirected in ${record.repo}`);
  }
  assertValidSkillSource(contentDir, request.slug);

  const temporaryLink = path.join(path.dirname(linkPath), `.${request.slug}-update-${randomUUID()}`);
  try {
    fs.symlinkSync(path.relative(path.dirname(linkPath), contentDir), temporaryLink);
    fs.renameSync(temporaryLink, linkPath);
  } finally {
    if (entryExists(temporaryLink)) fs.unlinkSync(temporaryLink);
  }
  return result;
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
