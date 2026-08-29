import { describe, it, expect } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { parseSkillFrontmatter, generateSkillsIndex, resolveSkillsDir } from './opencode.js';

describe('parseSkillFrontmatter', () => {
  it('parses plain scalar name and description', () => {
    const md = ['---', 'name: demo', 'description: A short one-line summary.', '---', '# body'].join(
      '\n',
    );
    expect(parseSkillFrontmatter(md)).toEqual({
      name: 'demo',
      description: 'A short one-line summary.',
    });
  });

  it('parses a folded (>-) block-scalar description into a single line', () => {
    const md = [
      '---',
      'name: gateway',
      'description: >-',
      '  First line of the folded',
      '  description spanning',
      '  multiple lines.',
      'metadata:',
      '  author: someone',
      '---',
      'body',
    ].join('\n');
    expect(parseSkillFrontmatter(md)).toEqual({
      name: 'gateway',
      description: 'First line of the folded description spanning multiple lines.',
    });
  });

  it('returns empty object when there is no frontmatter', () => {
    expect(parseSkillFrontmatter('# just a heading\n\ntext')).toEqual({});
  });

  it('returns empty object on an unterminated frontmatter block', () => {
    expect(parseSkillFrontmatter('---\nname: x\n')).toEqual({});
  });
});

describe('generateSkillsIndex', () => {
  function makeSkill(root: string, dir: string, frontmatter: string): void {
    fs.mkdirSync(path.join(root, dir), { recursive: true });
    fs.writeFileSync(path.join(root, dir, 'SKILL.md'), frontmatter);
  }

  it('builds an index with name, description, and read path; skips entries without a description', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-'));
    const out = path.join(os.tmpdir(), `idx-${Date.now()}.md`);
    makeSkill(root, 'alpha', '---\nname: alpha\ndescription: The alpha skill.\n---\n');
    makeSkill(root, 'beta', '---\nname: beta\ndescription: The beta skill.\n---\n');
    // No description → excluded from the index.
    makeSkill(root, 'gamma', '---\nname: gamma\n---\n');

    const result = generateSkillsIndex(root, out);
    expect(result).toBe(out);

    const body = fs.readFileSync(out, 'utf8');
    expect(body).toContain('**alpha** — The alpha skill.');
    expect(body).toContain(`Read: \`${path.join(root, 'alpha', 'SKILL.md')}\``);
    expect(body).toContain('**beta** — The beta skill.');
    expect(body).not.toContain('gamma');

    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(out, { force: true });
  });

  it('returns null when the skills directory does not exist', () => {
    const missing = path.join(os.tmpdir(), `no-such-skills-${Date.now()}`);
    expect(generateSkillsIndex(missing, path.join(os.tmpdir(), 'unused.md'))).toBeNull();
  });

  it('returns null when no skill has a description', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-empty-'));
    makeSkill(root, 'alpha', '---\nname: alpha\n---\n');
    expect(generateSkillsIndex(root, path.join(os.tmpdir(), 'unused.md'))).toBeNull();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('indexes symlinked selections and reports the resolved path', () => {
    const mount = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-mount-'));
    const effective = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-effective-'));
    const out = path.join(os.tmpdir(), `skills-index-${Date.now()}.md`);
    makeSkill(mount, 'alpha', '---\nname: alpha\ndescription: The alpha skill.\n---\n');
    makeSkill(mount, 'beta', '---\nname: beta\ndescription: The beta skill.\n---\n');
    // Only alpha is selected for this group.
    fs.symlinkSync(path.join(mount, 'alpha'), path.join(effective, 'alpha'));

    expect(generateSkillsIndex(effective, out)).toBe(out);
    const body = fs.readFileSync(out, 'utf8');
    expect(body).toContain(`Read: \`${fs.realpathSync(path.join(mount, 'alpha', 'SKILL.md'))}\``);
    expect(body).not.toContain('beta');

    fs.rmSync(mount, { recursive: true, force: true });
    fs.rmSync(effective, { recursive: true, force: true });
    fs.rmSync(out, { force: true });
  });
});

describe('resolveSkillsDir', () => {
  it('prefers the first candidate that has entries', () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-none-'));
    const populated = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-some-'));
    fs.mkdirSync(path.join(populated, 'alpha'));

    expect(resolveSkillsDir([empty, populated])).toBe(populated);
    expect(resolveSkillsDir(['/no/such/dir', populated])).toBe(populated);
    // Nothing anywhere: fall back to the last candidate rather than crashing.
    expect(resolveSkillsDir(['/no/such/dir', empty])).toBe(empty);

    fs.rmSync(empty, { recursive: true, force: true });
    fs.rmSync(populated, { recursive: true, force: true });
  });
});
