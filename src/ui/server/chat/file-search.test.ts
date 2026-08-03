import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { compareEntriesByDate, searchFilesByName } from './file-search.js';

const ROOT = '/tmp/nanoclaw-file-search-test';

function write(relativePath: string, content = relativePath): void {
  const absolute = path.join(ROOT, relativePath);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, content);
}

function setMtime(relativePath: string, iso: string): void {
  const date = new Date(iso);
  fs.utimesSync(path.join(ROOT, relativePath), date, date);
}

beforeEach(() => {
  fs.rmSync(ROOT, { recursive: true, force: true });
  fs.mkdirSync(ROOT, { recursive: true });
});

afterEach(() => {
  fs.rmSync(ROOT, { recursive: true, force: true });
});

describe('searchFilesByName', () => {
  it('searches recursively beneath the requested directory and sorts newest first', async () => {
    write('docs/nested/notes.md');
    write('docs/notes-archive.md');
    write('docs/my-notes.txt');
    write('outside/notes.md');
    setMtime('docs/nested/notes.md', '2026-01-01T00:00:00.000Z');
    setMtime('docs/notes-archive.md', '2026-03-01T00:00:00.000Z');
    setMtime('docs/my-notes.txt', '2026-02-01T00:00:00.000Z');

    const response = await searchFilesByName(ROOT, 'docs', 'NOTES', false);

    expect(response?.results.map((entry) => [entry.path, entry.type])).toEqual([
      ['docs/notes-archive.md', 'file'],
      ['docs/my-notes.txt', 'file'],
      ['docs/nested/notes.md', 'file'],
    ]);
    expect(response?.truncated).toBe(false);
  });

  it('returns matching directories and still searches inside them', async () => {
    write('docs/notes/reference.txt');
    write('docs/archive/notes.txt');
    setMtime('docs/notes', '2026-02-01T00:00:00.000Z');
    setMtime('docs/archive/notes.txt', '2026-01-01T00:00:00.000Z');

    const response = await searchFilesByName(ROOT, 'docs', 'notes', false);

    expect(response?.results.map((entry) => [entry.path, entry.type])).toEqual([
      ['docs/notes', 'dir'],
      ['docs/archive/notes.txt', 'file'],
    ]);
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
      'docs/.private',
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

describe('compareEntriesByDate', () => {
  it('sorts newest first, then path, with missing dates last', () => {
    const entries = [
      { path: 'missing', mtime: null },
      { path: 'same-b', mtime: '2026-02-01T00:00:00.000Z' },
      { path: 'newest', mtime: '2026-03-01T00:00:00.000Z' },
      { path: 'same-a', mtime: '2026-02-01T00:00:00.000Z' },
    ];

    expect(entries.sort(compareEntriesByDate).map((entry) => entry.path)).toEqual([
      'newest',
      'same-a',
      'same-b',
      'missing',
    ]);
  });
});
