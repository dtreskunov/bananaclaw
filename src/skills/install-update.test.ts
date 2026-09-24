import { execFileSync } from 'child_process';
import { randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as skillGit from './git.js';
import { installCatalogSkill, resolveSkillUpdate, updateCatalogSkill } from './install.js';
import { addMarketplace, refreshMarketplace } from './marketplace.js';
import { defaultSkillRoots, groupCatalogsDir, groupSkillsDir, listSkills } from './registry.js';
import { findRepoRoot } from './skill-git.js';
import { getMarketplaceRecord, marketplaceCacheDir, putMarketplaceRecord, setSkillsStoreRoot } from './store.js';

let root: string;
let repo: string;
let groupFolder: string;
const catalogId = 'update-test';
const slug = 'update-alpha';
const otherSlug = 'update-beta';

function git(args: string[], cwd = repo): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'test',
      GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'test',
      GIT_COMMITTER_EMAIL: 'test@example.com',
      GIT_TERMINAL_PROMPT: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function skillPath(name = slug): string {
  return path.join(groupSkillsDir(groupFolder), name);
}

function contents(name = slug): string {
  return fs.readFileSync(path.join(skillPath(name), 'SKILL.md'), 'utf8');
}

function writeSkill(name: string, body: string, dir = repo): void {
  fs.mkdirSync(path.join(dir, 'skills', name), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'skills', name, 'SKILL.md'),
    `---\nname: ${name}\ndescription: A test skill.\n---\n${body}\n`,
  );
}

function manifest(plugins = [{ name: 'tools', source: './', skills: [`./skills/${slug}`, `./skills/${otherSlug}`] }]) {
  fs.mkdirSync(path.join(repo, '.claude-plugin'), { recursive: true });
  fs.writeFileSync(path.join(repo, '.claude-plugin', 'marketplace.json'), JSON.stringify({ plugins }));
}

function commit(message: string, dir = repo): string {
  git(['add', '-A'], dir);
  git(['commit', '-m', message], dir);
  return git(['rev-parse', 'HEAD'], dir);
}

function install(name = slug): string {
  installCatalogSkill({ groupFolder, marketplaceId: catalogId, plugin: 'tools', slug: name });
  return findRepoRoot(fs.realpathSync(skillPath(name)))!;
}

function legacy(): string {
  const original = install();
  const dir = path.join(groupCatalogsDir(groupFolder), catalogId);
  fs.renameSync(original, dir);
  fs.unlinkSync(skillPath());
  fs.symlinkSync(path.relative(groupSkillsDir(groupFolder), path.join(dir, 'skills', slug)), skillPath());
  return dir;
}

async function advance(): Promise<string> {
  writeSkill(slug, 'new alpha');
  writeSkill(otherSlug, 'new beta');
  commit('upstream update');
  return (await refreshMarketplace(catalogId)).commit!;
}

function request() {
  return resolveSkillUpdate(groupFolder, slug);
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(process.cwd(), '.test-skill-update-'));
  repo = path.join(root, 'upstream');
  groupFolder = `test-skill-update-${randomUUID()}`;
  setSkillsStoreRoot(path.join(root, 'store'));
  writeSkill(slug, 'old alpha');
  writeSkill(otherSlug, 'old beta');
  fs.writeFileSync(path.join(repo, '.gitignore'), '*.ignored\n');
  manifest();
  git(['init', '-b', 'main']);
  commit('initial');
  addMarketplace({ repo, ref: 'main', id: catalogId });
});

afterEach(() => {
  vi.restoreAllMocks();
  setSkillsStoreRoot(null);
  fs.rmSync(path.dirname(groupSkillsDir(groupFolder)), { recursive: true, force: true });
  fs.rmSync(root, { recursive: true, force: true });
});

describe('cached installed skill updates', () => {
  it.each(['revision', 'legacy'])('updates a %s checkout with a pinned, derived request', async (layout) => {
    const oldDir = layout === 'legacy' ? legacy() : install();
    const oldHead = git(['rev-parse', 'HEAD'], oldDir);
    const fresh = await advance();
    expect(request()).toEqual({ groupFolder, marketplaceId: catalogId, plugin: 'tools', slug, expectedCommit: fresh });

    expect(updateCatalogSkill(request())).toEqual({
      slug,
      catalogId,
      repo,
      ref: 'main',
      commit: fresh,
      sourcePath: `skills/${slug}`,
    });
    expect(contents()).toContain('new alpha');
    expect(fs.readlinkSync(skillPath())).toBe(path.join('.catalogs', `${catalogId}@${fresh}`, 'skills', slug));
    expect(git(['rev-parse', 'HEAD'], oldDir)).toBe(oldHead);
    expect(fs.readFileSync(path.join(oldDir, 'skills', slug, 'SKILL.md'), 'utf8')).toContain('old alpha');
  });

  it.each(['revision', 'legacy'])('returns no-op success for a clean current %s checkout', (layout) => {
    if (layout === 'legacy') legacy();
    else install();
    const link = fs.readlinkSync(skillPath());
    const inode = fs.lstatSync(skillPath()).ino;
    const run = vi.spyOn(skillGit, 'git');
    const rename = vi.spyOn(fs, 'renameSync');
    expect(updateCatalogSkill(request()).commit).toBe(getMarketplaceRecord(catalogId)!.commit);
    expect(fs.readlinkSync(skillPath())).toBe(link);
    expect(fs.lstatSync(skillPath()).ino).toBe(inode);
    expect(rename).not.toHaveBeenCalled();
    expect(run.mock.calls.some(([args]) => args[0] === 'clone' || args[0] === 'sparse-checkout')).toBe(false);
  });

  it('uses the actual legacy skill path instead of its broader sparse cone', async () => {
    const dir = legacy();
    git(['sparse-checkout', 'set', '--', 'skills'], dir);
    await advance();
    expect(updateCatalogSkill(request()).sourcePath).toBe(`skills/${slug}`);
    expect(contents()).toContain('new alpha');
  });

  it.each(['clean', 'uncommitted', 'committed'])('preserves the other shared skill with %s work', async (mode) => {
    const oldDir = install();
    expect(install(otherSlug)).toBe(oldDir);
    if (mode !== 'clean') {
      fs.appendFileSync(path.join(skillPath(otherSlug), 'SKILL.md'), '\nKeep beta work.\n');
      if (mode === 'committed') commit('local beta edit', oldDir);
    }
    const beta = contents(otherSlug);
    const betaLink = fs.readlinkSync(skillPath(otherSlug));
    const head = git(['rev-parse', 'HEAD'], oldDir);
    const status = git(['status', '--porcelain'], oldDir);
    await advance();
    updateCatalogSkill(request());
    expect(contents()).toContain('new alpha');
    expect(contents(otherSlug)).toBe(beta);
    expect(fs.readlinkSync(skillPath(otherSlug))).toBe(betaLink);
    expect(git(['rev-parse', 'HEAD'], oldDir)).toBe(head);
    expect(git(['status', '--porcelain'], oldDir)).toBe(status);
  });

  it('uses only the cached snapshot offline and stays usable after cache removal', async () => {
    install();
    const fresh = await advance();
    writeSkill(slug, 'uncached alpha');
    commit('not refreshed');
    fs.renameSync(repo, `${repo}-offline`);
    const run = vi.spyOn(skillGit, 'git');
    updateCatalogSkill(request());
    expect(contents()).toContain('new alpha');
    expect(contents()).not.toContain('uncached alpha');
    expect(run.mock.calls.some(([args]) => ['fetch', 'pull', 'ls-remote'].includes(args[0]))).toBe(false);
    const clones = run.mock.calls.filter(([args]) => args[0] === 'clone');
    expect(clones).toHaveLength(1);
    expect(clones[0][0].slice(-2)[0]).toBe(marketplaceCacheDir(catalogId));
    const dir = findRepoRoot(fs.realpathSync(skillPath()))!;
    fs.rmSync(marketplaceCacheDir(catalogId), { recursive: true });
    expect(fs.existsSync(path.join(dir, '.git/objects/info/alternates'))).toBe(false);
    git(['fsck', '--full'], dir);
    expect(git(['rev-parse', 'HEAD'], dir)).toBe(fresh);
    expect(contents()).toContain('new alpha');
  });

  it.each(['tracked', 'staged', 'untracked', 'ignored', 'deleted'])(
    'refuses %s local edits without changing the link',
    async (mode) => {
      const oldDir = install();
      await advance();
      const link = fs.readlinkSync(skillPath());
      const file = path.join(skillPath(), 'SKILL.md');
      if (mode === 'tracked' || mode === 'staged') {
        fs.appendFileSync(file, '\nKeep local edit.\n');
        if (mode === 'staged') git(['add', '-A'], oldDir);
      } else if (mode === 'deleted') {
        fs.unlinkSync(file);
      } else {
        fs.writeFileSync(
          path.join(skillPath(), mode === 'ignored' ? 'local.ignored' : 'local.txt'),
          'Keep local file.',
        );
      }
      const before = git(['status', '--porcelain', '--ignored', '--untracked-files=all'], oldDir);
      expect(() => updateCatalogSkill(request())).toThrow(/uncommitted local changes/);
      expect(fs.readlinkSync(skillPath())).toBe(link);
      expect(git(['status', '--porcelain', '--ignored', '--untracked-files=all'], oldDir)).toBe(before);
    },
  );

  it.each(['revision', 'legacy'])('refuses and preserves local commits in a %s checkout', async (layout) => {
    const oldDir = layout === 'legacy' ? legacy() : install();
    fs.appendFileSync(path.join(skillPath(), 'SKILL.md'), '\nKeep committed work.\n');
    const localHead = commit('local alpha edit', oldDir);
    const link = fs.readlinkSync(skillPath());
    await advance();
    expect(() => updateCatalogSkill(request())).toThrow(/local commits/);
    expect(fs.readlinkSync(skillPath())).toBe(link);
    expect(contents()).toContain('Keep committed work.');
    expect(git(['rev-parse', 'HEAD'], oldDir)).toBe(localHead);
  });

  it('fails closed when a legacy original base is unavailable', async () => {
    const dir = legacy();
    git(['update-ref', '-d', 'refs/remotes/origin/main'], dir);
    await advance();
    expect(() => updateCatalogSkill(request())).toThrow(/cannot determine.*original base/);
    expect(contents()).toContain('old alpha');
  });

  it('refuses edits even when the cached commit is already installed', () => {
    install();
    fs.writeFileSync(path.join(skillPath(), 'keep.ignored'), 'keep');
    expect(() => updateCatalogSkill(request())).toThrow(/uncommitted local changes/);
  });

  it.each(['tracked', 'ignored', 'committed'])('rejects %s local work during resolution, before an audit', (mode) => {
    const dir = install();
    const link = fs.readlinkSync(skillPath());
    if (mode === 'ignored') {
      fs.writeFileSync(path.join(skillPath(), 'keep.ignored'), 'keep');
    } else {
      fs.appendFileSync(path.join(skillPath(), 'SKILL.md'), '\nKeep my work.\n');
      if (mode === 'committed') commit('local work', dir);
    }
    expect(request).toThrow(mode === 'committed' ? /local commits/ : /uncommitted local changes/);
    expect(fs.readlinkSync(skillPath())).toBe(link);
  });

  it('does not change disabled skill selection', async () => {
    install();
    const selection = path.join(path.dirname(groupSkillsDir(groupFolder)), 'container.json');
    const original = JSON.stringify({ skills: [] });
    fs.writeFileSync(selection, original);
    await advance();
    updateCatalogSkill(request());
    expect(fs.readFileSync(selection, 'utf8')).toBe(original);
    expect(contents()).toContain('new alpha');
  });
});

describe('update provenance and snapshot validation', () => {
  it.each(['../update-alpha', '/update-alpha', 'a/b', '..', '', '-option'])('refuses invalid slug %j', (invalid) => {
    expect(() => resolveSkillUpdate(groupFolder, invalid)).toThrow(/valid skill name/);
  });

  it('refuses group path traversal', () => {
    expect(() => resolveSkillUpdate('../other', slug)).toThrow(/invalid group folder/);
  });

  it('refuses built-in skills', () => {
    const builtin = listSkills(defaultSkillRoots())[0];
    expect(builtin).toBeDefined();
    expect(() => resolveSkillUpdate(groupFolder, builtin.slug)).toThrow(/built-in/);
  });

  it('refuses authored and missing skills', () => {
    expect(request).toThrow(/not installed/);
    fs.mkdirSync(skillPath(), { recursive: true });
    expect(request).toThrow(/authored/);
  });

  it.each(['foreign', 'redirected-checkout', 'redirected-catalogs'])('refuses a %s symlink', (mode) => {
    const dir = install();
    if (mode === 'foreign') {
      fs.unlinkSync(skillPath());
      fs.symlinkSync(path.join(repo, 'skills', slug), skillPath());
    } else {
      const source = mode === 'redirected-checkout' ? dir : groupCatalogsDir(groupFolder);
      const outside = path.join(path.dirname(groupSkillsDir(groupFolder)), 'outside');
      fs.renameSync(source, outside);
      fs.symlinkSync(outside, source);
    }
    expect(request).toThrow(/not a managed catalog symlink/);
    expect(contents()).toContain('old alpha');
  });

  it('refuses mismatched origin provenance', () => {
    const dir = install();
    git(['remote', 'set-url', 'origin', 'https://example.invalid/other.git'], dir);
    expect(request).toThrow(/origin does not match/);
  });

  it('refuses a removed catalog registration', () => {
    install();
    fs.writeFileSync(path.join(root, 'store/marketplaces.json'), '{"sources":[]}');
    expect(request).toThrow(/no longer registered/);
  });

  it.each(['missing', 'renamed'])('refuses a %s source rather than switching to another path', async (mode) => {
    install();
    if (mode === 'missing') {
      manifest([{ name: 'tools', source: './', skills: [`./skills/${otherSlug}`] }]);
    } else {
      fs.mkdirSync(path.join(repo, 'replacement'));
      fs.renameSync(path.join(repo, 'skills', slug), path.join(repo, 'replacement', slug));
      manifest([{ name: 'tools', source: './', skills: [`./replacement/${slug}`] }]);
    }
    commit('source changed');
    await refreshMarketplace(catalogId);
    expect(request).toThrow(/missing from the cached catalog/);
    expect(contents()).toContain('old alpha');
  });

  it.each(['same-plugin', 'other-plugin'])('refuses an ambiguous source in %s', async (mode) => {
    install();
    manifest([
      { name: 'tools', source: './', skills: [`./skills/${slug}`] },
      { name: mode === 'same-plugin' ? 'tools' : 'other', source: './', skills: [`./skills/${slug}`] },
    ]);
    commit('ambiguous catalog');
    await refreshMarketplace(catalogId);
    expect(request).toThrow(/ambiguous/);
  });

  it('accepts a plugin rename when the exact source path remains unique', async () => {
    install();
    manifest([{ name: 'renamed', source: './', skills: [`./skills/${slug}`] }]);
    commit('rename plugin');
    await refreshMarketplace(catalogId);
    expect(request().plugin).toBe('renamed');
    expect(updateCatalogSkill(request()).slug).toBe(slug);
  });

  it.each(['missing-cache', 'dirty-cache', 'bad-commit', 'wrong-head'])('refuses an unusable %s snapshot', (mode) => {
    install();
    const cache = marketplaceCacheDir(catalogId);
    if (mode === 'missing-cache') fs.rmSync(cache, { recursive: true });
    if (mode === 'dirty-cache') fs.appendFileSync(path.join(cache, 'skills', slug, 'SKILL.md'), '\nEdited.');
    if (mode === 'bad-commit') putMarketplaceRecord({ ...getMarketplaceRecord(catalogId)!, commit: null });
    if (mode === 'wrong-head') {
      fs.appendFileSync(path.join(cache, 'skills', slug, 'SKILL.md'), '\nCommitted.');
      commit('cache change', cache);
    }
    expect(request).toThrow(/snapshot|cache/);
    expect(contents()).toContain('old alpha');
  });

  it('rejects a stale commit after the audit window', async () => {
    install();
    const reviewed = request();
    await advance();
    expect(() => updateCatalogSkill(reviewed)).toThrow(/stale/);
    expect(contents()).toContain('old alpha');
  });

  it.each(['uncommitted', 'committed'])('rejects %s work added during the audit window', async (mode) => {
    const dir = install();
    await advance();
    const reviewed = request();
    const link = fs.readlinkSync(skillPath());
    fs.appendFileSync(path.join(skillPath(), 'SKILL.md'), '\nWork during audit.\n');
    if (mode === 'committed') commit('during audit', dir);
    expect(() => updateCatalogSkill(reviewed)).toThrow(
      mode === 'committed' ? /local commits/ : /uncommitted local changes/,
    );
    expect(fs.readlinkSync(skillPath())).toBe(link);
    expect(contents()).toContain('Work during audit.');
  });

  it.each(['commit', 'catalog', 'plugin'])('rejects a forged or unpinned %s request', (field) => {
    install();
    const reviewed = request();
    if (field === 'commit') delete reviewed.expectedCommit;
    if (field === 'catalog') reviewed.marketplaceId = 'another';
    if (field === 'plugin') reviewed.plugin = 'another';
    expect(() => updateCatalogSkill(reviewed)).toThrow(/stale/);
    expect(contents()).toContain('old alpha');
  });
});

describe('atomic update failures', () => {
  it.each(['checkout', 'rename', 'symlink', 'candidate'])(
    'keeps the original usable after %s failure',
    async (mode) => {
      const oldDir = install();
      await advance();
      const reviewed = request();
      const oldLink = fs.readlinkSync(skillPath());
      if (mode === 'checkout') {
        const run = skillGit.git;
        vi.spyOn(skillGit, 'git').mockImplementation((args, cwd, timeout) => {
          if (args[0] === 'checkout') throw new Error('injected checkout failure');
          return run(args, cwd, timeout);
        });
      } else if (mode === 'rename') {
        const rename = fs.renameSync;
        vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
          if (String(to) === skillPath()) throw new Error('injected rename failure');
          return rename(from, to);
        });
      } else if (mode === 'symlink') {
        vi.spyOn(fs, 'symlinkSync').mockImplementation(() => {
          throw new Error('injected symlink failure');
        });
      } else {
        const run = skillGit.git;
        vi.spyOn(skillGit, 'git').mockImplementation((args, cwd, timeout) => {
          const result = run(args, cwd, timeout);
          if (args[0] === 'checkout') fs.writeFileSync(path.join(cwd!, 'skills', slug, 'SKILL.md'), 'invalid');
          return result;
        });
      }
      expect(() => updateCatalogSkill(reviewed)).toThrow(/failure|SKILL.md/);
      expect(fs.readlinkSync(skillPath())).toBe(oldLink);
      expect(findRepoRoot(fs.realpathSync(skillPath()))).toBe(oldDir);
      expect(contents()).toContain('old alpha');
      expect(fs.readdirSync(groupSkillsDir(groupFolder)).filter((name) => name.startsWith(`.${slug}-update-`))).toEqual(
        [],
      );
      if (mode === 'checkout') expect(fs.readdirSync(groupCatalogsDir(groupFolder))).toEqual([path.basename(oldDir)]);
    },
  );
});
