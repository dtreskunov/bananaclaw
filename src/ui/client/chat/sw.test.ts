import fs from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

type RenotifyPolicy = (deliveryOrigin: string | null, hasExistingNotification: boolean) => boolean;

function loadRenotifyPolicy(): RenotifyPolicy {
  const source = fs.readFileSync(new URL('./sw.js', import.meta.url), 'utf8');
  const sandbox: {
    self: { addEventListener: () => void };
    policy?: RenotifyPolicy;
  } = {
    self: { addEventListener: () => {} },
  };
  vm.runInNewContext(`${source}\n;globalThis.policy = shouldRenotify;`, sandbox);
  if (!sandbox.policy) throw new Error('service worker policy was not loaded');
  return sandbox.policy;
}

describe('service worker notification cadence', () => {
  const shouldRenotify = loadRenotifyPolicy();

  it('alerts for the first mid-turn update', () => {
    expect(shouldRenotify('send_message', false)).toBe(true);
  });

  describe('authoritative unread badges', () => {
    it('uses server thread counts, serializes refreshes and never clears just on focus', async () => {
      const source = fs.readFileSync(new URL('./sw.js', import.meta.url), 'utf8');
      const set = vi.fn(), clear = vi.fn();
      const fetch = vi.fn().mockResolvedValueOnce({ ok: true, json: async () => ({ unreadThreadCount: 3 }) })
        .mockResolvedValueOnce({ ok: true, json: async () => ({ unreadThreadCount: 0 }) });
      const sandbox: {
        self: object; fetch: typeof fetch; refresh?: () => Promise<void>;
      } = { self: { addEventListener() {}, navigator: { setAppBadge: set, clearAppBadge: clear } }, fetch };
      vm.runInNewContext(`${source}\n;globalThis.refresh = refreshUnreadBadge;`, sandbox);
      if (!sandbox.refresh) throw new Error('Badge refresh missing');
      await Promise.all([sandbox.refresh(), sandbox.refresh()]);
      expect(set).toHaveBeenCalledExactlyOnceWith(3);
      expect(clear).toHaveBeenCalledOnce();
      expect(fetch).toHaveBeenCalledWith('/ui/chat/api/unread', { credentials: 'include', cache: 'no-store' });
      const client = fs.readFileSync(new URL('./src/badge.ts', import.meta.url), 'utf8');
      expect(client).not.toContain('visibilitychange');
      expect(client).not.toContain('unread += 1');
    });
  });

  it('silently replaces repeated mid-turn updates', () => {
    expect(shouldRenotify('send_message', true)).toBe(false);
  });

  it('re-alerts for final and legacy responses', () => {
    expect(shouldRenotify('response', true)).toBe(true);
    expect(shouldRenotify(null, true)).toBe(true);
  });
});
