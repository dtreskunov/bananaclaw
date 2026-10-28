import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearChat, selectGroup, startNewThread } from './actions';
import { applyHash, parseHash } from './hash';
import { router } from './router';
import { chatReady, drawerOpen, groupId, groups, refs, threadId, threads, toastMessage } from './state';
import { dismissToast } from './components/Toast';
import type { Thread } from './types';

vi.hoisted(() => vi.stubGlobal('window', { matchMedia: () => ({ matches: false }) }));

const latest: Thread = {
  threadId: 'latest',
  sessionId: 'latest-session',
  channelType: 'web',
  messagingGroupId: 'web-context',
  title: 'Existing conversation',
  lastActivityAt: '',
  messageCount: 2,
};
const blank: Thread = {
  ...latest,
  threadId: 'blank',
  sessionId: null,
  title: '(new thread)',
  messageCount: 0,
};
let serverThreads: Thread[];
const socketUrls: string[] = [];

beforeEach(() => {
  vi.useFakeTimers();
  socketUrls.length = 0;
  vi.stubGlobal('location', { hash: '', protocol: 'https:', host: 'example.test' });
  const browserHistory = {
    state: null as unknown,
    replaceState: vi.fn((state: unknown, _unused: string, url?: string | URL | null) => {
      browserHistory.state = state;
      if (url) location.hash = String(url);
    }),
  };
  vi.stubGlobal('history', browserHistory);
  vi.stubGlobal(
    'WebSocket',
    class {
      constructor(url: string) {
        socketUrls.push(url);
      }
      close() {}
    },
  );
  vi.stubGlobal('requestAnimationFrame', vi.fn());
  groups.value = [{ id: 'agent', name: 'Agent' }];
  serverThreads = [latest];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (url.endsWith('/chat/start')) return Response.json({ threadId: 'created', messagingGroupId: 'web-context' });
      if (url.startsWith('api/sync?')) return Response.json({ approvals: [], threads: serverThreads });
      if (url === 'api/groups/agent/dirs/') return Response.json({ entries: [] });
      throw new Error(`Unexpected request: ${url}`);
    }),
  );
});

afterEach(() => {
  clearChat();
  groupId.value = null;
  groups.value = [];
  threads.value = [];
  refs.suppressHashCount = 0;
  drawerOpen.threads.value = false;
  drawerOpen.files.value = false;
  while (toastMessage.value) dismissToast();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('new conversation on startup', () => {
  it.each([false, true])(
    "discards another group's blank thread when switching groups (new: %s)",
    async (newConversation) => {
      groupId.value = 'other-agent';
      threads.value = [{ ...blank, messagingGroupId: 'other-web-context' }];

      await selectGroup('agent', { newConversation });

      await vi.waitFor(() => expect(threadId.value).toBe(newConversation ? 'created' : 'latest'));
      expect(threads.value.some((thread) => thread.messagingGroupId === 'other-web-context')).toBe(false);
      expect(socketUrls).toEqual([
        `wss://example.test/ui/chat/api/groups/agent/chat/${newConversation ? 'created' : 'latest'}/ws?mg=web-context`,
      ]);
    },
  );

  it("discards another group's blank thread when navigating by hash", async () => {
    groupId.value = 'other-agent';
    threadId.value = 'blank';
    chatReady.value = true;
    threads.value = [{ ...blank, messagingGroupId: 'other-web-context' }];
    location.hash = '#g/agent';

    await applyHash(router);

    expect(threadId.value).toBe('latest');
    expect(threads.value).toEqual([latest]);
    expect(chatReady.value).toBe(false);
  });

  it('clears the old chat immediately while a hash navigation waits for its thread list', async () => {
    let finishSync!: (response: Response) => void;
    vi.mocked(fetch).mockImplementation(async (url) => {
      if (String(url).startsWith('api/sync?'))
        return new Promise<Response>((resolve) => {
          finishSync = resolve;
        });
      if (url === 'api/groups/agent/dirs/') return Response.json({ entries: [] });
      throw new Error(`Unexpected request: ${url}`);
    });
    groupId.value = 'other-agent';
    threadId.value = 'blank';
    chatReady.value = true;
    threads.value = [blank];
    location.hash = '#g/agent';

    const navigation = applyHash(router);

    expect(threadId.value).toBeNull();
    expect(chatReady.value).toBe(false);
    expect(threads.value).toEqual([]);
    finishSync(Response.json({ approvals: [], threads: [latest] }));
    await navigation;
    expect(threadId.value).toBe('latest');
  });

  it('ignores a hash navigation that finishes after a newer group selection', async () => {
    let finishSync!: (response: Response) => void;
    vi.mocked(fetch).mockImplementation(async (url) => {
      if (url === 'api/sync?gid=agent')
        return new Promise<Response>((resolve) => {
          finishSync = resolve;
        });
      if (url === 'api/groups/other-agent/dirs/') return Response.json({ entries: [] });
      if (String(url).startsWith('api/sync?'))
        return Response.json({ approvals: [], threads: [{ ...latest, threadId: 'new-latest' }] });
      throw new Error(`Unexpected request: ${url}`);
    });
    location.hash = '#g/agent';
    const navigation = applyHash(router);

    await selectGroup('other-agent');
    finishSync(Response.json({ approvals: [], threads: [latest] }));
    await navigation;

    expect(groupId.value).toBe('other-agent');
    expect(threadId.value).toBe('new-latest');
    expect(socketUrls).toEqual(['wss://example.test/ui/chat/api/groups/other-agent/chat/new-latest/ws?mg=web-context']);
  });

  it('ignores a group selection that finishes after a newer selection', async () => {
    let finishOldTree!: (response: Response) => void;
    vi.mocked(fetch).mockImplementation(async (url) => {
      if (url === 'api/groups/agent/dirs/')
        return new Promise<Response>((resolve) => {
          finishOldTree = resolve;
        });
      if (url === 'api/groups/other-agent/dirs/') return Response.json({ entries: [] });
      if (String(url).startsWith('api/sync?'))
        return Response.json({
          approvals: [],
          threads: [{ ...latest, threadId: groupId.value === 'agent' ? 'old-latest' : 'new-latest' }],
        });
      throw new Error(`Unexpected request: ${url}`);
    });
    const oldSelection = selectGroup('agent');
    await vi.waitFor(() => expect(finishOldTree).toBeTypeOf('function'));

    await selectGroup('other-agent');
    finishOldTree(Response.json({ entries: [] }));
    await oldSelection;

    expect(groupId.value).toBe('other-agent');
    expect(threadId.value).toBe('new-latest');
  });

  it('opens a blank conversation instead of the latest thread on a fresh visit', async () => {
    await applyHash(router, { newConversation: true });
    await vi.waitFor(() => expect(threadId.value).toBe('created'));

    expect(parseHash()).toMatchObject({ groupId: 'agent', threadId: 'created' });
    expect(fetch).toHaveBeenCalledWith('api/groups/agent/chat/start', expect.objectContaining({ method: 'POST' }));
    expect(fetch).not.toHaveBeenCalledWith(expect.stringContaining('/warmup'), expect.anything());
  });

  describe('shared new-thread shortcut', () => {
    it('opens a blank thread in the selected group and closes both drawers', async () => {
      groupId.value = 'agent';
      threads.value = [latest];
      drawerOpen.threads.value = true;
      drawerOpen.files.value = true;

      startNewThread();

      await vi.waitFor(() => expect(drawerOpen.threads.value).toBe(false));
      expect(drawerOpen.files.value).toBe(false);
      expect(threadId.value).toBe('created');
      expect(fetch).toHaveBeenCalledWith('api/groups/agent/chat/start', expect.objectContaining({ method: 'POST' }));
      expect(fetch).not.toHaveBeenCalledWith(expect.stringContaining('/warmup'), expect.anything());
    });

    it('reuses an existing empty web thread', async () => {
      groupId.value = 'agent';
      serverThreads = [latest, blank];
      threads.value = serverThreads;
      drawerOpen.threads.value = true;

      startNewThread();

      await vi.waitFor(() => expect(drawerOpen.threads.value).toBe(false));
      expect(threadId.value).toBe('blank');
      expect(fetch).not.toHaveBeenCalledWith(expect.stringContaining('/chat/start'), expect.anything());
    });

    it('does not allocate duplicate threads on rapid clicks', async () => {
      groupId.value = 'agent';
      threads.value = [latest];

      startNewThread();
      startNewThread();

      await vi.waitFor(() => expect(threadId.value).toBe('created'));
      expect(vi.mocked(fetch).mock.calls.filter(([url]) => String(url).endsWith('/chat/start'))).toHaveLength(1);
    });

    it('does nothing until an agent group is selected', () => {
      startNewThread();
      expect(fetch).not.toHaveBeenCalled();
    });
  });

  it('reuses an existing empty web thread without allocating another one', async () => {
    serverThreads = [latest, blank];
    location.hash = '#g/agent';

    await applyHash(router, { newConversation: true });

    expect(threadId.value).toBe('blank');
    expect(parseHash()?.threadId).toBe('blank');
    expect(fetch).not.toHaveBeenCalledWith(expect.stringContaining('/chat/start'), expect.anything());
  });

  it('preserves the newly allocated blank conversation across refresh before warmup or send', async () => {
    await applyHash(router, { newConversation: true });
    await vi.waitFor(() => expect(threadId.value).toBe('created'));
    clearChat();
    groupId.value = null;
    threads.value = [];

    await applyHash(router, { newConversation: true });

    expect(threadId.value).toBe('created');
    expect(parseHash()?.threadId).toBe('created');
    expect(threads.value.find((t) => t.threadId === 'created')).toMatchObject({
      title: '(new thread)',
      messageCount: 0,
      messagingGroupId: 'web-context',
    });
    expect(vi.mocked(fetch).mock.calls.filter(([url]) => url === 'api/groups/agent/chat/start')).toHaveLength(1);
  });

  it('resumes a persisted conversation from the URL without creating another one', async () => {
    location.hash = '#g/agent/t/latest';

    await applyHash(router, { newConversation: true });

    expect(threadId.value).toBe('latest');
    expect(fetch).not.toHaveBeenCalledWith(expect.stringContaining('/chat/start'), expect.anything());
  });

  it('prefers the persisted thread over an older blank copy in browser history', async () => {
    serverThreads = [blank];
    await applyHash(router, { newConversation: true });
    clearChat();
    groupId.value = null;
    threads.value = [];
    serverThreads = [{ ...blank, sessionId: 'persisted', title: 'Started conversation', messageCount: 4 }];

    await applyHash(router, { newConversation: true });

    expect(threadId.value).toBe('blank');
    expect(threads.value).toEqual(serverThreads);
    expect(fetch).not.toHaveBeenCalledWith(expect.stringContaining('/chat/start'), expect.anything());
  });

  it('keeps other browser history state when remembering a blank conversation', async () => {
    history.replaceState({ __modal_back__: true }, '');
    serverThreads = [blank];

    await applyHash(router, { newConversation: true });

    expect(history.state).toMatchObject({
      __modal_back__: true,
      blankConversation: { groupId: 'agent', thread: blank },
    });
  });

  it('continues opening the latest thread when switching groups after startup', async () => {
    await selectGroup('agent');

    expect(threadId.value).toBe('latest');
    expect(fetch).not.toHaveBeenCalledWith(expect.stringContaining('/chat/start'), expect.anything());
  });

  it('does not start a conversation using a stale list after a failed refresh', async () => {
    threads.value = [latest];
    vi.mocked(fetch).mockImplementation(async (url) => {
      if (String(url).startsWith('api/sync?')) return Response.json({ error: 'unavailable' }, { status: 503 });
      return Response.json({ entries: [] });
    });

    await selectGroup('agent', { newConversation: true });

    expect(threadId.value).toBeNull();
    expect(toastMessage.value).toMatchObject({ text: 'Could not load threads', kind: 'err' });
    expect(fetch).not.toHaveBeenCalledWith(expect.stringContaining('/chat/start'), expect.anything());
  });
});
