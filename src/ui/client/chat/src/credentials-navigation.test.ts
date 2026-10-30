import { afterEach, describe, expect, it, vi } from 'vitest';
import { credentialsIntent, openChat, openCredentials } from './credentials-navigation';
import { credentialsOpen, drawerOpen, groupAdminOpen, groupId, refs, threadId } from './state';

vi.hoisted(() => {
  vi.stubGlobal('window', { matchMedia: () => ({ matches: false }), addEventListener: vi.fn() });
  vi.stubGlobal('location', {
    href: 'https://example.test/ui/chat/#g/agent/t/chat',
    search: '',
    hash: '#g/agent/t/chat',
  });
  vi.stubGlobal('history', { state: null, replaceState: vi.fn() });
});
afterEach(() => {
  credentialsOpen.value = false;
  groupAdminOpen.value = false;
  groupId.value = null;
  threadId.value = null;
  refs.suppressHashCount = 0;
  credentialsIntent.value = null;
  Object.defineProperty(history, 'state', { configurable: true, value: null });
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe('personal Credentials navigation', () => {
  it('closes chat drawers and preserves the chat route when returning', () => {
    groupId.value = 'agent';
    threadId.value = 'chat';
    drawerOpen.files.value = true;
    openCredentials();
    expect(credentialsOpen.value).toBe(true);
    expect(drawerOpen.files.value).toBe(false);
    expect(location.hash).toBe('#credentials');
    openChat();
    expect(credentialsOpen.value).toBe(false);
    expect(location.hash).toBe('#g/agent/t/chat');
  });

  it('waits for Agent Settings to consume its back-button entry before navigating', async () => {
    vi.useFakeTimers();
    groupAdminOpen.value = true;
    Object.defineProperty(history, 'state', { configurable: true, value: { __modal_back__: true } });
    openCredentials({ resourceUrl: 'https://mcp.example.com', create: true });
    expect(groupAdminOpen.value).toBe(false);
    expect(credentialsOpen.value).toBe(false);
    const callback = vi
      .mocked(window.addEventListener)
      .mock.calls.find(([type]) => type === 'popstate')![1] as () => void;
    callback();
    await vi.advanceTimersByTimeAsync(0);
    expect(credentialsOpen.value).toBe(true);
    expect(location.hash).toBe('#credentials');
    expect(credentialsIntent.value).toEqual({ resourceUrl: 'https://mcp.example.com', create: true });
  });
});
