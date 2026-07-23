import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import { listAvailableSkills } from './skill-catalog.js';

const tempDirs: string[] = [];

function makeSkill(root: string, slug: string, frontmatter: string): void {
  const dir = path.join(root, slug);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\n${frontmatter}\n---\n`, 'utf8');
}

afterEach(() => {
  delete process.env.SKILL_CATALOG_TEST_ENABLED;
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('listAvailableSkills', () => {
  it('reads and sorts installed SKILL.md metadata, including folded descriptions', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-skills-'));
    tempDirs.push(root);
    makeSkill(root, 'zeta', 'name: Zeta\ndescription: >-\n  Folded description\n  stays intact.');
    makeSkill(root, 'alpha', 'description: Alpha description.');
    fs.mkdirSync(path.join(root, 'not-a-skill'));

    expect(listAvailableSkills(root)).toEqual([
      {
        slug: 'alpha',
        name: 'alpha',
        description: 'Alpha description.',
        available: true,
        unavailableReason: null,
      },
      {
        slug: 'zeta',
        name: 'Zeta',
        description: 'Folded description stays intact.',
        available: true,
        unavailableReason: null,
      },
    ]);
  });

  it('keeps skills with unmet environment requirements visible but unavailable', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-skills-'));
    tempDirs.push(root);
    makeSkill(
      root,
      'conditional',
      'name: Conditional\ndescription: Needs a feature flag.\nrequires_env: SKILL_CATALOG_TEST_ENABLED',
    );

    expect(listAvailableSkills(root)).toEqual([
      {
        slug: 'conditional',
        name: 'Conditional',
        description: 'Needs a feature flag.',
        available: false,
        unavailableReason: 'Requires SKILL_CATALOG_TEST_ENABLED',
      },
    ]);
  });
});
