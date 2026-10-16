/**
 * Typing-refresh instance forwarding tests.
 *
 * Three tick sites can fire setTyping — the immediate tick on a new
 * refresher, the 4s interval tick, and the immediate re-trigger when
 * startTypingRefresh is called for an already-refreshing session. All three
 * must forward the adapter instance, or a named instance's typing indicator
 * fires through the wrong bot.
 */
import fs from 'fs';
import net from 'node:net';

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';

vi.mock('../../config.js', async () => {
  const actual = await vi.importActual('../../config.js');
  return { ...actual, DATA_DIR: '.test-typing' };
});

import { setTypingAdapter, startTypingRefresh, stopTypingRefresh } from './index.js';
import { sessionLinkSocketPath, startSessionSignalServer, stopSessionSignalServer } from '../../session-link.js';

type Call = {
  channelType: string;
  platformId: string;
  threadId: string | null;
  instance?: string;
};

function captureAdapter() {
  const calls: Call[] = [];
  setTypingAdapter({
    async setTyping(channelType, platformId, threadId, instance) {
      calls.push({ channelType, platformId, threadId, instance });
    },
  });
  return calls;
}

async function connectSignal(): Promise<net.Socket> {
  await startSessionSignalServer('sess-1');
  const socket = net.createConnection(sessionLinkSocketPath('sess-1'));
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('error', reject);
  });
  return socket;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(async () => {
  stopTypingRefresh('sess-1');
  await stopSessionSignalServer('sess-1', true);
  fs.rmSync('.test-typing', { recursive: true, force: true });
  vi.useRealTimers();
});

describe('startTypingRefresh — instance forwarding', () => {
  it('immediate tick passes the instance to the adapter', async () => {
    const calls = captureAdapter();
    startTypingRefresh('sess-1', 'ag-1', 'slack', 'slack:C1', null, 'slack-tester');
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      channelType: 'slack',
      platformId: 'slack:C1',
      threadId: null,
      instance: 'slack-tester',
    });
  });

  it('interval ticks inside the grace window pass the stored entry instance', async () => {
    const calls = captureAdapter();
    startTypingRefresh('sess-1', 'ag-1', 'slack', 'slack:C1', 'T1', 'slack-tester');
    await vi.advanceTimersByTimeAsync(0);
    calls.length = 0;

    // Two 4s ticks — well inside the 15s grace window, so they fire
    // unconditionally (no runner signal needed) from the stored entry.
    await vi.advanceTimersByTimeAsync(8_500);
    expect(calls.length).toBeGreaterThanOrEqual(2);
    for (const c of calls) {
      expect(c.instance).toBe('slack-tester');
      expect(c.threadId).toBe('T1');
    }
  });

  it('re-trigger on an active turn moves routing for subsequent ticks', async () => {
    const calls = captureAdapter();
    startTypingRefresh('sess-1', 'ag-1', 'slack', 'slack:C1', null, 'slack-tester');
    await vi.advanceTimersByTimeAsync(0);
    calls.length = 0;
    await vi.advanceTimersByTimeAsync(100);

    // Second call for the same session: immediate tick with the new value.
    startTypingRefresh('sess-1', 'ag-1', 'slack', 'slack:C1', null, 'slack-worker');
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toHaveLength(1);
    expect(calls[0].instance).toBe('slack-worker');

    // The stored route moves for subsequent ticks.
    calls.length = 0;
    await vi.advanceTimersByTimeAsync(4_500);
    expect(calls.length).toBeGreaterThanOrEqual(1);
    expect(calls[calls.length - 1].instance).toBe('slack-worker');
  });

  it('re-trigger with a changed address updates the whole entry — interval ticks stay self-consistent', async () => {
    const calls = captureAdapter();
    startTypingRefresh('sess-1', 'ag-1', 'slack', 'slack:C1', 'T1', 'slack-tester');
    await vi.advanceTimersByTimeAsync(0);
    calls.length = 0;

    // Same session re-triggered from a different platform and chat
    // (agent-shared sessions span messaging groups). The stored entry must
    // not tear: keeping the old address with the new instance would hand a
    // telegram platformId to the slack-tester adapter on the next tick.
    startTypingRefresh('sess-1', 'ag-1', 'telegram', 'tg:99', null, 'telegram');
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      channelType: 'telegram',
      platformId: 'tg:99',
      threadId: null,
      instance: 'telegram',
    });

    // Interval ticks fire from the stored entry — all four fields must
    // have moved together.
    calls.length = 0;
    await vi.advanceTimersByTimeAsync(4_500);
    expect(calls.length).toBeGreaterThanOrEqual(1);
    for (const c of calls) {
      expect(c).toEqual({
        channelType: 'telegram',
        platformId: 'tg:99',
        threadId: null,
        instance: 'telegram',
      });
    }
  });
});

describe('startTypingRefresh — runner signals', () => {
  it('pauses on a stale session link and re-arms on a heartbeat', async () => {
    const calls = captureAdapter();
    startTypingRefresh('sess-1', 'ag-1', 'web', 'web-1', 'thread-1', 'web');
    await vi.advanceTimersByTimeAsync(16_000);
    calls.length = 0;
    await vi.advanceTimersByTimeAsync(8_000);
    expect(calls).toHaveLength(0);

    const socket = await connectSignal();
    socket.write(`${JSON.stringify({ v: 5, type: 'heartbeat' })}\n`);
    await vi.advanceTimersByTimeAsync(100);
    await vi.advanceTimersByTimeAsync(4_000);

    expect(calls.length).toBeGreaterThan(0);
    socket.destroy();
  });

  it('stops refreshing when the runner ends the turn', async () => {
    const calls = captureAdapter();
    startTypingRefresh('sess-1', 'ag-1', 'slack', 'slack:C1', null, 'slack-tester');
    await vi.advanceTimersByTimeAsync(100);
    const socket = await connectSignal();
    socket.write(`${JSON.stringify({ v: 5, type: 'turn.end' })}\n`);
    await vi.advanceTimersByTimeAsync(100);
    calls.length = 0;

    await vi.advanceTimersByTimeAsync(8_000);
    expect(calls).toHaveLength(0);
    socket.destroy();
  });
});
