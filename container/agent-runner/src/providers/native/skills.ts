import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_SHARED_ROOT = '/home/node/.claude/skills';
const DEFAULT_LOCAL_ROOT = '/workspace/agent/skills';
const MAX_SKILL_FILE_BYTES = 256 * 1024;

interface SkillFrontmatter {
  name?: unknown;
  description?: unknown;
  'allowed-tools'?: unknown;
  requires_env?: unknown;
}

export interface NativeSkill {
  slug: string;
  name: string;
  description: string;
  allowedTools: string[];
  requiresEnv?: string;
  root: string;
  source: 'shared' | 'local';
}

function parseFrontmatter(markdown: string): SkillFrontmatter {
  const lines = markdown.split('\n');
  if (lines[0]?.trim() !== '---') return {};
  const end = lines.findIndex((line, index) => index > 0 && line.trim() === '---');
  if (end === -1) return {};
  try {
    const parsed = Bun.YAML.parse(lines.slice(1, end).join('\n'));
    return parsed && typeof parsed === 'object' ? (parsed as SkillFrontmatter) : {};
  } catch {
    return {};
  }
}

function allowedTools(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string' && item.trim() !== '');
  if (typeof value !== 'string' || value.trim() === '') return [];
  return value.split(',').map((item) => item.trim()).filter(Boolean);
}

function isTruthy(value: string | undefined): boolean {
  return value !== undefined && ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
}

function discoverRoot(
  root: string,
  source: NativeSkill['source'],
  env: Record<string, string | undefined>,
): NativeSkill[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }

  const skills: NativeSkill[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    const candidateRoot = path.join(root, entry.name);
    let resolvedRoot: string;
    let markdown: string;
    try {
      resolvedRoot = fs.realpathSync(candidateRoot);
      markdown = fs.readFileSync(path.join(resolvedRoot, 'SKILL.md'), 'utf8');
    } catch {
      continue;
    }
    const frontmatter = parseFrontmatter(markdown);
    const description =
      typeof frontmatter.description === 'string' ? frontmatter.description.replace(/\s+/g, ' ').trim() : '';
    if (!description) continue;
    const requiresEnv =
      typeof frontmatter.requires_env === 'string' && frontmatter.requires_env.trim()
        ? frontmatter.requires_env.trim()
        : undefined;
    // Shared entries already passed the host's availability filter. Local
    // skills have no host selector, so enforce their requirement here.
    if (source === 'local' && requiresEnv && !isTruthy(env[requiresEnv])) continue;
    skills.push({
      slug: entry.name,
      name: typeof frontmatter.name === 'string' && frontmatter.name.trim() ? frontmatter.name.trim() : entry.name,
      description,
      allowedTools: allowedTools(frontmatter['allowed-tools']),
      ...(requiresEnv ? { requiresEnv } : {}),
      root: resolvedRoot,
      source,
    });
  }
  return skills;
}

function isInside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

export class NativeSkillRegistry {
  private readonly skillsBySlug = new Map<string, NativeSkill>();
  private readonly aliases = new Map<string, NativeSkill | null>();

  constructor(
    sharedRoot = process.env.NATIVE_SHARED_SKILLS_ROOT ?? DEFAULT_SHARED_ROOT,
    localRoot = process.env.NATIVE_LOCAL_SKILLS_ROOT ?? DEFAULT_LOCAL_ROOT,
    env: Record<string, string | undefined> = process.env,
  ) {
    for (const skill of discoverRoot(sharedRoot, 'shared', env)) this.skillsBySlug.set(skill.slug, skill);
    for (const skill of discoverRoot(localRoot, 'local', env)) this.skillsBySlug.set(skill.slug, skill);
    for (const skill of this.skills()) {
      this.aliases.set(skill.slug.toLowerCase(), skill);
      const declaredName = skill.name.toLowerCase();
      const existing = this.aliases.get(declaredName);
      this.aliases.set(declaredName, existing && existing.slug !== skill.slug ? null : skill);
    }
  }

  skills(): NativeSkill[] {
    return [...this.skillsBySlug.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  instructions(): string | null {
    const skills = this.skills();
    if (skills.length === 0) return null;
    return [
      '## Available skills',
      '',
      'Skills are task-specific instructions loaded progressively. When a request matches',
      'a skill below, call `load_skill` before acting and follow the returned instructions.',
      'Use the optional `path` argument to read files referenced by that skill.',
      'Skill `allowed-tools` metadata may use Claude names: Bash maps to `shell`,',
      'Read/Write/Edit map to native file tools, and Server(tool) maps to',
      '`mcp__Server__tool`. The actual tool list remains authoritative.',
      '',
      ...skills.map((skill) => `- **${skill.name}** (\`${skill.slug}\`) — ${skill.description}`),
    ].join('\n');
  }

  load(name: string, relativePath = 'SKILL.md'): string {
    const skill = this.aliases.get(name.trim().toLowerCase());
    if (skill === null) throw new Error(`Ambiguous skill name: ${name}; use its slug`);
    if (!skill) throw new Error(`Unknown skill: ${name}`);
    if (!relativePath || path.isAbsolute(relativePath)) throw new Error('Skill path must be relative');
    const candidate = path.resolve(skill.root, relativePath);
    let resolved: string;
    try {
      resolved = fs.realpathSync(candidate);
    } catch {
      throw new Error(`Skill file not found: ${relativePath}`);
    }
    if (!isInside(skill.root, resolved)) throw new Error('Skill path escapes the skill directory');
    const stat = fs.statSync(resolved);
    if (!stat.isFile()) throw new Error('Skill path is not a file');
    if (stat.size > MAX_SKILL_FILE_BYTES) throw new Error(`Skill file exceeds ${MAX_SKILL_FILE_BYTES} bytes`);
    const body = fs.readFileSync(resolved, 'utf8');
    if (body.includes('\0')) throw new Error('Skill file is not text');
    const metadata = [
      `name=${JSON.stringify(skill.name)}`,
      `slug=${JSON.stringify(skill.slug)}`,
      `source=${JSON.stringify(skill.source)}`,
      `path=${JSON.stringify(path.relative(skill.root, resolved) || 'SKILL.md')}`,
      ...(skill.allowedTools.length > 0 ? [`allowed_tools=${JSON.stringify(skill.allowedTools)}`] : []),
      ...(skill.requiresEnv ? [`requires_env=${JSON.stringify(skill.requiresEnv)}`] : []),
    ].join(' ');
    return `<skill ${metadata}>\n${body}\n</skill>`;
  }
}