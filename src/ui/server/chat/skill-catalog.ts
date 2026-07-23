import fs from 'fs';
import path from 'path';
import { load as parseYaml } from 'js-yaml';

import { readEnvFile } from '../../../env.js';

export interface AvailableSkill {
  slug: string;
  name: string;
  description: string;
  available: boolean;
  unavailableReason: string | null;
}

interface SkillFrontmatter {
  name?: unknown;
  description?: unknown;
  requires_env?: unknown;
}

function readFrontmatter(skillFile: string): SkillFrontmatter {
  let text: string;
  try {
    text = fs.readFileSync(skillFile, 'utf8');
  } catch {
    return {};
  }

  const lines = text.split('\n');
  if (lines[0]?.trim() !== '---') return {};
  const end = lines.findIndex((line, index) => index > 0 && line.trim() === '---');
  if (end === -1) return {};

  try {
    const parsed = parseYaml(lines.slice(1, end).join('\n'));
    return parsed && typeof parsed === 'object' ? (parsed as SkillFrontmatter) : {};
  } catch {
    return {};
  }
}

function isTruthyEnv(value: string | undefined): boolean {
  return value !== undefined && ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
}

export function listAvailableSkills(skillsDir = path.join(process.cwd(), 'container', 'skills')): AvailableSkill[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(skillsDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const discovered = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const slug = entry.name;
      const skillFile = path.join(skillsDir, slug, 'SKILL.md');
      if (!fs.existsSync(skillFile)) return null;
      const frontmatter = readFrontmatter(skillFile);
      const requiredEnv = typeof frontmatter.requires_env === 'string' ? frontmatter.requires_env.trim() : '';
      return {
        slug,
        name: typeof frontmatter.name === 'string' && frontmatter.name.trim() ? frontmatter.name.trim() : slug,
        description:
          typeof frontmatter.description === 'string' ? frontmatter.description.replace(/\s+/g, ' ').trim() : '',
        requiredEnv,
      };
    })
    .filter((skill): skill is NonNullable<typeof skill> => skill !== null)
    .sort((a, b) => a.name.localeCompare(b.name));

  const envNames = [...new Set(discovered.map((skill) => skill.requiredEnv).filter(Boolean))];
  const fileEnv = readEnvFile(envNames);

  return discovered.map(({ requiredEnv, ...skill }) => {
    const available = requiredEnv === '' || isTruthyEnv(process.env[requiredEnv] ?? fileEnv[requiredEnv]);
    return {
      ...skill,
      available,
      unavailableReason: available ? null : `Requires ${requiredEnv}`,
    };
  });
}
