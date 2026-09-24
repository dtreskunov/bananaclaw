import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { installCatalogSkill, uninstallSkill, SkillInstallError } from './install.js';
import {
  addMarketplace,
  listCatalogs,
  MarketplaceError,
  normalizeRepoSource,
  previewCatalog,
  readCatalog,
  refreshMarketplace,
  removeMarketplace,
} from './marketplace.js';
import { listSkills } from './registry.js';
import { findRepoRoot, readSkillGit } from './skill-git.js';
import { getMarketplaceRecord, marketplaceCacheDir, putMarketplaceRecord, setSkillsStoreRoot } from './store.js';
import * as skillGit from './git.js';
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
  vi.restoreAllMocks();
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
    expect(fs.readlinkSync(link)).toBe(path.join('.catalogs', `test-catalog@${record.commit}`, 'skills', 'pdf'));
    expect(fs.existsSync(path.join(link, 'SKILL.md'))).toBe(true);
    expect(record).toMatchObject({ slug: 'pdf', catalogId: 'test-catalog', sourcePath: 'skills/pdf' });
    expect(record.commit).toMatch(/^[0-9a-f]{40}$/);

    // Only the requested path is checked out, not the whole catalog.
    const checkout = path.join(skillsRoot(), '.catalogs', `test-catalog@${record.commit}`, 'skills');
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

    const commit = getMarketplaceRecord('test-catalog')!.commit;
    expect(fs.readdirSync(path.join(skillsRoot(), '.catalogs'))).toEqual([`test-catalog@${commit}`]);
    expect(fs.readdirSync(path.join(skillsRoot(), '.catalogs', `test-catalog@${commit}`, 'skills')).sort()).toEqual([
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
    const installed = installCatalogSkill({
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
    expect(fs.existsSync(path.join(skillsRoot(), '.catalogs', `test-catalog@${installed.commit}`))).toBe(true);
    expect(() => uninstallSkill(GROUP_FOLDER, 'pdf')).toThrow(SkillInstallError);
  });

  function installPdf(expectedCommit?: string) {
    return installCatalogSkill({
      groupFolder: GROUP_FOLDER,
      marketplaceId: 'test-catalog',
      plugin: 'document-skills',
      slug: 'pdf',
      expectedCommit,
    });
  }

  function installCanvas(expectedCommit?: string) {
    return installCatalogSkill({
      groupFolder: GROUP_FOLDER,
      marketplaceId: 'test-catalog',
      plugin: 'design-skills',
      slug: 'canvas-design',
      expectedCommit,
    });
  }

  function advanceRemote(repo: string): void {
    writeSkill(repo, 'skills/pdf', 'name: pdf\ndescription: Updated PDF skill.');
    writeSkill(repo, 'skills/canvas-design', 'name: canvas-design\ndescription: Updated canvas skill.');
    git(['add', '-A'], repo);
    git(['commit', '-m', 'update skills'], repo);
  }

  it('installs the cached commit even when upstream has moved ahead', () => {
    const { repo } = setup();
    const commit = getMarketplaceRecord('test-catalog')!.commit!;
    advanceRemote(repo);

    const installed = installPdf(commit);
    expect(installed.commit).toBe(commit);
    expect(fs.readFileSync(path.join(skillsRoot(), 'pdf/SKILL.md'), 'utf8')).toContain('Work with PDF files.');
    expect(readSkillGit(fs.realpathSync(path.join(skillsRoot(), 'pdf')))).toMatchObject({
      remote: repo,
      commit,
      localCommits: 0,
      modified: false,
    });
  });

  it('installs offline and remains independent after the browsing cache is removed', () => {
    const { repo } = setup();
    const offline = `${repo}-offline`;
    fs.renameSync(repo, offline);
    tempDirs.push(offline);

    const installed = installPdf();
    const checkout = findRepoRoot(fs.realpathSync(path.join(skillsRoot(), 'pdf')))!;
    expect(fs.existsSync(path.join(checkout, '.git/objects/info/alternates'))).toBe(false);
    expect(readSkillGit(fs.realpathSync(path.join(skillsRoot(), 'pdf')))?.remote).toBe(repo);
    removeMarketplace('test-catalog');

    git(['fsck', '--full'], checkout);
    git(['sparse-checkout', 'add', 'skills/canvas-design'], checkout);
    expect(fs.readFileSync(path.join(checkout, 'skills/canvas-design/SKILL.md'), 'utf8')).toContain(
      'Design on a canvas.',
    );
    expect(readSkillGit(fs.realpathSync(path.join(skillsRoot(), 'pdf')))?.commit).toBe(installed.commit);
  });

  it('rejects a stale preview instead of silently installing the refreshed commit', async () => {
    const { repo } = setup();
    const oldCommit = getMarketplaceRecord('test-catalog')!.commit!;
    advanceRemote(repo);
    const fresh = await refreshMarketplace('test-catalog');
    expect(fresh.commit).not.toBe(oldCommit);

    expect(() => installPdf(oldCommit)).toThrow(/changed since it was displayed/);
    expect(fs.existsSync(path.join(skillsRoot(), 'pdf'))).toBe(false);
  });

  it('isolates new revisions without overwriting existing agent edits or commits', async () => {
    const { repo } = setup();
    const first = installPdf();
    const firstDir = findRepoRoot(fs.realpathSync(path.join(skillsRoot(), 'pdf')))!;
    fs.appendFileSync(path.join(skillsRoot(), 'pdf/SKILL.md'), '\nCommitted agent edit.\n');
    git(['add', '-A'], firstDir);
    git(['commit', '-m', 'agent edit'], firstDir);
    fs.appendFileSync(path.join(skillsRoot(), 'pdf/SKILL.md'), '\nUncommitted agent edit.\n');
    const before = readSkillGit(fs.realpathSync(path.join(skillsRoot(), 'pdf')));
    advanceRemote(repo);
    const refreshed = await refreshMarketplace('test-catalog');

    const second = installCanvas(refreshed.commit!);
    expect(second.commit).not.toBe(first.commit);
    expect(readSkillGit(fs.realpathSync(path.join(skillsRoot(), 'pdf')))).toEqual(before);
    expect(fs.readFileSync(path.join(skillsRoot(), 'pdf/SKILL.md'), 'utf8')).toContain('Uncommitted agent edit.');
    expect(fs.readFileSync(path.join(skillsRoot(), 'canvas-design/SKILL.md'), 'utf8')).toContain(
      'Updated canvas skill.',
    );
    expect(
      listSkills([{ origin: 'workspace', hostDir: skillsRoot(), containerDir: '/workspace/agent/skills' }]).map(
        (skill) => skill.catalogId,
      ),
    ).toEqual(['test-catalog', 'test-catalog']);
  });

  it.each(['uncommitted', 'committed'])('isolates a same-revision install from %s changes to its source', (mode) => {
    setup();
    const first = installPdf();
    const firstDir = findRepoRoot(fs.realpathSync(path.join(skillsRoot(), 'pdf')))!;
    git(['sparse-checkout', 'add', 'skills/canvas-design'], firstDir);
    const edited = path.join(firstDir, 'skills/canvas-design/SKILL.md');
    fs.appendFileSync(edited, '\nAgent changes.\n');
    if (mode === 'committed') {
      git(['add', '-A'], firstDir);
      git(['commit', '-m', 'agent edit'], firstDir);
    }

    const second = installCanvas(first.commit);
    expect(second.commit).toBe(first.commit);
    expect(findRepoRoot(fs.realpathSync(path.join(skillsRoot(), 'canvas-design')))).not.toBe(firstDir);
    expect(fs.readFileSync(path.join(skillsRoot(), 'canvas-design/SKILL.md'), 'utf8')).not.toContain('Agent changes.');
    expect(fs.readFileSync(edited, 'utf8')).toContain('Agent changes.');
    expect(
      listSkills([{ origin: 'workspace', hostDir: skillsRoot(), containerDir: '/workspace/agent/skills' }]).map(
        (skill) => skill.catalogId,
      ),
    ).toEqual(['test-catalog', 'test-catalog']);
  });

  it('adds a sparse path without disturbing uncommitted edits to another installed skill', () => {
    setup();
    installPdf();
    const firstDir = findRepoRoot(fs.realpathSync(path.join(skillsRoot(), 'pdf')))!;
    fs.appendFileSync(path.join(skillsRoot(), 'pdf/SKILL.md'), '\nKeep this edit.\n');
    installCanvas();
    expect(findRepoRoot(fs.realpathSync(path.join(skillsRoot(), 'canvas-design')))).toBe(firstDir);
    expect(fs.readFileSync(path.join(skillsRoot(), 'pdf/SKILL.md'), 'utf8')).toContain('Keep this edit.');
  });

  it('leaves legacy checkouts and their catalog identity intact', () => {
    setup();
    installPdf();
    const link = path.join(skillsRoot(), 'pdf');
    const firstDir = findRepoRoot(fs.realpathSync(link))!;
    const legacy = path.join(skillsRoot(), '.catalogs/test-catalog');
    fs.renameSync(firstDir, legacy);
    fs.unlinkSync(link);
    fs.symlinkSync('.catalogs/test-catalog/skills/pdf', link);
    fs.appendFileSync(path.join(link, 'SKILL.md'), '\nLegacy edit.\n');

    installCanvas();
    expect(fs.readlinkSync(link)).toBe('.catalogs/test-catalog/skills/pdf');
    expect(fs.readFileSync(path.join(link, 'SKILL.md'), 'utf8')).toContain('Legacy edit.');
    expect(
      listSkills([{ origin: 'workspace', hostDir: skillsRoot(), containerDir: '/workspace/agent/skills' }]).map(
        (skill) => skill.catalogId,
      ),
    ).toEqual(['test-catalog', 'test-catalog']);
  });

  it('rejects a missing or edited cache without trying the upstream', () => {
    setup();
    const cache = marketplaceCacheDir('test-catalog');
    fs.appendFileSync(path.join(cache, 'skills/pdf/SKILL.md'), '\nUnreviewed cache edit.\n');
    expect(() => installPdf()).toThrow(/cache has local changes/);
    fs.rmSync(cache, { recursive: true });
    expect(() => installPdf()).toThrow(/snapshot unavailable/);
    expect(fs.existsSync(path.join(skillsRoot(), 'pdf'))).toBe(false);
  });
});

describe('registering preview snapshots', () => {
  it('uses the expanded preview without fetching the newer upstream revision', () => {
    setSkillsStoreRoot(tempDir('nanoclaw-skill-store-'));
    const repo = makeMarketplaceRepo();
    const preview = previewCatalog({ repo });
    fs.appendFileSync(path.join(repo, 'skills/pdf/SKILL.md'), '\nNew upstream change.\n');
    git(['add', '-A'], repo);
    git(['commit', '-m', 'new upstream'], repo);

    const registered = addMarketplace({ repo, ref: preview.ref, expectedCommit: preview.commit! });
    expect(registered.commit).toBe(preview.commit);
    expect(registered.refreshedAt).toBeNull();
    const installed = installCatalogSkill({
      groupFolder: GROUP_FOLDER,
      marketplaceId: registered.id,
      plugin: 'document-skills',
      slug: 'pdf',
      expectedCommit: preview.commit!,
    });
    expect(installed.commit).toBe(preview.commit);
    expect(fs.readFileSync(path.join(GROUPS_DIR, GROUP_FOLDER, 'skills/pdf/SKILL.md'), 'utf8')).not.toContain(
      'New upstream change.',
    );
  });
});

describe('refreshing catalog snapshots', () => {
  function setupRefresh() {
    const store = tempDir('nanoclaw-refresh-store-');
    setSkillsStoreRoot(store);
    const repo = makeMarketplaceRepo();
    const record = {
      ...addMarketplace({ repo, id: 'refresh-catalog' }),
      refreshedAt: '2020-01-01T00:00:00.000Z',
    };
    putMarketplaceRecord(record);
    return { store, repo, record, cache: marketplaceCacheDir(record.id) };
  }

  it('publishes a validated commit and identity with a new successful-refresh timestamp', async () => {
    const { repo, record } = setupRefresh();
    fs.appendFileSync(path.join(repo, 'skills/pdf/SKILL.md'), '\nRefreshed content.\n');
    const manifestPath = path.join(repo, '.claude-plugin/marketplace.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    manifest.name = 'refreshed-name';
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));
    git(['add', '-A'], repo);
    git(['commit', '-m', 'refresh'], repo);

    const refreshed = await refreshMarketplace(record.id);
    expect(refreshed.commit).not.toBe(record.commit);
    expect(refreshed.label).toBe('refreshed-name');
    expect(Date.parse(refreshed.refreshedAt!)).toBeGreaterThan(Date.parse(record.refreshedAt));
    expect(refreshed.lastRefreshAttemptAt).toBeTruthy();
    expect(refreshed.lastRefreshError).toBeNull();
    expect(readCatalog(refreshed)).toMatchObject({ commit: refreshed.commit, error: null });
    expect(getMarketplaceRecord(record.id)).toEqual(refreshed);
  });

  it('records successful checks even if the remote commit has not changed', async () => {
    const { record } = setupRefresh();
    putMarketplaceRecord({ ...record, lastRefreshError: 'previous failure' });
    const refreshed = await refreshMarketplace(record.id);
    expect(refreshed.commit).toBe(record.commit);
    expect(refreshed.refreshedAt).not.toBe(record.refreshedAt);
    expect(refreshed.lastRefreshError).toBeNull();
  });

  it('keeps the prior cache installable after an upstream failure', async () => {
    const { repo, record, cache, store } = setupRefresh();
    const original = fs.readFileSync(path.join(cache, 'skills/pdf/SKILL.md'), 'utf8');
    const moved = `${repo}-offline`;
    fs.renameSync(repo, moved);
    tempDirs.push(moved);

    await expect(refreshMarketplace(record.id)).rejects.toThrow(/refresh failed/);
    const after = getMarketplaceRecord(record.id)!;
    expect(after).toMatchObject({ commit: record.commit, refreshedAt: record.refreshedAt });
    expect(after.lastRefreshError).toContain('refresh failed');
    expect(after.lastRefreshAttemptAt).toBeTruthy();
    expect(fs.readFileSync(path.join(cache, 'skills/pdf/SKILL.md'), 'utf8')).toBe(original);
    expect(fs.readdirSync(store).filter((entry) => entry.startsWith('.refresh-'))).toEqual([]);
    expect(
      installCatalogSkill({
        groupFolder: GROUP_FOLDER,
        marketplaceId: record.id,
        plugin: 'document-skills',
        slug: 'pdf',
        expectedCommit: record.commit!,
      }).commit,
    ).toBe(record.commit);
  });

  it('rejects an invalid refreshed catalog without replacing a valid snapshot', async () => {
    const { repo, record, cache } = setupRefresh();
    const oldManifest = fs.readFileSync(path.join(cache, '.claude-plugin/marketplace.json'), 'utf8');
    fs.writeFileSync(path.join(repo, '.claude-plugin/marketplace.json'), '{invalid');
    git(['add', '-A'], repo);
    git(['commit', '-m', 'invalid catalog'], repo);

    await expect(refreshMarketplace(record.id)).rejects.toThrow(/refreshed catalog is invalid/);
    expect(getMarketplaceRecord(record.id)).toMatchObject({ commit: record.commit, refreshedAt: record.refreshedAt });
    expect(fs.readFileSync(path.join(cache, '.claude-plugin/marketplace.json'), 'utf8')).toBe(oldManifest);
  });

  it('deduplicates overlapping refreshes while the old snapshot remains readable', async () => {
    const { record, cache } = setupRefresh();
    const actual = skillGit.gitAsync;
    let release!: () => void;
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    const spy = vi.spyOn(skillGit, 'gitAsync').mockImplementation(async (...args) => {
      await wait;
      return actual(...args);
    });

    const first = refreshMarketplace(record.id);
    const second = refreshMarketplace(record.id);
    expect(first).toBe(second);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(readCatalog(getMarketplaceRecord(record.id)!)).toMatchObject({ commit: record.commit, error: null });
    expect(() => removeMarketplace(record.id)).toThrow(/catalog is refreshing/);
    expect(fs.existsSync(path.join(cache, '.git'))).toBe(true);
    release();
    await first;
    expect(spy.mock.calls.filter(([args]) => args[0] === 'fetch')).toHaveLength(1);
  });

  it('does not replace a usable snapshot with a manifest containing no valid skills', async () => {
    const { record, repo } = setupRefresh();
    fs.writeFileSync(path.join(repo, '.claude-plugin/marketplace.json'), '{"plugins":[]}');
    git(['add', '-A'], repo);
    git(['commit', '-m', 'empty catalog'], repo);
    await expect(refreshMarketplace(record.id)).rejects.toThrow(/no supported, valid skills/);
    expect(readCatalog(getMarketplaceRecord(record.id)!).plugins.flatMap((plugin) => plugin.skills)).not.toEqual([]);
    expect(getMarketplaceRecord(record.id)?.refreshedAt).toBe(record.refreshedAt);
  });

  it('restores the previous cache when publication fails', async () => {
    const { record, cache, store } = setupRefresh();
    const rename = fs.renameSync;
    vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (String(from).endsWith('/next') && to === cache) {
        throw new Error('publication rename denied');
      }
      return rename(from, to);
    });

    await expect(refreshMarketplace(record.id)).rejects.toThrow(/publication rename denied/);
    expect(readCatalog(getMarketplaceRecord(record.id)!)).toMatchObject({ commit: record.commit, error: null });
    expect(getMarketplaceRecord(record.id)?.refreshedAt).toBe(record.refreshedAt);
    expect(fs.readdirSync(store).filter((entry) => entry.startsWith('.refresh-'))).toEqual([]);
  });

  it('rebuilds a missing browsing cache and clears its failure state', async () => {
    const { record, cache } = setupRefresh();
    fs.rmSync(cache, { recursive: true });
    const updated = await refreshMarketplace(record.id);
    expect(updated.commit).toBe(record.commit);
    expect(readCatalog(updated).error).toBeNull();
    expect(updated.lastRefreshError).toBeNull();
  });

  it('restores the old snapshot if saving the published metadata fails', async () => {
    const { record, cache } = setupRefresh();
    const rename = fs.renameSync;
    let published = false;
    let failSave = true;
    vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (String(from).endsWith('/next') && to === cache) published = true;
      if (published && failSave && String(to).endsWith('/marketplaces.json')) {
        failSave = false;
        throw new Error('metadata write denied');
      }
      return rename(from, to);
    });
    await expect(refreshMarketplace(record.id)).rejects.toThrow(/metadata write denied/);
    expect(readCatalog(getMarketplaceRecord(record.id)!)).toMatchObject({ commit: record.commit, error: null });
    expect(getMarketplaceRecord(record.id)?.refreshedAt).toBe(record.refreshedAt);
  });

  it('keeps installed checkout objects and local edits unchanged across refresh', async () => {
    const { record, repo } = setupRefresh();
    installCatalogSkill({
      groupFolder: GROUP_FOLDER,
      marketplaceId: record.id,
      plugin: 'document-skills',
      slug: 'pdf',
      expectedCommit: record.commit!,
    });
    const installed = path.join(GROUPS_DIR, GROUP_FOLDER, 'skills/pdf');
    fs.appendFileSync(path.join(installed, 'SKILL.md'), '\nKeep installed edits.\n');
    const before = readSkillGit(fs.realpathSync(installed));
    fs.appendFileSync(path.join(repo, 'skills/pdf/SKILL.md'), '\nNew upstream content.\n');
    git(['add', '-A'], repo);
    git(['commit', '-m', 'new upstream content'], repo);
    await refreshMarketplace(record.id);
    expect(readSkillGit(fs.realpathSync(installed))).toEqual(before);
    const content = fs.readFileSync(path.join(installed, 'SKILL.md'), 'utf8');
    expect(content).toContain('Keep installed edits.');
    expect(content).not.toContain('New upstream content.');
  });

  it('rejects unknown catalogs asynchronously', async () => {
    setSkillsStoreRoot(tempDir('nanoclaw-refresh-store-'));
    await expect(refreshMarketplace('missing')).rejects.toThrow('unknown catalog');
  });
});

describe('preview snapshot identity', () => {
  it('uses a registered catalog with a custom id when previewing its source', () => {
    setSkillsStoreRoot(tempDir('nanoclaw-skill-store-'));
    const repo = makeMarketplaceRepo();
    const registered = addMarketplace({ repo, id: 'custom-id' });
    expect(previewCatalog({ repo }).id).toBe(registered.id);
    expect(previewCatalog({ repo }).commit).toBe(registered.commit);
  });

  it('rejects a replaced preview without deleting its newer cache', () => {
    setSkillsStoreRoot(tempDir('nanoclaw-skill-store-'));
    const repo = makeMarketplaceRepo();
    const first = previewCatalog({ repo });
    fs.appendFileSync(path.join(repo, 'skills/pdf/SKILL.md'), '\nNew revision.\n');
    git(['add', '-A'], repo);
    git(['commit', '-m', 'new revision'], repo);
    const second = previewCatalog({ repo });
    expect(second.commit).not.toBe(first.commit);

    expect(() => addMarketplace({ repo, ref: first.ref, expectedCommit: first.commit! })).toThrow(/cache changed/);
    expect(getMarketplaceRecord(first.id)).toBeNull();
    expect(fs.existsSync(path.join(marketplaceCacheDir(first.id), '.git'))).toBe(true);
    expect(addMarketplace({ repo, ref: second.ref, expectedCommit: second.commit! }).commit).toBe(second.commit);
  });
});
