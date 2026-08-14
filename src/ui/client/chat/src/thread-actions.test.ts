import { afterEach, describe, expect, it, vi } from 'vitest';
import { deleteThread, loadThreads } from './actions';
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

describe('deleteThread', () => {
  it('includes channel context when deleting a non-web thread', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200 } as Response));
    groupId.value = 'agent';
    threads.value = [
      {
        threadId: 'resend:agent@example.com:person@example.net:root',
        title: 'Email thread',
        channelType: 'resend',
        messagingGroupId: 'mailbox',
      } as Thread,
    ];

    await deleteThread(threads.value[0]!);

    expect(fetch).toHaveBeenCalledWith(
      'api/groups/agent/chat/resend%3Aagent%40example.com%3Aperson%40example.net%3Aroot?channel=resend&mg=mailbox',
      { method: 'DELETE', credentials: 'same-origin' },
    );
    expect(threads.value).toEqual([]);
  });

  it('keeps the existing URL for web threads', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200 } as Response));
    groupId.value = 'agent';
    const thread = { threadId: 'web-thread', title: 'Web thread', channelType: 'web' } as Thread;
    threads.value = [thread];

    await deleteThread(thread);

    expect(fetch).toHaveBeenCalledWith('api/groups/agent/chat/web-thread', {
      method: 'DELETE',
      credentials: 'same-origin',
    });
  });
});
