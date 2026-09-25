import { afterEach, describe, expect, it, vi } from 'vitest';
import { deleteThread, loadThreads } from './actions';
import { groupId, threadId, threads, toastMessage } from './state';
import { dismissToast } from './components/Toast';
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
  while (toastMessage.value) dismissToast();
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
        sessionId: 'email-session',
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
    const thread = {
      threadId: 'web-thread',
      sessionId: 'web-session',
      title: 'Web thread',
      channelType: 'web',
    } as Thread;
    threads.value = [thread];

    await deleteThread(thread);

    expect(fetch).toHaveBeenCalledWith('api/groups/agent/chat/web-thread', {
      method: 'DELETE',
      credentials: 'same-origin',
    });
  });

  it('removes an unpersisted thread locally and opens the latest thread', async () => {
    const latest = {
      threadId: 'latest',
      sessionId: 'latest-session',
      title: 'Latest thread',
      channelType: 'resend',
      messagingGroupId: 'mailbox',
      canSend: true,
    } as Thread;
    const ephemeral = {
      threadId: 'ephemeral',
      sessionId: null,
      title: '(new thread)',
      channelType: 'web',
      messageCount: 0,
    } as Thread;
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ approvals: [], threads: [latest], threadMessages: [] }),
      } as Response),
    );
    groupId.value = 'agent';
    threadId.value = ephemeral.threadId;
    threads.value = [ephemeral, latest];

    await deleteThread(ephemeral);

    expect(fetch).not.toHaveBeenCalledWith(
      'api/groups/agent/chat/ephemeral',
      expect.objectContaining({ method: 'DELETE' }),
    );
    expect(threadId.value).toBe(latest.threadId);
    expect(threads.value).toEqual([latest]);
  });

  it('treats a missing session id as an unpersisted thread', async () => {
    const ephemeral = {
      threadId: 'ephemeral',
      title: '(new thread)',
      channelType: 'web',
      messageCount: 0,
    } as Thread;
    vi.stubGlobal('fetch', vi.fn());
    groupId.value = 'agent';
    threadId.value = ephemeral.threadId;
    threads.value = [ephemeral];

    await deleteThread(ephemeral);

    expect(fetch).not.toHaveBeenCalled();
    expect(threadId.value).toBeNull();
    expect(threads.value).toEqual([]);
  });

  it('shows delete failures as shared error toasts', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 500 } as Response));
    groupId.value = 'agent';
    const thread = {
      threadId: 'web-thread',
      sessionId: 'web-session',
      title: 'Web thread',
      channelType: 'web',
    } as Thread;
    threads.value = [thread];

    await deleteThread(thread);

    expect(toastMessage.value).toMatchObject({ text: 'Delete failed (HTTP 500)', kind: 'err' });
    expect(threads.value).toEqual([thread]);
  });
});
