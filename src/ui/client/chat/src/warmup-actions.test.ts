import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { addPendingFiles, deleteThread, sendChat, warmChat } from './actions';
import {
  activeTurn,
  canSend,
  channelType,
  chatReady,
  chatReloadRequired,
  groupId,
  messagingGroupId,
  pending,
  pendingWebSends,
  threadId,
  threads,
} from './state';
import { resetConversation } from './conversation-state';
import type { Thread } from './types';

vi.hoisted(() => vi.stubGlobal('window', { matchMedia: () => ({ matches: false }) }));

let sequence = 0;
let thread: Thread;
const response = (status = 200, body = { sessionId: 'warm-session' }) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

beforeEach(() => {
  resetConversation();
  groupId.value = 'agent';
  threadId.value = `empty-${++sequence}`;
  channelType.value = 'web';
  messagingGroupId.value = null;
  chatReady.value = true;
  chatReloadRequired.value = false;
  canSend.value = true;
  activeTurn.value = null;
  pending.value = [];
  pendingWebSends.value = [];
  thread = {
    threadId: threadId.value,
    sessionId: null,
    channelType: 'web',
    title: '(new thread)',
    lastActivityAt: '',
    messageCount: 0,
  };
  threads.value = [thread];
  vi.stubGlobal(
    'fetch',
    vi.fn().mockImplementation(async () => response()),
  );
});

afterEach(() => {
  vi.restoreAllMocks();
  groupId.value = null;
  threadId.value = null;
  threads.value = [];
  pending.value = [];
  pendingWebSends.value = [];
});

describe('composer-intent warmup', () => {
  it('sends one request per empty thread and records the reusable session', async () => {
    const first = warmChat();
    expect(warmChat()).toBe(first);
    await first;
    await warmChat();
    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledWith(
      `api/groups/agent/chat/${thread.threadId}/warmup`,
      expect.objectContaining({ method: 'POST', credentials: 'same-origin', body: '{}' }),
    );
    expect(threads.value[0].sessionId).toBe('warm-session');
    expect(pendingWebSends.value).toEqual([]);
    expect(activeTurn.value).toBeNull();
  });

  it.each(['existing', 'non-web', 'read-only', 'disconnected', 'reload'])(
    'does not warm %s contexts',
    async (context) => {
      if (context === 'existing') threads.value = [{ ...thread, messageCount: 1 }];
      if (context === 'non-web') channelType.value = 'telegram';
      if (context === 'read-only') canSend.value = false;
      if (context === 'disconnected') chatReady.value = false;
      if (context === 'reload') chatReloadRequired.value = true;
      await warmChat();
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it('captures the original thread without retargeting after navigation', async () => {
    let complete!: (value: Response) => void;
    vi.mocked(fetch).mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          complete = resolve;
        }),
    );
    const request = warmChat();
    const other = { ...thread, threadId: 'other', sessionId: 'other-session' };
    threads.value = [thread, other];
    threadId.value = other.threadId;
    complete(response());
    await request;
    expect(threads.value.map((entry) => entry.sessionId)).toEqual(['warm-session', 'other-session']);
    threadId.value = thread.threadId;
    await warmChat();
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('does not apply a warmup response to another group', async () => {
    let complete!: (value: Response) => void;
    vi.mocked(fetch).mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          complete = resolve;
        }),
    );
    const request = warmChat();
    groupId.value = 'another-agent';
    threads.value = [{ ...thread, sessionId: 'another-session' }];
    complete(response());
    await request;
    expect(threads.value[0].sessionId).toBe('another-session');
  });

  it('lets Send proceed while warmup is still pending', async () => {
    let complete!: (value: Response) => void;
    vi.mocked(fetch).mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          complete = resolve;
        }),
    );
    const request = warmChat();
    expect(await sendChat('Hello', null)).toBe(true);
    expect(vi.mocked(fetch).mock.calls[1][0]).toBe(`api/groups/agent/chat/${thread.threadId}/send`);
    complete(response());
    await request;
  });

  it.each(['http', 'network'])('logs %s failure without blocking submission', async (failure) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    if (failure === 'http') vi.mocked(fetch).mockResolvedValueOnce(response(503));
    else vi.mocked(fetch).mockRejectedValueOnce(new Error('Connection lost'));
    await warmChat();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('Send will use normal startup'),
      expect.objectContaining({ groupId: 'agent', threadId: thread.threadId }),
    );
    await warmChat();
    expect(fetch).toHaveBeenCalledOnce();
    expect(await sendChat('Hello', null)).toBe(true);
  });

  it('warms accepted attachments, but not empty or rejected selections', async () => {
    addPendingFiles([], 1, 10, 10);
    addPendingFiles([new File(['too large'], 'large.txt')], 1, 1, 1);
    expect(fetch).not.toHaveBeenCalled();
    addPendingFiles([new File(['x'], 'draft.txt')], 1, 10, 10);
    await warmChat();
    expect(fetch).toHaveBeenCalledOnce();
    expect(pending.value).toHaveLength(1);
  });

  it.each([404, 500])('handles HTTP %s when deleting after a failed warmup', async (status) => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.mocked(fetch).mockRejectedValueOnce(new Error('Connection lost'));
    await warmChat();
    threadId.value = 'another';
    vi.mocked(fetch).mockResolvedValueOnce(response(status));
    await deleteThread(thread);
    expect(fetch).toHaveBeenLastCalledWith(`api/groups/agent/chat/${thread.threadId}?cancelApprovals=1`, {
      method: 'DELETE',
      credentials: 'same-origin',
    });
    expect(threads.value).toEqual(status === 404 ? [] : [thread]);
  });

  it('waits for warmup before deleting an initially client-only thread', async () => {
    let complete!: (value: Response) => void;
    vi.mocked(fetch).mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          complete = resolve;
        }),
    );
    const request = warmChat();
    // Keep deletion off the active thread so it does not initiate navigation.
    threadId.value = 'another';
    const deletion = deleteThread(thread);
    expect(fetch).toHaveBeenCalledOnce();
    complete(response());
    await request;
    await deletion;
    expect(fetch).toHaveBeenLastCalledWith(`api/groups/agent/chat/${thread.threadId}?cancelApprovals=1`, {
      method: 'DELETE',
      credentials: 'same-origin',
    });
    expect(threads.value).toEqual([]);
  });
});
