import { uiHeaders } from './api-test-fixtures';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearChat, deleteThread, loadThreads } from './actions';
import { groupId, threadId, threads, toastMessage } from './state';
import { dismissToast } from './components/Toast';
import { testThread } from './conversation-test-fixtures';
import { installSyncFixture } from './sync-action-test-fixtures';

vi.hoisted(() => {
  vi.stubGlobal('window', {
    matchMedia: () => ({ matches: false }),
  });
});

let sync: Awaited<ReturnType<typeof installSyncFixture>>;
beforeEach(async () => {
  sync = await installSyncFixture();
});
afterEach(() => {
  clearChat();
  sync.dispose();
  groupId.value = null;
  threadId.value = null;
  threads.value = [];
  while (toastMessage.value) dismissToast();
  vi.restoreAllMocks();
});

describe('loadThreads', () => {
  it('requests a fresh socket snapshot and replaces the visible thread list', async () => {
    const freshThread = testThread({ threadId: 'fresh', title: 'Fresh thread', channelType: 'web' });
    sync.read.mockResolvedValue({ attention: [], approvals: [], threads: [freshThread] });
    groupId.value = 'agent';
    threads.value = [testThread({ threadId: 'stale', title: 'Stale thread', channelType: 'web' })];

    await loadThreads('agent');

    expect(sync.read).toHaveBeenCalledWith('agent');
    expect(threads.value).toEqual([freshThread]);
  });
});

describe('deleteThread', () => {
  it('includes channel context when deleting a non-web thread', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        headers: uiHeaders,
        ok: true,
        status: 200,
        json: async () => ({ cancelledApprovals: 0 }),
      } as Response),
    );
    groupId.value = 'agent';
    threads.value = [
      testThread({
        threadId: 'resend:agent@example.com:person@example.net:root',
        sessionId: 'email-session',
        title: 'Email thread',
        channelType: 'resend',
        messagingGroupId: 'mailbox',
      }),
    ];

    await deleteThread(threads.value[0]!);

    expect(fetch).toHaveBeenCalledWith(
      'api/groups/agent/chat/resend%3Aagent%40example.com%3Aperson%40example.net%3Aroot?channel=resend&mg=mailbox&cancelApprovals=1',
      { method: 'DELETE', credentials: 'same-origin', headers: expect.any(Headers) },
    );
    expect(threads.value).toEqual([]);
  });

  it('includes cancellation consent without channel overrides for web threads', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        headers: uiHeaders,
        ok: true,
        status: 200,
        json: async () => ({ cancelledApprovals: 0 }),
      } as Response),
    );
    groupId.value = 'agent';
    const thread = testThread({
      threadId: 'web-thread',
      sessionId: 'web-session',
      title: 'Web thread',
      channelType: 'web',
    });
    threads.value = [thread];

    await deleteThread(thread);

    expect(fetch).toHaveBeenCalledWith('api/groups/agent/chat/web-thread?cancelApprovals=1', {
      method: 'DELETE',
      credentials: 'same-origin',
      headers: expect.any(Headers),
    });
  });

  it('removes an unpersisted thread locally and opens the latest thread', async () => {
    const latest = testThread({
      threadId: 'latest',
      sessionId: 'latest-session',
      title: 'Latest thread',
      channelType: 'resend',
      messagingGroupId: 'mailbox',
      canSend: true,
    });
    const ephemeral = testThread({
      threadId: 'ephemeral',
      sessionId: null,
      title: '(new thread)',
      channelType: 'web',
      messageCount: 0,
    });
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        headers: uiHeaders,
        ok: true,
        status: 200,
        json: async () => ({ attention: [], approvals: [], threads: [latest], threadMessages: [] }),
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

  it('closes the only unpersisted thread locally', async () => {
    const ephemeral = testThread({
      threadId: 'ephemeral',
      sessionId: null,
      title: '(new thread)',
      channelType: 'web',
      messageCount: 0,
    });
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
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ headers: uiHeaders, ok: false, status: 500 } as Response));
    groupId.value = 'agent';
    const thread = testThread({
      threadId: 'web-thread',
      sessionId: 'web-session',
      title: 'Web thread',
      channelType: 'web',
    });
    threads.value = [thread];

    await deleteThread(thread);

    expect(toastMessage.value).toMatchObject({ text: 'Delete failed (HTTP 500)', kind: 'err' });
    expect(threads.value).toEqual([thread]);
  });

  it('sends explicit cancellation consent and reports cancelled approvals', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        headers: uiHeaders,
        ok: true,
        status: 200,
        json: async () => ({ cancelledApprovals: 2 }),
      } as Response),
    );
    groupId.value = 'agent';
    const thread = testThread({ threadId: 'web-thread', sessionId: 'web-session', channelType: 'web' });
    threads.value = [thread];

    await deleteThread(thread, true);

    expect(fetch).toHaveBeenCalledWith('api/groups/agent/chat/web-thread?cascade=1&cancelApprovals=1', {
      method: 'DELETE',
      credentials: 'same-origin',
      headers: expect.any(Headers),
    });
    expect(threads.value).toEqual([]);
    expect(toastMessage.value).toMatchObject({
      text: 'Deleted thread; cancelled 2 outstanding approval requests.',
      kind: 'ok',
    });
  });

  it.each([
    'Deleting this thread requires confirmation to cancel its outstanding approvals.',
    'An approval is being processed for this thread. Wait for it to finish before deleting.',
  ])('preserves the thread and displays the server conflict: %s', async (detail) => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        headers: uiHeaders,
        ok: false,
        status: 409,
        json: async () => ({ detail }),
      } as Response),
    );
    groupId.value = 'agent';
    const thread = testThread({ threadId: 'web-thread', sessionId: 'web-session', channelType: 'web' });
    threads.value = [thread];

    await deleteThread(thread);

    expect(threads.value).toEqual([thread]);
    expect(toastMessage.value).toMatchObject({
      text: detail,
      kind: 'err',
    });
  });
});
