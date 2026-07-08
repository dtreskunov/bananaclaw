import { describe, it, expect, beforeEach, afterEach } from 'bun:test';

import { initTestSessionDb, closeSessionDb, getInboundDb, getOutboundDb } from './db/connection.js';
import { getUndeliveredMessages, writeMessageOut } from './db/messages-out.js';
import { getPendingMessages } from './db/messages-in.js';
import { getContinuation, setContinuation } from './db/session-state.js';
import { MockProvider } from './providers/mock.js';
import type { ProviderExchange } from './providers/types.js';
import { runPollLoop } from './poll-loop.js';
import { loadConfig } from './config.js';

beforeEach(() => {
  initTestSessionDb();
  // runPollLoop reads runtime config (e.g. voiceMode for audio transcription).
  // The container always calls loadConfig() before runPollLoop; mirror that
  // here. With no container.json present, loadConfig() falls back to defaults
  // (voiceMode 'off'), so transcription is skipped.
  loadConfig();
  // Seed a destination so output parsing can resolve "discord-test" → routing
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

function insertMessage(id: string, content: object, opts?: { platformId?: string; channelType?: string; threadId?: string }) {
  getInboundDb()
    .prepare(
      `INSERT INTO messages_in (id, kind, timestamp, status, platform_id, channel_type, thread_id, content)
       VALUES (?, 'chat', datetime('now'), 'pending', ?, ?, ?, ?)`,
    )
    .run(id, opts?.platformId ?? null, opts?.channelType ?? null, opts?.threadId ?? null, JSON.stringify(content));
}

describe('poll loop integration', () => {
  it('should pick up a message, process it, and write a response', async () => {
    insertMessage('m1', { sender: 'Alice', text: 'What is the meaning of life?' }, { platformId: 'chan-1', channelType: 'discord', threadId: 'thread-1' });

    const provider = new MockProvider({}, () => '<message to="discord-test">42</message>');

    const controller = new AbortController();
    const loopPromise = runPollLoopWithTimeout(provider, controller.signal, 2000);

    await waitFor(() => getUndeliveredMessages().length > 0, 2000);
    controller.abort();

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(JSON.parse(out[0].content).text).toBe('42');
    expect(out[0].platform_id).toBe('chan-1');
    expect(out[0].channel_type).toBe('discord');
    expect(out[0].in_reply_to).toBe('m1');

    // Input message should be acked (not pending)
    const pending = getPendingMessages();
    expect(pending).toHaveLength(0);

    await loopPromise.catch(() => {});
  });

  it('should process multiple messages in a batch', async () => {
    insertMessage('m1', { sender: 'Alice', text: 'Hello' });
    insertMessage('m2', { sender: 'Bob', text: 'World' });

    const provider = new MockProvider({}, () => '<message to="discord-test">Got both messages</message>');
    const controller = new AbortController();
    const loopPromise = runPollLoopWithTimeout(provider, controller.signal, 2000);

    await waitFor(() => getUndeliveredMessages().length > 0, 2000);
    controller.abort();

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(JSON.parse(out[0].content).text).toBe('Got both messages');

    await loopPromise.catch(() => {});
  });

  it('should resolve thread_id per-destination, not from global routing', async () => {
    // Seed a second destination
    getInboundDb()
      .prepare(
        `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
         VALUES ('slack-test', 'Slack Test', 'channel', 'slack', 'chan-2', NULL)`,
      )
      .run();

    // Insert messages from each destination with distinct thread IDs
    insertMessage('m-discord', { sender: 'Alice', text: 'from discord' }, { platformId: 'chan-1', channelType: 'discord', threadId: 'discord-thread-1' });
    insertMessage('m-slack', { sender: 'Bob', text: 'from slack' }, { platformId: 'chan-2', channelType: 'slack', threadId: 'slack-thread-99' });

    // Agent replies to both destinations
    const provider = new MockProvider({}, () =>
      '<message to="discord-test">reply-d</message><message to="slack-test">reply-s</message>',
    );
    const controller = new AbortController();
    const loopPromise = runPollLoopWithTimeout(provider, controller.signal, 2000);

    await waitFor(() => getUndeliveredMessages().length >= 2, 2000);
    controller.abort();

    const out = getUndeliveredMessages();
    const discordOut = out.find((m) => m.platform_id === 'chan-1');
    const slackOut = out.find((m) => m.platform_id === 'chan-2');

    expect(discordOut).toBeDefined();
    expect(discordOut!.thread_id).toBe('discord-thread-1');
    expect(discordOut!.in_reply_to).toBe('m-discord');

    expect(slackOut).toBeDefined();
    expect(slackOut!.thread_id).toBe('slack-thread-99');
    expect(slackOut!.in_reply_to).toBe('m-slack');

    await loopPromise.catch(() => {});
  });

  it('bare text produces no outbound messages (scratchpad only)', async () => {
    insertMessage('m1', { sender: 'Alice', text: 'hello' }, { platformId: 'chan-1', channelType: 'discord' });

    // Agent responds with bare text — no <message to="..."> wrapping
    const provider = new MockProvider({}, () => 'I am thinking about this...');
    const controller = new AbortController();
    const loopPromise = runPollLoopWithTimeout(provider, controller.signal, 2000);

    // Wait long enough for the poll loop to process
    await sleep(1000);
    controller.abort();

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(0);

    await loopPromise.catch(() => {});
  });

  it('unknown destination is dropped, valid destination is sent', async () => {
    insertMessage('m1', { sender: 'Alice', text: 'hi' }, { platformId: 'chan-1', channelType: 'discord' });

    const provider = new MockProvider(
      {},
      () => '<message to="nonexistent">dropped</message><message to="discord-test">delivered</message>',
    );
    const controller = new AbortController();
    const loopPromise = runPollLoopWithTimeout(provider, controller.signal, 2000);

    await waitFor(() => getUndeliveredMessages().length > 0, 2000);
    controller.abort();

    const out = getUndeliveredMessages();
    // Only the valid destination should produce output
    expect(out).toHaveLength(1);
    expect(JSON.parse(out[0].content).text).toBe('delivered');
    expect(out[0].platform_id).toBe('chan-1');

    await loopPromise.catch(() => {});
  });

  it('multiple <message> blocks each produce an outbound message', async () => {
    getInboundDb()
      .prepare(
        `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
         VALUES ('slack-test', 'Slack Test', 'channel', 'slack', 'chan-2', NULL)`,
      )
      .run();

    insertMessage('m1', { sender: 'Alice', text: 'broadcast' }, { platformId: 'chan-1', channelType: 'discord' });

    const provider = new MockProvider(
      {},
      () => '<message to="discord-test">for discord</message><message to="slack-test">for slack</message>',
    );
    const controller = new AbortController();
    const loopPromise = runPollLoopWithTimeout(provider, controller.signal, 2000);

    await waitFor(() => getUndeliveredMessages().length >= 2, 2000);
    controller.abort();

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(2);
    const discord = out.find((m) => m.platform_id === 'chan-1');
    const slack = out.find((m) => m.platform_id === 'chan-2');
    expect(discord).toBeDefined();
    expect(JSON.parse(discord!.content).text).toBe('for discord');
    expect(slack).toBeDefined();
    expect(JSON.parse(slack!.content).text).toBe('for slack');

    await loopPromise.catch(() => {});
  });

  it('sends null thread_id when no prior inbound from destination', async () => {
    // Seed a second destination that has NO inbound messages
    getInboundDb()
      .prepare(
        `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
         VALUES ('slack-new', 'Slack New', 'channel', 'slack', 'chan-new', NULL)`,
      )
      .run();

    // Only insert a message from discord — slack-new has never sent anything
    insertMessage('m1', { sender: 'Alice', text: 'tell slack' }, { platformId: 'chan-1', channelType: 'discord', threadId: 'discord-thread' });

    const provider = new MockProvider({}, () => '<message to="slack-new">hello slack</message>');
    const controller = new AbortController();
    const loopPromise = runPollLoopWithTimeout(provider, controller.signal, 2000);

    await waitFor(() => getUndeliveredMessages().length > 0, 2000);
    controller.abort();

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(out[0].platform_id).toBe('chan-new');
    expect(out[0].thread_id).toBeNull();

    await loopPromise.catch(() => {});
  });

  it('resolves most recent thread_id when destination has multiple inbound messages', async () => {
    // Two messages from same destination, different threads
    insertMessage('m-old', { sender: 'Alice', text: 'old' }, { platformId: 'chan-1', channelType: 'discord', threadId: 'thread-old' });
    insertMessage('m-new', { sender: 'Alice', text: 'new' }, { platformId: 'chan-1', channelType: 'discord', threadId: 'thread-new' });

    const provider = new MockProvider({}, () => '<message to="discord-test">reply</message>');
    const controller = new AbortController();
    const loopPromise = runPollLoopWithTimeout(provider, controller.signal, 2000);

    await waitFor(() => getUndeliveredMessages().length > 0, 2000);
    controller.abort();

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(out[0].thread_id).toBe('thread-new');
    expect(out[0].in_reply_to).toBe('m-new');

    await loopPromise.catch(() => {});
  });

  it('should process messages arriving after loop starts', async () => {
    const provider = new MockProvider({}, () => '<message to="discord-test">Processed</message>');
    const controller = new AbortController();
    const loopPromise = runPollLoopWithTimeout(provider, controller.signal, 3000);

    // Insert message after loop has started
    await sleep(200);
    insertMessage('m-late', { sender: 'Charlie', text: 'Late arrival' });

    await waitFor(() => getUndeliveredMessages().length > 0, 2000);
    controller.abort();

    const out = getUndeliveredMessages();
    expect(out.length).toBeGreaterThanOrEqual(1);

    await loopPromise.catch(() => {});
  });

  it('internal tags between message blocks are stripped from scratchpad', async () => {
    insertMessage('m1', { sender: 'Alice', text: 'hi' }, { platformId: 'chan-1', channelType: 'discord' });

    const provider = new MockProvider(
      {},
      () => '<internal>thinking about this...</internal><message to="discord-test">answer</message><internal>done thinking</internal>',
    );
    const controller = new AbortController();
    const loopPromise = runPollLoopWithTimeout(provider, controller.signal, 2000);

    await waitFor(() => getUndeliveredMessages().length > 0, 2000);
    controller.abort();

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(JSON.parse(out[0].content).text).toBe('answer');

    await loopPromise.catch(() => {});
  });

  it('reaction-only MCP write does NOT suppress the unwrapped-text nudge', async () => {
    // Regression for: a weaker model that reacts ✅ and then leaves its
    // actual answer unwrapped used to have the nudge suppressed (because
    // any MCP write counted as "the agent already replied"). Result was
    // silent dropping of the answer. After the fix, operation-only rows
    // (kind='chat' with {operation: 'reaction'}) do NOT count, the nudge
    // fires, and the model gets a chance to re-wrap on the next turn.
    insertMessage('m1', { sender: 'Alice', text: 'what model?' }, { platformId: 'chan-1', channelType: 'discord' });

    let turn = 0;
    const provider = new MockProvider({}, (prompt) => {
      turn++;
      if (turn === 1) {
        // Simulate add_reaction firing mid-turn alongside unwrapped text.
        writeMessageOut({
          id: `reaction-${Date.now()}`,
          kind: 'chat',
          platform_id: 'chan-1',
          channel_type: 'discord',
          thread_id: null,
          content: JSON.stringify({ operation: 'reaction', messageId: '1', emoji: 'white_check_mark' }),
        });
        return "I'm powered by deepseek-v3.1";  // BARE TEXT — no wrapping
      }
      // Verify the nudge actually arrived in the follow-up prompt.
      expect(prompt).toContain('was not delivered');
      return '<message to="discord-test">I\'m powered by deepseek-v3.1</message>';
    });
    const controller = new AbortController();
    const loopPromise = runPollLoopWithTimeout(provider, controller.signal, 3000);

    // Wait for the recovered text reply (separate from the reaction row).
    await waitFor(
      () => getUndeliveredMessages().some((m) => {
        try {
          const c = JSON.parse(m.content) as { text?: string };
          return typeof c.text === 'string' && c.text.includes('deepseek');
        } catch { return false; }
      }),
      3000,
    );
    controller.abort();

    const out = getUndeliveredMessages();
    const textRow = out.find((m) => {
      try { return typeof (JSON.parse(m.content) as { text?: string }).text === 'string'; }
      catch { return false; }
    });
    expect(textRow).toBeDefined();
    expect(JSON.parse(textRow!.content).text).toContain('deepseek');

    await loopPromise.catch(() => {});
  });

  it('handles mixed task + chat batch with correct origin metadata', async () => {
    // Seed destination for routing lookup
    insertMessage('m-chat', { sender: 'Alice', text: 'check this' }, { platformId: 'chan-1', channelType: 'discord' });
    // Task with same routing — simulates a scheduled task in a channel session
    getInboundDb()
      .prepare(
        `INSERT INTO messages_in (id, kind, timestamp, status, platform_id, channel_type, content)
         VALUES ('t-task', 'task', datetime('now'), 'pending', 'chan-1', 'discord', ?)`,
      )
      .run(JSON.stringify({ prompt: 'daily check' }));

    const provider = new MockProvider({}, () => '<message to="discord-test">done</message>');
    const controller = new AbortController();
    const loopPromise = runPollLoopWithTimeout(provider, controller.signal, 2000);

    await waitFor(() => getUndeliveredMessages().length > 0, 2000);
    controller.abort();

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(out[0].platform_id).toBe('chan-1');

    await loopPromise.catch(() => {});
  });

});

// Helper: run poll loop until aborted or timeout
async function runPollLoopWithTimeout(provider: MockProvider, signal: AbortSignal, timeoutMs: number): Promise<void> {
  return Promise.race([
    runPollLoop({
      provider,
      providerName: 'mock',
      cwd: '/tmp',
      signal,
    }),
    new Promise<void>((_, reject) => {
      signal.addEventListener('abort', () => reject(new Error('aborted')));
    }),
    new Promise<void>((_, reject) => setTimeout(() => reject(new Error('timeout')), timeoutMs)),
  ]);
}

async function waitFor(condition: () => boolean, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timeout');
    await sleep(50);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('poll loop — exchange hook (onExchangeComplete)', () => {
  // A provider that declares the per-exchange hook. The hook call is the
  // wiring under test — these tests go red if the poll-loop seam is severed.
  // What the provider DOES with an exchange (e.g. write markdown into
  // conversations/) ships with the provider, not the runner.
  class HookedMockProvider extends MockProvider {
    readonly exchanges: ProviderExchange[] = [];
    onExchangeComplete(exchange: ProviderExchange): void {
      this.exchanges.push(exchange);
    }
  }

  it('reports each exchange to a provider that declares the hook', async () => {
    insertMessage('m1', { sender: 'Alice', text: 'please archive this' }, { platformId: 'chan-1', channelType: 'discord' });

    const provider = new HookedMockProvider({}, () => '<message to="discord-test">archived answer</message>');
    const controller = new AbortController();
    const loopPromise = runPollLoopWithTimeout(provider, controller.signal, 2000);

    await waitFor(() => provider.exchanges.length > 0, 2000);
    controller.abort();

    expect(provider.exchanges.length).toBe(1);
    const exchange = provider.exchanges[0];
    expect(exchange.prompt).toContain('please archive this');
    expect(exchange.result).toContain('archived answer');
    expect(exchange.continuation).toStartWith('mock-session-');
    expect(exchange.status).toBe('completed');

    await loopPromise.catch(() => {});
  });

  it('does not report the internal wrapping-retry nudge as a user prompt', async () => {
    insertMessage('m1', { sender: 'Alice', text: 'wrap this later' }, { platformId: 'chan-1', channelType: 'discord' });

    let calls = 0;
    const provider = new HookedMockProvider({}, () => {
      calls += 1;
      // First result is unwrapped (triggers the retry nudge), second is wrapped.
      return calls === 1 ? 'unwrapped text' : '<message to="discord-test">wrapped now</message>';
    });
    const controller = new AbortController();
    const loopPromise = runPollLoopWithTimeout(provider, controller.signal, 3000);

    await waitFor(() => provider.exchanges.length >= 2, 3000);
    controller.abort();

    // Both exchanges attribute themselves to the real user prompt, never the nudge.
    for (const exchange of provider.exchanges) {
      expect(exchange.prompt).not.toContain('Your response was not delivered');
      expect(exchange.prompt).toContain('wrap this later');
    }
    expect(provider.exchanges.map((e) => e.status)).toEqual(['undelivered', 'completed']);

    await loopPromise.catch(() => {});
  });

  it('a throwing hook never breaks delivery', async () => {
    insertMessage('m1', { sender: 'Alice', text: 'still deliver this' }, { platformId: 'chan-1', channelType: 'discord' });

    class ThrowingHookProvider extends MockProvider {
      onExchangeComplete(): void {
        throw new Error('hook exploded');
      }
    }
    const provider = new ThrowingHookProvider({}, () => '<message to="discord-test">delivered anyway</message>');
    const controller = new AbortController();
    const loopPromise = runPollLoopWithTimeout(provider, controller.signal, 2000);

    await waitFor(() => getUndeliveredMessages().length > 0, 2000);
    controller.abort();

    const out = getUndeliveredMessages();
    expect(out.length).toBe(1);
    expect(out[0].content).toContain('delivered anyway');

    await loopPromise.catch(() => {});
  });
});

describe('poll loop — provider error recovery', () => {
  it('writes error to outbound and continues loop on provider throw', async () => {
    insertMessage('m1', { sender: 'Alice', text: 'trigger error' }, { platformId: 'chan-1', channelType: 'discord' });

    const provider = new ThrowingProvider('API rate limit exceeded');
    const controller = new AbortController();
    const loopPromise = runPollLoopWithTimeout(provider as unknown as MockProvider, controller.signal, 2000);

    await waitFor(() => getUndeliveredMessages().length > 0, 2000);
    controller.abort();

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(JSON.parse(out[0].content).text).toContain("couldn't be processed");
    expect(JSON.parse(out[0].content).text).toContain('API rate limit exceeded');

    // Input message should be marked completed despite the error
    const pending = getPendingMessages();
    expect(pending).toHaveLength(0);

    await loopPromise.catch(() => {});
  });
});

describe('poll loop — stale session recovery', () => {
  it('clears continuation when provider reports session invalid', async () => {
    // Pre-seed a continuation so the local variable in runPollLoop is set.
    // Without this, the `if (continuation && isSessionInvalid)` check skips.
    setContinuation('mock', 'pre-existing-session');

    insertMessage('m1', { sender: 'Alice', text: 'stale session' }, { platformId: 'chan-1', channelType: 'discord' });

    const provider = new InvalidSessionProvider();
    const controller = new AbortController();
    const loopPromise = runPollLoopWithTimeout(provider as unknown as MockProvider, controller.signal, 2000);

    await waitFor(() => getUndeliveredMessages().length > 0, 2000);
    controller.abort();

    // Error was written to outbound
    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(JSON.parse(out[0].content).text).toContain("couldn't be processed");

    // The invalid session was cleared (isSessionInvalid returned true). The
    // runner persists each fresh `init` continuation immediately for crash
    // recovery, so after the stale-session retry the active continuation is the
    // new (also-doomed) session id — never the original invalid one, which
    // would itself be cleared on the next turn.
    expect(getContinuation('mock')).not.toBe('pre-existing-session');

    await loopPromise.catch(() => {});
  });
});

describe('poll loop — /clear command', () => {
  it('clears session, writes confirmation, skips query', async () => {
    // Seed a continuation so we can verify it gets cleared
    setContinuation('mock', 'existing-session-id');
    expect(getContinuation('mock')).toBe('existing-session-id');

    // Insert a /clear command
    getInboundDb()
      .prepare(
        `INSERT INTO messages_in (id, kind, timestamp, status, platform_id, channel_type, content)
         VALUES ('m-clear', 'chat', datetime('now'), 'pending', 'chan-1', 'discord', ?)`,
      )
      .run(JSON.stringify({ text: '/clear' }));

    const provider = new MockProvider({}, () => '<message to="discord-test">should not run</message>');
    const controller = new AbortController();
    const loopPromise = runPollLoopWithTimeout(provider, controller.signal, 2000);

    await waitFor(() => getUndeliveredMessages().length > 0, 2000);
    controller.abort();

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(JSON.parse(out[0].content).text).toBe('Session cleared.');

    // Continuation was cleared
    expect(getContinuation('mock')).toBeUndefined();

    // Command message was completed
    const pending = getPendingMessages();
    expect(pending).toHaveLength(0);

    await loopPromise.catch(() => {});
  });
});

/**
 * Provider that throws on every query, simulating API failures.
 */
class ThrowingProvider {
  readonly supportsNativeSlashCommands = false;
  private errorMessage: string;

  constructor(errorMessage: string) {
    this.errorMessage = errorMessage;
  }

  isSessionInvalid(): boolean {
    return false;
  }

  query(_input: { prompt: string; cwd: string }) {
    const errorMessage = this.errorMessage;
    return {
      push() {},
      end() {},
      abort() {},
      events: (async function* () {
        throw new Error(errorMessage);
      })(),
    };
  }
}

/**
 * Provider that throws with an error that triggers isSessionInvalid.
 * First emits an init event (setting continuation), then throws.
 */
class InvalidSessionProvider {
  readonly supportsNativeSlashCommands = false;

  isSessionInvalid(): boolean {
    return true;
  }

  query(_input: { prompt: string; cwd: string }) {
    return {
      push() {},
      end() {},
      abort() {},
      events: (async function* () {
        yield { type: 'init' as const, continuation: 'doomed-session' };
        throw new Error('session not found');
      })(),
    };
  }
}

describe('poll loop — slash command during active query', () => {
  it('aborts the active query when /clear arrives as a follow-up', async () => {
    insertMessage('m-active', { sender: 'Alice', text: 'long running request' }, { platformId: 'chan-1', channelType: 'discord' });

    const provider = new BlockingProvider();
    const controller = new AbortController();
    const loopPromise = runPollLoopWithTimeout(provider as unknown as MockProvider, controller.signal, 3000);

    await waitFor(() => provider.queries === 1, 2000);
    insertMessage('m-clear-active', { sender: 'Alice', text: '/clear' }, { platformId: 'chan-1', channelType: 'discord' });

    await waitFor(() => provider.aborts === 1, 2000);
    await waitFor(
      () => getUndeliveredMessages().some((msg) => JSON.parse(msg.content).text === 'Session cleared.'),
      2000,
    );
    controller.abort();

    expect(provider.ends).toBe(0);
    expect(getContinuation('mock')).toBeUndefined();
    expect(getPendingMessages()).toHaveLength(0);

    await loopPromise.catch(() => {});
  });
});

describe('poll loop — scheduled task during active query', () => {
  it('ends (not aborts) the active query so a due task runs as its own turn', async () => {
    insertMessage('m-active', { sender: 'Alice', text: 'long running request' }, { platformId: 'chan-1', channelType: 'discord' });

    const provider = new BlockingProvider();
    const controller = new AbortController();
    const loopPromise = runPollLoopWithTimeout(provider as unknown as MockProvider, controller.signal, 3000);

    // First turn is now blocking with its query held open.
    await waitFor(() => provider.queries === 1, 2000);

    // A scheduled task fires while that turn is still active. It must NOT be
    // pushed into the live query — doing so contaminates the task with the
    // in-flight conversation (the exact bug: the model treats the task as
    // already-handled and no-ops). The follow-up poll instead ends the
    // stream so the outer loop runs the task as a fresh, isolated turn.
    getInboundDb()
      .prepare(
        `INSERT INTO messages_in (id, kind, timestamp, status, process_after, trigger, platform_id, channel_type, content)
         VALUES ('task-fired', 'task', datetime('now'), 'pending', datetime('now', '-1 minute'), 1, 'chan-1', 'discord', ?)`,
      )
      .run(JSON.stringify({ prompt: 'Send a message to discord-test containing exactly: scheduled msg' }));

    // Graceful end (not abort), and a second query is started for the task.
    await waitFor(() => provider.ends === 1, 2000);
    await waitFor(() => provider.queries === 2, 2000);
    expect(provider.aborts).toBe(0);

    controller.abort();
    await loopPromise.catch(() => {});
  });
});

/**
 * Provider whose query never completes until ended/aborted — for testing how
 * the loop interrupts an active stream.
 */
class BlockingProvider {
  readonly supportsNativeSlashCommands = false;
  queries = 0;
  aborts = 0;
  ends = 0;

  isSessionInvalid(): boolean {
    return false;
  }

  query() {
    const owner = this;
    this.queries += 1;
    let wake: (() => void) | null = null;
    let ended = false;
    let aborted = false;

    return {
      push() {},
      end: () => {
        owner.ends += 1;
        ended = true;
        wake?.();
      },
      abort: () => {
        owner.aborts += 1;
        aborted = true;
        wake?.();
      },
      events: (async function* () {
        yield { type: 'activity' as const };
        yield { type: 'init' as const, continuation: 'blocking-session' };
        while (!ended && !aborted) {
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
          wake = null;
        }
      })(),
    };
  }
}
