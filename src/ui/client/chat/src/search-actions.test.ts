import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearSearch, searchThreads } from './actions';
import { searchError, searchLoading, searchOpen, searchQuery, searchResults } from './state';
import type { SearchResult } from './types';

vi.hoisted(() => {
  vi.stubGlobal('window', {
    matchMedia: () => ({ matches: false }),
  });
});

function deferredResponse() {
  let resolve!: (response: Response) => void;
  const promise = new Promise<Response>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function responseWith(results: SearchResult[]): Response {
  return {
    ok: true,
    status: 200,
    json: async () => ({ results }),
  } as Response;
}

function result(messageId: string): SearchResult {
  return {
    messageId,
    sessionId: 'session',
    threadId: 'thread',
    channelType: 'web',
    messagingGroupId: 'group',
    direction: 'in',
    timestamp: '2026-07-22T00:00:00.000Z',
    snippet: messageId,
    rank: 0,
  };
}

afterEach(() => {
  clearSearch();
  vi.restoreAllMocks();
});

describe('searchThreads', () => {
  it('ignores a stale response after a newer search completes', async () => {
    const first = deferredResponse();
    const second = deferredResponse();
    vi.stubGlobal('fetch', vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise));

    const firstSearch = searchThreads('agent', 'first');
    const secondSearch = searchThreads('agent', 'second');
    second.resolve(responseWith([result('second')]));
    await secondSearch;
    first.resolve(responseWith([result('first')]));
    await firstSearch;

    expect(searchQuery.value).toBe('second');
    expect(searchResults.value?.map((item) => item.messageId)).toEqual(['second']);
    expect(searchLoading.value).toBe(false);
  });

  it('does not reopen search after clear while a request is pending', async () => {
    const pending = deferredResponse();
    vi.stubGlobal('fetch', vi.fn().mockReturnValueOnce(pending.promise));

    searchOpen.value = true;
    const request = searchThreads('agent', 'pending');
    clearSearch();
    pending.resolve(responseWith([result('late')]));
    await request;

    expect(searchOpen.value).toBe(false);
    expect(searchResults.value).toBeNull();
    expect(searchLoading.value).toBe(false);
  });

  it('keeps request failures distinct from an empty result', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.stubGlobal('fetch', vi.fn().mockRejectedValueOnce(new Error('offline')));

    await searchThreads('agent', 'failure');

    expect(searchResults.value).toEqual([]);
    expect(searchError.value).toContain('Search failed');
    expect(searchLoading.value).toBe(false);
  });
});
