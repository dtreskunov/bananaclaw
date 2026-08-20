import { afterEach, describe, expect, it, vi } from 'vitest';
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
