/**
 * Installing a catalog skill into an agent group's workspace.
 *
 * A skill is vendored as a sparse checkout: the catalog is cloned once per
 * group into `<group>/skills/.catalogs/<id>` with only the paths that group
 * actually uses, and each installed skill is a symlink from
 * `<group>/skills/<slug>` into that clone. Adding a second skill from the same
 * catalog costs one more sparse path and one more symlink, not another clone.
 *
 * Nothing custom is written into the repo — `git remote`, `git rev-parse` and
 * `git sparse-checkout list` already record everything we need, so provenance
 * travels with the directory and can't drift out of sync with the files.
 */
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import { parseSkillFrontmatter, validateSkillFrontmatter, SKILL_NAME_RE, MAX_SKILL_NAME_LEN } from './frontmatter.js';
import { findCatalogSkill, MarketplaceError, resolveWithin } from './marketplace.js';
import { defaultSkillRoots, groupCatalogsDir, listSkills, CATALOGS_DIRNAME } from './registry.js';
import { getMarketplaceRecord } from './store.js';

export class SkillInstallError extends Error {}

const GIT_TIMEOUT_MS = 120_000;

function git(args: string[], cwd?: string): string {
  return execFileSync('git', args, {
    cwd,
    timeout: GIT_TIMEOUT_MS,
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '/bin/true', GCM_INTERACTIVE: 'never' },
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

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
  const target = path.join(path.dirname(groupCatalogsDir(groupFolder)), slug);
  if (fs.existsSync(target) || isBrokenLink(target)) {
    throw new SkillInstallError(`"${slug}" already exists in this agent's skills`);
  }
}

function isBrokenLink(p: string): boolean {
  try {
    fs.lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Clone the catalog into the group (sparse, blob-filtered) if it isn't there
 * yet, then make sure `sourcePath` is one of the checked-out paths.
 */
function ensureCatalogCheckout(
  groupFolder: string,
  catalogId: string,
  repo: string,
  ref: string,
  sourcePath: string,
): string {
  const repoDir = path.join(groupCatalogsDir(groupFolder), catalogId);

  try {
    if (!fs.existsSync(path.join(repoDir, '.git'))) {
      fs.rmSync(repoDir, { recursive: true, force: true });
      fs.mkdirSync(path.dirname(repoDir), { recursive: true });
      git([
        'clone',
        '--filter=blob:none',
        '--no-checkout',
        '--depth',
        '1',
        '--single-branch',
        '--branch',
        ref,
        '--',
        repo,
        repoDir,
      ]);
      git(['sparse-checkout', 'init', '--cone'], repoDir);
      git(['sparse-checkout', 'set', sourcePath], repoDir);
    } else {
      git(['sparse-checkout', 'add', sourcePath], repoDir);
    }
    git(['checkout'], repoDir);
  } catch (err) {
    const detail = err instanceof Error ? err.message.split('\n')[0] : String(err);
    throw new SkillInstallError(`git checkout failed: ${detail}`);
  }

  return repoDir;
}

function assertValidSkillSource(dir: string, slug: string): void {
  let markdown: string;
  try {
    markdown = fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8');
  } catch {
    throw new SkillInstallError('source has no SKILL.md');
  }
  const frontmatter = parseSkillFrontmatter(markdown);
  const { errors } = validateSkillFrontmatter(frontmatter, slug);
  if (!frontmatter || errors.length > 0) {
    throw new SkillInstallError(`invalid SKILL.md: ${errors.join('; ') || 'unparseable frontmatter'}`);
  }
}

export interface InstallRequest {
  groupFolder: string;
  marketplaceId: string;
  plugin: string;
  slug: string;
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

  const entry = findCatalogSkill(request.marketplaceId, request.plugin, request.slug);
  if (!entry) throw new SkillInstallError(`"${request.slug}" is not in ${request.marketplaceId}/${request.plugin}`);

  assertInstallableSlug(entry.slug, request.groupFolder);

  const repoDir = ensureCatalogCheckout(request.groupFolder, record.id, record.repo, record.ref, entry.path);
  const contentDir = resolveWithin(repoDir, entry.path);
  if (!contentDir || !fs.existsSync(contentDir)) {
    throw new SkillInstallError(`"${entry.path}" is missing from ${record.repo}`);
  }
  assertValidSkillSource(contentDir, entry.slug);

  // Relative so the link resolves identically on the host and at
  // /workspace/agent/skills inside the container.
  const skillsRoot = path.dirname(groupCatalogsDir(request.groupFolder));
  const linkPath = path.join(skillsRoot, entry.slug);
  fs.symlinkSync(path.join(CATALOGS_DIRNAME, record.id, entry.path), linkPath);

  return {
    slug: entry.slug,
    catalogId: record.id,
    repo: record.repo,
    ref: record.ref,
    commit: git(['rev-parse', 'HEAD'], repoDir),
    sourcePath: entry.path,
  };
}

/**
 * Remove an installed skill. Only the symlink goes; the catalog checkout stays
 * for the other skills sharing it. Refuses when the agent has uncommitted work
 * in the skill unless forced, so an uninstall can't silently discard it.
 */
export function uninstallSkill(groupFolder: string, slug: string, force = false): void {
  const skillsRoot = path.dirname(groupCatalogsDir(groupFolder));
  const linkPath = path.join(skillsRoot, slug);
  if (!isBrokenLink(linkPath)) throw new SkillInstallError(`"${slug}" is not installed for this agent`);
  if (!fs.lstatSync(linkPath).isSymbolicLink()) {
    throw new SkillInstallError(`"${slug}" is an authored skill — delete it from the workspace instead`);
  }

  if (!force) {
    const resolved = fs.realpathSync(linkPath);
    const dirty = execFileSync('git', ['status', '--porcelain', '--', '.'], {
      cwd: resolved,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (dirty !== '') {
      throw new SkillInstallError(`"${slug}" has uncommitted local changes — pass force to remove it anyway`);
    }
  }

  fs.rmSync(linkPath, { force: true });
}
