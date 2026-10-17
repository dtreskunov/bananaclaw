import { describe, expect, it, vi } from 'vitest';

import { ThreadScanCache, THREAD_SCAN_MAX_AGE_MS } from './thread-scan-cache.js';
import type { SessionThreadScan, ThreadScanSpec } from './thread-scan.js';

const spec: ThreadScanSpec = { agentGroupId: 'group', sessionId: 'session' };
const result: SessionThreadScan = {
  threads: [],
  dms: [],
  dmReplies: [],
  owners: [],
  totalCost: 0,
  totalTokens: 0,
  turnCount: 0,
};

describe('per-session thread scan cache', () => {
  it('rescans only the changed session, across viewer requests and routing scopes', () => {
    const read = vi.fn(() => result);
    const cache = new ThreadScanCache(read);
    const specs = Array.from({ length: 404 }, (_, index) => ({ ...spec, sessionId: `session-${index}` }));
    for (const input of specs) cache.get(input);
    expect(read).toHaveBeenCalledTimes(404);
    read.mockClear();
    for (const input of specs) cache.get(input);
    expect(read).not.toHaveBeenCalled();
    cache.invalidate('session-200');
    for (const input of specs) cache.get(input);
    expect(read).toHaveBeenCalledExactlyOnceWith(specs[200]);
  });

  it('keys routing variations separately and invalidates every variant of a session', () => {
    const read = vi.fn(() => result);
    const cache = new ThreadScanCache(read);
    const routed = { ...spec, thread: { channelType: 'resend', platformId: 'inbox', threadId: 'thread' } };
    cache.get(spec);
    cache.get(routed);
    expect(read).toHaveBeenCalledTimes(2);
    cache.invalidate(spec.sessionId);
    cache.get(spec);
    cache.get(routed);
    expect(read).toHaveBeenCalledTimes(4);
  });

  it('reconciles unobserved writes after a bounded age, including frequently accessed sessions', () => {
    let now = 0;
    const read = vi.fn(() => result);
    const cache = new ThreadScanCache(read, () => now);
    cache.get(spec);
    now = THREAD_SCAN_MAX_AGE_MS - 1;
    cache.get(spec);
    expect(read).toHaveBeenCalledTimes(1);
    now++;
    cache.get(spec);
    expect(read).toHaveBeenCalledTimes(2);
    cache.invalidate(null);
    cache.get(spec);
    expect(read).toHaveBeenCalledTimes(3);
  });

  it('bounds retained results with LRU eviction and never caches failures', () => {
    const read = vi.fn(() => result);
    const cache = new ThreadScanCache(read);
    cache.get(spec);
    for (let i = 0; i < 1024; i++) cache.get({ ...spec, sessionId: `other-${i}` });
    read.mockClear();
    cache.get(spec);
    expect(read).toHaveBeenCalledTimes(1);
    cache.invalidate(spec.sessionId);
    read.mockImplementationOnce(() => {
      throw new Error('database locked');
    });
    expect(() => cache.get(spec)).toThrow('database locked');
    cache.get(spec);
    expect(read).toHaveBeenCalledTimes(3);
  });
});
