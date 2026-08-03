import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { searchFilesByName } from './file-search.js';

const ROOT = '/tmp/nanoclaw-file-search-test';

function write(relativePath: string, content = relativePath): void {
  const absolute = path.join(ROOT, relativePath);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, content);
}

beforeEach(() => {
  fs.rmSync(ROOT, { recursive: true, force: true });
  fs.mkdirSync(ROOT, { recursive: true });
});

afterEach(() => {
  fs.rmSync(ROOT, { recursive: true, force: true });
});

describe('searchFilesByName', () => {
  it('searches recursively beneath the requested directory and ranks filename matches', async () => {
    write('docs/nested/notes.md');
    write('docs/notes-archive.md');
    write('docs/my-notes.txt');
    write('outside/notes.md');

    const response = await searchFilesByName(ROOT, 'docs', 'NOTES', false);

    expect(response?.results.map((entry) => entry.path)).toEqual([
      'docs/nested/notes.md',
      'docs/notes-archive.md',
      'docs/my-notes.txt',
    ]);
    expect(response?.truncated).toBe(false);
  });

  it('applies hidden and admin visibility rules throughout the traversal', async () => {
    write('docs/public.txt');
    write('docs/.private/secret.txt');
    write('docs/node_modules/package.txt');
    write('docs/container.json');

    const member = await searchFilesByName(ROOT, 'docs', '.', false);
    const admin = await searchFilesByName(ROOT, 'docs', '.', true);

    expect(member?.results.map((entry) => entry.path)).toEqual(['docs/public.txt']);
    expect(admin?.results.map((entry) => entry.path)).toEqual([
      'docs/.private/secret.txt',
      'docs/container.json',
      'docs/public.txt',
    ]);
  });

  it('does not follow symlinks or accept an unsafe search root', async () => {
    write('docs/local.txt');
    fs.symlinkSync('/tmp', path.join(ROOT, 'docs', 'escape'));

    expect((await searchFilesByName(ROOT, 'docs', 'local', false))?.results).toHaveLength(1);
    expect(await searchFilesByName(ROOT, 'docs/local.txt', 'local', false)).toBeNull();
    expect(await searchFilesByName(ROOT, '../docs', 'local', false)).toBeNull();
  });
});
