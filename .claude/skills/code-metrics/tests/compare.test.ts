import { execFile, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { load } from 'js-yaml';
import { afterEach, describe, expect, it } from 'vitest';

import { classifyFile, compare, formatReport, measureSource, parseArgs, summarize } from '../scripts/compare.js';

const temporaryRepos: string[] = [];

function git(root: string, args: string[], date?: string): string {
  return execFileSync(
    'git',
    [
      '-c',
      'core.hooksPath=/dev/null',
      '-c',
      'commit.gpgsign=false',
      '-c',
      'user.name=Code Metrics Test',
      '-c',
      'user.email=metrics@example.invalid',
      ...args,
    ],
    {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, ...(date ? { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } : {}) },
    },
  ).trim();
}

function write(root: string, file: string, content: string): void {
  const target = path.join(root, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}

function repository(commit = true): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'code-metrics-test-'));
  temporaryRepos.push(root);
  git(root, ['init', '-q', '-b', 'main']);
  if (commit) {
    write(root, 'src/main.ts', 'export function answer() { return 1; }\n');
    git(root, ['add', '.']);
    git(root, ['commit', '-qm', 'Baseline'], '2026-10-25T10:00:00Z');
  }
  return root;
}

afterEach(() => {
  for (const root of temporaryRepos.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('source measurement', () => {
  it('counts non-comment physical lines and isolates nested function complexity', () => {
    const result = measureSource(
      '// comment\n\nfunction outer(a = 0) {\n  /* comment */ if (a) return () => a ? 1 : 0;\n  return 0;\n}\n',
      'example.ts',
    );
    expect(result.loc).toBe(4);
    expect(result.functions.map((fn) => fn.complexity).sort()).toEqual([2, 3]);
    expect(measureSource('/* only\ncomment */\n', 'comments.ts').loc).toBe(0);
    expect(measureSource('const f = () => `a\n\nb`;\n', 'template.ts').loc).toBe(2);
  });

  it('uses classic ESLint branching and does not honor inline suppressions', () => {
    const result = measureSource(
      '/* eslint-disable complexity */\nconst f = (a = { x: 1 }) => a?.x ?? 0;\n',
      'optional.ts',
    );
    expect(result.functions[0].complexity).toBe(4);
  });

  it('excludes top-level branches and implicit class code paths', () => {
    const result = measureSource(
      'if (flag) run();\nclass C { field = flag && 1; static { if (flag) run(); } method() { if (flag) return 1; } }\n',
      'class.ts',
    );
    expect(result.functions).toHaveLength(1);
    expect(result.functions[0].complexity).toBe(2);
  });

  it('fails explicitly for malformed source', () => {
    expect(() => measureSource('function {', 'broken.ts')).toThrow('broken.ts: analysis failed');
  });

  it('reports exact threshold, percentile, and empty-snapshot values', () => {
    const functions = Array.from({ length: 20 }, (_, index) => ({
      name: 'Function',
      complexity: index === 19 ? 21 : 1,
      line: index + 1,
      column: 1,
    }));
    expect(summarize([{ loc: 20, functions }])).toMatchObject({
      files: 1,
      loc: 20,
      functions: 20,
      complexity: 40,
      average: 2,
      p95: 1,
      max: 21,
      above20: 1,
      branchPointsPerKloc: 1000,
    });
    expect(
      summarize([
        {
          loc: 2,
          functions: [20, 21].map((complexity) => ({
            name: 'Function',
            complexity,
            line: 1,
            column: 1,
          })),
        },
      ]).above20,
    ).toBe(1);
    expect(summarize([])).toMatchObject({
      loc: 0,
      functions: 0,
      complexity: 0,
      average: null,
      p95: null,
      max: null,
      above20: 0,
    });
  });
});

describe('source-role classification', () => {
  it.each([
    'src/index.ts',
    'src/config.ts',
    'src/cli/client.ts',
    'src/skills/registry.ts',
    'src/db/migrations/001-initial.ts',
    'src/ui/client/chat/src/components/App.tsx',
    'src/ui/client/chat/sw.js',
    'src/ui/client/chat/voice-worklet.js',
    'container/agent-runner/src/providers/native.ts',
  ])('keeps runtime code in production: %s', (file) => {
    expect(classifyFile(file)).toBe('production');
  });

  it.each([
    '.claude/skills/code-metrics/scripts/compare.ts',
    '.claude/skills/add-dashboard/resources/dashboard-pusher.ts',
    'setup/verify.ts',
    'scripts/init-first-agent.ts',
    'container/agent-runner/scripts/sdk-signal-probe.ts',
    'src/ui/scripts/mint-magic.ts',
    'src/ui/client/chat/vite.config.ts',
    'eslint.config.js',
    'vitest.skills.config.ts',
    'other/new-module.ts',
  ])('does not count developer and operational tooling as production: %s', (file) => {
    expect(classifyFile(file)).toBe('tooling');
  });

  it.each([
    'src/main.test.ts',
    'src/test.ts',
    'src/test-helpers/create.ts',
    'src/__tests__/example.ts',
    'src/__fixtures__/example.ts',
    'src/__mocks__/example.ts',
    'src/ui/client/chat/fixtures/turn-status.tsx',
    'src/ui/client/chat/src/conversation-test-fixtures.ts',
    'container/agent-runner/src/providers/mock.ts',
    'setup/verify.test.ts',
    '.claude/skills/code-metrics/tests/compare.test.ts',
  ])('prioritizes tests/support inside every source root: %s', (file) => {
    expect(classifyFile(file)).toBe('tests');
  });
});

describe('Git snapshots and persistent cache', () => {
  it('measures partially staged content, not unstaged or untracked source', () => {
    const root = repository();
    const staged = 'export function answer(flag: boolean) { return flag ? 2 : 1; }\n';
    write(root, 'src/main.ts', staged);
    git(root, ['add', 'src/main.ts']);
    write(root, 'src/main.ts', 'broken unstaged syntax {{{');
    write(root, 'src/untracked.ts', 'broken untracked syntax {{{');
    const indexBefore = git(root, ['ls-files', '--stage']);
    const report = compare({ staged: true }, root);
    expect(report.snapshots[0].production).toMatchObject({ loc: 1, complexity: 1 });
    expect(report.snapshots[1].production).toMatchObject({ loc: 1, complexity: 2 });
    expect(report.snapshots[1].revision).toBe(git(root, ['write-tree']));
    expect(git(root, ['ls-files', '--stage'])).toBe(indexBefore);
    expect(fs.readFileSync(path.join(root, 'src/main.ts'), 'utf8')).toContain('broken unstaged');
    expect(report.changes).toHaveLength(1);
  });

  it('supports initial commits, deletions, fixtures, symlinks, and generated exclusions', () => {
    const root = repository(false);
    write(root, 'src/main.ts', 'const f = () => "你好";\n');
    write(root, 'src/fixtures/example.ts', 'const f = () => true;\n');
    write(root, 'src/space\nname.js', 'const f = () => false;\n');
    write(root, 'src/ui/dist/app.js', 'invalid generated syntax {{{');
    write(root, 'src/vendor/copied.ts', 'invalid vendor syntax {{{');
    write(root, 'README.md', 'Not source');
    fs.symlinkSync('main.ts', path.join(root, 'src/link.ts'));
    git(root, ['add', '.']);
    const initial = compare({ staged: true }, root);
    expect(initial.snapshots[0].revision).toBeNull();
    expect(initial.snapshots[0].all.loc).toBe(0);
    expect(initial.snapshots[1].production).toMatchObject({ files: 2, loc: 2 });
    expect(initial.snapshots[1].tests).toMatchObject({ files: 1, loc: 1 });
    expect(formatReport(initial)).toContain('n/a baseline');
    git(root, ['commit', '-qm', 'Initial']);
    git(root, ['rm', '-q', 'src/main.ts']);
    expect(compare({ staged: true }, root).snapshots[1].production.files).toBe(1);
  });

  it('reuses unchanged blobs across runs and reclassifies renamed fixtures', () => {
    const root = repository();
    const cold = compare({ staged: true }, root);
    expect(cold.cache).toMatchObject({ hits: 0, misses: 1 });
    expect(compare({ staged: true }, root).cache).toMatchObject({ hits: 1, misses: 0 });
    git(root, ['mv', 'src/main.ts', 'src/main.test.ts']);
    const renamed = compare({ staged: true }, root);
    expect(renamed.cache).toMatchObject({ hits: 1, misses: 0 });
    expect(renamed.snapshots[1].production.loc).toBe(0);
    expect(renamed.snapshots[1].tests.loc).toBe(1);
    write(root, 'src/main.test.ts', 'export function answer() { return 42; }\n');
    git(root, ['add', '.']);
    expect(compare({ staged: true }, root).cache).toMatchObject({ hits: 1, misses: 1 });
  });

  it('partitions every metric and keeps cached tooling-only additions out of production', () => {
    const root = repository();
    const source = 'export function answer() { return 1; }\n';
    compare({ staged: true }, root);
    write(root, '.claude/skills/code-metrics/scripts/compare.ts', source);
    write(root, 'setup/install.ts', source);
    write(root, 'scripts/helper.ts', source);
    write(root, 'vitest.config.ts', source);
    write(root, 'src/ui/scripts/probe.ts', source);
    write(root, 'src/main.test.ts', source);
    git(root, ['add', '.']);
    const report = compare({ staged: true }, root);
    const [before, after] = report.snapshots;
    expect(report.cache).toMatchObject({ hits: 1, misses: 0 });
    expect(after.production).toEqual(before.production);
    expect(after.tests).toMatchObject({ files: 1, loc: 1, complexity: 1 });
    expect(after.tooling).toMatchObject({ files: 5, loc: 5, complexity: 5 });
    expect(after.hotspots.map((fn) => fn.file)).toEqual(['src/main.ts']);
    expect(Object.keys(after.components)).toEqual(['Host']);
    for (const snapshot of report.snapshots) {
      for (const metric of ['files', 'loc', 'functions', 'complexity'] as const) {
        expect(snapshot.production[metric] + snapshot.tests[metric] + snapshot.tooling[metric]).toBe(
          snapshot.all[metric],
        );
      }
    }
    expect(report.methodology.classificationVersion).toBe(2);
    expect(report.changes.find((file) => file.file === 'scripts/helper.ts')).toMatchObject({
      beforeCategory: null,
      afterCategory: 'tooling',
    });
    const text = formatReport(report);
    expect(text).toContain('| Production total complexity | 1 | 1 |');
    expect(text).toContain('| Tooling/setup total complexity | 0 | 5 |');
    expect(text).not.toContain('Non-test');
    expect(text.split('Largest changed production files')[1]).not.toContain('scripts/helper.ts');
  });

  it('invalidates analyzer versions, rejects corrupt data, and supports bypassing cache', () => {
    const root = repository();
    const report = compare({ staged: true }, root);
    const { eslint, parser, typescript } = report.methodology.versions;
    expect(path.basename(report.cache.directory)).toBe(`v1-${eslint}-${parser}-${typescript}`);
    const entry = path.join(report.cache.directory, fs.readdirSync(report.cache.directory)[0]);
    const valid = fs.readFileSync(entry, 'utf8');
    fs.writeFileSync(entry, '{"loc":-1,"functions":[]}');
    expect(() => compare({ staged: true }, root)).toThrow(`Invalid metrics cache ${entry}`);
    fs.writeFileSync(entry, '{broken JSON');
    expect(() => compare({ staged: true }, root)).toThrow(`Invalid metrics cache ${entry}`);
    const uncached = compare({ staged: true, noCache: true }, root);
    expect(uncached.snapshots).toEqual(report.snapshots);
    expect(fs.readFileSync(entry, 'utf8')).toBe('{broken JSON');
    fs.writeFileSync(entry, valid);
    const oldDirectory = path.join(path.dirname(report.cache.directory), 'v0-old-analyzer');
    fs.renameSync(report.cache.directory, oldDirectory);
    expect(compare({ staged: true }, root).cache.misses).toBe(1);
    expect(fs.readdirSync(report.cache.directory).some((file) => file.endsWith('.tmp'))).toBe(false);
  });

  it('shares the cache with linked worktrees', () => {
    const root = repository();
    const report = compare({ staged: true }, root);
    const worktree = path.join(root, 'linked-worktree');
    git(root, ['worktree', 'add', '-q', '--detach', worktree, 'HEAD']);
    const linked = compare({ staged: true }, worktree);
    expect(linked.cache.directory).toBe(report.cache.directory);
    expect(linked.cache).toMatchObject({ hits: 1, misses: 0 });
  });

  it('runs the CLI concurrently without partial cache entries', async () => {
    const root = repository();
    const execute = promisify(execFile);
    const cli = createRequire(import.meta.url).resolve('tsx/cli');
    const script = fileURLToPath(new URL('../scripts/compare.ts', import.meta.url));
    const runs = await Promise.all(
      [0, 1].map(() => execute(process.execPath, [cli, script, '--staged', '--json'], { cwd: root, encoding: 'utf8' })),
    );
    const reports = runs.map(({ stdout }) => JSON.parse(stdout));
    expect(reports[0].snapshots).toEqual(reports[1].snapshots);
    expect(reports[0].snapshots[1].production.loc).toBe(1);
    const warm = compare({ staged: true }, root);
    expect(warm.cache).toMatchObject({ hits: 1, misses: 0 });
    expect(fs.readdirSync(warm.cache.directory).every((file) => file.endsWith('.json'))).toBe(true);
  });

  it('works in a fresh clone without sharing another clone cache', () => {
    const root = repository();
    compare({ staged: true }, root);
    const clone = path.join(root, 'fresh-clone');
    git(root, ['clone', '-q', '--shared', root, clone]);
    const fresh = compare({ staged: true }, clone);
    expect(fresh.snapshots[1].production).toMatchObject({ loc: 1, complexity: 1 });
    expect(fresh.cache).toMatchObject({ hits: 0, misses: 1 });
    expect(fresh.cache.directory).toContain(path.join('fresh-clone', '.git'));
  });

  it('resolves a time-based ancestor and explicit historical revisions', () => {
    const root = repository();
    const old = git(root, ['rev-parse', 'HEAD']);
    write(root, 'src/main.ts', 'export const answer = (flag: boolean) => flag ? 2 : 1;\n');
    git(root, ['add', '.']);
    git(root, ['commit', '-qm', 'Later'], '2026-11-03T10:00:00Z');
    const report = compare({}, root, new Date('2026-11-04T20:22:32Z'));
    expect(report.snapshots[0].revision).toBe(old);
    expect(report.methodology.cutoff).toBe('2026-10-28T20:22:32.000Z');
    expect(compare({ from: old, to: 'HEAD' }, root).snapshots).toEqual(report.snapshots);
    expect(() => compare({ days: 100 }, root, new Date('2026-11-04T20:22:32Z'))).toThrow('provide --from explicitly');
    expect(() => compare({ from: 'missing-ref' }, root)).toThrow();
  });

  it('rejects unmerged index entries', () => {
    const root = repository();
    const blob = git(root, ['rev-parse', 'HEAD:src/main.ts']);
    execFileSync('git', ['update-index', '--index-info'], {
      cwd: root,
      input: `0 ${'0'.repeat(blob.length)}\tsrc/main.ts\n100644 ${blob} 1\tsrc/main.ts\n100644 ${blob} 2\tsrc/main.ts\n100644 ${blob} 3\tsrc/main.ts\n`,
    });
    expect(() => compare({ staged: true }, root)).toThrow();
  });
});

describe('skill interface', () => {
  it('validates arguments rather than silently choosing another comparison', () => {
    expect(parseArgs(['--staged', '--json', '--no-cache'])).toEqual({ staged: true, json: true, noCache: true });
    expect(parseArgs(['--from', 'HEAD~1', '--to', 'HEAD'])).toEqual({ from: 'HEAD~1', to: 'HEAD' });
    expect(() => parseArgs(['--from'])).toThrow('requires a value');
    expect(() => parseArgs(['--unknown'])).toThrow('Unknown argument');
    expect(() => compare({ staged: true, from: 'HEAD' })).toThrow('cannot be combined');
    expect(() => compare({ from: 'HEAD', days: 7 })).toThrow('either --from or --days');
    for (const days of [0, -1, 1.5, NaN, Infinity]) {
      expect(() => compare({ days })).toThrow('positive integer');
    }
  });

  it('has valid discoverable skill metadata and shared pre-commit instructions', () => {
    const skill = fileURLToPath(new URL('../SKILL.md', import.meta.url));
    const content = fs.readFileSync(skill, 'utf8');
    const frontmatter = /^---\n([\s\S]*?)\n---\n/.exec(content);
    expect(frontmatter).not.toBeNull();
    expect(load(frontmatter![1])).toMatchObject({
      name: 'code-metrics',
      description: expect.stringMatching(/LOC.*complexity.*commit/s),
    });
    expect(content.split('\n').length).toBeLessThan(500);
    const root = path.resolve(path.dirname(skill), '../../..');
    const command = 'pnpm exec tsx .claude/skills/code-metrics/scripts/compare.ts --staged';
    for (const file of ['CLAUDE.md', '.github/copilot-instructions.md']) {
      expect(fs.readFileSync(path.join(root, file), 'utf8')).toContain(command);
    }
  });
});
