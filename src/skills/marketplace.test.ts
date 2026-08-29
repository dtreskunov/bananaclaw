import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import { installCatalogSkill, installedUpdateStatus, uninstallSkill, SkillInstallError } from './install.js';
import {
  addMarketplace,
  listCatalogs,
  MarketplaceError,
  normalizeRepoSource,
  refreshMarketplace,
  removeMarketplace,
} from './marketplace.js';
import { listSkills } from './registry.js';
import { getInstalledRecord, installedSkillsDir, setSkillsStoreRoot } from './store.js';

const tempDirs: string[] = [];

function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function git(args: string[], cwd: string): void {
  execFileSync('git', args, {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'test',
      GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'test',
      GIT_COMMITTER_EMAIL: 'test@example.com',
    },
    stdio: 'ignore',
  });
}

function writeSkill(root: string, rel: string, frontmatter: string): string {
  const dir = path.join(root, rel);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\n${frontmatter}\n---\n\n# Body\n`, 'utf8');
  return dir;
}

/** A git repo laid out like a Claude Code plugin marketplace. */
function makeMarketplaceRepo(): string {
  const repo = tempDir('nanoclaw-marketplace-repo-');
  writeSkill(repo, 'skills/pdf', 'name: pdf\ndescription: Work with PDF files.\nlicense: Proprietary');
  writeSkill(repo, 'skills/canvas-design', 'name: canvas-design\ndescription: Design on a canvas.');
  writeSkill(repo, 'skills/orphan', 'name: orphan\ndescription: Not listed by any plugin.');
  fs.mkdirSync(path.join(repo, '.claude-plugin'), { recursive: true });
  fs.writeFileSync(
    path.join(repo, '.claude-plugin', 'marketplace.json'),
    JSON.stringify({
      name: 'test-agent-skills',
      metadata: { description: 'Test catalog' },
      plugins: [
        { name: 'document-skills', description: 'Docs', source: './', skills: ['./skills/pdf'] },
        { name: 'design-skills', source: './', skills: ['./skills/canvas-design'] },
        { name: 'remote-skills', source: 'https://example.com/other.git' },
      ],
    }),
  );
  git(['init', '-b', 'main'], repo);
  git(['add', '-A'], repo);
  git(['commit', '-m', 'init'], repo);
  return repo;
}

afterEach(() => {
  setSkillsStoreRoot(null);
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('normalizeRepoSource', () => {
  it('expands owner/repo shorthand and accepts https', () => {
    expect(normalizeRepoSource('anthropics/skills')).toBe('https://github.com/anthropics/skills.git');
    expect(normalizeRepoSource('https://github.com/anthropics/skills.git')).toBe(
      'https://github.com/anthropics/skills.git',
    );
  });

  it('refuses transports and option-looking values that could reach git', () => {
    for (const bad of [
      'git@github.com:a/b.git',
      'git://x/y',
      'file:///tmp/x',
      '--upload-pack=touch /tmp/pwn',
      'http://x/y',
      '',
    ]) {
      expect(() => normalizeRepoSource(bad)).toThrow(MarketplaceError);
    }
  });
});

describe('plugin marketplaces', () => {
  it('adds a catalog and groups skills by plugin', () => {
    setSkillsStoreRoot(tempDir('nanoclaw-skill-store-'));
    const record = addMarketplace({ repo: makeMarketplaceRepo(), ref: 'main', id: 'test-catalog' });
    expect(record.label).toBe('test-agent-skills');
    expect(record.description).toBe('Test catalog');
    expect(record.commit).toMatch(/^[0-9a-f]{40}$/);

    const [catalog] = listCatalogs();
    expect(catalog!.kind).toBe('plugin-marketplace');
    expect(catalog!.plugins.map((plugin) => plugin.name)).toEqual([
      'document-skills',
      'design-skills',
      'remote-skills',
    ]);
    // Only manifest-listed skills appear; `orphan` is in the repo but unlisted.
    expect(catalog!.plugins[0]!.skills.map((skill) => skill.slug)).toEqual(['pdf']);
    expect(catalog!.plugins[0]!.skills[0]).toMatchObject({ path: 'skills/pdf', license: 'Proprietary' });
    expect(catalog!.plugins[2]!.unsupportedReason).toContain('outside this repository');
  });

  it('falls back to scanning skills/ when there is no manifest', () => {
    setSkillsStoreRoot(tempDir('nanoclaw-skill-store-'));
    const repo = tempDir('nanoclaw-plain-repo-');
    writeSkill(repo, 'skills/alpha', 'name: alpha\ndescription: Plain repo skill.');
    git(['init', '-b', 'main'], repo);
    git(['add', '-A'], repo);
    git(['commit', '-m', 'init'], repo);

    addMarketplace({ repo, ref: 'main', id: 'plain' });
    const [catalog] = listCatalogs();
    expect(catalog!.kind).toBe('skill-repo');
    expect(catalog!.plugins[0]!.skills.map((skill) => skill.slug)).toEqual(['alpha']);
  });

  it('rejects a duplicate id and forgets the cache on removal', () => {
    const store = tempDir('nanoclaw-skill-store-');
    setSkillsStoreRoot(store);
    const repo = makeMarketplaceRepo();
    addMarketplace({ repo, ref: 'main', id: 'dup' });
    expect(() => addMarketplace({ repo, ref: 'main', id: 'dup' })).toThrow(MarketplaceError);

    removeMarketplace('dup');
    expect(listCatalogs()).toEqual([]);
    expect(fs.existsSync(path.join(store, 'cache', 'dup'))).toBe(false);
  });
});

describe('installing from a catalog', () => {
  function setup(): { store: string; repo: string } {
    const store = tempDir('nanoclaw-skill-store-');
    setSkillsStoreRoot(store);
    const repo = makeMarketplaceRepo();
    addMarketplace({ repo, ref: 'main', id: 'test-catalog' });
    return { store, repo };
  }

  it('copies the skill in and records provenance', () => {
    setup();
    const record = installCatalogSkill({
      marketplaceId: 'test-catalog',
      plugin: 'document-skills',
      slug: 'pdf',
      actorUserId: 'web:someone',
    });

    expect(fs.existsSync(path.join(installedSkillsDir(), 'pdf', 'SKILL.md'))).toBe(true);
    expect(record).toMatchObject({
      slug: 'pdf',
      marketplaceId: 'test-catalog',
      plugin: 'document-skills',
      path: 'skills/pdf',
      license: 'Proprietary',
      installedBy: 'web:someone',
    });
    expect(record.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(getInstalledRecord('pdf')!.commit).toMatch(/^[0-9a-f]{40}$/);

    // The installed root feeds discovery like any other skill.
    const discovered = listSkills([
      { origin: 'installed', hostDir: installedSkillsDir(), containerDir: '/app/skills-installed' },
    ]);
    expect(discovered.map((skill) => skill.slug)).toEqual(['pdf']);
    expect(discovered[0]!.source!.repo).toBeTruthy();
  });

  it('refuses a skill the plugin does not list', () => {
    setup();
    expect(() =>
      installCatalogSkill({ marketplaceId: 'test-catalog', plugin: 'document-skills', slug: 'orphan' }),
    ).toThrow(SkillInstallError);
  });

  it('refuses to shadow a built-in skill', () => {
    setup();
    const builtinSlug = listSkills().find((skill) => skill.origin === 'builtin')?.slug;
    expect(builtinSlug).toBeTruthy();
    // Re-point the catalog entry at a name that collides with the repo's own skills.
    expect(() =>
      installCatalogSkill({ marketplaceId: 'test-catalog', plugin: 'document-skills', slug: builtinSlug! }),
    ).toThrow(SkillInstallError);
  });

  it('refuses a source tree containing a symlink', () => {
    const { repo } = setup();
    fs.symlinkSync('/etc/passwd', path.join(repo, 'skills', 'pdf', 'secrets'));
    git(['add', '-A'], repo);
    git(['commit', '-m', 'add symlink'], repo);
    refreshMarketplace('test-catalog');

    expect(() =>
      installCatalogSkill({ marketplaceId: 'test-catalog', plugin: 'document-skills', slug: 'pdf' }),
    ).toThrow(/symlink/);
  });

  it('flags an upstream change as an available update, and uninstall clears it', () => {
    const { repo } = setup();
    installCatalogSkill({ marketplaceId: 'test-catalog', plugin: 'document-skills', slug: 'pdf' });
    expect(installedUpdateStatus()).toEqual({ pdf: false });

    fs.appendFileSync(path.join(repo, 'skills', 'pdf', 'SKILL.md'), '\nNew guidance.\n');
    git(['commit', '-am', 'update pdf'], repo);
    refreshMarketplace('test-catalog');
    expect(installedUpdateStatus()).toEqual({ pdf: true });

    uninstallSkill('pdf');
    expect(installedUpdateStatus()).toEqual({});
    expect(fs.existsSync(path.join(installedSkillsDir(), 'pdf'))).toBe(false);
    expect(() => uninstallSkill('pdf')).toThrow(SkillInstallError);
  });
});
