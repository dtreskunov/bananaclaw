import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { NativeSkillRegistry } from './skills.js';

let root: string;
let shared: string;
let local: string;

function writeSkill(base: string, slug: string, description: string, body = '# Instructions'): void {
  const dir = path.join(base, slug);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'SKILL.md'),
    ['---', `name: ${slug}`, `description: ${description}`, 'allowed-tools: Bash(example:*)', '---', '', body].join('\n'),
  );
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'native-skills-'));
  shared = path.join(root, 'shared');
  local = path.join(root, 'local');
  fs.mkdirSync(shared);
  fs.mkdirSync(local);
});

afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe('NativeSkillRegistry', () => {
  it('indexes effective shared skills and always includes group-local skills', () => {
    writeSkill(shared, 'browser', 'Browse websites.');
    writeSkill(local, 'custom', 'Use the custom workflow.');
    const registry = new NativeSkillRegistry(shared, local);

    expect(registry.skills().map((skill) => skill.slug)).toEqual(['browser', 'custom']);
    expect(registry.instructions()).toContain('call `load_skill` before acting');
    expect(registry.instructions()).toContain('**custom** (`custom`)');
  });

  it('lets a group-local skill override a shared skill with the same slug', () => {
    writeSkill(shared, 'demo', 'Shared instructions.', '# Shared');
    writeSkill(local, 'demo', 'Local instructions.', '# Local');
    const registry = new NativeSkillRegistry(shared, local);

    expect(registry.skills()).toHaveLength(1);
    expect(registry.skills()[0]?.source).toBe('local');
    expect(registry.load('demo')).toContain('# Local');
    expect(registry.load('demo')).toContain('allowed_tools=["Bash(example:*)"]');
  });

  it('loads referenced files but rejects traversal and escaping symlinks', () => {
    writeSkill(local, 'demo', 'Demo skill.');
    fs.mkdirSync(path.join(local, 'demo', 'references'));
    fs.writeFileSync(path.join(local, 'demo', 'references', 'guide.md'), '# Guide');
    fs.symlinkSync('/etc/passwd', path.join(local, 'demo', 'references', 'escape'));
    const registry = new NativeSkillRegistry(shared, local);

    expect(registry.load('demo', 'references/guide.md')).toContain('# Guide');
    expect(() => registry.load('demo', '../outside')).toThrow(/not found|escapes/);
    expect(() => registry.load('demo', 'references/escape')).toThrow(/escapes/);
  });

  it('skips malformed skills without a description', () => {
    const dir = path.join(shared, 'bad');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'SKILL.md'), '---\nname: bad\n---\n# Bad');
    expect(new NativeSkillRegistry(shared, local).skills()).toEqual([]);
  });

  it('enforces requires_env for group-local skills', () => {
    const dir = path.join(local, 'gated');
    fs.mkdirSync(dir);
    fs.writeFileSync(
      path.join(dir, 'SKILL.md'),
      '---\nname: gated\ndescription: Gated skill.\nrequires_env: FEATURE_ON\n---\n# Gated',
    );
    expect(new NativeSkillRegistry(shared, local, {}).skills()).toEqual([]);
    expect(new NativeSkillRegistry(shared, local, { FEATURE_ON: 'true' }).skills()).toHaveLength(1);
  });

  it('requires a slug when two skills declare the same name', () => {
    writeSkill(shared, 'one', 'First skill.');
    writeSkill(shared, 'two', 'Second skill.');
    for (const slug of ['one', 'two']) {
      const file = path.join(shared, slug, 'SKILL.md');
      fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(`name: ${slug}`, 'name: duplicate'));
    }
    const registry = new NativeSkillRegistry(shared, local);
    expect(() => registry.load('duplicate')).toThrow(/Ambiguous/);
    expect(registry.load('one')).toContain('name: duplicate');
  });
});