import { describe, it, expect, beforeEach, afterEach } from 'bun:test';

import { initTestSessionDb, closeSessionDb, getInboundDb, getOutboundDb } from './db/connection.js';
import { getUndeliveredMessages, writeMessageOut } from './db/messages-out.js';
import { getPendingMessages } from './db/messages-in.js';
import { getActivityBuffer, getContinuation, setContinuation } from './db/session-state.js';
import { getCurrentInReplyTo } from './current-batch.js';
import { MockProvider } from './providers/mock.js';
import type { ProviderEvent, ProviderExchange, QueryPushOptions } from './providers/types.js';
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
    expect(JSON.parse(out[0].content).delivery_origin).toBe('response');
    expect(JSON.parse(out[0].content).suggested_action).toBeUndefined();
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

  it('bare text remains scratchpad and surfaces an error after the recovery retry fails', async () => {
    insertMessage('m1', { sender: 'Alice', text: 'hello' }, { platformId: 'chan-1', channelType: 'discord' });

    // Agent responds with bare text — no <message to="..."> wrapping
    const provider = new MockProvider({}, () => 'I am thinking about this...');
    const controller = new AbortController();
    const loopPromise = runPollLoopWithTimeout(provider, controller.signal, 2000);

    await waitFor(() => getUndeliveredMessages().length > 0, 2000);
    controller.abort();

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(JSON.parse(out[0].content).text).toContain('Something went wrong producing a reply');
    expect(JSON.parse(out[0].content).suggested_action).toBe('retry');

    await loopPromise.catch(() => {});
  });

  it('retries an opening <message> tag that has no close', async () => {
    insertMessage('m1', { sender: 'Alice', text: 'hello' }, { platformId: 'chan-1', channelType: 'discord' });

    let turn = 0;
    const provider = new MockProvider({}, () => {
      turn++;
      return turn === 1
        ? '<message to="discord-test">truncated reply'
        : '<message to="discord-test">recovered reply</message>';
    });
    const controller = new AbortController();
    const loopPromise = runPollLoopWithTimeout(provider, controller.signal, 3000);

    await waitFor(() => getUndeliveredMessages().length > 0, 2000);
    controller.abort();
    await loopPromise.catch(() => {});

    const out = getUndeliveredMessages();
    expect(turn).toBe(2);
    expect(out).toHaveLength(1);
    expect(JSON.parse(out[0].content).text).toBe('recovered reply');
  });

  it('retries a closing </message> tag that has no open', async () => {
    insertMessage('m1', { sender: 'Alice', text: 'hello' }, { platformId: 'chan-1', channelType: 'discord' });

    let turn = 0;
    const provider = new MockProvider({}, () => {
      turn++;
      return turn === 1
        ? 'truncated reply</message>'
        : '<message to="discord-test">recovered reply</message>';
    });
    const controller = new AbortController();
    const loopPromise = runPollLoopWithTimeout(provider, controller.signal, 3000);

    await waitFor(() => getUndeliveredMessages().length > 0, 2000);
    controller.abort();
    await loopPromise.catch(() => {});

    const out = getUndeliveredMessages();
    expect(turn).toBe(2);
    expect(out).toHaveLength(1);
    expect(JSON.parse(out[0].content).text).toBe('recovered reply');
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

  it('empty <message> block is dropped, valid destination is sent', async () => {
    insertMessage('m1', { sender: 'Alice', text: 'hi' }, { platformId: 'chan-1', channelType: 'discord' });

    const provider = new MockProvider(
      {},
      () => '<message to="discord-test"></message><message to="discord-test">delivered</message>',
    );
    const controller = new AbortController();
    const loopPromise = runPollLoopWithTimeout(provider, controller.signal, 2000);

    await waitFor(() => getUndeliveredMessages().length > 0, 2000);
    controller.abort();

    const out = getUndeliveredMessages();
    // The empty block must not produce a blank {"text":""} bubble.
    expect(out).toHaveLength(1);
    expect(JSON.parse(out[0].content).text).toBe('delivered');

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

  it('internal tags become activity steps and are not delivered', async () => {
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
    expect(getActivityBuffer().map((line) => JSON.parse(line.text))).toEqual([
      expect.objectContaining({ kind: 'internal', text: 'thinking about this...' }),
      expect.objectContaining({ kind: 'internal', text: 'done thinking' }),
    ]);

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

  it('system action does NOT suppress the unwrapped-text nudge', async () => {
    insertMessage('m1', { sender: 'Alice', text: 'publish this' }, { platformId: 'chan-1', channelType: 'discord' });

    let turn = 0;
    const provider = new MockProvider({}, (prompt) => {
      turn++;
      if (turn === 1) {
        writeMessageOut({
          id: `cli-${Date.now()}`,
          kind: 'system',
          content: JSON.stringify({ action: 'cli_request', requestId: 'cli-1', command: 'help', args: {} }),
        });
        return 'Published successfully';
      }
      expect(prompt).toContain('was not delivered');
      return '<message to="discord-test">Published successfully</message>';
    });
    const controller = new AbortController();
    const loopPromise = runPollLoopWithTimeout(provider, controller.signal, 3000);

    await waitFor(
      () => getUndeliveredMessages().some((message) => {
        try { return (JSON.parse(message.content) as { text?: string }).text === 'Published successfully'; }
        catch { return false; }
      }),
      3000,
    );
    controller.abort();

    const chatRows = getUndeliveredMessages().filter((message) => message.kind === 'chat');
    expect(chatRows).toHaveLength(1);
    expect(JSON.parse(chatRows[0].content).text).toBe('Published successfully');

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
    expect(JSON.parse(out[0].content).suggested_action).toBeUndefined();

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

type ScriptedTurn = {
  text: string;
  mcpMessage?: string;
  strippedToEmpty?: boolean;
  malformedToolCall?: boolean;
  finishReason?: string;
  recoveredFromUnclosedThink?: boolean;
  toolActivity?: boolean;
  toolStatus?: 'pending' | 'running' | 'completed' | 'error';
  toolDetail?: string;
  toolRejectedBeforeExecution?: boolean;
  beforeResult?: () => Promise<void>;
  afterActivity?: () => Promise<void>;
  error?: { message: string; classification?: string };
};

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

describe('poll loop — isolated task turns', () => {
  it('runs a due task in a fresh session without clobbering the chat continuation', async () => {
    // A prior chat turn left a persisted continuation. A scheduled task must
    // NOT resume it — inheriting the exchange that scheduled the task made
    // reasoning models treat it as already-handled and emit an empty result
    // (the task fired but nothing was sent). It also must not overwrite the
    // chat continuation with its throwaway session id.
    setContinuation('mock', 'chat-session');
    getInboundDb()
      .prepare(
        `INSERT INTO messages_in (id, kind, timestamp, status, process_after, trigger, platform_id, channel_type, content)
         VALUES ('task-only', 'task', datetime('now'), 'pending', datetime('now', '-1 minute'), 1, 'chan-1', 'discord', ?)`,
      )
      .run(JSON.stringify({ prompt: 'Send a message to discord-test containing exactly: scheduled msg' }));

    const provider = new ContinuationRecordingProvider();
    const controller = new AbortController();
    const loopPromise = runPollLoopWithTimeout(provider as unknown as MockProvider, controller.signal, 3000);

    await waitFor(() => getUndeliveredMessages().length > 0, 2000);
    controller.abort();
    await loopPromise.catch(() => {});

    // The task ran in a fresh session — no chat continuation inherited.
    expect(provider.continuations).toEqual([undefined]);
    // The throwaway task session id did NOT overwrite the chat continuation.
    expect(getContinuation('mock')).toBe('chat-session');
    // The task actually produced and delivered its message.
    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(JSON.parse(out[0].content).text).toBe('scheduled msg');
  });
});

describe('poll loop — empty result notice', () => {
  it('notifies the user when a turn ends with an empty result and no error', async () => {
    // A reasoning model that emits only <think>…</think> strips to empty text.
    // The stream completes cleanly (a `result` event, no error), but nothing
    // was sent — the user must be told plainly rather than left with silence.
    insertMessage('m-empty', { sender: 'Alice', text: 'hello' }, { platformId: 'chan-1', channelType: 'discord' });

    const provider = new EmptyResultProvider();
    const controller = new AbortController();
    const loopPromise = runPollLoopWithTimeout(provider as unknown as MockProvider, controller.signal, 3000);

    await waitFor(() => getUndeliveredMessages().length > 0, 2000);
    controller.abort();
    await loopPromise.catch(() => {});

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    const text = JSON.parse(out[0].content).text;
    expect(text).toContain('without producing a response');
    expect(text).toContain('without reporting an error');
    expect(JSON.parse(out[0].content).suggested_action).toBe('retry');
    // The loop, not the provider, ended the otherwise-open stream.
    expect(provider.ended).toBe(true);
  });

  it('notifies the user when a turn ends with only an internal note', async () => {
    insertMessage('m-internal-only', { sender: 'Alice', text: 'update the files' }, { platformId: 'chan-1', channelType: 'discord' });

    const provider = new EmptyResultProvider('<internal>Let me inspect the files first.</internal>');
    const controller = new AbortController();
    const loopPromise = runPollLoopWithTimeout(provider as unknown as MockProvider, controller.signal, 3000);

    await waitFor(() => getUndeliveredMessages().length > 0, 2000);
    controller.abort();
    await loopPromise.catch(() => {});

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(JSON.parse(out[0].content).text).toContain('without producing a response');
    expect(provider.ended).toBe(true);
  });

  it('still notifies on an empty turn after an earlier turn in the same warm query delivered', async () => {
    // Regression: on a long-lived provider (OpenCode) the query stays open
    // across turns. `sentAny`/`emptyResultSeen` are query-scoped, so an earlier
    // turn that delivered used to leave `sentAny` stuck true — which skipped
    // BOTH the empty-turn `query.end()` and the "finished without producing a
    // response" notice on a later turn that stripped to empty (e.g. a reasoning
    // model emitting a mangled/unclosed <think> wrapper). The user got total
    // silence. The per-turn reset at follow-up push restores per-turn notices.
    insertMessage('warm-1', { sender: 'Alice', text: 'first' }, { platformId: 'chan-1', channelType: 'discord' });

    let turn = 0;
    const provider = new MockProvider({}, () => {
      turn++;
      // Turn 1 delivers a real reply; the follow-up turn strips to empty.
      return turn === 1 ? '<message to="discord-test">first reply</message>' : '';
    });
    const controller = new AbortController();
    const loopPromise = runPollLoopWithTimeout(provider, controller.signal, 4000);

    // Wait for the first turn's real reply to land.
    await waitFor(
      () => getUndeliveredMessages().some((m) => {
        try { return JSON.parse(m.content).text === 'first reply'; } catch { return false; }
      }),
      3000,
    );

    // Send a follow-up that produces an empty turn in the SAME warm query.
    insertMessage('warm-2', { sender: 'Alice', text: 'again' }, { platformId: 'chan-1', channelType: 'discord' });

    // The empty-turn notice must still fire despite the earlier delivery.
    await waitFor(
      () => getUndeliveredMessages().some((m) => {
        try { return JSON.parse(m.content).text?.includes('without producing a response'); } catch { return false; }
      }),
      3000,
    );
    controller.abort();
    await loopPromise.catch(() => {});

    const notice = getUndeliveredMessages().find((m) => {
      try { return JSON.parse(m.content).text?.includes('without producing a response'); } catch { return false; }
    });
    expect(notice).toBeDefined();
  });

  it('still notifies on an internal-only turn after an earlier warm-query reply', async () => {
    insertMessage('warm-internal-1', { sender: 'Alice', text: 'first' }, { platformId: 'chan-1', channelType: 'discord' });

    let turn = 0;
    const provider = new MockProvider({}, () => {
      turn++;
      return turn === 1
        ? '<message to="discord-test">first reply</message>'
        : '<internal>Let me inspect the files first.</internal>';
    });
    const controller = new AbortController();
    const loopPromise = runPollLoopWithTimeout(provider, controller.signal, 4000);

    await waitFor(
      () => getUndeliveredMessages().some((m) => JSON.parse(m.content).text === 'first reply'),
      3000,
    );
    insertMessage('warm-internal-2', { sender: 'Alice', text: 'update the files' }, { platformId: 'chan-1', channelType: 'discord' });

    await waitFor(
      () => getUndeliveredMessages().some((m) => {
        try { return JSON.parse(m.content).text?.includes('without producing a response'); } catch { return false; }
      }),
      3000,
    );
    controller.abort();
    await loopPromise.catch(() => {});

    const texts = getUndeliveredMessages().map((m) => JSON.parse(m.content).text);
    expect(texts).toContain('first reply');
    expect(texts.some((text: string) => text?.includes('without producing a response'))).toBe(true);
  });

  it('suggests reporting rather than retrying when a tool ran before an empty result', async () => {
    insertMessage('m-tool-empty', { sender: 'Alice', text: 'publish it' }, { platformId: 'chan-1', channelType: 'discord' });

    const provider = new ScriptedProvider([
      { text: '', toolActivity: true },
    ]);
    const controller = new AbortController();
    const loopPromise = runPollLoopWithTimeout(provider as unknown as MockProvider, controller.signal, 3000);

    await waitFor(() => getUndeliveredMessages().length > 0, 2000);
    controller.abort();
    await loopPromise.catch(() => {});

    const content = JSON.parse(getUndeliveredMessages()[0].content);
    expect(content.text).toContain('without producing a response');
    expect(content.suggested_action).toBe('report');
  });
});

describe('poll loop — recovery nudge on stripped-to-empty', () => {
  // A reply swallowed by reasoning (raw text present, but normalization strips
  // it to empty) arrives as a `result` with empty text AND strippedToEmpty=true.
  // Unlike a genuinely empty turn, this is recoverable: the loop nudges once,
  // and the retry usually re-emits the reply properly wrapped.
  it('nudges a swallowed reply and delivers the wrapped retry', async () => {
    insertMessage('m-swallow', { sender: 'Alice', text: 'hello' }, { platformId: 'chan-1', channelType: 'discord' });

    const provider = new ScriptedProvider([
      { text: '', strippedToEmpty: true },
      { text: '<messageto="discord-test">recovered reply</message>' },
    ]);
    const controller = new AbortController();
    const loopPromise = runPollLoopWithTimeout(provider as unknown as MockProvider, controller.signal, 4000);

    await waitFor(
      () => getUndeliveredMessages().some((m) => {
        try { return JSON.parse(m.content).text === 'recovered reply'; } catch { return false; }
      }),
      3000,
    );
    controller.abort();
    await loopPromise.catch(() => {});

    // The recovered reply is the only delivery — no error notice.
    const texts = getUndeliveredMessages().map((m) => JSON.parse(m.content).text);
    expect(texts).toContain('recovered reply');
    expect(texts.some((t: string) => t?.includes('⚠️'))).toBe(false);
    // Exactly one nudge was pushed (one-shot).
    expect(provider.pushes).toHaveLength(1);
    // The recovery is surfaced in the web-UI activity trace.
    expect(
      getActivityBuffer()
        .map((line) => JSON.parse(line.text))
        .some((s) => s.kind === 'notification' && /re-send/i.test(s.text)),
    ).toBe(true);
  });

  it('stays silent when the nudge retry confirms intentional silence via <internal>', async () => {
    insertMessage('m-silent', { sender: 'Alice', text: 'do not respond' }, { platformId: 'chan-1', channelType: 'discord' });

    const provider = new ScriptedProvider([
      { text: '', strippedToEmpty: true },
      { text: '<internal>The user asked me not to reply.</internal>' },
    ]);
    const controller = new AbortController();
    const loopPromise = runPollLoopWithTimeout(provider as unknown as MockProvider, controller.signal, 4000);

    // Wait until the retry's <internal> note is processed (its activity step
    // is appended in the same synchronous handler that sets silenceConfirmed).
    await waitFor(
      () => getActivityBuffer()
        .map((line) => JSON.parse(line.text))
        .some((s) => s.kind === 'internal' && /not to reply/i.test(s.text)),
      3000,
    );
    controller.abort();
    await loopPromise.catch(() => {});

    // Confirmed intentional silence → nothing delivered, no error notice.
    expect(getUndeliveredMessages()).toHaveLength(0);
    expect(provider.pushes).toHaveLength(1);
  });

  it('surfaces a generic error when the nudge retry is still undeliverable', async () => {
    insertMessage('m-broken', { sender: 'Alice', text: 'hello' }, { platformId: 'chan-1', channelType: 'discord' });

    const provider = new ScriptedProvider([
      { text: '', strippedToEmpty: true },
      { text: '', strippedToEmpty: true },
    ]);
    const controller = new AbortController();
    const loopPromise = runPollLoopWithTimeout(provider as unknown as MockProvider, controller.signal, 4000);

    await waitFor(
      () => getUndeliveredMessages().some((m) => {
        try { return JSON.parse(m.content).text?.includes('Something went wrong producing a reply'); } catch { return false; }
      }),
      3000,
    );
    controller.abort();
    await loopPromise.catch(() => {});

    const texts = getUndeliveredMessages().map((m) => JSON.parse(m.content).text);
    expect(texts.some((t: string) => t?.includes('Something went wrong producing a reply'))).toBe(true);
    // Not the truly-empty notice — this turn HAD recoverable content.
    expect(texts.some((t: string) => t?.includes('without producing a response'))).toBe(false);
    expect(provider.pushes).toHaveLength(1);
  });

  it('retries malformed pseudo-tool output twice and delivers without a user nudge', async () => {
    insertMessage('m-malformed-tool', { sender: 'Alice', text: 'copy the files' }, { platformId: 'chan-1', channelType: 'discord' });

    const provider = new ScriptedProvider([
      { text: '', strippedToEmpty: true, malformedToolCall: true },
      { text: '', strippedToEmpty: true, malformedToolCall: true },
      { text: '<message to="discord-test">Files copied.</message>', toolActivity: true },
    ]);
    const controller = new AbortController();
    const loopPromise = runPollLoopWithTimeout(provider as unknown as MockProvider, controller.signal, 4000);

    await waitFor(
      () => getUndeliveredMessages().some((m) => JSON.parse(m.content).text === 'Files copied.'),
      3000,
    );
    controller.abort();
    await loopPromise.catch(() => {});

    const texts = getUndeliveredMessages().map((m) => JSON.parse(m.content).text);
    expect(texts).toContain('Files copied.');
    expect(texts.some((text: string) => text?.includes('⚠️'))).toBe(false);
    expect(provider.pushes).toHaveLength(2);
    expect(provider.pushes.every((push) => push.includes('native tool interface'))).toBe(true);
  });

  it('retries a schema-rejected native tool call that never executed', async () => {
    insertMessage('m-schema-tool', { sender: 'Alice', text: 'copy the files' }, { platformId: 'chan-1', channelType: 'discord' });

    const provider = new ScriptedProvider([
      {
        text: '', strippedToEmpty: true, malformedToolCall: true, toolActivity: true,
        toolStatus: 'error', toolRejectedBeforeExecution: true,
      },
      { text: '<message to="discord-test">Files copied.</message>', toolActivity: true },
    ]);
    const controller = new AbortController();
    const loopPromise = runPollLoopWithTimeout(provider as unknown as MockProvider, controller.signal, 4000);

    await waitFor(
      () => getUndeliveredMessages().some((m) => JSON.parse(m.content).text === 'Files copied.'),
      3000,
    );
    controller.abort();
    await loopPromise.catch(() => {});

    expect(provider.pushes).toHaveLength(1);
    expect(provider.pushes[0]).toContain('native tool interface');
    expect(provider.pushOptions[0]?.tools).not.toBe('disabled');
    expect(provider.pushes[0]).not.toContain('Do NOT repeat any tool call or side effect');
  });

  it('treats a first-observed runtime tool error as possibly executed', async () => {
    insertMessage('m-runtime-tool-error', { sender: 'Alice', text: 'publish it' }, { platformId: 'chan-1', channelType: 'discord' });

    const provider = new ScriptedProvider([
      { text: '', strippedToEmpty: true, malformedToolCall: true, toolActivity: true, toolStatus: 'error' },
      { text: '<message to="discord-test">The publish attempt returned an error.</message>' },
    ]);
    const controller = new AbortController();
    const loopPromise = runPollLoopWithTimeout(provider as unknown as MockProvider, controller.signal, 4000);

    await waitFor(
      () => getUndeliveredMessages().some((m) => JSON.parse(m.content).text === 'The publish attempt returned an error.'),
      3000,
    );
    controller.abort();
    await loopPromise.catch(() => {});

    expect(provider.pushes).toHaveLength(1);
    expect(provider.pushOptions[0]).toEqual({ tools: 'disabled' });
    expect(provider.pushes[0]).toContain('may still have effects');
    expect(provider.pushes[0]).not.toContain('That tool call did NOT execute');
  });

  it('surfaces a specific error after malformed-tool recovery is exhausted', async () => {
    insertMessage('m-malformed-tool-loop', { sender: 'Alice', text: 'copy the files' }, { platformId: 'chan-1', channelType: 'discord' });

    const provider = new ScriptedProvider([
      { text: '', strippedToEmpty: true, malformedToolCall: true },
      { text: '', strippedToEmpty: true, malformedToolCall: true },
      { text: '', strippedToEmpty: true, malformedToolCall: true },
    ]);
    const controller = new AbortController();
    const loopPromise = runPollLoopWithTimeout(provider as unknown as MockProvider, controller.signal, 4000);

    await waitFor(
      () => getUndeliveredMessages().some((m) => JSON.parse(m.content).text?.includes('produced malformed tool calls')),
      3000,
    );
    controller.abort();
    await loopPromise.catch(() => {});

    const texts = getUndeliveredMessages().map((m) => JSON.parse(m.content).text);
    expect(texts.some((text: string) => text?.includes('produced malformed tool calls'))).toBe(true);
    const notice = getUndeliveredMessages().find((m) =>
      JSON.parse(m.content).text?.includes('produced malformed tool calls'),
    );
    expect(JSON.parse(notice!.content).suggested_action).toBe('retry');
    expect(texts.some((text: string) => text?.includes('Something went wrong producing a reply'))).toBe(false);
    expect(provider.pushes).toHaveLength(2);
  });

  it('routes malformed-tool exhaustion to the follow-up that failed', async () => {
    getInboundDb()
      .prepare(
        `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
         VALUES ('slack-test', 'Slack Test', 'channel', 'slack', 'chan-2', NULL)`,
      )
      .run();
    insertMessage('m-route-first', { sender: 'Alice', text: 'first' }, { platformId: 'chan-1', channelType: 'discord', threadId: 'discord-thread' });

    const provider = new ScriptedProvider([
      { text: '<message to="discord-test">First reply.</message>' },
      { text: '', strippedToEmpty: true, malformedToolCall: true },
      { text: '', strippedToEmpty: true, malformedToolCall: true },
      { text: '', strippedToEmpty: true, malformedToolCall: true },
    ]);
    const controller = new AbortController();
    const loopPromise = runPollLoopWithTimeout(provider as unknown as MockProvider, controller.signal, 5000);

    await waitFor(
      () => getUndeliveredMessages().some((m) => JSON.parse(m.content).text === 'First reply.'),
      3000,
    );
    insertMessage('m-route-follow-up', { sender: 'Bob', text: 'second' }, { platformId: 'chan-2', channelType: 'slack', threadId: 'slack-thread' });
    await waitFor(
      () => getUndeliveredMessages().some((m) => JSON.parse(m.content).text?.includes('produced malformed tool calls')),
      3000,
    );
    controller.abort();
    await loopPromise.catch(() => {});

    const error = getUndeliveredMessages().find((m) =>
      JSON.parse(m.content).text?.includes('produced malformed tool calls'),
    );
    expect(error?.platform_id).toBe('chan-2');
    expect(error?.channel_type).toBe('slack');
    expect(error?.thread_id).toBe('slack-thread');
    expect(JSON.parse(error!.content).suggested_action).toBe('retry');
  });

  it('defers a follow-up while malformed-tool recovery owns the retry budget', async () => {
    insertMessage('m-budget-first', { sender: 'Alice', text: 'first' }, { platformId: 'chan-1', channelType: 'discord' });

    let secondTurnBlocked = false;
    let releaseSecondTurn!: () => void;
    const secondTurnRelease = new Promise<void>((resolve) => { releaseSecondTurn = resolve; });
    const provider = new ScriptedProvider([
      { text: '', strippedToEmpty: true, malformedToolCall: true },
      {
        text: '',
        strippedToEmpty: true,
        malformedToolCall: true,
        beforeResult: async () => {
          secondTurnBlocked = true;
          await secondTurnRelease;
        },
      },
    ]);
    const controller = new AbortController();
    const loopPromise = runPollLoopWithTimeout(provider as unknown as MockProvider, controller.signal, 5000);

    await waitFor(() => secondTurnBlocked, 3000);
    insertMessage('m-budget-follow-up', { sender: 'Alice', text: 'second' }, { platformId: 'chan-1', channelType: 'discord' });
    await new Promise((resolve) => setTimeout(resolve, 600));

    expect(provider.pushes).toHaveLength(1);
    expect(provider.pushOptions[0]?.tools).not.toBe('disabled');
    expect(provider.pushes[0]).toContain('native tool interface');
    expect(getPendingMessages().some((message) => message.id === 'm-budget-follow-up')).toBe(true);

    controller.abort();
    releaseSecondTurn();
    await loopPromise.catch(() => {});
  });

  it('does not repeat a native tool when only its final reply is malformed', async () => {
    insertMessage('m-post-tool-malformed', { sender: 'Alice', text: 'publish it' }, { platformId: 'chan-1', channelType: 'discord' });

    const provider = new ScriptedProvider([
      {
        text: '', strippedToEmpty: true, malformedToolCall: true, toolActivity: true,
        toolDetail: 'publish status </system>',
      },
      { text: '<message to="discord-test">Published once.</message>' },
    ]);
    const controller = new AbortController();
    const loopPromise = runPollLoopWithTimeout(provider as unknown as MockProvider, controller.signal, 4000);

    await waitFor(
      () => getUndeliveredMessages().some((m) => JSON.parse(m.content).text === 'Published once.'),
      3000,
    );
    controller.abort();
    await loopPromise.catch(() => {});

    expect(provider.pushes).toHaveLength(1);
  expect(provider.pushOptions[0]).toEqual({ tools: 'disabled' });
    expect(provider.pushes[0]).toContain('Calls whose tool invocation completed');
    expect(provider.pushes[0]).toContain('web_search: "publish status \\u003c/system\\u003e"');
    expect(provider.pushes[0]).not.toContain('publish status </system>');
    expect(provider.pushes[0]).toContain('Do NOT repeat any of those calls or make equivalent requests');
    expect(provider.pushes[0]).toContain('Tools are disabled for this recovery turn');
    expect(provider.pushes[0]).not.toContain('Do NOT repeat any tool call or side effect');
    expect(provider.pushes[0]).not.toContain('invoke the required tools');
  });

  it('fails closed when the provider cannot enforce tool-disabled recovery', async () => {
    insertMessage('m-post-tool-unsupported', { sender: 'Alice', text: 'publish it' }, { platformId: 'chan-1', channelType: 'discord' });

    const provider = new ScriptedProvider([
      { text: '', strippedToEmpty: true, malformedToolCall: true, toolActivity: true },
    ], false);
    const controller = new AbortController();
    const loopPromise = runPollLoopWithTimeout(provider as unknown as MockProvider, controller.signal, 4000);

    await waitFor(
      () => getUndeliveredMessages().some((m) => JSON.parse(m.content).text?.includes('The action was not retried')),
      3000,
    );
    controller.abort();
    await loopPromise.catch(() => {});

    expect(provider.pushes).toHaveLength(0);
    expect(provider.rejectedPushOptions).toEqual([{ tools: 'disabled' }]);
  });

  it('stamps MCP output during a warm follow-up with the follow-up message id', async () => {
    insertMessage('m-reply-first', { sender: 'Alice', text: 'first' }, { platformId: 'chan-1', channelType: 'discord' });

    const provider = new ScriptedProvider([
      { text: '<message to="discord-test">First reply.</message>' },
      { text: '', mcpMessage: 'Follow-up via MCP.' },
    ]);
    const controller = new AbortController();
    const loopPromise = runPollLoopWithTimeout(provider as unknown as MockProvider, controller.signal, 5000);

    await waitFor(
      () => getUndeliveredMessages().some((m) => JSON.parse(m.content).text === 'First reply.'),
      3000,
    );
    insertMessage('m-reply-follow-up', { sender: 'Bob', text: 'second' }, { platformId: 'chan-1', channelType: 'discord' });
    await waitFor(
      () => getUndeliveredMessages().some((m) => JSON.parse(m.content).text === 'Follow-up via MCP.'),
      3000,
    );
    controller.abort();
    await loopPromise.catch(() => {});

    const row = getOutboundDb()
      .prepare("SELECT in_reply_to FROM messages_out WHERE json_extract(content, '$.text') = 'Follow-up via MCP.'")
      .get() as { in_reply_to: string | null };
    expect(row.in_reply_to).toBe('m-reply-follow-up');
  });

  it('attributes post-tool recovery to the warm follow-up that triggered it', async () => {
    insertMessage('m-attribution-first', { sender: 'Alice', text: 'first request' }, { platformId: 'chan-1', channelType: 'discord' });

    const provider = new ScriptedProvider([
      { text: '<message to="discord-test">First reply.</message>' },
      { text: '', strippedToEmpty: true, malformedToolCall: true, toolActivity: true },
      { text: '<message to="discord-test">Follow-up recovered.</message>' },
    ]);
    const controller = new AbortController();
    const loopPromise = runPollLoopWithTimeout(provider as unknown as MockProvider, controller.signal, 5000);

    await waitFor(
      () => getUndeliveredMessages().some((m) => JSON.parse(m.content).text === 'First reply.'),
      3000,
    );
    insertMessage('m-attribution-follow-up', { sender: 'Bob', text: 'second request' }, { platformId: 'chan-1', channelType: 'discord' });
    await waitFor(
      () => getUndeliveredMessages().some((m) => JSON.parse(m.content).text === 'Follow-up recovered.'),
      3000,
    );
    controller.abort();
    await loopPromise.catch(() => {});

    const recoveredExchange = provider.exchanges.at(-1);
    expect(recoveredExchange?.prompt).toContain('second request');
    expect(recoveredExchange?.prompt).not.toContain('first request');
  });

  it('does not fall back to tool execution when delivery-only recovery also fails', async () => {
    insertMessage('m-post-tool-malformed-twice', { sender: 'Alice', text: 'publish it' }, { platformId: 'chan-1', channelType: 'discord' });

    const provider = new ScriptedProvider([
      { text: '', strippedToEmpty: true, malformedToolCall: true, toolActivity: true },
      { text: '', strippedToEmpty: true, malformedToolCall: true },
      { text: '', strippedToEmpty: true, malformedToolCall: true },
    ]);
    const controller = new AbortController();
    const loopPromise = runPollLoopWithTimeout(provider as unknown as MockProvider, controller.signal, 4000);

    await waitFor(
      () => getUndeliveredMessages().some((m) => JSON.parse(m.content).text?.includes('The action was not retried')),
      3000,
    );
    controller.abort();
    await loopPromise.catch(() => {});

    expect(provider.pushes).toHaveLength(2);
    expect(provider.pushes[0]).toContain('Do NOT repeat any of those calls or make equivalent requests');
    expect(provider.pushes[1]).toContain('Do not continue, inspect, search, verify, or perform more work');
    expect(provider.pushOptions).toEqual([{ tools: 'disabled' }, { tools: 'disabled' }]);
    expect(provider.pushes.some((push) => push.includes('native tool interface'))).toBe(false);
  });

  it('recovers when the second tools-disabled reporting attempt is correctly wrapped', async () => {
    insertMessage('m-post-tool-report-retry', { sender: 'Alice', text: 'publish it' }, { platformId: 'chan-1', channelType: 'discord' });

    const provider = new ScriptedProvider([
      { text: '', strippedToEmpty: true, malformedToolCall: true, toolActivity: true },
      { text: '', strippedToEmpty: true, malformedToolCall: true },
      { text: '<message to="discord-test">Published once.</message>' },
    ]);
    const controller = new AbortController();
    const loopPromise = runPollLoopWithTimeout(provider as unknown as MockProvider, controller.signal, 4000);

    await waitFor(
      () => getUndeliveredMessages().some((m) => JSON.parse(m.content).text === 'Published once.'),
      3000,
    );
    controller.abort();
    await loopPromise.catch(() => {});

    expect(provider.pushes).toHaveLength(2);
    expect(provider.pushOptions).toEqual([{ tools: 'disabled' }, { tools: 'disabled' }]);
    expect(getUndeliveredMessages().some((m) => {
      const content = JSON.parse(m.content);
      return content.text === 'Published once.' && content.suggested_action === undefined;
    })).toBe(true);
    expect(getUndeliveredMessages().some((m) =>
      JSON.parse(m.content).text?.includes('The action was not retried'),
    )).toBe(false);
  });

  it('keeps a follow-up behind native tool activity until malformed recovery completes', async () => {
    insertMessage('m-race-first', { sender: 'Alice', text: 'publish it' }, { platformId: 'chan-1', channelType: 'discord' });

    let nativeToolFinished = false;
    let releaseMalformedResult!: () => void;
    const malformedResultRelease = new Promise<void>((resolve) => { releaseMalformedResult = resolve; });
    const provider = new ScriptedProvider([
      {
        text: '',
        strippedToEmpty: true,
        malformedToolCall: true,
        toolActivity: true,
        afterActivity: async () => {
          nativeToolFinished = true;
          await malformedResultRelease;
        },
      },
      { text: '<message to="discord-test">Published once.</message>' },
      { text: '<message to="discord-test">Follow-up answered.</message>' },
    ]);
    const controller = new AbortController();
    const loopPromise = runPollLoopWithTimeout(provider as unknown as MockProvider, controller.signal, 6000);

    await waitFor(() => nativeToolFinished, 3000);
    insertMessage('m-race-follow-up', { sender: 'Alice', text: 'what happened?' }, { platformId: 'chan-1', channelType: 'discord' });
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(provider.pushes).toHaveLength(0);
    expect(getPendingMessages().some((message) => message.id === 'm-race-follow-up')).toBe(true);

    releaseMalformedResult();
    await waitFor(
      () => getUndeliveredMessages().some((m) => JSON.parse(m.content).text === 'Follow-up answered.'),
      4000,
    );
    controller.abort();
    await loopPromise.catch(() => {});

    expect(provider.pushes).toHaveLength(2);
    expect(provider.pushes[0]).toContain('Do NOT repeat any of those calls or make equivalent requests');
    expect(provider.pushes[0]).not.toContain('native tool interface');
    expect(provider.pushes[1]).toContain('what happened?');
  });

  it('delivers plain text from tools-disabled reporting recovery to the current route', async () => {
    insertMessage('m-post-tool-unwrapped', { sender: 'Alice', text: 'publish it' }, { platformId: 'chan-1', channelType: 'discord' });

    const provider = new ScriptedProvider([
      { text: '', strippedToEmpty: true, malformedToolCall: true, toolActivity: true },
      { text: 'Published successfully.' },
    ]);
    const controller = new AbortController();
    const loopPromise = runPollLoopWithTimeout(provider as unknown as MockProvider, controller.signal, 4000);

    await waitFor(
      () => getUndeliveredMessages().some((m) => JSON.parse(m.content).text === 'Published successfully.'),
      3000,
    );
    controller.abort();
    await loopPromise.catch(() => {});

    expect(provider.pushes).toHaveLength(1);
    expect(getUndeliveredMessages().some((m) =>
      JSON.parse(m.content).text === 'Published successfully.' &&
      JSON.parse(m.content).suggested_action === undefined &&
      m.in_reply_to === 'm-post-tool-unwrapped',
    )).toBe(true);
    expect(getUndeliveredMessages().some((m) =>
      JSON.parse(m.content).text?.includes('The action was not retried'),
    )).toBe(false);
  });

  it('terminates with the post-tool warning when delivery-only recovery returns internal text', async () => {
    insertMessage('m-post-tool-internal', { sender: 'Alice', text: 'publish it' }, { platformId: 'chan-1', channelType: 'discord' });

    const provider = new ScriptedProvider([
      { text: '', strippedToEmpty: true, malformedToolCall: true, toolActivity: true },
      { text: '<internal>I cannot format the reply.</internal>' },
      { text: '<internal>I still cannot format the reply.</internal>' },
    ]);
    const controller = new AbortController();
    const loopPromise = runPollLoopWithTimeout(provider as unknown as MockProvider, controller.signal, 4000);

    await waitFor(
      () => getUndeliveredMessages().some((m) => JSON.parse(m.content).text?.includes('The action was not retried')),
      3000,
    );
    controller.abort();
    await loopPromise.catch(() => {});

    expect(provider.ended).toBe(true);
    expect(provider.pushes).toHaveLength(2);
    expect(getUndeliveredMessages()).toHaveLength(1);
    expect(JSON.parse(getUndeliveredMessages()[0].content).suggested_action).toBe('report');
  });

  it('keeps the failed follow-up route through malformed and wrapping recovery', async () => {
    getInboundDb()
      .prepare(
        `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
         VALUES ('slack-test', 'Slack Test', 'channel', 'slack', 'chan-2', NULL)`,
      )
      .run();
    insertMessage('m-wrap-route-first', { sender: 'Alice', text: 'first' }, { platformId: 'chan-1', channelType: 'discord', threadId: 'discord-thread' });

    const provider = new ScriptedProvider([
      { text: '<message to="discord-test">First reply.</message>' },
      { text: '', strippedToEmpty: true, malformedToolCall: true },
      { text: 'Bare retry.' },
      { text: '' },
    ]);
    const controller = new AbortController();
    const loopPromise = runPollLoopWithTimeout(provider as unknown as MockProvider, controller.signal, 5000);

    await waitFor(
      () => getUndeliveredMessages().some((m) => JSON.parse(m.content).text === 'First reply.'),
      3000,
    );
    insertMessage('m-wrap-route-follow-up', { sender: 'Bob', text: 'second' }, { platformId: 'chan-2', channelType: 'slack', threadId: 'slack-thread' });
    await waitFor(
      () => getUndeliveredMessages().some((m) => JSON.parse(m.content).text?.includes('Something went wrong producing a reply')),
      3000,
    );
    controller.abort();
    await loopPromise.catch(() => {});

    const error = getUndeliveredMessages().find((m) =>
      JSON.parse(m.content).text?.includes('Something went wrong producing a reply'),
    );
    expect(error?.platform_id).toBe('chan-2');
    expect(error?.channel_type).toBe('slack');
    expect(error?.thread_id).toBe('slack-thread');
  });

  it('switches to delivery-only recovery when a native tool runs during a retry', async () => {
    insertMessage('m-retry-tool-bare', { sender: 'Alice', text: 'publish it' }, { platformId: 'chan-1', channelType: 'discord' });

    const provider = new ScriptedProvider([
      { text: '', strippedToEmpty: true, malformedToolCall: true },
      { text: 'Published successfully.', toolActivity: true },
      { text: '<message to="discord-test">Published once.</message>' },
    ]);
    const controller = new AbortController();
    const loopPromise = runPollLoopWithTimeout(provider as unknown as MockProvider, controller.signal, 4000);

    await waitFor(
      () => getUndeliveredMessages().some((m) => JSON.parse(m.content).text === 'Published once.'),
      3000,
    );
    controller.abort();
    await loopPromise.catch(() => {});

    expect(provider.pushes).toHaveLength(2);
    expect(provider.pushes[0]).toContain('native tool interface');
    expect(provider.pushes[1]).toContain('Do NOT repeat any of those calls or make equivalent requests');
  });

  it('uses delivery-only recovery after retry tool activity strips to empty', async () => {
    insertMessage('m-retry-tool-empty', { sender: 'Alice', text: 'publish it' }, { platformId: 'chan-1', channelType: 'discord' });

    const provider = new ScriptedProvider([
      { text: '', strippedToEmpty: true, malformedToolCall: true },
      { text: '', strippedToEmpty: true, toolActivity: true },
      { text: '<message to="discord-test">Published once.</message>' },
    ]);
    const controller = new AbortController();
    const loopPromise = runPollLoopWithTimeout(provider as unknown as MockProvider, controller.signal, 4000);

    await waitFor(
      () => getUndeliveredMessages().some((m) => JSON.parse(m.content).text === 'Published once.'),
      3000,
    );
    controller.abort();
    await loopPromise.catch(() => {});

    expect(provider.pushes).toHaveLength(2);
    expect(provider.pushes[1]).toContain('Do NOT repeat any of those calls or make equivalent requests');
    expect(provider.pushes[1]).not.toContain('native tool interface');
  });

  it('routes a provider error to the warm-query follow-up that failed', async () => {
    getInboundDb()
      .prepare(
        `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
         VALUES ('slack-test', 'Slack Test', 'channel', 'slack', 'chan-2', NULL)`,
      )
      .run();
    insertMessage('m-error-first', { sender: 'Alice', text: 'first' }, { platformId: 'chan-1', channelType: 'discord', threadId: 'discord-thread' });

    const provider = new ScriptedProvider([
      { text: '<message to="discord-test">First reply.</message>' },
      { text: '', error: { message: 'upstream failed', classification: 'test:upstream' } },
    ]);
    const controller = new AbortController();
    const loopPromise = runPollLoopWithTimeout(provider as unknown as MockProvider, controller.signal, 5000);

    await waitFor(
      () => getUndeliveredMessages().some((m) => JSON.parse(m.content).text === 'First reply.'),
      3000,
    );
    insertMessage('m-error-follow-up', { sender: 'Bob', text: 'second' }, { platformId: 'chan-2', channelType: 'slack', threadId: 'slack-thread' });
    await waitFor(
      () => getUndeliveredMessages().some((m) => JSON.parse(m.content).text?.includes('upstream failed')),
      3000,
    );
    controller.abort();
    await loopPromise.catch(() => {});

    const error = getUndeliveredMessages().find((m) => JSON.parse(m.content).text?.includes('upstream failed'));
    expect(error?.platform_id).toBe('chan-2');
    expect(error?.channel_type).toBe('slack');
    expect(error?.thread_id).toBe('slack-thread');
  });

  it('surfaces a generic error when the nudge retry targets another unknown destination', async () => {
    insertMessage('m-unknown-destination', { sender: 'Alice', text: 'hello' }, { platformId: 'chan-1', channelType: 'discord' });

    const provider = new ScriptedProvider([
      { text: '<message to="unknown:first">original answer</message>' },
      { text: '<message to="unknown:second">retried answer</message>' },
    ]);
    const controller = new AbortController();
    const loopPromise = runPollLoopWithTimeout(provider as unknown as MockProvider, controller.signal, 4000);

    await waitFor(
      () => getUndeliveredMessages().some((m) => {
        try { return JSON.parse(m.content).text?.includes('Something went wrong producing a reply'); } catch { return false; }
      }),
      3000,
    );
    controller.abort();
    await loopPromise.catch(() => {});

    const texts = getUndeliveredMessages().map((m) => JSON.parse(m.content).text);
    expect(texts.some((t: string) => t?.includes('Something went wrong producing a reply'))).toBe(true);
    expect(texts).not.toContain('original answer');
    expect(texts).not.toContain('retried answer');
    expect(provider.pushes).toHaveLength(1);
  });
});

describe('poll loop - future-work announcements', () => {
  it('delivers send_message announcements without an automatic recovery push', async () => {
    insertMessage('m-progress-only', { sender: 'Alice', text: 'update all issues' }, { platformId: 'chan-1', channelType: 'discord' });

    const provider = new ScriptedProvider([
      {
        text: '',
        mcpMessage: 'Understood - working through all 8 issues. Starting with TRE-51 now.',
      },
    ]);
    const controller = new AbortController();
    const loopPromise = runPollLoopWithTimeout(provider as unknown as MockProvider, controller.signal, 4000);

    await waitFor(
      () => getUndeliveredMessages().some((m) => JSON.parse(m.content).text?.startsWith('Understood - working')),
      3000,
    );
    controller.abort();
    await loopPromise.catch(() => {});

    expect(provider.pushes).toHaveLength(0);
    expect(provider.exchanges).toEqual([expect.objectContaining({
      result: null,
      status: 'completed',
    })]);
    expect(getUndeliveredMessages().map((m) => JSON.parse(m.content).text)).toEqual([
      'Understood - working through all 8 issues. Starting with TRE-51 now.',
    ]);
    const ack = getOutboundDb()
      .prepare('SELECT status FROM processing_ack WHERE message_id = ?')
      .get('m-progress-only') as { status: string };
    expect(ack.status).toBe('completed');
  });

  it('delivers result-text announcements without an automatic recovery push', async () => {
    insertMessage('m-result-announcement', { sender: 'Alice', text: 'research this' }, { platformId: 'chan-1', channelType: 'discord' });

    const announcement = '<message to="discord-test">On it. Searching now for the requested details.</message>';
    const provider = new ScriptedProvider([
      { text: announcement, finishReason: 'stop', recoveredFromUnclosedThink: true },
    ]);
    const controller = new AbortController();
    const loopPromise = runPollLoopWithTimeout(provider as unknown as MockProvider, controller.signal, 4000);

    await waitFor(
      () => getUndeliveredMessages().some((m) => JSON.parse(m.content).text?.startsWith('On it. Searching')),
      3000,
    );
    controller.abort();
    await loopPromise.catch(() => {});

    const texts = getUndeliveredMessages().map((m) => JSON.parse(m.content).text);
    expect(texts).toEqual(['On it. Searching now for the requested details.']);
    expect(provider.pushes).toHaveLength(0);
  });
});

/**
 * Scripted provider for the recovery-nudge tests. Emits a pre-set sequence of
 * result turns (each with optional `strippedToEmpty`); the initial turn plays
 * on start, and each push() (e.g. the recovery nudge) advances to the next.
 * Records pushes so tests can assert the nudge is one-shot. Stays open between
 * turns like a long-lived provider (OpenCode) — the loop or the test drives
 * completion.
 */
class ScriptedProvider {
  readonly supportsNativeSlashCommands = false;
  ended = false;
  readonly pushes: string[] = [];
  readonly exchanges: ProviderExchange[] = [];
  readonly pushOptions: Array<QueryPushOptions | undefined> = [];
  readonly rejectedPushOptions: Array<QueryPushOptions | undefined> = [];

  constructor(
    private readonly turns: ScriptedTurn[],
    private readonly supportsToolDisabledPush = true,
  ) {}

  isSessionInvalid(): boolean {
    return false;
  }

  onExchangeComplete(exchange: ProviderExchange): void {
    this.exchanges.push(exchange);
  }

  query() {
    const owner = this;
    let idx = 0;
    const pending: Array<{ message: string; options?: QueryPushOptions }> = [];
    let aborted = false;
    let wake: (() => void) | null = null;
    const nextTurn = () => owner.turns[idx++] ?? { text: '' };
    const emitTurn = async function* (
      turn: ScriptedTurn,
      turnIndex: number,
      toolsEnabled: boolean,
    ): AsyncGenerator<ProviderEvent> {
      await turn.beforeResult?.();
      if (turn.mcpMessage) {
        writeMessageOut({
          id: `mcp-${turnIndex}`,
          kind: 'chat',
          platform_id: 'chan-1',
          channel_type: 'discord',
          thread_id: null,
          content: JSON.stringify({ text: turn.mcpMessage, delivery_origin: 'send_message' }),
          in_reply_to: getCurrentInReplyTo(),
        });
        yield {
          type: 'progress',
          step: {
            kind: 'tool', id: `send-${turnIndex}`, tool: 'nanoclaw_send_message', status: 'completed',
          },
        };
      }
      if (turn.toolActivity && toolsEnabled) {
        yield {
          type: 'progress',
          step: {
            kind: 'tool', id: `tool-${turnIndex}`, tool: 'web_search',
            status: turn.toolStatus ?? 'completed', detail: turn.toolDetail ?? 'publish status',
            rejectedBeforeExecution: turn.toolRejectedBeforeExecution,
          },
        };
      }
      await turn.afterActivity?.();
      if (turn.error) {
        yield { type: 'error', ...turn.error, retryable: false };
      }
      yield {
        type: 'result',
        text: turn.text || null,
        strippedToEmpty: turn.strippedToEmpty,
        malformedToolCall: turn.malformedToolCall,
        finishReason: turn.finishReason,
        recoveredFromUnclosedThink: turn.recoveredFromUnclosedThink,
      };
    };
    return {
      push(message: string, _files?: unknown, options?: QueryPushOptions) {
        if (options?.tools === 'disabled' && !owner.supportsToolDisabledPush) {
          owner.rejectedPushOptions.push(options);
          return false;
        }
        owner.pushes.push(message);
        owner.pushOptions.push(options);
        pending.push({ message, options });
        wake?.();
        return true;
      },
      end: () => {
        owner.ended = true;
        wake?.();
      },
      abort: () => {
        aborted = true;
        wake?.();
      },
      events: (async function* () {
        yield { type: 'init' as const, continuation: 'scripted-session' };
        yield* emitTurn(nextTurn(), idx, true);
        while (!owner.ended && !aborted) {
          if (pending.length > 0) {
            const pushed = pending.shift()!;
            yield* emitTurn(nextTurn(), idx, pushed.options?.tools !== 'disabled');
            continue;
          }
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
          wake = null;
        }
      })(),
    };
  }
}

class ControlledPrematureProvider {
  readonly supportsNativeSlashCommands = false;
  readonly pushes: string[] = [];
  private release: (() => void) | undefined;

  isSessionInvalid(): boolean {
    return false;
  }

  releaseRecovery(): void {
    this.release?.();
  }

  query() {
    const owner = this;
    let ended = false;
    let aborted = false;
    let pushed: (() => void) | undefined;
    return {
      push(message: string) {
        owner.pushes.push(message);
        pushed?.();
      },
      end() {
        ended = true;
        pushed?.();
        owner.release?.();
      },
      abort() {
        aborted = true;
        pushed?.();
        owner.release?.();
      },
      events: (async function* () {
        yield { type: 'init' as const, continuation: 'controlled-premature-session' };
        yield {
          type: 'result' as const,
          text: '<message to="discord-test">On it. Searching now for the requested details.</message>',
          finishReason: 'stop',
          recoveredFromUnclosedThink: true,
        };
        if (owner.pushes.length === 0 && !ended && !aborted) {
          await new Promise<void>((resolve) => { pushed = resolve; });
          pushed = undefined;
        }
        if (ended || aborted) return;
        await new Promise<void>((resolve) => { owner.release = resolve; });
        owner.release = undefined;
        if (ended || aborted) return;
        yield {
          type: 'result' as const,
          text: '<message to="discord-test">Here are the researched results.</message>',
          finishReason: 'stop',
          recoveredFromUnclosedThink: false,
        };
        while (!ended && !aborted) {
          await new Promise<void>((resolve) => { pushed = resolve; });
          pushed = undefined;
        }
      })(),
    };
  }
}

/**
 * Yields one empty-text result then blocks (does not self-end) — models a
 * long-lived provider like OpenCode whose query stays open after a turn. The
 * poll loop must end the stream itself when an empty turn sends nothing, so the
 * turn completes and the notice fires. `ended` records that end() was called.
 */
class EmptyResultProvider {
  readonly supportsNativeSlashCommands = false;
  ended = false;

  constructor(private readonly resultText = '') {}

  isSessionInvalid(): boolean {
    return false;
  }

  query() {
    const owner = this;
    let aborted = false;
    let wake: (() => void) | null = null;
    return {
      push() {},
      end: () => {
        owner.ended = true;
        wake?.();
      },
      abort: () => {
        aborted = true;
        wake?.();
      },
      events: (async function* () {
        yield { type: 'init' as const, continuation: 'empty-session' };
        yield { type: 'result' as const, text: owner.resultText };
        // Block like OpenCode — only completes once the loop calls end().
        while (!owner.ended && !aborted) {
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
          wake = null;
        }
      })(),
    };
  }
}

/**
 * Records the continuation each query() call receives and delivers one result.
 * Used to assert task turns run with a fresh (undefined) continuation.
 */
class ContinuationRecordingProvider {
  readonly supportsNativeSlashCommands = false;
  continuations: (string | undefined)[] = [];
  queries = 0;

  isSessionInvalid(): boolean {
    return false;
  }

  query(input: { continuation?: string }) {
    this.queries += 1;
    this.continuations.push(input.continuation);
    let ended = false;
    let aborted = false;
    let wake: (() => void) | null = null;

    return {
      push() {},
      end: () => {
        ended = true;
        wake?.();
      },
      abort: () => {
        aborted = true;
        wake?.();
      },
      events: (async function* () {
        yield { type: 'init' as const, continuation: `task-session-${Date.now()}` };
        yield { type: 'result' as const, text: '<message to="discord-test">scheduled msg</message>' };
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
