import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { closeSessionDb, initTestSessionDb } from '../../db/connection.js';
import { createNativeTools } from './tools.js';

let root: string;

async function execute(name: string, input: unknown): Promise<unknown> {
  const candidate = createNativeTools(root)[name] as { execute?: (value: unknown, options: object) => unknown };
  if (!candidate.execute) throw new Error(`Tool ${name} is not executable`);
  return candidate.execute(input, { toolCallId: 'test', messages: [], context: {} });
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'native-tools-'));
  initTestSessionDb();
});

afterEach(() => {
  closeSessionDb();
  fs.rmSync(root, { recursive: true, force: true });
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

  it('blocks writes outside the persistent workspace', async () => {
    expect(execute('write', { path: '../escape.txt', content: 'no' })).rejects.toThrow(/restricted|outside/);
  });

  it('searches and globs without external binaries', async () => {
    fs.writeFileSync(path.join(root, 'one.ts'), 'needle\n');
    fs.writeFileSync(path.join(root, 'two.txt'), 'needle\n');
    expect(String(await execute('glob', { pattern: '*.ts' }))).toBe('one.ts');
    expect(String(await execute('grep', { query: 'needle' }))).toContain('one.ts:1:needle');
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
