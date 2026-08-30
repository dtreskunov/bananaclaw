/**
 * Skill catalog DTOs for the admin UI.
 *
 * Thin adapter over `src/skills/registry.ts` — discovery, symlink handling and
 * env gating all live there so the UI and the spawn path can't disagree about
 * which skills exist. Provenance for installed skills comes from git rather
 * than a side table, so it always describes the files actually on disk.
 */
import { listSkills, type SkillOrigin, type SkillRoot } from '../../../skills/registry.js';
import { readMarketplaceRecords } from '../../../skills/store.js';

export interface SkillProvenance {
  /** `origin` remote of the catalog checkout this skill was vendored from. */
  repo: string | null;
  commit: string | null;
  /** Path of the skill within that repo. */
  sourcePath: string | null;
  /** Agent has uncommitted edits to the vendored files. */
  modified: boolean;
  /** Commits the agent made on top of what was fetched. */
  localCommits: number;
}

export interface AvailableSkill {
  slug: string;
  name: string;
  description: string;
  available: boolean;
  unavailableReason: string | null;
  origin: SkillOrigin;
  /** Catalog this skill came from; built-ins use the reserved built-in id. */
  catalogId: string | null;
  /** Display name for that catalog. */
  catalogLabel: string;
  /** Enabled by omission rather than by selection — toggled via the deny-list. */
  alwaysOn: boolean;
  license: string | null;
  /** Spec-conformance warnings — informational, the skill still works. */
  warnings: string[];
  source: SkillProvenance | null;
}

export function listAvailableSkills(roots?: SkillRoot[]): AvailableSkill[] {
  const catalogNames = new Map(readMarketplaceRecords().map((record) => [record.id, record.label ?? record.id]));
  return listSkills(roots).map((skill) => ({
    slug: skill.slug,
    name: skill.name,
    description: skill.description,
    available: skill.available,
    unavailableReason: skill.unavailableReason,
    origin: skill.origin,
    catalogId: skill.catalogId,
    catalogLabel:
      skill.origin === 'builtin'
        ? 'built-in'
        : skill.origin === 'workspace'
          ? 'workspace'
          : (catalogNames.get(skill.catalogId ?? '') ?? skill.catalogId ?? 'unknown'),
    // Everything in the group's own root is on unless explicitly denied.
    alwaysOn: skill.origin !== 'builtin',
    license: skill.license,
    warnings: skill.warnings,
    source: skill.git
      ? {
          repo: skill.git.remote,
          commit: skill.git.commit,
          sourcePath: skill.git.sourcePath,
          modified: skill.git.modified,
          localCommits: skill.git.localCommits,
        }
      : null,
  }));
}
