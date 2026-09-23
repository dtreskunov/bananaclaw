/**
 * Skill discovery — the single source of truth for "what skills exist".
 *
 * Two roots feed the agent:
 *   - built-in   `container/skills/`        → mounted RO at /app/skills
 *   - workspace  `groups/<folder>/skills/` → mounted RW at /workspace/agent/skills
 *
 * The workspace root holds both kinds of per-group skill. A skill the agent
 * wrote is a real directory; a skill installed from a catalog is a symlink
 * into a sparse clone under `.catalogs/<id>@<commit>`. That is the only
 * thing distinguishing them, and it means provenance is whatever git already
 * knows — nothing custom is written into the repo.
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
import { GROUPS_DIR } from '../config.js';
import { readSkillManifest } from './frontmatter.js';
import { readSkillGit, type SkillGitInfo } from './skill-git.js';

export type SkillOrigin = 'builtin' | 'installed' | 'workspace';

/**
 * Reserved catalog id for the skills that ship with the install. Built-ins
 * aren't fetched from anywhere, but presenting them as a catalog keeps one
 * model in the UI: every skill comes from somewhere.
 */
export const BUILTIN_CATALOG_ID = 'built-in';

/** Reserved catalog id for skills the agent wrote in its own workspace. */
export const WORKSPACE_CATALOG_ID = 'workspace';

/** Holds the sparse catalog clones inside a group's skill root. */
export const CATALOGS_DIRNAME = '.catalogs';

// Higher wins when a slug exists in more than one root. The group's own root
// beats the built-ins, matching how the native provider already resolves a
// local skill over a shared one.
const ORIGIN_PRIORITY: Record<SkillOrigin, number> = { workspace: 3, installed: 3, builtin: 1 };

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
  /** Git provenance for catalog-installed skills; null for the rest. */
  git: SkillGitInfo | null;
}

export function defaultSkillRoots(projectRoot = process.cwd()): SkillRoot[] {
  return [{ origin: 'builtin', hostDir: path.join(projectRoot, 'container', 'skills'), containerDir: '/app/skills' }];
}

/**
 * Built-ins plus the group's own skill root. `groups/<folder>/skills` is
 * mounted RW at `/workspace/agent/skills` and holds both the agent's authored
 * skills and the ones installed from catalogs.
 */
export function groupSkillRoots(groupFolder: string, projectRoot = process.cwd()): SkillRoot[] {
  return [
    ...defaultSkillRoots(projectRoot),
    {
      origin: 'workspace',
      hostDir: path.join(GROUPS_DIR, groupFolder, 'skills'),
      containerDir: '/workspace/agent/skills',
    },
  ];
}

/** Where a group's skills live — both its own and the ones vendored in. */
export function groupSkillsDir(groupFolder: string): string {
  return path.join(GROUPS_DIR, groupFolder, 'skills');
}

/** Where a group's sparse catalog clones live. */
export function groupCatalogsDir(groupFolder: string): string {
  return path.join(groupSkillsDir(groupFolder), CATALOGS_DIRNAME);
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

function isSymlink(p: string): boolean {
  try {
    return fs.lstatSync(p).isSymbolicLink();
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
  git: SkillGitInfo | null;
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

    const manifest = readSkillManifest(hostPath, slug);
    if (!manifest?.frontmatter || manifest.errors.length > 0) continue;
    const { frontmatter, warnings } = manifest;

    // In the group root a symlink means "vendored from a catalog" — it points
    // into `.catalogs/`. A real directory is the agent's own work.
    let git: SkillGitInfo | null = null;
    let origin = root.origin;
    if (root.origin === 'workspace' && isSymlink(hostPath)) {
      git = readSkillGit(fs.realpathSync(hostPath));
      if (git?.remote) origin = 'installed';
    }

    skills.push({
      slug,
      origin,
      hostPath,
      containerPath: `${root.containerDir}/${slug}`,
      name: frontmatter.name ?? slug,
      description: frontmatter.description,
      license: frontmatter.license,
      requiresEnv: frontmatter.requiresEnv,
      hasInstructions: fs.existsSync(path.join(hostPath, 'instructions.md')),
      warnings,
      git,
    });
  }
  return skills;
}

/**
 * All discoverable skills, sorted by display name. When a slug exists in more
 * than one root, `ORIGIN_PRIORITY` decides which copy wins.
 */
export function listSkills(roots: SkillRoot[] = defaultSkillRoots()): DiscoveredSkill[] {
  const bySlug = new Map<string, RawSkill>();
  for (const root of roots) {
    for (const skill of readRoot(root)) {
      const existing = bySlug.get(skill.slug);
      if (existing && ORIGIN_PRIORITY[existing.origin] >= ORIGIN_PRIORITY[skill.origin]) continue;
      bySlug.set(skill.slug, skill);
    }
  }

  const raw = [...bySlug.values()];
  const resolveEnv = makeEnvResolver(raw.map((skill) => skill.requiresEnv ?? ''));

  return raw
    .map((skill) => {
      const available = skill.requiresEnv === null || isTruthyEnv(resolveEnv(skill.requiresEnv));
      return {
        ...skill,
        available,
        unavailableReason: available ? null : `Requires ${skill.requiresEnv}`,
        catalogId:
          skill.origin === 'builtin'
            ? BUILTIN_CATALOG_ID
            : skill.origin === 'installed'
              ? catalogIdOf(skill.git)
              : WORKSPACE_CATALOG_ID,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name) || a.slug.localeCompare(b.slug));
}

/** Accept revision-isolated checkouts and the legacy `.catalogs/<id>` layout. */
function catalogIdOf(git: SkillGitInfo | null): string | null {
  return git ? path.basename(git.repoDir).replace(/@(?:[a-f0-9]{64}|[a-f0-9]{40})(?:-[A-Za-z0-9]+)?$/, '') : null;
}

export function getSkillBySlug(slug: string, roots?: SkillRoot[]): DiscoveredSkill | null {
  return listSkills(roots).find((skill) => skill.slug === slug) ?? null;
}
