import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  clearFileSearch,
  closePreview,
  openFileSearch,
  openFileSearchDirectory,
  searchFiles,
  selectFile,
} from './actions';
import {
  fileSearchLoading,
  fileSearchOpen,
  fileSearchQuery,
  fileSearchResults,
  fileSearchRoot,
  fileSearchTruncated,
  groupId,
  previewBlock,
  treePath,
} from './state';
import type { TreeEntry } from './types';

vi.hoisted(() => {
  vi.stubGlobal('window', {
    matchMedia: () => ({ matches: false }),
  });
  vi.stubGlobal('location', { hash: '' });
  vi.stubGlobal('history', {
    pushState: vi.fn(),
    replaceState: vi.fn(),
  });
});

function deferredResponse() {
  let resolve!: (response: Response) => void;
  const promise = new Promise<Response>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function responseWith(results: TreeEntry[], truncated = false): Response {
  return {
    ok: true,
    status: 200,
    json: async () => ({ results, truncated }),
  } as Response;
}

function result(path: string): TreeEntry {
  return { path, name: path.slice(path.lastIndexOf('/') + 1), type: 'file' };
}

afterEach(() => {
  clearFileSearch();
  vi.restoreAllMocks();
});

describe('searchFiles', () => {
  it('keeps the directory captured when search mode opens', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(responseWith([result('docs/nested/notes.md')], true)));
    openFileSearch('docs');

    await searchFiles('agent', 'notes');

    expect(fileSearchRoot.value).toBe('docs');
    expect(fileSearchQuery.value).toBe('notes');
    expect(fileSearchResults.value?.map((entry) => entry.path)).toEqual(['docs/nested/notes.md']);
    expect(fileSearchTruncated.value).toBe(true);
  });

  it('ignores a stale response after a newer file search completes', async () => {
    const first = deferredResponse();
    const second = deferredResponse();
    vi.stubGlobal('fetch', vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise));
    openFileSearch('docs');

    const firstSearch = searchFiles('agent', 'first');
    const secondSearch = searchFiles('agent', 'second');
    second.resolve(responseWith([result('docs/second.txt')]));
    await secondSearch;
    first.resolve(responseWith([result('docs/first.txt')]));
    await firstSearch;

    expect(fileSearchQuery.value).toBe('second');
    expect(fileSearchResults.value?.map((entry) => entry.path)).toEqual(['docs/second.txt']);
    expect(fileSearchLoading.value).toBe(false);
  });

  it('does not reopen search after it is cleared while a request is pending', async () => {
    const pending = deferredResponse();
    vi.stubGlobal('fetch', vi.fn().mockReturnValueOnce(pending.promise));
    openFileSearch('docs');

    const request = searchFiles('agent', 'pending');
    clearFileSearch();
    pending.resolve(responseWith([result('docs/late.txt')]));
    await request;

    expect(fileSearchOpen.value).toBe(false);
    expect(fileSearchResults.value).toBeNull();
    expect(fileSearchLoading.value).toBe(false);
  });

  it('drills into a directory result and reruns the retained query in that scope', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ entries: [] }),
      } as Response)
      .mockResolvedValueOnce(responseWith([result('docs/notes/reference.txt')]));
    vi.stubGlobal('fetch', fetchMock);
    groupId.value = 'agent';
    openFileSearch('docs');

    await openFileSearchDirectory('agent', 'docs/notes', 'reference');

    expect(treePath.value).toBe('docs/notes');
    expect(fileSearchRoot.value).toBe('docs/notes');
    expect(fileSearchQuery.value).toBe('reference');
    expect(fileSearchResults.value?.map((entry) => entry.path)).toEqual(['docs/notes/reference.txt']);
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain('path=docs%2Fnotes&q=reference');
  });
});

describe('file preview cancellation', () => {
  it('does not reopen a preview when a file response arrives after close', async () => {
    const head = deferredResponse();
    vi.stubGlobal('fetch', vi.fn().mockReturnValueOnce(head.promise));
    groupId.value = 'agent';

    const selection = selectFile({ path: 'docs/late.txt', name: 'late.txt' });
    closePreview();
    head.resolve({ status: 200, headers: new Headers() } as Response);
    await selection;

    expect(previewBlock.value).toBeNull();
  });
});
