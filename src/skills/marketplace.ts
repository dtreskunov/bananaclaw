/**
 * Skill catalogs — Claude Code plugin marketplaces and plain skill repos.
 *
 * A marketplace is a git repo. If it carries `.claude-plugin/marketplace.json`
 * we read the plugin bundles from it (the format `/plugin marketplace add`
 * uses); otherwise we fall back to scanning for `<dir>/SKILL.md`, which covers
 * any repo that just follows the Agent Skills layout.
 *
 * Repos are cloned shallow into `data/skills/cache/<id>` and only ever read.
 * Nothing here executes repo content — installing is a plain file copy, and
 * skills only run once an operator selects them for a group.
 */
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import { log } from '../log.js';
import { parseSkillFrontmatter, validateSkillFrontmatter, SKILL_NAME_RE } from './frontmatter.js';
import {
  deleteMarketplaceRecord,
  getMarketplaceRecord,
  marketplaceCacheDir,
  putMarketplaceRecord,
  readMarketplaceRecords,
  type MarketplaceRecord,
} from './store.js';

const GIT_TIMEOUT_MS = 120_000;
const MAX_SKILL_MD_BYTES = 256 * 1024;
const MARKETPLACE_MANIFEST = path.join('.claude-plugin', 'marketplace.json');
const SCAN_MAX_DEPTH = 3;
const SCAN_MAX_SKILLS = 500;
const SCAN_SKIP = new Set(['.git', '.github', 'node_modules', 'dist', 'build', '.venv', 'venv']);

export class MarketplaceError extends Error {}

export interface CatalogSkill {
  marketplaceId: string;
  plugin: string;
  slug: string;
  name: string;
  description: string;
  license: string | null;
  /** Path within the repo, e.g. `skills/pdf`. */
  path: string;
  warnings: string[];
}

export interface CatalogPlugin {
  name: string;
  description: string | null;
  skills: CatalogSkill[];
  /** Set when the plugin can't be read (e.g. it points at another repo). */
  unsupportedReason: string | null;
}

export interface MarketplaceCatalog {
  id: string;
  repo: string;
  /** GitHub `owner/repo`, used to look this catalog's skills up in the directory. */
  source: string | null;
  ref: string;
  label: string | null;
  description: string | null;
  commit: string | null;
  refreshedAt: string | null;
  /** Manifest-driven, a scanned layout, or one of the read-only local sets. */
  kind: 'plugin-marketplace' | 'skill-repo' | 'built-in' | 'workspace';
  plugins: CatalogPlugin[];
  error: string | null;
}

/** `https://github.com/owner/repo.git` → `owner/repo`; null for other sources. */
export function githubSourceOf(repo: string): string | null {
  const m = /^https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(repo);
  return m ? `${m[1]}/${m[2]}` : null;
}

// ── source validation ─────────────────────────────────────────────────────

const REF_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/;
const ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const SHORTHAND_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * Accept `owner/repo`, an https URL, or an absolute path to a local clone.
 * Everything else (ssh, git://, file://, option-looking strings) is refused —
 * these values become `git` arguments.
 */
export function normalizeRepoSource(input: string): string {
  const value = input.trim();
  const hasControlChars = [...value].some((char) => char.charCodeAt(0) < 0x20);
  if (value === '' || value.startsWith('-') || hasControlChars) {
    throw new MarketplaceError('invalid repository');
  }
  if (SHORTHAND_RE.test(value)) return `https://github.com/${value}.git`;
  if (/^https:\/\/[^\s]+$/.test(value)) return value;
  if (path.isAbsolute(value) && fs.existsSync(path.join(value, '.git'))) return value;
  throw new MarketplaceError('repository must be owner/repo, an https URL, or a path to a local clone');
}

function assertRef(ref: string): string {
  if (!REF_RE.test(ref)) throw new MarketplaceError(`invalid ref "${ref}"`);
  return ref;
}

/** Derive a stable cache/store id from the repo when the caller gives none. */
function deriveId(repo: string): string {
  const base = repo
    .replace(/\.git$/, '')
    .split(/[/\\]/)
    .filter(Boolean)
    .slice(-2)
    .join('-')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return ID_RE.test(base) ? base : `marketplace-${Date.now()}`;
}

// ── git ───────────────────────────────────────────────────────────────────

function git(args: string[], cwd?: string): string {
  return execFileSync('git', args, {
    cwd,
    timeout: GIT_TIMEOUT_MS,
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
    // Never let git block on a credential prompt inside the host process.
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '/bin/true', GCM_INTERACTIVE: 'never' },
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

/** Clone or fast-forward the cache for a source. Returns the current commit. */
export function syncMarketplaceCache(record: MarketplaceRecord): string {
  const dir = marketplaceCacheDir(record.id);
  const ref = assertRef(record.ref);
  try {
    if (fs.existsSync(path.join(dir, '.git'))) {
      git(['fetch', '--depth', '1', 'origin', ref], dir);
      git(['reset', '--hard', 'FETCH_HEAD'], dir);
      git(['clean', '-fdx'], dir);
    } else {
      fs.rmSync(dir, { recursive: true, force: true });
      fs.mkdirSync(path.dirname(dir), { recursive: true });
      git(['clone', '--depth', '1', '--single-branch', '--branch', ref, '--', record.repo, dir]);
    }
    return git(['rev-parse', 'HEAD'], dir);
  } catch (err) {
    const detail = err instanceof Error ? err.message.split('\n')[0] : String(err);
    throw new MarketplaceError(`git sync failed: ${detail}`);
  }
}

// ── manifest parsing ──────────────────────────────────────────────────────

interface RawPlugin {
  name?: unknown;
  description?: unknown;
  source?: unknown;
  skills?: unknown;
}

/** Resolve `rel` under `base`, refusing anything that escapes the tree. */
export function resolveWithin(base: string, rel: string): string | null {
  const cleaned = rel.replace(/^\.\//, '').trim();
  if (cleaned === '' || path.isAbsolute(cleaned)) return null;
  const resolved = path.resolve(base, cleaned);
  const relative = path.relative(base, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) return null;
  return resolved;
}

function readSkillAt(dir: string, marketplaceId: string, plugin: string, repoRoot: string): CatalogSkill | null {
  const skillMd = path.join(dir, 'SKILL.md');
  let markdown: string;
  try {
    if (fs.statSync(skillMd).size > MAX_SKILL_MD_BYTES) return null;
    markdown = fs.readFileSync(skillMd, 'utf8');
  } catch {
    return null;
  }

  const slug = path.basename(dir);
  const frontmatter = parseSkillFrontmatter(markdown);
  const { errors, warnings } = validateSkillFrontmatter(frontmatter, slug);
  if (!frontmatter || errors.length > 0) return null;
  if (!SKILL_NAME_RE.test(slug)) return null;

  return {
    marketplaceId,
    plugin,
    slug,
    name: frontmatter.name ?? slug,
    description: frontmatter.description,
    license: frontmatter.license,
    path: path.relative(repoRoot, dir).split(path.sep).join('/'),
    warnings,
  };
}

/**
 * Walk for skill folders. Recurses because real repos nest — openai/skills
 * keeps everything under `skills/.curated/<slug>/`, so neither a flat scan nor
 * skipping dotted directories finds anything there. A directory holding a
 * SKILL.md is a skill and is never descended into, so a skill's own
 * `scripts/` and `references/` can't masquerade as more skills.
 */
function scanSkillDirs(
  base: string,
  marketplaceId: string,
  plugin: string,
  repoRoot: string,
  depth = SCAN_MAX_DEPTH,
  seen = new Set<string>(),
): CatalogSkill[] {
  let entries: string[];
  try {
    entries = fs.readdirSync(base);
  } catch {
    return [];
  }

  const out: CatalogSkill[] = [];
  for (const entry of entries.sort()) {
    if (SCAN_SKIP.has(entry)) continue;
    const dir = path.join(base, entry);
    try {
      if (!fs.statSync(dir).isDirectory()) continue;
    } catch {
      continue;
    }

    const skill = readSkillAt(dir, marketplaceId, plugin, repoRoot);
    if (skill) {
      if (!seen.has(skill.slug)) {
        seen.add(skill.slug);
        out.push(skill);
      }
      continue;
    }
    if (depth > 1 && seen.size < SCAN_MAX_SKILLS) {
      out.push(...scanSkillDirs(dir, marketplaceId, plugin, repoRoot, depth - 1, seen));
    }
  }
  return out;
}

function pluginsFromManifest(repoRoot: string, id: string, manifest: Record<string, unknown>): CatalogPlugin[] {
  const rawPlugins = Array.isArray(manifest.plugins) ? (manifest.plugins as RawPlugin[]) : [];
  const plugins: CatalogPlugin[] = [];

  for (const raw of rawPlugins) {
    const name = typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim() : null;
    if (!name) continue;
    const description = typeof raw.description === 'string' ? raw.description.trim() : null;

    // Only same-repo sources are supported. A plugin pointing at another repo
    // would need its own clone; surface that instead of silently dropping it.
    const unsupported = (reason: string): void => {
      plugins.push({ name, description, skills: [], unsupportedReason: reason });
    };
    if (raw.source !== undefined && typeof raw.source !== 'string') {
      unsupported('plugin sources outside this repository are not supported yet');
      continue;
    }
    const source = typeof raw.source === 'string' ? raw.source.trim() : './';
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(source) || source.startsWith('git@') || path.isAbsolute(source)) {
      unsupported('plugin sources outside this repository are not supported yet');
      continue;
    }
    const sourceDir = source === './' || source === '.' || source === '' ? repoRoot : resolveWithin(repoRoot, source);
    if (!sourceDir) {
      unsupported('plugin source path escapes the repository');
      continue;
    }

    let skills: CatalogSkill[];
    if (Array.isArray(raw.skills)) {
      skills = [];
      for (const entry of raw.skills) {
        if (typeof entry !== 'string') continue;
        const dir = resolveWithin(sourceDir, entry);
        if (!dir) continue;
        const skill = readSkillAt(dir, id, name, repoRoot);
        if (skill) skills.push(skill);
      }
    } else {
      skills = scanSkillDirs(path.join(sourceDir, 'skills'), id, name, repoRoot);
    }

    plugins.push({ name, description, skills, unsupportedReason: null });
  }

  return plugins;
}

/** Read the catalog out of an already-synced cache directory. */
export function readCatalog(record: MarketplaceRecord): MarketplaceCatalog {
  const repoRoot = marketplaceCacheDir(record.id);
  const base: Omit<MarketplaceCatalog, 'kind' | 'plugins' | 'error'> = {
    id: record.id,
    repo: record.repo,
    source: githubSourceOf(record.repo),
    ref: record.ref,
    label: record.label,
    description: record.description,
    commit: record.commit,
    refreshedAt: record.refreshedAt,
  };

  if (!fs.existsSync(repoRoot)) {
    return { ...base, kind: 'skill-repo', plugins: [], error: 'not synced yet — refresh this catalog' };
  }

  const manifestPath = path.join(repoRoot, MARKETPLACE_MANIFEST);
  if (fs.existsSync(manifestPath)) {
    try {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
      return {
        ...base,
        label: typeof manifest.name === 'string' ? manifest.name : base.label,
        kind: 'plugin-marketplace',
        plugins: pluginsFromManifest(repoRoot, record.id, manifest),
        error: null,
      };
    } catch (err) {
      log.warn('marketplace manifest unreadable', { id: record.id, err });
      return { ...base, kind: 'plugin-marketplace', plugins: [], error: 'marketplace.json is not valid JSON' };
    }
  }

  // No manifest: treat it as a plain Agent Skills repo.
  const skills = scanSkillDirs(repoRoot, record.id, 'skills', repoRoot);
  return {
    ...base,
    kind: 'skill-repo',
    plugins: skills.length > 0 ? [{ name: 'skills', description: null, skills, unsupportedReason: null }] : [],
    error: skills.length > 0 ? null : 'no SKILL.md folders found in this repository',
  };
}

/** Manifest `name` + `metadata.description`, for labeling a newly added source. */
function readManifestIdentity(id: string): { label: string | null; description: string | null } {
  try {
    const manifest = JSON.parse(
      fs.readFileSync(path.join(marketplaceCacheDir(id), MARKETPLACE_MANIFEST), 'utf8'),
    ) as Record<string, unknown>;
    const metadata =
      manifest.metadata && typeof manifest.metadata === 'object' ? (manifest.metadata as Record<string, unknown>) : {};
    return {
      label: typeof manifest.name === 'string' ? manifest.name : null,
      description: typeof metadata.description === 'string' ? metadata.description : null,
    };
  } catch {
    return { label: null, description: null };
  }
}

// ── public API ────────────────────────────────────────────────────────────

/**
 * Sync, retrying on the other conventional default branch. Callers rarely know
 * whether a repo is on `main` or `master`, and a preview is one click.
 */
function syncWithDefaultBranchFallback(record: MarketplaceRecord): MarketplaceRecord {
  try {
    return { ...record, commit: syncMarketplaceCache(record) };
  } catch (err) {
    const alternate = record.ref === 'main' ? 'master' : record.ref === 'master' ? 'main' : null;
    if (!alternate) throw err;
    const retry = { ...record, ref: alternate };
    return { ...retry, commit: syncMarketplaceCache(retry) };
  }
}

/**
 * Clone a repo and read its catalog without registering it.
 *
 * Search results carry only a name and a slug, so expanding one has to read
 * the repo to get descriptions. The clone lands in the normal cache dir keyed
 * by the same derived id, so adding the catalog afterwards reuses it.
 */
export function previewCatalog(input: { repo: string; ref?: string }): MarketplaceCatalog {
  const repo = normalizeRepoSource(input.repo);
  const id = deriveId(repo);
  const existing = getMarketplaceRecord(id);
  if (existing) return readCatalog(existing);

  pruneUnreferencedCaches();
  const draft: MarketplaceRecord = {
    id,
    repo,
    ref: assertRef((input.ref ?? 'main').trim() || 'main'),
    label: null,
    description: null,
    commit: null,
    addedAt: new Date().toISOString(),
    refreshedAt: null,
  };
  const synced = syncWithDefaultBranchFallback(draft);
  return readCatalog({ ...synced, ...readManifestIdentity(id) });
}

/** Drop the oldest preview clones that no configured catalog is using. */
function pruneUnreferencedCaches(keep = 8): void {
  const cacheRoot = path.dirname(marketplaceCacheDir('x'));
  const referenced = new Set(readMarketplaceRecords().map((record) => record.id));
  let entries: string[];
  try {
    entries = fs.readdirSync(cacheRoot);
  } catch {
    return;
  }
  const orphans = entries
    .filter((id) => !referenced.has(id))
    .map((id) => {
      const dir = path.join(cacheRoot, id);
      let mtime = 0;
      try {
        mtime = fs.statSync(dir).mtimeMs;
      } catch {
        /* racing removal */
      }
      return { dir, mtime };
    })
    .sort((a, b) => b.mtime - a.mtime);

  for (const orphan of orphans.slice(keep)) {
    fs.rmSync(orphan.dir, { recursive: true, force: true });
  }
}

export function addMarketplace(input: { repo: string; ref?: string; id?: string }): MarketplaceRecord {
  const repo = normalizeRepoSource(input.repo);
  const ref = assertRef((input.ref ?? 'main').trim() || 'main');
  const id = input.id?.trim() || deriveId(repo);
  if (!ID_RE.test(id)) throw new MarketplaceError(`invalid catalog id "${id}"`);
  if (getMarketplaceRecord(id)) throw new MarketplaceError(`catalog "${id}" already exists`);

  const draft: MarketplaceRecord = {
    id,
    repo,
    ref,
    label: null,
    description: null,
    commit: null,
    addedAt: new Date().toISOString(),
    refreshedAt: null,
  };

  let synced: MarketplaceRecord;
  try {
    synced = syncWithDefaultBranchFallback(draft);
  } catch (err) {
    fs.rmSync(marketplaceCacheDir(id), { recursive: true, force: true });
    throw err;
  }

  const record: MarketplaceRecord = {
    ...synced,
    ...readManifestIdentity(id),
    refreshedAt: new Date().toISOString(),
  };
  putMarketplaceRecord(record);
  return record;
}

export function refreshMarketplace(id: string): MarketplaceRecord {
  const record = getMarketplaceRecord(id);
  if (!record) throw new MarketplaceError(`unknown catalog "${id}"`);
  const commit = syncMarketplaceCache(record);
  const updated: MarketplaceRecord = {
    ...record,
    ...readManifestIdentity(id),
    commit,
    refreshedAt: new Date().toISOString(),
  };
  putMarketplaceRecord(updated);
  return updated;
}

export function removeMarketplace(id: string): void {
  if (!getMarketplaceRecord(id)) throw new MarketplaceError(`unknown catalog "${id}"`);
  deleteMarketplaceRecord(id);
  fs.rmSync(marketplaceCacheDir(id), { recursive: true, force: true });
}

export function listCatalogs(): MarketplaceCatalog[] {
  return readMarketplaceRecords().map((record) => readCatalog(record));
}

export function findCatalogSkill(marketplaceId: string, plugin: string, slug: string): CatalogSkill | null {
  const record = getMarketplaceRecord(marketplaceId);
  if (!record) return null;
  for (const candidate of readCatalog(record).plugins) {
    if (candidate.name !== plugin) continue;
    const skill = candidate.skills.find((entry) => entry.slug === slug);
    if (skill) return skill;
  }
  return null;
}
