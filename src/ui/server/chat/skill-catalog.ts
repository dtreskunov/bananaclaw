/**
 * Skill catalog DTOs for the admin UI.
 *
 * Thin adapter over `src/skills/registry.ts` — discovery, symlink handling and
 * env gating all live there so the UI and the spawn path can't disagree about
 * which skills exist.
 */
import { installedUpdateStatus } from '../../../skills/install.js';
import { listSkills, type SkillOrigin, type SkillRoot } from '../../../skills/registry.js';

export interface SkillProvenance {
  marketplaceId: string | null;
  plugin: string | null;
  repo: string;
  ref: string;
  commit: string;
  path: string;
  installedAt: string;
}

export interface AvailableSkill {
  slug: string;
  name: string;
  description: string;
  available: boolean;
  unavailableReason: string | null;
  origin: SkillOrigin;
  license: string | null;
  /** Spec-conformance warnings — informational, the skill still works. */
  warnings: string[];
  source: SkillProvenance | null;
  /** True when the catalog has a newer version; null when it can't be told. */
  updateAvailable: boolean | null;
}

export function listAvailableSkills(roots?: SkillRoot[]): AvailableSkill[] {
  const updates = installedUpdateStatus();
  return listSkills(roots).map((skill) => ({
    slug: skill.slug,
    name: skill.name,
    description: skill.description,
    available: skill.available,
    unavailableReason: skill.unavailableReason,
    origin: skill.origin,
    license: skill.license,
    warnings: skill.warnings,
    source: skill.source
      ? {
          marketplaceId: skill.source.marketplaceId,
          plugin: skill.source.plugin,
          repo: skill.source.repo,
          ref: skill.source.ref,
          commit: skill.source.commit,
          path: skill.source.path,
          installedAt: skill.source.installedAt,
        }
      : null,
    updateAvailable: skill.origin === 'installed' ? (updates[skill.slug] ?? null) : null,
  }));
}
