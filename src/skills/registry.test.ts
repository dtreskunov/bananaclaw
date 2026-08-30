import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import { listSkills, type SkillRoot } from './registry.js';
import { setSkillsStoreRoot } from './store.js';

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-skill-registry-'));
  tempDirs.push(dir);
  return dir;
}

function writeSkill(root: string, slug: string, frontmatter: string): string {
  const dir = path.join(root, slug);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\n${frontmatter}\n---\n`, 'utf8');
  return dir;
}

function builtinRoot(dir: string): SkillRoot {
  return { origin: 'builtin', hostDir: dir, containerDir: '/app/skills' };
}

afterEach(() => {
  delete process.env.SKILL_REGISTRY_TEST_ENABLED;
  setSkillsStoreRoot(null);
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('listSkills', () => {
  it('reads and sorts skill metadata, including folded descriptions', () => {
    const root = tempDir();
    writeSkill(root, 'zeta', 'name: zeta\ndescription: >-\n  Folded description\n  stays intact.');
    writeSkill(root, 'alpha', 'description: Alpha description.');
    fs.mkdirSync(path.join(root, 'not-a-skill'));

    const skills = listSkills([builtinRoot(root)]);
    expect(skills.map((skill) => skill.slug)).toEqual(['alpha', 'zeta']);
    expect(skills[0]!.name).toBe('alpha');
    expect(skills[1]!.description).toBe('Folded description stays intact.');
    expect(skills[1]!.containerPath).toBe('/app/skills/zeta');
  });

  it('discovers a skill folder that is a symlink into another checkout', () => {
    const root = tempDir();
    const external = tempDir();
    writeSkill(external, 'borrowed', 'name: borrowed\ndescription: Lives elsewhere.');
    fs.symlinkSync(path.join(external, 'borrowed'), path.join(root, 'borrowed'));

    // Regression: Dirent.isDirectory() reports false for a symlinked folder,
    // which hid these from the UI while the spawn path still mounted them.
    expect(listSkills([builtinRoot(root)]).map((skill) => skill.slug)).toEqual(['borrowed']);
  });

  it('keeps skills with unmet environment requirements visible but unavailable', () => {
    const root = tempDir();
    writeSkill(
      root,
      'conditional',
      'name: conditional\ndescription: Needs a flag.\nmetadata:\n  requires_env: SKILL_REGISTRY_TEST_ENABLED',
    );

    const [skill] = listSkills([builtinRoot(root)]);
    expect(skill).toMatchObject({
      slug: 'conditional',
      requiresEnv: 'SKILL_REGISTRY_TEST_ENABLED',
      available: false,
      unavailableReason: 'Requires SKILL_REGISTRY_TEST_ENABLED',
    });

    process.env.SKILL_REGISTRY_TEST_ENABLED = 'true';
    expect(listSkills([builtinRoot(root)])[0]!.available).toBe(true);
  });

  it('still honors the pre-spec top-level requires_env', () => {
    const root = tempDir();
    writeSkill(root, 'legacy', 'name: legacy\ndescription: Old style.\nrequires_env: SKILL_REGISTRY_TEST_ENABLED');

    const [skill] = listSkills([builtinRoot(root)]);
    expect(skill!.requiresEnv).toBe('SKILL_REGISTRY_TEST_ENABLED');
    expect(skill!.warnings.join(' ')).toContain('deprecated at the top level');
  });

  it('skips folders whose SKILL.md fails spec validation', () => {
    const root = tempDir();
    writeSkill(root, 'no-description', 'name: no-description');
    writeSkill(root, 'bad-name', 'name: Not_Kebab\ndescription: Nope.');
    writeSkill(root, 'fine', 'name: fine\ndescription: Yes.');

    expect(listSkills([builtinRoot(root)]).map((skill) => skill.slug)).toEqual(['fine']);
  });

  it("merges both roots and lets the group's own copy win a slug collision", () => {
    const builtin = tempDir();
    const workspace = tempDir();
    writeSkill(builtin, 'shared', 'name: shared\ndescription: From the repo.');
    writeSkill(workspace, 'shared', 'name: shared\ndescription: The agent own copy.');
    writeSkill(workspace, 'extra', 'name: extra\ndescription: Only in the group.');

    const skills = listSkills([
      builtinRoot(builtin),
      { origin: 'workspace', hostDir: workspace, containerDir: '/workspace/agent/skills' },
    ]);
    expect(skills.map((skill) => [skill.slug, skill.origin])).toEqual([
      ['extra', 'workspace'],
      ['shared', 'workspace'],
    ]);
    expect(skills.find((skill) => skill.slug === 'shared')!.description).toBe('The agent own copy.');
    expect(skills.find((skill) => skill.slug === 'extra')!.containerPath).toBe('/workspace/agent/skills/extra');
  });

  it('discovers the group workspace root and lets it override a built-in', () => {
    const builtin = tempDir();
    const workspace = tempDir();
    writeSkill(builtin, 'shared', 'name: shared\ndescription: From the repo.');
    writeSkill(builtin, 'only-builtin', 'name: only-builtin\ndescription: Repo only.');
    writeSkill(workspace, 'shared', 'name: shared\ndescription: The agent own copy.');
    writeSkill(workspace, 'homegrown', 'name: homegrown\ndescription: Written by the agent.');

    const skills = listSkills([
      builtinRoot(builtin),
      { origin: 'workspace', hostDir: workspace, containerDir: '/workspace/agent/skills' },
    ]);
    expect(skills.map((skill) => [skill.slug, skill.origin])).toEqual([
      ['homegrown', 'workspace'],
      ['only-builtin', 'builtin'],
      ['shared', 'workspace'],
    ]);

    const homegrown = skills.find((skill) => skill.slug === 'homegrown')!;
    expect(homegrown.catalogId).toBe('workspace');
    expect(homegrown.containerPath).toBe('/workspace/agent/skills/homegrown');
    // The agent's copy wins, matching how the native provider already resolves it.
    expect(skills.find((skill) => skill.slug === 'shared')!.description).toBe('The agent own copy.');
  });
});
