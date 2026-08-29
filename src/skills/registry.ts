/**
 * Skill discovery — the single source of truth for "what skills exist".
 *
 * Two roots feed the agent:
 *   - built-in   `container/skills/`        → mounted RO at /app/skills
 *   - installed  `data/skills/installed/`   → mounted RO at /app/skills-installed
 *
 * Everything host-side that needs to know about skills (the admin UI catalog,
 * the spawn-time selection + symlink sync, the CLAUDE.md composer) goes
 * through here. They used to walk `container/skills/` independently with
 * different directory tests, which meant a symlinked skill folder was mounted
 * into containers but invisible in the UI — and silently dropped the moment
 * anyone edited the selection.
 */
import fs from 'fs';
import path from 'path';

import { readEnvFile } from '../env.js';
import { parseSkillFrontmatter, validateSkillFrontmatter } from './frontmatter.js';
import { getInstalledRecord, installedSkillsDir, type InstalledSkillRecord } from './store.js';

export type SkillOrigin = 'builtin' | 'installed';

/**
 * Reserved catalog id for the skills that ship with the install. Built-ins
 * aren't fetched from anywhere, but presenting them as a catalog keeps one
 * model in the UI: every skill comes from somewhere.
 */
export const BUILTIN_CATALOG_ID = 'built-in';

export interface SkillRoot {
  origin: SkillOrigin;
  /** Directory on the host. */
  hostDir: string;
  /** Directory the same tree is mounted at inside the container. */
  containerDir: string;
}

export interface DiscoveredSkill {
  slug: string;
  name: string;
  description: string;
  license: string | null;
  origin: SkillOrigin;
  /** Catalog this came from; `BUILTIN_CATALOG_ID` for built-ins. */
  catalogId: string | null;
  /** Absolute host path to the skill folder (symlinks not resolved). */
  hostPath: string;
  /** Absolute in-container path — what skill symlinks and fragments point at. */
  containerPath: string;
  /** Env var required for this skill to be offered, or null. */
  requiresEnv: string | null;
  available: boolean;
  unavailableReason: string | null;
  /** Ships an `instructions.md` fragment for CLAUDE.md composition. */
  hasInstructions: boolean;
  /** Spec-conformance warnings from `validateSkillFrontmatter`. */
  warnings: string[];
  /** Provenance for marketplace-installed skills; null for built-ins. */
  source: InstalledSkillRecord | null;
}

export function defaultSkillRoots(projectRoot = process.cwd()): SkillRoot[] {
  return [
    { origin: 'builtin', hostDir: path.join(projectRoot, 'container', 'skills'), containerDir: '/app/skills' },
    { origin: 'installed', hostDir: installedSkillsDir(), containerDir: '/app/skills-installed' },
  ];
}

/**
 * True when `p` is (or points at) a directory. `statSync` follows symlinks —
 * `Dirent.isDirectory()` does not, which is exactly the bug this replaces.
 */
function isDirLike(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function isTruthyEnv(value: string | undefined): boolean {
  return value !== undefined && ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
}

/**
 * Resolve an env var through the process env first, then `.env` — the systemd
 * unit doesn't load the file, so a UI-visible flag may only exist there.
 */
function makeEnvResolver(names: string[]): (name: string) => string | undefined {
  const unique = [...new Set(names.filter(Boolean))];
  const fileEnv = unique.length > 0 ? readEnvFile(unique) : {};
  return (name) => process.env[name] ?? fileEnv[name];
}

interface RawSkill {
  slug: string;
  origin: SkillOrigin;
  hostPath: string;
  containerPath: string;
  name: string;
  description: string;
  license: string | null;
  requiresEnv: string | null;
  hasInstructions: boolean;
  warnings: string[];
}

function readRoot(root: SkillRoot): RawSkill[] {
  let entries: string[];
  try {
    entries = fs.readdirSync(root.hostDir);
  } catch {
    return [];
  }

  const skills: RawSkill[] = [];
  for (const slug of entries) {
    if (slug.startsWith('.')) continue;
    const hostPath = path.join(root.hostDir, slug);
    if (!isDirLike(hostPath)) continue;

    let markdown: string;
    try {
      markdown = fs.readFileSync(path.join(hostPath, 'SKILL.md'), 'utf8');
    } catch {
      continue;
    }

    const frontmatter = parseSkillFrontmatter(markdown);
    const { errors, warnings } = validateSkillFrontmatter(frontmatter, slug);
    if (!frontmatter || errors.length > 0) continue;

    skills.push({
      slug,
      origin: root.origin,
      hostPath,
      containerPath: `${root.containerDir}/${slug}`,
      name: frontmatter.name ?? slug,
      description: frontmatter.description,
      license: frontmatter.license,
      requiresEnv: frontmatter.requiresEnv,
      hasInstructions: fs.existsSync(path.join(hostPath, 'instructions.md')),
      warnings,
    });
  }
  return skills;
}

/**
 * All discoverable skills, sorted by display name. Built-ins win when a slug
 * exists in both roots — the installer refuses to shadow a built-in, so this
 * only matters if someone drops a folder in by hand.
 */
export function listSkills(roots: SkillRoot[] = defaultSkillRoots()): DiscoveredSkill[] {
  const bySlug = new Map<string, RawSkill>();
  for (const root of roots) {
    for (const skill of readRoot(root)) {
      const existing = bySlug.get(skill.slug);
      if (existing && existing.origin === 'builtin') continue;
      bySlug.set(skill.slug, skill);
    }
  }

  const raw = [...bySlug.values()];
  const resolveEnv = makeEnvResolver(raw.map((skill) => skill.requiresEnv ?? ''));

  return raw
    .map((skill) => {
      const available = skill.requiresEnv === null || isTruthyEnv(resolveEnv(skill.requiresEnv));
      const source = skill.origin === 'installed' ? getInstalledRecord(skill.slug) : null;
      return {
        ...skill,
        available,
        unavailableReason: available ? null : `Requires ${skill.requiresEnv}`,
        catalogId: skill.origin === 'builtin' ? BUILTIN_CATALOG_ID : (source?.marketplaceId ?? null),
        source,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name) || a.slug.localeCompare(b.slug));
}

export function getSkillBySlug(slug: string, roots?: SkillRoot[]): DiscoveredSkill | null {
  return listSkills(roots).find((skill) => skill.slug === slug) ?? null;
}
