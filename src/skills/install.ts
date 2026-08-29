/**
 * Installing skills from a catalog into `data/skills/installed/`.
 *
 * The copy is deliberately dumb: walk the source tree, refuse anything
 * surprising, write files. No scripts run at install time — a skill only ever
 * executes after an operator selects it for a group and the agent chooses to
 * use it. What we do record is provenance (repo/ref/commit/path) and a digest
 * of the installed tree, so an upstream change is visible instead of silent.
 */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

import { parseSkillFrontmatter, validateSkillFrontmatter, SKILL_NAME_RE, MAX_SKILL_NAME_LEN } from './frontmatter.js';
import { findCatalogSkill, MarketplaceError, resolveWithin } from './marketplace.js';
import { defaultSkillRoots, listSkills } from './registry.js';
import {
  deleteInstalledRecord,
  getInstalledRecord,
  getMarketplaceRecord,
  installedSkillsDir,
  marketplaceCacheDir,
  putInstalledRecord,
  readInstalledRecords,
  type InstalledSkillRecord,
} from './store.js';

export class SkillInstallError extends Error {}

const MAX_TREE_BYTES = 32 * 1024 * 1024;
const MAX_TREE_FILES = 2000;

interface WalkedFile {
  /** Path relative to the tree root, using forward slashes. */
  rel: string;
  abs: string;
  size: number;
  mode: number;
}

/**
 * Enumerate a skill tree, rejecting symlinks and non-regular files. A symlink
 * inside an installed skill would resolve against the container's filesystem
 * and could point straight out of the read-only mount.
 */
function walkTree(root: string): WalkedFile[] {
  const files: WalkedFile[] = [];
  let bytes = 0;

  const visit = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const abs = path.join(dir, entry.name);
      const rel = path.relative(root, abs).split(path.sep).join('/');
      if (entry.isSymbolicLink()) {
        throw new SkillInstallError(`refusing to install: "${rel}" is a symlink`);
      }
      if (entry.isDirectory()) {
        if (entry.name === '.git') continue;
        visit(abs);
        continue;
      }
      if (!entry.isFile()) {
        throw new SkillInstallError(`refusing to install: "${rel}" is not a regular file`);
      }
      const stat = fs.statSync(abs);
      bytes += stat.size;
      files.push({ rel, abs, size: stat.size, mode: stat.mode });
      if (files.length > MAX_TREE_FILES) {
        throw new SkillInstallError(`skill has more than ${MAX_TREE_FILES} files`);
      }
      if (bytes > MAX_TREE_BYTES) {
        throw new SkillInstallError(`skill exceeds ${Math.round(MAX_TREE_BYTES / 1024 / 1024)}MB`);
      }
    }
  };

  visit(root);
  return files;
}

/** sha256 over the tree's relative paths and contents — order-independent. */
export function skillTreeDigest(root: string): string {
  const hash = crypto.createHash('sha256');
  for (const file of walkTree(root)) {
    hash.update(file.rel);
    hash.update('\0');
    hash.update(fs.readFileSync(file.abs));
    hash.update('\0');
  }
  return hash.digest('hex');
}

function assertInstallableSlug(slug: string): void {
  if (!SKILL_NAME_RE.test(slug) || slug.length > MAX_SKILL_NAME_LEN) {
    throw new SkillInstallError(`"${slug}" is not a valid skill name`);
  }
  const clash = listSkills(defaultSkillRoots()).find((skill) => skill.slug === slug && skill.origin === 'builtin');
  if (clash) {
    throw new SkillInstallError(`"${slug}" is a built-in skill and cannot be replaced`);
  }
}

function assertValidSkillSource(dir: string, slug: string): { license: string | null } {
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
  return { license: frontmatter.license };
}

/** Copy into a temp sibling then rename, so a failure never leaves a half-skill. */
function copyTreeAtomic(source: string, target: string): void {
  const files = walkTree(source);
  const staging = `${target}.tmp-${process.pid}-${Date.now().toString(36)}`;
  fs.rmSync(staging, { recursive: true, force: true });

  try {
    for (const file of files) {
      const dest = path.join(staging, file.rel);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(file.abs, dest);
      // Preserve only the executable bit; never setuid/setgid/sticky.
      fs.chmodSync(dest, file.mode & 0o111 ? 0o755 : 0o644);
    }
    fs.rmSync(target, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.renameSync(staging, target);
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

export interface InstallRequest {
  marketplaceId: string;
  plugin: string;
  slug: string;
  actorUserId?: string | null;
}

export function installCatalogSkill(request: InstallRequest): InstalledSkillRecord {
  const record = getMarketplaceRecord(request.marketplaceId);
  if (!record) throw new MarketplaceError(`unknown catalog "${request.marketplaceId}"`);

  const entry = findCatalogSkill(request.marketplaceId, request.plugin, request.slug);
  if (!entry) throw new SkillInstallError(`"${request.slug}" is not in ${request.marketplaceId}/${request.plugin}`);

  assertInstallableSlug(entry.slug);

  const sourceDir = resolveWithin(marketplaceCacheDir(record.id), entry.path);
  if (!sourceDir || !fs.existsSync(sourceDir)) {
    throw new SkillInstallError('source path is no longer present — refresh the catalog');
  }
  const { license } = assertValidSkillSource(sourceDir, entry.slug);

  const target = path.join(installedSkillsDir(), entry.slug);
  copyTreeAtomic(sourceDir, target);

  const installed: InstalledSkillRecord = {
    slug: entry.slug,
    marketplaceId: record.id,
    plugin: entry.plugin,
    repo: record.repo,
    ref: record.ref,
    commit: record.commit ?? 'unknown',
    path: entry.path,
    license,
    digest: skillTreeDigest(target),
    installedAt: new Date().toISOString(),
    installedBy: request.actorUserId ?? null,
  };
  putInstalledRecord(installed);
  return installed;
}

export function uninstallSkill(slug: string): void {
  const record = getInstalledRecord(slug);
  const target = path.join(installedSkillsDir(), slug);
  if (!record && !fs.existsSync(target)) {
    throw new SkillInstallError(`"${slug}" is not an installed skill`);
  }
  fs.rmSync(target, { recursive: true, force: true });
  deleteInstalledRecord(slug);
}

/**
 * Compare each installed skill's digest against its source in the catalog
 * cache. `null` means we can't tell (catalog removed, or never refreshed).
 */
export function installedUpdateStatus(): Record<string, boolean | null> {
  const out: Record<string, boolean | null> = {};
  for (const [slug, record] of Object.entries(readInstalledRecords())) {
    if (!record.marketplaceId || !getMarketplaceRecord(record.marketplaceId)) {
      out[slug] = null;
      continue;
    }
    const sourceDir = resolveWithin(marketplaceCacheDir(record.marketplaceId), record.path);
    if (!sourceDir || !fs.existsSync(sourceDir)) {
      out[slug] = null;
      continue;
    }
    try {
      out[slug] = skillTreeDigest(sourceDir) !== record.digest;
    } catch {
      out[slug] = null;
    }
  }
  return out;
}
