import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyHash, buildHash, parseHash } from './hash';
import {
  drawerOpen,
  filePath,
  fileSearchOpen,
  fileSearchQuery,
  fileSearchRoot,
  groupId,
  groups,
  isMobile,
  paneOpen,
  threadId,
  threads,
  treePath,
} from './state';
import type { RouterApi } from './types';

vi.hoisted(() => {
  vi.stubGlobal('window', {
    matchMedia: () => ({ matches: false }),
  });
  vi.stubGlobal('location', { hash: '' });
  vi.stubGlobal('history', {
    replaceState: vi.fn(),
  });
});

afterEach(() => {
  groupId.value = null;
  groups.value = [];
  threadId.value = null;
  threads.value = [];
  treePath.value = '';
  filePath.value = null;
  fileSearchOpen.value = false;
  fileSearchRoot.value = '';
  fileSearchQuery.value = '';
  paneOpen.threads.value = false;
  paneOpen.files.value = false;
  drawerOpen.threads.value = false;
  drawerOpen.files.value = false;
  isMobile.value = false;
  location.hash = '';
  Object.defineProperty(history, 'state', { configurable: true, value: null });
  vi.restoreAllMocks();
});

describe('file search hash state', () => {
  it('round-trips the search mode, query, and scoped root', () => {
    groupId.value = 'agent';
    treePath.value = 'docs';
    paneOpen.files.value = true;
    fileSearchOpen.value = true;
    fileSearchRoot.value = 'docs';
    fileSearchQuery.value = 'release notes';

    location.hash = buildHash();

    expect(parseHash()).toMatchObject({
      fileSearchOpen: true,
      fileSearchRoot: 'docs',
      fileSearchQuery: 'release notes',
    });
  });

  describe('startup conversation routing', () => {
    let router: RouterApi;

    beforeEach(() => {
      groups.value = [{ id: 'agent' }] as typeof groups.value;
      threads.value = [{ threadId: 'latest', channelType: 'web' }] as typeof threads.value;
      router = {
        selectGroup: vi.fn().mockResolvedValue(undefined),
        loadThreads: vi.fn().mockResolvedValue(true),
        openChat: vi.fn().mockResolvedValue(undefined),
        clearChat: vi.fn(),
        loadTree: vi.fn().mockResolvedValue(undefined),
        selectFile: vi.fn().mockResolvedValue(undefined),
        restoreFileSearch: vi.fn().mockResolvedValue(undefined),
        notFound: vi.fn(),
      };
    });

    it('starts a new conversation in the default group on a fresh visit', async () => {
      await applyHash(router, { newConversation: true });

      expect(router.selectGroup).toHaveBeenCalledWith('agent', { newConversation: true });
    });

    it.each(['#g/agent', '#g/agent/d/docs/?files=open', '#g/agent/f/docs/notes.md?files=open'])(
      'starts a new conversation when the startup URL has no thread: %s',
      async (hash) => {
        location.hash = hash;

        await applyHash(router, { newConversation: true });

        expect(router.openChat).toHaveBeenCalledExactlyOnceWith('agent', null, null);
        expect(paneOpen.files.value).toBe(hash.includes('files=open'));
        if (hash.includes('/f/'))
          expect(router.selectFile).toHaveBeenCalledWith({ path: 'docs/notes.md', name: 'notes.md' });
        else expect(router.loadTree).toHaveBeenCalledWith(hash.includes('/d/') ? 'docs' : '');
      },
    );

    it.each(['web', 'telegram'])('resumes an explicit %s thread on startup or refresh', async (channelType) => {
      location.hash = '#g/agent/t/linked';
      threads.value = [
        ...threads.value,
        { threadId: 'linked', channelType, messagingGroupId: 'messaging-group', canSend: true },
      ] as typeof threads.value;

      await applyHash(router, { newConversation: true });

      expect(router.openChat).toHaveBeenCalledExactlyOnceWith('agent', 'linked', null);
    });

    it('leaves group navigation after startup opening the newest thread', async () => {
      location.hash = '#g/agent';

      await applyHash(router);

      expect(router.openChat).toHaveBeenCalledExactlyOnceWith('agent', 'latest', null);
    });

    it('preserves the stale-link fallback when the URL specifies a foreign thread', async () => {
      location.hash = '#g/agent/t/foreign';

      await applyHash(router, { newConversation: true });

      expect(router.openChat).toHaveBeenCalledExactlyOnceWith('agent', 'latest', null);
    });

    it.each(['other-group', 'agent'])(
      'does not restore a saved blank conversation with a different group or thread: %s',
      async (savedGroup) => {
        location.hash = '#g/agent/t/missing';
        Object.defineProperty(history, 'state', {
          configurable: true,
          value: {
            blankConversation: {
              groupId: savedGroup,
              thread: { threadId: savedGroup === 'agent' ? 'other-thread' : 'missing' },
            },
          },
        });

        await applyHash(router, { newConversation: true });

        expect(router.openChat).toHaveBeenCalledExactlyOnceWith('agent', 'latest', null);
      },
    );

    it('does not replace an explicit thread when its list fails to load', async () => {
      location.hash = '#g/agent/t/linked';
      vi.mocked(router.loadThreads).mockResolvedValue(false);

      await applyHash(router, { newConversation: true });

      expect(router.openChat).toHaveBeenCalledExactlyOnceWith('agent', 'linked', null);
    });

    it('does not open a conversation in an inaccessible group', async () => {
      location.hash = '#g/unknown';

      await applyHash(router, { newConversation: true });

      expect(router.notFound).toHaveBeenCalledWith('No access to group unknown');
      expect(router.openChat).not.toHaveBeenCalled();
      expect(router.selectGroup).not.toHaveBeenCalled();
    });
  });

  it('preserves an explicit global search scope while previewing a result', () => {
    groupId.value = 'agent';
    treePath.value = 'docs';
    filePath.value = 'docs/notes.md';
    fileSearchOpen.value = true;
    fileSearchRoot.value = '';
    fileSearchQuery.value = 'notes';

    location.hash = buildHash();

    expect(location.hash).toContain('file-root=');
    expect(parseHash()?.fileSearchRoot).toBe('');
  });

  it('preserves typed query text independently from active search mode', () => {
    groupId.value = 'agent';
    fileSearchQuery.value = 'draft query';

    location.hash = buildHash();

    expect(parseHash()).toMatchObject({
      fileSearchOpen: false,
      fileSearchQuery: 'draft query',
    });
  });

  it('restores the search before loading results for the routed directory', async () => {
    groups.value = [{ id: 'agent' }] as typeof groups.value;
    groupId.value = 'agent';
    location.hash = '#g/agent/d/docs/?files=open&file-search=open&file-query=release+notes&file-root=docs';
    const router: RouterApi = {
      selectGroup: vi.fn(),
      loadThreads: vi.fn(),
      openChat: vi.fn(),
      clearChat: vi.fn(),
      loadTree: vi.fn(),
      selectFile: vi.fn(),
      restoreFileSearch: vi.fn().mockImplementation(() => {
        location.hash = buildHash();
        return Promise.resolve();
      }),
      notFound: vi.fn(),
    };

    await applyHash(router);

    expect(router.restoreFileSearch).toHaveBeenCalledWith(true, 'docs', 'release notes');
    expect(router.loadTree).toHaveBeenCalledWith('docs');
    expect(location.hash).toContain('/d/docs/');
  });

  it('opens the group\u2019s newest thread when the routed thread belongs elsewhere', async () => {
    groups.value = [{ id: 'agent' }] as typeof groups.value;
    location.hash = '#g/agent/t/foreign-thread';
    const router: RouterApi = {
      selectGroup: vi.fn(),
      loadThreads: vi.fn().mockImplementation(() => {
        threads.value = [{ threadId: 'mine', channelType: 'web' }] as typeof threads.value;
        return Promise.resolve(true);
      }),
      openChat: vi.fn().mockResolvedValue(undefined),
      clearChat: vi.fn(),
      loadTree: vi.fn(),
      selectFile: vi.fn(),
      restoreFileSearch: vi.fn().mockResolvedValue(undefined),
      notFound: vi.fn(),
    };

    await applyHash(router);

    expect(router.openChat).toHaveBeenCalledTimes(1);
    expect(vi.mocked(router.openChat).mock.calls[0]!.slice(0, 2)).toEqual(['agent', 'mine']);
  });
});
