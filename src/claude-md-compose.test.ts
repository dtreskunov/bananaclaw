import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, expect, it } from 'vitest';

import { selectedSkillFragments } from './claude-md-compose.js';

describe('selectedSkillFragments', () => {
  it('returns only instruction fragments with effective skill entries', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-skill-fragments-'));
    const shared = path.join(root, 'shared');
    const effective = path.join(root, 'effective');
    fs.mkdirSync(effective, { recursive: true });
    for (const name of ['selected', 'unselected', 'no-fragment']) {
      fs.mkdirSync(path.join(shared, name), { recursive: true });
      fs.writeFileSync(path.join(shared, name, 'SKILL.md'), `---\nname: ${name}\ndescription: test\n---\n`);
      if (name !== 'no-fragment') fs.writeFileSync(path.join(shared, name, 'instructions.md'), name);
    }
    fs.symlinkSync('/app/skills/selected', path.join(effective, 'selected'));
    fs.symlinkSync('/app/skills/no-fragment', path.join(effective, 'no-fragment'));

    expect(selectedSkillFragments(effective, [{ origin: 'builtin', hostDir: shared, containerDir: '/app/skills' }])).toEqual([
      { slug: 'selected', containerPath: '/app/skills/selected' },
    ]);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('points installed-root fragments at the installed container path', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-skill-fragments-'));
    const installed = path.join(root, 'installed');
    const effective = path.join(root, 'effective');
    fs.mkdirSync(effective, { recursive: true });
    fs.mkdirSync(path.join(installed, 'extra'), { recursive: true });
    fs.writeFileSync(path.join(installed, 'extra', 'SKILL.md'), '---\nname: extra\ndescription: test\n---\n');
    fs.writeFileSync(path.join(installed, 'extra', 'instructions.md'), 'extra');
    fs.symlinkSync('/app/skills-installed/extra', path.join(effective, 'extra'));

    expect(
      selectedSkillFragments(effective, [
        { origin: 'installed', hostDir: installed, containerDir: '/app/skills-installed' },
      ]),
    ).toEqual([{ slug: 'extra', containerPath: '/app/skills-installed/extra' }]);
    fs.rmSync(root, { recursive: true, force: true });
  });
});