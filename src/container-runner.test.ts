import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

import { packageDockerfile, resolveProviderName, sessionLinkMount, syncSkillSymlinks } from './container-runner.js';

describe('packageDockerfile', () => {
  const none = { apt: [], npm: [], pip: [] };

  it('quotes version constraints so they are not read as redirects', () => {
    const out = packageDockerfile('base', { ...none, pip: ['minimax-mcp', 'mcp<2'] });
    expect(out).toContain(`pip install --no-cache-dir 'minimax-mcp' 'mcp<2'`);
    expect(out).not.toMatch(/mcp<2(?!')/);
  });

  it('quotes npm specs in both the build allowlist and the install', () => {
    const out = packageDockerfile('base', { ...none, npm: ['@stripe/link-cli@0.13.1'] });
    expect(out).toContain(`echo 'only-built-dependencies[]=@stripe/link-cli@0.13.1' >> /root/.npmrc`);
    expect(out).toContain(`pnpm install -g '@stripe/link-cli@0.13.1'`);
  });

  it('escapes a quote inside a spec rather than closing the string', () => {
    expect(packageDockerfile('base', { ...none, apt: [`a'b`] })).toContain(`'a'\\''b'`);
  });

  it('emits no install step for an empty list', () => {
    expect(packageDockerfile('base', none)).toBe('FROM base\nUSER root\nUSER node\n');
  });
});

describe('resolveProviderName', () => {
  it('uses the container config provider', () => {
    expect(resolveProviderName('opencode')).toBe('opencode');
  });

  it('defaults to claude when nothing is set', () => {
    expect(resolveProviderName(undefined)).toBe('claude');
  });

  it('lowercases the resolved name', () => {
    expect(resolveProviderName('CODEX')).toBe('codex');
  });

  it('treats empty string as unset (falls through)', () => {
    expect(resolveProviderName('')).toBe('claude');
  });

  it('uses env default when config is unset', () => {
    expect(resolveProviderName(null, 'codex')).toBe('codex');
    expect(resolveProviderName(undefined, 'OPENCODE')).toBe('opencode');
  });

  it('container config still wins over env default', () => {
    expect(resolveProviderName('claude', 'codex')).toBe('claude');
  });

  it('falls through env empty/null to claude', () => {
    expect(resolveProviderName(null, '')).toBe('claude');
    expect(resolveProviderName(null, null)).toBe('claude');
  });
});

describe('sessionLinkMount', () => {
  it('mounts only the session capability directory read-only', () => {
    const mount = sessionLinkMount('session-a');
    expect(mount.containerPath).toBe('/run/nanoclaw');
    expect(mount.readonly).toBe(true);
    expect(mount.hostPath).toMatch(/[\\/]+data[\\/]+\.session-links[\\/]+[a-f0-9]{24}$/);
    expect(mount.hostPath).not.toContain('session-a');
  });
});

describe('syncSkillSymlinks', () => {
  it('converts selected fx copies back to symlinks and removes unselected shared copies', () => {
    const root = fs.mkdtempSync(path.join('/tmp', 'nanoclaw-skill-sync-'));
    const claudeDir = path.join(root, 'claude');
    const shared = path.join(root, 'shared');
    for (const name of ['selected', 'unselected']) {
      fs.mkdirSync(path.join(shared, name), { recursive: true });
      fs.writeFileSync(path.join(shared, name, 'SKILL.md'), `---\nname: ${name}\ndescription: test\n---\n`);
      fs.mkdirSync(path.join(claudeDir, 'skills', name), { recursive: true });
      fs.writeFileSync(path.join(claudeDir, 'skills', name, 'SKILL.md'), 'old fx copy');
    }
    fs.mkdirSync(path.join(claudeDir, 'skills', 'custom'), { recursive: true });

    syncSkillSymlinks(claudeDir, { provider: 'native', skills: ['selected'] } as never, [
      { origin: 'builtin', hostDir: shared, containerDir: '/app/skills' },
    ]);

    expect(fs.lstatSync(path.join(claudeDir, 'skills', 'selected')).isSymbolicLink()).toBe(true);
    expect(fs.readlinkSync(path.join(claudeDir, 'skills', 'selected'))).toBe('/app/skills/selected');
    expect(fs.existsSync(path.join(claudeDir, 'skills', 'unselected'))).toBe(false);
    expect(fs.existsSync(path.join(claudeDir, 'skills', 'custom'))).toBe(false);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('links a symlinked skill folder and repoints a slug that moved roots', () => {    const root = fs.mkdtempSync(path.join('/tmp', 'nanoclaw-skill-sync-'));
    const claudeDir = path.join(root, 'claude');
    const builtin = path.join(root, 'builtin');
    const installed = path.join(root, 'installed');
    const external = path.join(root, 'external', 'linked');

    // A skill folder that is itself a symlink into a checkout outside the repo.
    fs.mkdirSync(external, { recursive: true });
    fs.writeFileSync(path.join(external, 'SKILL.md'), '---\nname: linked\ndescription: test\n---\n');
    fs.mkdirSync(builtin, { recursive: true });
    fs.symlinkSync(external, path.join(builtin, 'linked'));

    fs.mkdirSync(path.join(installed, 'moved'), { recursive: true });
    fs.writeFileSync(path.join(installed, 'moved', 'SKILL.md'), '---\nname: moved\ndescription: test\n---\n');
    fs.mkdirSync(path.join(claudeDir, 'skills'), { recursive: true });
    fs.symlinkSync('/app/skills/moved', path.join(claudeDir, 'skills', 'moved'));

    syncSkillSymlinks(claudeDir, { provider: 'native', skills: 'all' } as never, [
      { origin: 'builtin', hostDir: builtin, containerDir: '/app/skills' },
      { origin: 'installed', hostDir: installed, containerDir: '/app/skills-installed' },
    ]);

    expect(fs.readlinkSync(path.join(claudeDir, 'skills', 'linked'))).toBe('/app/skills/linked');
    expect(fs.readlinkSync(path.join(claudeDir, 'skills', 'moved'))).toBe('/app/skills-installed/moved');
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('keeps workspace skills linked even when the selection excludes them', () => {
    const root = fs.mkdtempSync(path.join('/tmp', 'nanoclaw-skill-sync-'));
    const claudeDir = path.join(root, 'claude');
    const builtin = path.join(root, 'builtin');
    const workspace = path.join(root, 'workspace');
    for (const [dir, name] of [
      [builtin, 'unselected'],
      [workspace, 'homegrown'],
    ] as const) {
      fs.mkdirSync(path.join(dir, name), { recursive: true });
      fs.writeFileSync(path.join(dir, name, 'SKILL.md'), `---\nname: ${name}\ndescription: test\n---\n`);
    }

    // The agent owns its workspace dir, so an explicit selection can't turn
    // those off — the native provider loads them regardless.
    syncSkillSymlinks(claudeDir, { provider: 'native', skills: [] } as never, [
      { origin: 'builtin', hostDir: builtin, containerDir: '/app/skills' },
      { origin: 'workspace', hostDir: workspace, containerDir: '/workspace/agent/skills' },
    ]);

    expect(fs.readlinkSync(path.join(claudeDir, 'skills', 'homegrown'))).toBe('/workspace/agent/skills/homegrown');
    expect(fs.existsSync(path.join(claudeDir, 'skills', 'unselected'))).toBe(false);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('lets the deny-list switch off a workspace skill and a selected one', () => {
    const root = fs.mkdtempSync(path.join('/tmp', 'nanoclaw-skill-sync-'));
    const claudeDir = path.join(root, 'claude');
    const builtin = path.join(root, 'builtin');
    const workspace = path.join(root, 'workspace');
    for (const [dir, name] of [
      [builtin, 'kept'],
      [builtin, 'denied'],
      [workspace, 'homegrown'],
    ] as const) {
      fs.mkdirSync(path.join(dir, name), { recursive: true });
      fs.writeFileSync(path.join(dir, name, 'SKILL.md'), `---\nname: ${name}\ndescription: test\n---\n`);
    }

    syncSkillSymlinks(
      claudeDir,
      { provider: 'native', skills: ['kept', 'denied'], disabledSkills: ['denied', 'homegrown'] } as never,
      [
        { origin: 'builtin', hostDir: builtin, containerDir: '/app/skills' },
        { origin: 'workspace', hostDir: workspace, containerDir: '/workspace/agent/skills' },
      ],
    );

    expect(fs.readdirSync(path.join(claudeDir, 'skills')).sort()).toEqual(['kept']);
    fs.rmSync(root, { recursive: true, force: true });
  });
});

describe('buildContainerArgs ordering invariant (structural)', () => {
  // The OneCLI gateway apply (SDK applyContainerConfig) appends credential-stub
  // mounts — e.g. the codex auth.json sentinel nested INSIDE our RW
  // /home/node/.codex mount. Docker applies binds in argument order, so the
  // stub must land AFTER its parent mount or the parent shadows it and the
  // agent silently degrades to loginless auth. Driving the real
  // buildContainerArgs needs a live gateway + container runtime, so this
  // guards the invariant structurally: the gateway apply must appear after
  // the volume-mounts loop in the source.
  it('applies the OneCLI gateway after the volume mounts', () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'src', 'container-runner.ts'), 'utf-8');
    const mountsLoop = src.indexOf('for (const mount of mounts)');
    const gatewayApply = src.indexOf('onecli.applyContainerConfig');
    expect(mountsLoop).toBeGreaterThan(-1);
    expect(gatewayApply).toBeGreaterThan(-1);
    expect(gatewayApply).toBeGreaterThan(mountsLoop);
  });
});

describe('container boot-failure tripwire (structural)', () => {
  // A container that dies at boot (unknown provider, missing CLI binary, bad
  // config) explains itself only on stderr — which logs at debug, below the
  // default level. The detached `docker run` spawn handler must keep a stderr
  // tail and surface it at warn on a non-zero exit, or the operator sees only
  // "exited code 1" on repeat. Driving a real failing spawn needs a container
  // runtime, so this guards the wiring structurally, matching the invariant
  // test above.
  it('surfaces the stderr tail when the container exits non-zero', () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'src', 'container-runner.ts'), 'utf-8');
    expect(src).toContain('runStderr += data.toString()');
    expect(src).toMatch(/runStderr[\s\S]*slice\(-20\)/);
    expect(src).toMatch(/exited non-zero[\s\S]*stderr: tail/);
  });
});
