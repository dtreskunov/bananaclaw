import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import { installCatalogSkill, uninstallSkill, SkillInstallError } from './install.js';
import {
  addMarketplace,
  listCatalogs,
  MarketplaceError,
  normalizeRepoSource,
  removeMarketplace,
} from './marketplace.js';
import { listSkills } from './registry.js';
import { setSkillsStoreRoot } from './store.js';
import { GROUPS_DIR } from '../config.js';

/** Scratch group the vendored-install tests install into. */
const GROUP_FOLDER = '.test-skill-install';

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
  fs.rmSync(path.join(GROUPS_DIR, GROUP_FOLDER), { recursive: true, force: true });
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

  it('finds skills nested under dotted directories without descending into a skill', () => {
    setSkillsStoreRoot(tempDir('nanoclaw-skill-store-'));
    const repo = tempDir('nanoclaw-nested-repo-');
    // openai/skills keeps everything under skills/.curated/<slug>/.
    writeSkill(repo, 'skills/.curated/deep', 'name: deep\ndescription: Nested under a dot dir.');
    // A skill's own subdirectory must not be picked up as another skill.
    writeSkill(repo, 'skills/.curated/deep/references', 'name: references\ndescription: Not a skill of its own.');
    git(['init', '-b', 'main'], repo);
    git(['add', '-Af'], repo);
    git(['commit', '-m', 'init'], repo);

    addMarketplace({ repo, ref: 'main', id: 'nested' });
    const [catalog] = listCatalogs();
    expect(catalog!.plugins[0]!.skills.map((skill) => skill.slug)).toEqual(['deep']);
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

  /** Skill root of the group installs are vendored into. */
  function skillsRoot(): string {
    return path.join(GROUPS_DIR, GROUP_FOLDER, 'skills');
  }

  it('vendors the skill as a symlink into a sparse catalog checkout', () => {
    setup();
    const record = installCatalogSkill({
      groupFolder: GROUP_FOLDER,
      marketplaceId: 'test-catalog',
      plugin: 'document-skills',
      slug: 'pdf',
    });

    const link = path.join(skillsRoot(), 'pdf');
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    // Relative, so it resolves the same on the host and at /workspace/agent.
    expect(fs.readlinkSync(link)).toBe(path.join('.catalogs', 'test-catalog', 'skills', 'pdf'));
    expect(fs.existsSync(path.join(link, 'SKILL.md'))).toBe(true);
    expect(record).toMatchObject({ slug: 'pdf', catalogId: 'test-catalog', sourcePath: 'skills/pdf' });
    expect(record.commit).toMatch(/^[0-9a-f]{40}$/);

    // Only the requested path is checked out, not the whole catalog.
    const checkout = path.join(skillsRoot(), '.catalogs', 'test-catalog', 'skills');
    expect(fs.readdirSync(checkout)).toEqual(['pdf']);
  });

  it('reads provenance back out of git, and marks agent edits as modified', () => {
    setup();
    installCatalogSkill({
      groupFolder: GROUP_FOLDER,
      marketplaceId: 'test-catalog',
      plugin: 'document-skills',
      slug: 'pdf',
    });

    const discovered = listSkills([
      { origin: 'workspace', hostDir: skillsRoot(), containerDir: '/workspace/agent/skills' },
    ]);
    expect(discovered.map((skill) => [skill.slug, skill.origin])).toEqual([['pdf', 'installed']]);
    expect(discovered[0]!.git).toMatchObject({ sourcePath: 'skills/pdf', modified: false, localCommits: 0 });
    expect(discovered[0]!.git!.remote).toBeTruthy();
    expect(discovered[0]!.catalogId).toBe('test-catalog');

    fs.appendFileSync(path.join(skillsRoot(), 'pdf', 'SKILL.md'), '\nAgent edit.\n');
    const afterEdit = listSkills([
      { origin: 'workspace', hostDir: skillsRoot(), containerDir: '/workspace/agent/skills' },
    ]);
    expect(afterEdit[0]!.git!.modified).toBe(true);
  });

  it('shares one checkout between skills from the same catalog', () => {
    setup();
    for (const [plugin, slug] of [
      ['document-skills', 'pdf'],
      ['design-skills', 'canvas-design'],
    ] as const) {
      installCatalogSkill({ groupFolder: GROUP_FOLDER, marketplaceId: 'test-catalog', plugin, slug });
    }

    expect(fs.readdirSync(path.join(skillsRoot(), '.catalogs'))).toEqual(['test-catalog']);
    expect(fs.readdirSync(path.join(skillsRoot(), '.catalogs', 'test-catalog', 'skills')).sort()).toEqual([
      'canvas-design',
      'pdf',
    ]);
  });

  it('refuses a skill the plugin does not list', () => {
    setup();
    expect(() =>
      installCatalogSkill({
        groupFolder: GROUP_FOLDER,
        marketplaceId: 'test-catalog',
        plugin: 'document-skills',
        slug: 'orphan',
      }),
    ).toThrow(SkillInstallError);
  });

  it('refuses to shadow a built-in skill', () => {
    setup();
    const builtinSlug = listSkills().find((skill) => skill.origin === 'builtin')?.slug;
    expect(builtinSlug).toBeTruthy();
    expect(() =>
      installCatalogSkill({
        groupFolder: GROUP_FOLDER,
        marketplaceId: 'test-catalog',
        plugin: 'document-skills',
        slug: builtinSlug!,
      }),
    ).toThrow(SkillInstallError);
  });

  it("refuses to overwrite the agent's own skill of the same name", () => {
    setup();
    writeSkill(skillsRoot(), 'pdf', 'name: pdf\ndescription: The agent wrote this.');
    expect(() =>
      installCatalogSkill({
        groupFolder: GROUP_FOLDER,
        marketplaceId: 'test-catalog',
        plugin: 'document-skills',
        slug: 'pdf',
      }),
    ).toThrow(/already exists/);
  });

  it('uninstall drops the link but keeps the shared checkout, and guards local edits', () => {
    setup();
    installCatalogSkill({
      groupFolder: GROUP_FOLDER,
      marketplaceId: 'test-catalog',
      plugin: 'document-skills',
      slug: 'pdf',
    });

    fs.appendFileSync(path.join(skillsRoot(), 'pdf', 'SKILL.md'), '\nAgent edit.\n');
    expect(() => uninstallSkill(GROUP_FOLDER, 'pdf')).toThrow(/uncommitted/);

    uninstallSkill(GROUP_FOLDER, 'pdf', true);
    expect(fs.existsSync(path.join(skillsRoot(), 'pdf'))).toBe(false);
    // The checkout stays — other skills may still be pointing into it.
    expect(fs.existsSync(path.join(skillsRoot(), '.catalogs', 'test-catalog'))).toBe(true);
    expect(() => uninstallSkill(GROUP_FOLDER, 'pdf')).toThrow(SkillInstallError);
  });
});
