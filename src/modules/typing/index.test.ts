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
vi.mock('../../container-config.js', () => ({ configFromDb: () => ({ model: 'openrouter/minimax/minimax-m3' }) }));
vi.mock('../../db/agent-groups.js', () => ({ getAgentGroup: () => ({ id: 'ag-1' }) }));
vi.mock('../../db/container-configs.js', () => ({ getContainerConfig: () => ({ agent_group_id: 'ag-1' }) }));

import { setTypingAdapter, startTypingRefresh, stopTypingRefresh } from './index.js';
import { sessionLinkSocketPath, startSessionSignalServer, stopSessionSignalServer } from '../../session-link.js';
import type { ActivityLine, TypingMetadata } from '../../channels/adapter.js';

type Call = {
  channelType: string;
  platformId: string;
  threadId: string | null;
  instance?: string;
  metadata?: TypingMetadata;
  items?: ActivityLine[];
};

function captureAdapter() {
  const calls: Call[] = [];
  setTypingAdapter({
    async setTyping(channelType, platformId, threadId, _hint, instance, items, metadata) {
      calls.push({ channelType, platformId, threadId, instance, metadata, ...(items?.length ? { items } : {}) });
    },
  });
  return calls;
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
      metadata: { startedAt: expect.any(Number), model: 'openrouter/minimax/minimax-m3' },
    });
  });

  it('interval ticks inside the grace window pass the stored entry instance', async () => {
    const calls = captureAdapter();
    startTypingRefresh('sess-1', 'ag-1', 'slack', 'slack:C1', 'T1', 'slack-tester');
    await vi.advanceTimersByTimeAsync(0);
    const startedAt = calls[0].metadata?.startedAt;
    calls.length = 0;

    // Two 4s ticks — well inside the 15s grace window, so they fire
    // unconditionally (no runner signal needed) from the stored entry.
    await vi.advanceTimersByTimeAsync(8_500);
    expect(calls.length).toBeGreaterThanOrEqual(2);
    for (const c of calls) {
      expect(c.instance).toBe('slack-tester');
      expect(c.threadId).toBe('T1');
      expect(c.metadata?.startedAt).toBe(startedAt);
    }
  });

  it('re-trigger on an active turn changes routing without resetting its metadata boundary', async () => {
    const calls = captureAdapter();
    startTypingRefresh('sess-1', 'ag-1', 'slack', 'slack:C1', null, 'slack-tester');
    await vi.advanceTimersByTimeAsync(0);
    const firstStartedAt = calls[0].metadata?.startedAt;
    calls.length = 0;
    await vi.advanceTimersByTimeAsync(100);

    // Second call for the same session: immediate tick with the new value.
    startTypingRefresh('sess-1', 'ag-1', 'slack', 'slack:C1', null, 'slack-worker');
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toHaveLength(1);
    expect(calls[0].instance).toBe('slack-worker');
    expect(calls[0].metadata?.startedAt).toBe(firstStartedAt);

    // The stored route moves, but subsequent ticks retain the same turn.
    calls.length = 0;
    await vi.advanceTimersByTimeAsync(4_500);
    expect(calls.length).toBeGreaterThanOrEqual(1);
    expect(calls[calls.length - 1].instance).toBe('slack-worker');
    expect(calls[calls.length - 1].metadata?.startedAt).toBe(firstStartedAt);
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
      metadata: { startedAt: expect.any(Number), model: 'openrouter/minimax/minimax-m3' },
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
        metadata: { startedAt: expect.any(Number), model: 'openrouter/minimax/minimax-m3' },
      });
    }
  });

  it('forwards a fresh in-flight usage snapshot', async () => {
    const calls = captureAdapter();
    startTypingRefresh('sess-1', 'ag-1', 'slack', 'slack:C1', null, 'slack-tester');
    await vi.advanceTimersByTimeAsync(0);
    calls.length = 0;

    await startSessionSignalServer('sess-1');
    const socket = net.createConnection(sessionLinkSocketPath('sess-1'));
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('error', reject);
    });
    socket.write(
      `${JSON.stringify({
        v: 4,
        type: 'activity',
        turnId: null,
        ts: String(Date.now()),
        ordinal: 0,
        step: { kind: 'tool', id: 'lookup', tool: 'budget', status: 'completed' },
      })}\n`,
    );
    socket.write(
      `${JSON.stringify({
        v: 4,
        type: 'usage',
        turnId: null,
        ts: String(Date.now()),
        usage: {
          cost_usd: 0.25,
          input_tokens: 1200,
          output_tokens: 30,
          cache_read_tokens: 1000,
          cache_write_tokens: 0,
          num_turns: 2,
          model: 'minimax/MiniMax-M3',
        },
      })}\n`,
    );
    await vi.advanceTimersByTimeAsync(100);

    await vi.advanceTimersByTimeAsync(4_500);
    expect(calls.at(-1)?.metadata?.usage).toEqual(
      expect.objectContaining({
        input_tokens: 1200,
        output_tokens: 30,
        num_turns: 2,
      }),
    );
    const turnStartedAt = calls.at(-1)?.metadata?.startedAt;
    const items = calls.at(-1)?.items;
    expect(items).toHaveLength(1);
    calls.length = 0;
    startTypingRefresh('sess-1', 'ag-1', 'web', 'web-1', 'thread-1', 'web');
    await vi.advanceTimersByTimeAsync(0);
    expect(calls.at(-1)?.metadata).toEqual(
      expect.objectContaining({
        startedAt: turnStartedAt,
        usage: expect.objectContaining({
          input_tokens: 1200,
          output_tokens: 30,
          num_turns: 2,
        }),
      }),
    );
    expect(calls.at(-1)?.items).toEqual(items);
    for (const [platform, thread, instance] of [
      ['web-2', 'thread-1', 'web'],
      ['web-2', 'thread-2', 'web'],
      ['web-2', 'thread-2', 'web-alt'],
    ]) {
      startTypingRefresh('sess-1', 'ag-1', 'web', platform, thread, instance);
      await vi.advanceTimersByTimeAsync(0);
      expect(calls.at(-1)?.items).toEqual(items);
      expect(calls.at(-1)?.metadata?.startedAt).toBe(turnStartedAt);
      startTypingRefresh('sess-1', 'ag-1', 'web', platform, thread, instance);
      await vi.advanceTimersByTimeAsync(0);
      expect(calls.at(-1)?.items).toBeUndefined();
    }
    socket.destroy();
  });
});

describe('startTypingRefresh — transient heartbeat stalls', () => {
  it('re-arms typing when a stale session link receives a heartbeat', async () => {
    const setTyping = vi.fn(async () => {});
    const clearTyping = vi.fn(async () => {});
    setTypingAdapter({ setTyping, clearTyping });
    startTypingRefresh('sess-1', 'ag-1', 'web', 'web-1', 'thread-1', 'web');
    await vi.advanceTimersByTimeAsync(16_000);

    expect(clearTyping).toHaveBeenCalledTimes(1);
    const callsBeforeRecovery = setTyping.mock.calls.length;

    await startSessionSignalServer('sess-1');
    const socket = net.createConnection(sessionLinkSocketPath('sess-1'));
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('error', reject);
    });
    socket.write(`${JSON.stringify({ v: 4, type: 'heartbeat' })}\n`);
    await vi.advanceTimersByTimeAsync(100);
    await vi.advanceTimersByTimeAsync(4_000);

    expect(setTyping.mock.calls.length).toBeGreaterThan(callsBeforeRecovery);
    socket.destroy();
  });
});
