import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, expect, it } from 'vitest';

import { selectedSkillFragmentNames } from './claude-md-compose.js';

describe('selectedSkillFragmentNames', () => {
  it('returns only shared instruction fragments with effective skill entries', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-skill-fragments-'));
    const shared = path.join(root, 'shared');
    const effective = path.join(root, 'effective');
    fs.mkdirSync(effective, { recursive: true });
    for (const name of ['selected', 'unselected', 'no-fragment']) {
      fs.mkdirSync(path.join(shared, name), { recursive: true });
      if (name !== 'no-fragment') fs.writeFileSync(path.join(shared, name, 'instructions.md'), name);
    }
    fs.symlinkSync('/app/skills/selected', path.join(effective, 'selected'));
    fs.symlinkSync('/app/skills/no-fragment', path.join(effective, 'no-fragment'));

    expect(selectedSkillFragmentNames(shared, effective)).toEqual(['selected']);
    fs.rmSync(root, { recursive: true, force: true });
  });
});