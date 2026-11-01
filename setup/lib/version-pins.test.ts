/**
 * versions.json is the machine-checkable source for sanctioned component
 * versions: setup steps read it, /update-nanoclaw diffs it across updates.
 * These tests go red if the file, the pin, or the release-skill wiring is
 * deleted — the pin moving back to a hardcoded constant is the regression
 * this guards against.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { describe, expect, it } from 'vitest';

import { readVersionPin } from './version-pins.js';
import { gatewayRelease } from '../agent-vault-release.js';

const here = path.dirname(fileURLToPath(import.meta.url));

describe('readVersionPin', () => {
  it('resolves the Agent Vault gateway pin from the real versions.json', () => {
    expect(readVersionPin('agent-vault-gateway')).toBe('gw-v0.3.0');
  });

  it('keeps installation guidance on the reviewed release and user-owned contract', () => {
    const release = gatewayRelease();
    const skill = fs.readFileSync(path.join(here, '..', '..', '.claude/skills/init-agent-vault/SKILL.md'), 'utf8');
    expect(skill).toContain(`The reviewed pin is \`${release.version}\``);
    expect(skill).toContain(`\`${release.commit}\``);
    expect(skill).toContain('user-owned connections');
    expect(skill).toContain('group-bound OAuth placeholders');
    expect(skill).toContain('pin is not permission to downgrade a newer canary');
  });

  it('throws for a component with no pin', () => {
    expect(() => readVersionPin('no-such-component')).toThrow(/no pin/);
  });
});
