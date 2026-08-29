/**
 * SKILL.md frontmatter parsing for the Agent Skills spec (agentskills.io).
 *
 * One parser for the whole host. The UI catalog, the spawn-time selector, the
 * CLAUDE.md composer and the marketplace installer all read SKILL.md through
 * here, so they can never disagree about what is installed or what it needs.
 */
import { load as parseYaml } from 'js-yaml';

/** Top-level keys the Agent Skills spec defines. Anything else is off-spec. */
export const SPEC_FRONTMATTER_KEYS = new Set([
  'name',
  'description',
  'license',
  'allowed-tools',
  'metadata',
  'compatibility',
]);

export const MAX_SKILL_NAME_LEN = 64;
export const MAX_SKILL_DESCRIPTION_LEN = 1024;
export const SKILL_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export interface SkillFrontmatter {
  name: string | null;
  description: string;
  license: string | null;
  compatibility: string | null;
  allowedTools: string[];
  metadata: Record<string, unknown>;
  /**
   * Env var that must be truthy for this skill to be offered, read from
   * `metadata.requires_env`. The pre-spec top-level `requires_env` is still
   * honored so third-party and older skills keep working.
   */
  requiresEnv: string | null;
  /** Frontmatter keys outside the spec — surfaced as warnings, never fatal. */
  offSpecKeys: string[];
}

export interface SkillValidation {
  /** Blocking problems — an installer must refuse these. */
  errors: string[];
  /** Non-blocking problems — shown in the UI, still installable. */
  warnings: string[];
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function asToolList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === 'string' && item.trim() !== '').map((s) => s.trim());
  }
  if (typeof value !== 'string') return [];
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

/**
 * Parse the YAML frontmatter block of a SKILL.md. Returns null when the file
 * has no frontmatter or the YAML is unusable — callers treat that as "not a
 * skill" rather than throwing.
 */
export function parseSkillFrontmatter(markdown: string): SkillFrontmatter | null {
  const lines = markdown.split('\n');
  if (lines[0]?.trim() !== '---') return null;
  const end = lines.findIndex((line, index) => index > 0 && line.trim() === '---');
  if (end === -1) return null;

  let parsed: unknown;
  try {
    parsed = parseYaml(lines.slice(1, end).join('\n'));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;

  const raw = parsed as Record<string, unknown>;
  const metadata =
    raw.metadata && typeof raw.metadata === 'object' && !Array.isArray(raw.metadata)
      ? (raw.metadata as Record<string, unknown>)
      : {};

  return {
    name: asString(raw.name),
    description: collapseWhitespace(asString(raw.description) ?? ''),
    license: asString(raw.license),
    compatibility: asString(raw.compatibility),
    allowedTools: asToolList(raw['allowed-tools']),
    metadata,
    requiresEnv: asString(metadata.requires_env) ?? asString(raw.requires_env),
    offSpecKeys: Object.keys(raw)
      .filter((key) => !SPEC_FRONTMATTER_KEYS.has(key))
      .sort(),
  };
}

/**
 * Check a parsed skill against the spec. `slug` is the directory name the
 * skill lives under; the spec expects it to match `name`.
 */
export function validateSkillFrontmatter(frontmatter: SkillFrontmatter | null, slug: string): SkillValidation {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!frontmatter) {
    return { errors: ['SKILL.md has no parseable YAML frontmatter'], warnings };
  }

  if (frontmatter.description === '') {
    errors.push('frontmatter is missing `description`');
  } else if (frontmatter.description.length > MAX_SKILL_DESCRIPTION_LEN) {
    warnings.push(
      `description is ${frontmatter.description.length} chars (spec suggests ≤ ${MAX_SKILL_DESCRIPTION_LEN})`,
    );
  }

  if (frontmatter.name === null) {
    warnings.push('frontmatter is missing `name` — falling back to the folder name');
  } else {
    if (frontmatter.name.length > MAX_SKILL_NAME_LEN) {
      errors.push(`name is ${frontmatter.name.length} chars (max ${MAX_SKILL_NAME_LEN})`);
    }
    if (!SKILL_NAME_RE.test(frontmatter.name)) {
      errors.push(`name "${frontmatter.name}" must be kebab-case (lowercase letters, digits, single hyphens)`);
    } else if (frontmatter.name !== slug) {
      warnings.push(`name "${frontmatter.name}" does not match the folder name "${slug}"`);
    }
  }

  // `requires_env` predates the spec and is still honored, so don't nag about it.
  const offSpec = frontmatter.offSpecKeys.filter((key) => key !== 'requires_env');
  if (offSpec.length > 0) {
    warnings.push(`off-spec frontmatter key${offSpec.length === 1 ? '' : 's'}: ${offSpec.join(', ')}`);
  }
  if (frontmatter.offSpecKeys.includes('requires_env')) {
    warnings.push('`requires_env` is deprecated at the top level — move it under `metadata:`');
  }

  return { errors, warnings };
}
