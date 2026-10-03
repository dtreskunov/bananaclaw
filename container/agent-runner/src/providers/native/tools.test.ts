import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { closeSessionDb, initTestSessionDb } from '../../db/connection.js';
import { createNativeTools } from './tools.js';

let root: string;
let outside: string;

async function execute(name: string, input: unknown, cwd = root): Promise<unknown> {
  const candidate = createNativeTools(cwd)[name] as { execute?: (value: unknown, options: object) => unknown };
  if (!candidate.execute) throw new Error(`Tool ${name} is not executable`);
  return candidate.execute(input, { toolCallId: 'test', messages: [], context: {} });
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'native-tools-'));
  outside = fs.mkdtempSync(path.join(os.tmpdir(), 'native-tools-outside-'));
  initTestSessionDb();
});

afterEach(() => {
  closeSessionDb();
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
});

describe('native coding tools', () => {
  it('advertises the shared Claude/OpenCode tool names', () => {
    expect(Object.keys(createNativeTools(root)).filter((name) => !name.startsWith('mcp__'))).toEqual([
      'read',
      'write',
      'edit',
      'patch',
      'glob',
      'grep',
      'bash',
    ]);
  });

  it('writes new nested files, reads them, and performs exact edits', async () => {
    await execute('write', { path: 'nested/note.txt', content: 'alpha beta' });
    expect(await execute('read', { path: 'nested/note.txt' })).toBe('alpha beta');
    await execute('edit', { path: 'nested/note.txt', oldText: 'beta', newText: 'gamma' });
    expect(fs.readFileSync(path.join(root, 'nested/note.txt'), 'utf8')).toBe('alpha gamma');
  });

  it.each(['absolute', 'relative'])('reads, writes, and edits outside the workspace using %s paths', async (kind) => {
    const filename = path.join(outside, 'nested', 'note.txt');
    const inputPath = kind === 'absolute' ? filename : path.relative(root, filename);
    await execute('write', { path: inputPath, content: 'alpha beta' });
    expect(await execute('read', { path: inputPath })).toBe('alpha beta');
    await execute('edit', { path: inputPath, oldText: 'beta', newText: 'gamma' });
    expect(fs.readFileSync(filename, 'utf8')).toBe('alpha gamma');
  });

  it('follows symlinks outside the workspace for reads, writes, and edits', async () => {
    fs.symlinkSync(outside, path.join(root, 'linked'));
    await execute('write', { path: 'linked/nested/note.txt', content: 'alpha beta' });
    expect(await execute('read', { path: 'linked/nested/note.txt' })).toBe('alpha beta');
    await execute('edit', { path: 'linked/nested/note.txt', oldText: 'beta', newText: 'gamma' });
    expect(fs.readFileSync(path.join(outside, 'nested/note.txt'), 'utf8')).toBe('alpha gamma');
  });

  it('retains the read size limit and exact-edit validation outside the workspace', async () => {
    const filename = path.join(outside, 'note.txt');
    fs.writeFileSync(filename, Buffer.alloc(256 * 1024 + 1));
    await expect(execute('read', { path: filename })).rejects.toThrow(/read limit/);
    fs.writeFileSync(filename, 'beta beta');
    await expect(execute('edit', { path: filename, oldText: 'beta', newText: 'gamma' }))
      .rejects.toThrow(/exactly once/);
    expect(fs.readFileSync(filename, 'utf8')).toBe('beta beta');
  });

  it('surfaces filesystem errors outside the workspace', async () => {
    const filename = path.join(outside, 'note.txt');
    await expect(execute('read', { path: filename })).rejects.toThrow(/ENOENT/);
    await expect(execute('edit', { path: filename, oldText: 'old', newText: 'new' })).rejects.toThrow(/ENOENT/);
    fs.writeFileSync(filename, 'not a directory');
    await expect(execute('write', { path: path.join(filename, 'child.txt'), content: 'new' }))
      .rejects.toThrow(/ENOTDIR|EEXIST/);
  });

  it('searches and globs without external binaries', async () => {
    fs.writeFileSync(path.join(root, 'one.ts'), 'needle\n');
    fs.writeFileSync(path.join(root, 'two.txt'), 'needle\n');
    fs.writeFileSync(path.join(outside, 'outside.ts'), 'needle\n');
    expect(String(await execute('glob', { pattern: '*.ts' }))).toBe('one.ts');
    expect(String(await execute('grep', { query: 'needle' }))).toContain('one.ts:1:needle');
    expect(String(await execute('grep', { query: 'needle' }))).not.toContain('outside.ts');
  });

  it.each(['absolute', 'relative', 'symlink'])('searches outside the workspace using a %s directory path', async (kind) => {
    fs.writeFileSync(path.join(root, 'workspace-only.txt'), 'needle\n');
    fs.writeFileSync(path.join(outside, 'one.ts'), 'needle\n');
    fs.writeFileSync(path.join(outside, 'two.txt'), 'needle\n');
    fs.mkdirSync(path.join(outside, 'nested'));
    fs.writeFileSync(path.join(outside, 'nested/three.ts'), 'hay\nneedle\n');
    fs.symlinkSync(outside, path.join(root, 'linked'));
    const inputPath = kind === 'absolute' ? outside : kind === 'relative' ? path.relative(root, outside) : 'linked';

    expect(await execute('glob', { pattern: '*.ts', path: inputPath })).toBe('one.ts');
    expect(await execute('glob', { pattern: 'nested/*.ts', path: inputPath })).toBe('nested/three.ts');
    expect(String(await execute('grep', { query: 'needle', path: inputPath })).split('\n').sort()).toEqual([
      'nested/three.ts:2:needle',
      'one.ts:1:needle',
      'two.txt:1:needle',
    ]);
  });

  it.each(['glob', 'grep'])('surfaces invalid search directories for %s', async (name) => {
    const args = name === 'glob' ? { pattern: '*' } : { query: 'needle' };
    await expect(execute(name, { ...args, path: path.join(outside, 'missing') })).rejects.toThrow(/ENOENT/);
    const filename = path.join(outside, 'note.txt');
    fs.writeFileSync(filename, 'needle');
    await expect(execute(name, { ...args, path: filename })).rejects.toThrow(/ENOTDIR/);
  });

  it('preserves ignored directories and grep file-size limits in other search roots', async () => {
    fs.writeFileSync(path.join(outside, 'note.txt'), 'needle\n');
    fs.writeFileSync(path.join(outside, 'large.txt'), `needle${' '.repeat(256 * 1024)}`);
    for (const directory of ['.git', 'node_modules', 'dist']) {
      fs.mkdirSync(path.join(outside, directory));
      fs.writeFileSync(path.join(outside, directory, 'ignored.txt'), 'needle\n');
    }
    expect(String(await execute('glob', { pattern: '**', path: outside })).split('\n').sort())
      .toEqual(['large.txt', 'note.txt']);
    expect(await execute('grep', { query: 'needle', path: outside })).toBe('note.txt:1:needle');
  });

  it('preserves the 200-result limit in other search roots', async () => {
    for (let index = 0; index < 201; index++) {
      fs.writeFileSync(path.join(outside, `note-${index}.txt`), 'needle\n');
    }
    expect(String(await execute('glob', { pattern: '*.txt', path: outside })).split('\n')).toHaveLength(200);
    expect(String(await execute('grep', { query: 'needle', path: outside })).split('\n')).toHaveLength(200);
  });

  it('applies a checked unified diff', async () => {
    fs.writeFileSync(path.join(root, 'note.txt'), 'old\n');
    await execute('patch', {
      patch: [
        'diff --git a/note.txt b/note.txt',
        '--- a/note.txt',
        '+++ b/note.txt',
        '@@ -1 +1 @@',
        '-old',
        '+new',
        '',
      ].join('\n'),
    });
    expect(fs.readFileSync(path.join(root, 'note.txt'), 'utf8')).toBe('new\n');
  });

  it.each(['absolute', 'relative'])('applies checked diffs outside the workspace using %s paths', async (kind) => {
    const filename = path.join(outside, 'note.txt');
    const inputPath = kind === 'absolute' ? filename : path.relative(root, filename);
    fs.writeFileSync(filename, 'old\n');
    await execute('patch', {
      patch: [
        `--- a/${inputPath}`,
        `+++ b/${inputPath}`,
        '@@ -1 +1 @@',
        '-old',
        '+new',
        '',
      ].join('\n'),
    });
    expect(fs.readFileSync(filename, 'utf8')).toBe('new\n');
    expect(fs.readdirSync(root)).toEqual([]);
  });

  it.each(['absolute', 'relative'])('does not skip outside %s paths when the workspace is nested in a Git repository', async (kind) => {
    const cwd = path.join(root, 'nested');
    fs.mkdirSync(cwd);
    expect(spawnSync('git', ['init', '--quiet', root]).status).toBe(0);
    const filename = path.join(outside, 'note.txt');
    const inputPath = kind === 'absolute' ? filename : path.relative(cwd, filename);
    fs.writeFileSync(filename, 'old\n');
    await execute('patch', {
      patch: [
        `--- a/${inputPath}`,
        `+++ b/${inputPath}`,
        '@@ -1 +1 @@',
        '-old',
        '+new',
        '',
      ].join('\n'),
    }, cwd);
    expect(fs.readFileSync(filename, 'utf8')).toBe('new\n');
    expect(fs.readdirSync(cwd)).toEqual([]);
  });

  it('checks every diff before changing files inside or outside the workspace', async () => {
    const filename = path.join(outside, 'note.txt');
    const inputPath = path.relative(root, filename);
    fs.writeFileSync(path.join(root, 'note.txt'), 'old\n');
    fs.writeFileSync(filename, 'different\n');
    await expect(execute('patch', {
      patch: [
        '--- a/note.txt',
        '+++ b/note.txt',
        '@@ -1 +1 @@',
        '-old',
        '+new',
        `--- a/${inputPath}`,
        `+++ b/${inputPath}`,
        '@@ -1 +1 @@',
        '-old',
        '+new',
        '',
      ].join('\n'),
    })).rejects.toThrow(/patch failed|does not apply/);
    expect(fs.readFileSync(path.join(root, 'note.txt'), 'utf8')).toBe('old\n');
    expect(fs.readFileSync(filename, 'utf8')).toBe('different\n');
    expect(fs.readdirSync(root)).toEqual(['note.txt']);
  });

  it('runs shell commands in the workspace', async () => {
    expect(String(await execute('bash', { command: 'pwd' }))).toContain(root);
  });

  it('escalates cancellation for a shell ignoring SIGTERM and does not start pre-aborted commands', async () => {
    const controller = new AbortController();
    const bash = createNativeTools(root).bash;
    const started = Date.now();
    const result = bash.execute!({ command: "trap '' TERM; printf ready > ready; while :; do sleep 1; done" }, {
      toolCallId: 'interrupt', messages: [], abortSignal: controller.signal,
    });
    while (!fs.existsSync(path.join(root, 'ready'))) {
      if (Date.now() - started > 2000) throw new Error('shell did not start');
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    controller.abort();
    await expect(result).rejects.toThrow('outcome unknown');
    expect(Date.now() - started).toBeLessThan(3500);
    await expect(bash.execute!({ command: 'touch must-not-exist' }, {
      toolCallId: 'already-stopped', messages: [], abortSignal: controller.signal,
    })).rejects.toThrow();
    expect(fs.existsSync(path.join(root, 'must-not-exist'))).toBe(false);
  });
});
