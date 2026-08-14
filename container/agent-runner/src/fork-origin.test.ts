import { describe, it, expect, beforeEach, afterEach } from 'bun:test';

import { initTestSessionDb, closeSessionDb, getInboundDb } from './db/connection.js';
import { getUndeliveredMessages } from './db/messages-out.js';
import { getContinuation, setContinuation } from './db/session-state.js';
import { MockProvider } from './providers/mock.js';
import type { AgentProvider, ForkContinuationInput } from './providers/types.js';
import { runPollLoop } from './poll-loop.js';
import { loadConfig } from './config.js';

beforeEach(() => {
  initTestSessionDb();
  loadConfig();
  getInboundDb()
    .prepare(
      `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
       VALUES ('discord-test', 'Discord Test', 'channel', 'discord', 'chan-1', NULL)`,
    )
    .run();
});

afterEach(() => {
  closeSessionDb();
});

const DIGEST = '<message from="Alice">what colour should the logo be?</message>';

function seedForkOrigin(opts: Partial<Record<string, string | null>> = {}): void {
  getInboundDb()
    .prepare(
      `INSERT INTO fork_origin
         (id, parent_session_id, parent_continuation, provider, anchor_ref, digest, created_at)
       VALUES (1, ?, ?, ?, ?, ?, datetime('now'))`,
    )
    .run(
      (opts.parentSessionId as string) ?? 'sess-parent',
      opts.parentContinuation === undefined ? 'parent-continuation' : (opts.parentContinuation as string | null),
      opts.provider === undefined ? 'mock' : (opts.provider as string | null),
      opts.anchorRef === undefined ? 'anchor-1' : (opts.anchorRef as string | null),
      DIGEST,
    );
}

function insertMessage(id: string, text: string): void {
  getInboundDb()
    .prepare(
      `INSERT INTO messages_in (id, kind, timestamp, status, platform_id, channel_type, content)
       VALUES (?, 'chat', datetime('now'), 'pending', 'chan-1', 'discord', ?)`,
    )
    .run(id, JSON.stringify({ sender: 'Alice', text }));
}

/**
 * MockProvider that records every prompt it is handed, so tests can assert
 * on what the agent actually saw rather than on internal bookkeeping.
 */
function recordingProvider(): { provider: MockProvider; prompts: string[] } {
  const prompts: string[] = [];
  const provider = new MockProvider({}, (prompt) => {
    prompts.push(prompt);
    return '<message to="discord-test">ok</message>';
  });
  return { provider, prompts };
}

describe('forked session adoption — digest tier', () => {
  it('prepends the inherited history to the first turn, once', async () => {
    seedForkOrigin();
    insertMessage('m1', 'and now?');

    const { provider, prompts } = recordingProvider();
    const controller = new AbortController();
    const loop = runLoop(provider, controller.signal);

    await waitFor(() => getUndeliveredMessages().length > 0, 2000);

    expect(prompts[0]).toContain('<forked_thread_history>');
    expect(prompts[0]).toContain(DIGEST);
    // The digest leads; the live message still follows it.
    expect(prompts[0].indexOf(DIGEST)).toBeLessThan(prompts[0].indexOf('and now?'));

    // A second turn in the same container must not re-inject it.
    insertMessage('m2', 'still there?');
    await waitFor(() => getUndeliveredMessages().length > 1, 2000);
    controller.abort();

    expect(prompts).toHaveLength(2);
    expect(prompts[1]).not.toContain('<forked_thread_history>');

    await loop.catch(() => {});
  });

  it('does not replay the history after a container restart', async () => {
    seedForkOrigin();
    insertMessage('m1', 'first');

    const first = recordingProvider();
    const c1 = new AbortController();
    const loop1 = runLoop(first.provider, c1.signal);
    await waitFor(() => getUndeliveredMessages().length > 0, 2000);
    c1.abort();
    await loop1.catch(() => {});

    // Same session DBs, brand-new container: fork_origin is still sitting in
    // inbound.db (the container can't delete it), so only the absorbed flag
    // in outbound.db stops a second injection.
    insertMessage('m2', 'second');
    const second = recordingProvider();
    const c2 = new AbortController();
    const loop2 = runLoop(second.provider, c2.signal);
    await waitFor(() => getUndeliveredMessages().length > 1, 2000);
    c2.abort();

    expect(second.prompts[0]).not.toContain('<forked_thread_history>');

    await loop2.catch(() => {});
  });

  it('is skipped entirely for a session that already has a continuation', async () => {
    seedForkOrigin();
    setContinuation('mock', 'already-running');
    insertMessage('m1', 'hello');

    const { provider, prompts } = recordingProvider();
    const controller = new AbortController();
    const loop = runLoop(provider, controller.signal);
    await waitFor(() => getUndeliveredMessages().length > 0, 2000);
    controller.abort();

    expect(prompts[0]).not.toContain('<forked_thread_history>');

    await loop.catch(() => {});
  });

  it('leaves a non-forked session prompt untouched', async () => {
    insertMessage('m1', 'plain message');

    const { provider, prompts } = recordingProvider();
    const controller = new AbortController();
    const loop = runLoop(provider, controller.signal);
    await waitFor(() => getUndeliveredMessages().length > 0, 2000);
    controller.abort();

    expect(prompts[0]).not.toContain('<forked_thread_history>');

    await loop.catch(() => {});
  });
});

describe('forked session adoption — native tier', () => {
  function forkingProvider(impl: (input: ForkContinuationInput) => Promise<string | null>): {
    provider: MockProvider;
    prompts: string[];
    calls: ForkContinuationInput[];
  } {
    const { provider, prompts } = recordingProvider();
    const calls: ForkContinuationInput[] = [];
    (provider as AgentProvider).forkContinuation = async (input) => {
      calls.push(input);
      return impl(input);
    };
    return { provider, prompts, calls };
  }

  it('adopts the provider fork and skips the digest', async () => {
    seedForkOrigin();
    insertMessage('m1', 'go on');

    const { provider, prompts, calls } = forkingProvider(async () => 'forked-continuation');
    const controller = new AbortController();
    const loop = runLoop(provider, controller.signal);
    await waitFor(() => getUndeliveredMessages().length > 0, 2000);
    controller.abort();

    expect(calls).toEqual([{ continuation: 'parent-continuation', anchorRef: 'anchor-1', cwd: '/tmp' }]);
    expect(prompts[0]).not.toContain('<forked_thread_history>');

    await loop.catch(() => {});
  });

  it('falls back to the digest when the provider fork throws', async () => {
    seedForkOrigin();
    insertMessage('m1', 'go on');

    const { provider, prompts } = forkingProvider(async () => {
      throw new Error('upstream session expired');
    });
    const controller = new AbortController();
    const loop = runLoop(provider, controller.signal);
    await waitFor(() => getUndeliveredMessages().length > 0, 2000);
    controller.abort();

    expect(prompts[0]).toContain('<forked_thread_history>');

    await loop.catch(() => {});
  });

  it('falls back to the digest when the provider declines', async () => {
    seedForkOrigin();
    insertMessage('m1', 'go on');

    const { provider, prompts } = forkingProvider(async () => null);
    const controller = new AbortController();
    const loop = runLoop(provider, controller.signal);
    await waitFor(() => getUndeliveredMessages().length > 0, 2000);
    controller.abort();

    expect(prompts[0]).toContain('<forked_thread_history>');

    await loop.catch(() => {});
  });

  it("never hands one provider another provider's continuation", async () => {
    // Branch cut while the group ran on Claude; container is now on mock.
    seedForkOrigin({ provider: 'claude' });
    insertMessage('m1', 'go on');

    const { provider, prompts, calls } = forkingProvider(async () => 'should-not-happen');
    const controller = new AbortController();
    const loop = runLoop(provider, controller.signal);
    await waitFor(() => getUndeliveredMessages().length > 0, 2000);
    controller.abort();

    expect(calls).toHaveLength(0);
    expect(prompts[0]).toContain('<forked_thread_history>');
    expect(getContinuation('mock')).not.toBe('should-not-happen');

    await loop.catch(() => {});
  });

  it('falls back to the digest when no anchor was captured', async () => {
    seedForkOrigin({ anchorRef: null });
    insertMessage('m1', 'go on');

    const { provider, prompts, calls } = forkingProvider(async () => 'should-not-happen');
    const controller = new AbortController();
    const loop = runLoop(provider, controller.signal);
    await waitFor(() => getUndeliveredMessages().length > 0, 2000);
    controller.abort();

    expect(calls).toHaveLength(0);
    expect(prompts[0]).toContain('<forked_thread_history>');

    await loop.catch(() => {});
  });
});

function runLoop(provider: MockProvider, signal: AbortSignal): Promise<void> {
  return Promise.race([
    runPollLoop({ provider, providerName: 'mock', cwd: '/tmp', signal }),
    new Promise<void>((_, reject) => {
      signal.addEventListener('abort', () => reject(new Error('aborted')));
    }),
    new Promise<void>((_, reject) => setTimeout(() => reject(new Error('timeout')), 5000)),
  ]);
}

async function waitFor(condition: () => boolean, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timeout');
    await new Promise((r) => setTimeout(r, 25));
  }
}
