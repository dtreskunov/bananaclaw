import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadThreads } from './actions';
import { groupId, threadId, threads } from './state';
import type { Thread } from './types';

vi.hoisted(() => {
  vi.stubGlobal('window', {
    matchMedia: () => ({ matches: false }),
  });
});

afterEach(() => {
  groupId.value = null;
  threadId.value = null;
  threads.value = [];
  vi.restoreAllMocks();
});

describe('loadThreads', () => {
  it('bypasses caches and replaces the visible thread list', async () => {
    const freshThread = { threadId: 'fresh', title: 'Fresh thread', channelType: 'web' } as Thread;
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ approvals: [], threads: [freshThread] }),
      } as Response),
    );
    groupId.value = 'agent';
    threads.value = [{ threadId: 'stale', title: 'Stale thread', channelType: 'web' } as Thread];

    await loadThreads('agent');

    expect(fetch).toHaveBeenCalledWith(
      'api/sync?gid=agent',
      expect.objectContaining({ cache: 'no-store', credentials: 'same-origin' }),
    );
    expect(threads.value).toEqual([freshThread]);
  });
});
