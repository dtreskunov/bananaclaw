import { describe, it, expect, beforeEach, afterEach } from 'bun:test';

import { initTestSessionDb, closeSessionDb, getInboundDb, getOutboundDb } from './db/connection.js';
import { getPendingMessages, hasPendingRestart, markCompleted, MAX_TIMER_DELAY_MS, nextPendingDueDelayMs } from './db/messages-in.js';
import { getUndeliveredMessages } from './db/messages-out.js';
import { formatMessages, extractRouting } from './formatter.js';
import {
  friendlyProviderErrorFallback, providerFailureSummary, renderFailedTurnReplay, shouldDeferInteractiveResponse,
} from './poll-loop.js';
import { appendActivity } from './db/session-state.js';
import { beginTurn } from './turn-execution.js';
import { setTurnContext } from './current-batch.js';
import { writeResponseRow } from './query/notices.js';
import { isCorruptionError, isMissingDbError } from './query/follow-up-watcher.js';
import { MockProvider } from './providers/mock.js';

beforeEach(() => {
  initTestSessionDb();
});

afterEach(() => {
  setTurnContext(null);
  closeSessionDb();
});

it.each([
  ['routing-input', 'routing-input'],
  [undefined, 'turn-input'],
  [null, null],
])('writes system responses with reply target %s', (inReplyTo, expected) => {
  const turn = beginTurn({ channelType: 'web', platformId: 'room', threadId: 'thread', inReplyTo: 'turn-input' }, []);
  setTurnContext(turn);
  const id = writeResponseRow(
    { channelType: 'web', platformId: 'room', threadId: 'thread', inReplyTo },
    'Provider error',
    { system_generated: true },
  );
  const row = getUndeliveredMessages()[0];
  expect(row).toMatchObject({ id, turn_id: turn.turnId, in_reply_to: expected,
    channel_type: 'web', platform_id: 'room', thread_id: 'thread' });
  expect(JSON.parse(row.content)).toMatchObject({ text: 'Provider error', delivery_origin: 'response', system_generated: true });
});

describe('future message timing', () => {
  it('ignores completed and future restart instructions', () => {
    insertMessage('wake', 'chat', { text: 'verify' }, { onWake: 1 });
    getInboundDb().prepare("UPDATE messages_in SET seq=2 WHERE id='wake'").run();
    expect(hasPendingRestart()).toBe(true);
    markCompleted(['wake']);
    expect(hasPendingRestart()).toBe(false);
    insertMessage('future-wake', 'chat', { text: 'later' }, {
      onWake: 1, processAfter: new Date(Date.now() + 60_000).toISOString(),
    });
    getInboundDb().prepare("UPDATE messages_in SET seq=4 WHERE id='future-wake'").run();
    expect(hasPendingRestart()).toBe(false);
  });
  it('does not consume an approval arriving after the boot configuration snapshot', () => {
    insertMessage('late-approval', 'chat', { text: 'Verify the new server' }, { onWake: 1 });
    getInboundDb().prepare("UPDATE messages_in SET seq=4 WHERE id='late-approval'").run();
    expect(getPendingMessages(true, { wakeThroughSeq: 2 })).toEqual([]);
    expect(hasPendingRestart(2)).toBe(true);
    expect(getPendingMessages(true, { wakeThroughSeq: 4 }).map((message) => message.id)).toEqual(['late-approval']);
    expect(hasPendingRestart(4)).toBe(false);
  });
  it('caps distant process_after delays below the runtime timeout ceiling', () => {
    const processAfter = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString();
    insertMessage('future', 'task', { prompt: 'later' }, { processAfter });
    expect(nextPendingDueDelayMs()).toBe(MAX_TIMER_DELAY_MS);
  });
});

function insertMessage(
  id: string,
  kind: string,
  content: object,
  opts?: { processAfter?: string; trigger?: 0 | 1; onWake?: 0 | 1 },
) {
  getInboundDb()
    .prepare(
      `INSERT INTO messages_in (id, kind, timestamp, status, process_after, trigger, on_wake, content)
     VALUES (?, ?, datetime('now'), 'pending', ?, ?, ?, ?)`,
    )
    .run(id, kind, opts?.processAfter ?? null, opts?.trigger ?? 1, opts?.onWake ?? 0, JSON.stringify(content));
}

describe('formatter', () => {
  it('should format a single chat message', () => {
    insertMessage('m1', 'chat', { sender: 'John', text: 'Hello world' });
    const messages = getPendingMessages();
    const prompt = formatMessages(messages);
    expect(prompt).toContain('sender="John"');
    expect(prompt).toContain('Hello world');
  });

  it('should format multiple chat messages as distinct <message> blocks', () => {
    insertMessage('m1', 'chat', { sender: 'John', text: 'Hello' });
    insertMessage('m2', 'chat', { sender: 'Jane', text: 'Hi there' });
    const messages = getPendingMessages();
    const prompt = formatMessages(messages);
    // The <messages> envelope was dropped in fe2e881b (#2556) so the SDK calls
    // the API; each message is now its own self-contained <message> block.
    expect(prompt).not.toContain('<messages>');
    expect(prompt.match(/<message /g) ?? []).toHaveLength(2);
    expect(prompt).toContain('sender="John"');
    expect(prompt).toContain('sender="Jane"');
  });

  it('should format task messages', () => {
    insertMessage('m1', 'task', { prompt: 'Review open PRs' });
    const messages = getPendingMessages();
    const prompt = formatMessages(messages);
    expect(prompt).toContain('<task');
    expect(prompt).toContain('Review open PRs');
  });

  it('should format webhook messages', () => {
    insertMessage('m1', 'webhook', { source: 'github', event: 'push', payload: { ref: 'main' } });
    const messages = getPendingMessages();
    const prompt = formatMessages(messages);
    expect(prompt).toContain('<webhook');
    expect(prompt).toContain('source="github"');
    expect(prompt).toContain('event="push"');
  });

  it('should format system messages', () => {
    insertMessage('m1', 'system', { action: 'register_group', status: 'success', result: { id: 'ag-1' } });
    const messages = getPendingMessages();
    const prompt = formatMessages(messages);
    expect(prompt).toContain('<system_response');
    expect(prompt).toContain('action="register_group"');
  });

  it('formats an interactive response as an explicit question response', () => {
    insertMessage('answer-1', 'interactive_response', {
      questionId: 'question-1',
      question: 'Which environment?',
      responseType: 'text',
      value: 'Staging',
    });
    const prompt = formatMessages(getPendingMessages());
    expect(prompt).toContain('<question_response');
    expect(prompt).toContain('question_id="question-1"');
    expect(prompt).toContain('Staging');
  });

  it('defers a fast interactive response until the asking turn ends', () => {
    insertMessage('answer-1', 'interactive_response', { questionId: 'question-1', value: 'A' });
    const messages = getPendingMessages();
    expect(shouldDeferInteractiveResponse(messages, true)).toBe(true);
    expect(shouldDeferInteractiveResponse(messages, false)).toBe(false);
  });

  it('should handle mixed kinds', () => {
    insertMessage('m1', 'chat', { sender: 'John', text: 'Hello' });
    insertMessage('m2', 'system', { action: 'test', status: 'ok', result: null });
    const messages = getPendingMessages();
    const prompt = formatMessages(messages);
    expect(prompt).toContain('sender="John"');
    expect(prompt).toContain('<system_response');
  });

  it('should escape XML in content', () => {
    insertMessage('m1', 'chat', { sender: 'A<B', text: 'x > y && z' });
    const messages = getPendingMessages();
    const prompt = formatMessages(messages);
    expect(prompt).toContain('A&lt;B');
    expect(prompt).toContain('x &gt; y &amp;&amp; z');
  });
});

describe('accumulate gate (trigger column)', () => {
  it('getPendingMessages returns both trigger=0 and trigger=1 rows', () => {
    // trigger=0 rides along as context, trigger=1 is the wake-eligible row.
    // The poll loop's gate depends on this data contract.
    insertMessage('m1', 'chat', { sender: 'A', text: 'chit chat' }, { trigger: 0 });
    insertMessage('m2', 'chat', { sender: 'B', text: 'actual mention' }, { trigger: 1 });
    const messages = getPendingMessages();
    expect(messages).toHaveLength(2);
    const byId = Object.fromEntries(messages.map((m) => [m.id, m]));
    expect(byId.m1.trigger).toBe(0);
    expect(byId.m2.trigger).toBe(1);
  });

  it('trigger=0-only batch: gate predicate `some(trigger===1)` is false', () => {
    insertMessage('m1', 'chat', { sender: 'A', text: 'noise' }, { trigger: 0 });
    insertMessage('m2', 'chat', { sender: 'B', text: 'more noise' }, { trigger: 0 });
    const messages = getPendingMessages();
    // This is the exact predicate the poll loop uses to skip accumulate-only
    // batches — gate should be false, so the loop sleeps without waking the agent.
    expect(messages.some((m) => m.trigger === 1)).toBe(false);
  });

  it('mixed batch: gate is true → loop proceeds, accumulated rows ride along', () => {
    insertMessage('m1', 'chat', { sender: 'A', text: 'earlier chatter' }, { trigger: 0 });
    insertMessage('m2', 'chat', { sender: 'B', text: 'the real mention' }, { trigger: 1 });
    const messages = getPendingMessages();
    expect(messages.some((m) => m.trigger === 1)).toBe(true);
    // Both messages are present for the formatter → agent sees the prior context.
    expect(messages.map((m) => m.id).sort()).toEqual(['m1', 'm2']);
  });

  it('trigger column defaults to 1 for legacy inserts without explicit value', () => {
    // The schema default is 1 (see src/db/schema.ts INBOUND_SCHEMA) — existing
    // rows / tests without the column set are effectively wake-eligible.
    getInboundDb()
      .prepare(
        `INSERT INTO messages_in (id, kind, timestamp, status, content)
         VALUES ('m1', 'chat', datetime('now'), 'pending', '{"text":"hi"}')`,
      )
      .run();
    const [msg] = getPendingMessages();
    expect(msg.trigger).toBe(1);
  });
});

describe('on_wake filtering', () => {
  it('first poll returns on_wake=1 messages', () => {
    insertMessage('m1', 'chat', { sender: 'system', text: 'Resuming.' }, { onWake: 1 });
    const messages = getPendingMessages(true);
    expect(messages).toHaveLength(1);
    expect(messages[0].id).toBe('m1');
  });

  it('subsequent polls skip on_wake=1 messages', () => {
    insertMessage('m1', 'chat', { sender: 'system', text: 'Resuming.' }, { onWake: 1 });
    const messages = getPendingMessages(false);
    expect(messages).toHaveLength(0);
  });

  it('normal messages returned regardless of isFirstPoll', () => {
    insertMessage('m1', 'chat', { sender: 'A', text: 'hello' });
    expect(getPendingMessages(true)).toHaveLength(1);

    // Reset: mark completed so we can re-test with a fresh message
    markCompleted(['m1']);
    insertMessage('m2', 'chat', { sender: 'A', text: 'hello again' });
    expect(getPendingMessages(false)).toHaveLength(1);
  });

  it('mixed batch: first poll returns both normal and on_wake messages', () => {
    insertMessage('m1', 'chat', { sender: 'A', text: 'user msg' });
    insertMessage('m2', 'chat', { sender: 'system', text: 'Resuming.' }, { onWake: 1 });
    const messages = getPendingMessages(true);
    expect(messages).toHaveLength(2);
    expect(messages.map((m) => m.id).sort()).toEqual(['m1', 'm2']);
  });

  it('mixed batch: subsequent poll returns only normal messages', () => {
    insertMessage('m1', 'chat', { sender: 'A', text: 'user msg' });
    insertMessage('m2', 'chat', { sender: 'system', text: 'Resuming.' }, { onWake: 1 });
    const messages = getPendingMessages(false);
    expect(messages).toHaveLength(1);
    expect(messages[0].id).toBe('m1');
  });

  it('on_wake defaults to 0 for inserts without explicit value', () => {
    getInboundDb()
      .prepare(
        `INSERT INTO messages_in (id, kind, timestamp, status, content)
         VALUES ('m1', 'chat', datetime('now'), 'pending', '{"text":"hi"}')`,
      )
      .run();
    // Should be returned even on non-first poll (on_wake=0)
    expect(getPendingMessages(false)).toHaveLength(1);
  });
});

describe('routing', () => {
  it('should extract routing from messages', () => {
    getInboundDb()
      .prepare(
        `INSERT INTO messages_in (id, kind, timestamp, status, platform_id, channel_type, thread_id, content)
       VALUES ('m1', 'chat', datetime('now'), 'pending', 'chan-123', 'discord', 'thread-456', '{"text":"hi"}')`,
      )
      .run();

    const messages = getPendingMessages();
    const routing = extractRouting(messages);
    expect(routing.platformId).toBe('chan-123');
    expect(routing.channelType).toBe('discord');
    expect(routing.threadId).toBe('thread-456');
    expect(routing.inReplyTo).toBe('m1');
  });
});

describe('origin metadata (from= attribute)', () => {
  function seedDestination(name: string, channelType: string, platformId: string): void {
    getInboundDb()
      .prepare(
        `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
         VALUES (?, ?, 'channel', ?, ?, NULL)`,
      )
      .run(name, name, channelType, platformId);
  }

  function insertWithRouting(id: string, kind: string, content: object, channelType: string | null, platformId: string | null): void {
    getInboundDb()
      .prepare(
        `INSERT INTO messages_in (id, kind, timestamp, status, platform_id, channel_type, content)
         VALUES (?, ?, datetime('now'), 'pending', ?, ?, ?)`,
      )
      .run(id, kind, platformId, channelType, JSON.stringify(content));
  }

  it('chat message includes from= when destination matches', () => {
    seedDestination('discord-main', 'discord', 'chan-1');
    insertWithRouting('m1', 'chat', { sender: 'Alice', text: 'hi' }, 'discord', 'chan-1');
    const prompt = formatMessages(getPendingMessages());
    expect(prompt).toContain('from="discord-main"');
  });

  it('chat message falls back to raw routing when no destination matches', () => {
    insertWithRouting('m1', 'chat', { sender: 'Alice', text: 'hi' }, 'telegram', 'chat-999');
    const prompt = formatMessages(getPendingMessages());
    expect(prompt).toContain('from="unknown:telegram:chat-999"');
  });

  it('chat message omits from= when routing is null', () => {
    insertMessage('m1', 'chat', { sender: 'Alice', text: 'hi' });
    const prompt = formatMessages(getPendingMessages());
    expect(prompt).not.toContain('from=');
  });

  it('task message includes from= when destination matches', () => {
    seedDestination('slack-ops', 'slack', 'C-OPS');
    insertWithRouting('t1', 'task', { prompt: 'check status' }, 'slack', 'C-OPS');
    const prompt = formatMessages(getPendingMessages());
    expect(prompt).toContain('<task');
    expect(prompt).toContain('from="slack-ops"');
  });

  it('task message omits from= when routing is null', () => {
    insertMessage('t1', 'task', { prompt: 'check status' });
    const prompt = formatMessages(getPendingMessages());
    expect(prompt).toContain('<task');
    expect(prompt).not.toContain('from=');
  });

  it('webhook message includes from= when destination matches', () => {
    seedDestination('github-ch', 'github', 'repo-1');
    insertWithRouting('w1', 'webhook', { source: 'github', event: 'push', payload: {} }, 'github', 'repo-1');
    const prompt = formatMessages(getPendingMessages());
    expect(prompt).toContain('<webhook');
    expect(prompt).toContain('from="github-ch"');
  });

  it('system message includes from= when destination matches', () => {
    seedDestination('discord-main', 'discord', 'chan-1');
    insertWithRouting('s1', 'system', { action: 'test', status: 'ok', result: null }, 'discord', 'chan-1');
    const prompt = formatMessages(getPendingMessages());
    expect(prompt).toContain('<system_response');
    expect(prompt).toContain('from="discord-main"');
  });
});

describe('mock provider', () => {
  it('should produce init + result events', async () => {
    const provider = new MockProvider({}, (prompt) => `Echo: ${prompt}`);
    const query = provider.query({
      prompt: 'Hello',
      cwd: '/tmp',
    });

    const events: Array<{ type: string }> = [];
    setTimeout(() => query.end(), 50);

    for await (const event of query.events) {
      events.push(event);
    }

    const typed = events.filter((e) => e.type !== 'activity');
    expect(typed.length).toBeGreaterThanOrEqual(2);
    expect(typed[0].type).toBe('init');
    expect(typed[1].type).toBe('result');
    expect((typed[1] as { text: string }).text).toBe('Echo: Hello');
  });

  it('should handle push() during active query', async () => {
    const provider = new MockProvider({}, (prompt) => `Re: ${prompt}`);
    const query = provider.query({
      prompt: 'First',
      cwd: '/tmp',
    });

    const events: Array<{ type: string; text?: string }> = [];

    setTimeout(() => query.push('Second'), 30);
    setTimeout(() => query.end(), 60);

    for await (const event of query.events) {
      events.push(event);
    }

    const results = events.filter((e) => e.type === 'result');
    expect(results).toHaveLength(2);
    expect(results[0].text).toBe('Re: First');
    expect(results[1].text).toBe('Re: Second');
  });
});

describe('end-to-end with mock provider', () => {
  it('should read messages_in, process with mock provider, write messages_out', async () => {
    // Insert a chat message into inbound DB
    insertMessage('m1', 'chat', { sender: 'User', text: 'What is 2+2?' });

    // Read and process
    const messages = getPendingMessages();
    expect(messages).toHaveLength(1);

    const routing = extractRouting(messages);
    const prompt = formatMessages(messages);

    // Create mock provider and run query
    const provider = new MockProvider({}, () => 'The answer is 4');
    const query = provider.query({
      prompt,
      cwd: '/tmp',
    });

    // Process events — simulate what poll-loop does
    const { markProcessing } = await import('./db/messages-in.js');
    const { writeMessageOut } = await import('./db/messages-out.js');

    markProcessing(['m1']);

    setTimeout(() => query.end(), 50);

    for await (const event of query.events) {
      if (event.type === 'result' && event.text) {
        writeMessageOut({
          id: `out-${Date.now()}`,
          in_reply_to: routing.inReplyTo,
          kind: 'chat',
          platform_id: routing.platformId,
          channel_type: routing.channelType,
          thread_id: routing.threadId,
          content: JSON.stringify({ text: event.text }),
        });
      }
    }

    markCompleted(['m1']);

    // Verify: message was processed (not pending, acked in processing_ack)
    const processed = getPendingMessages();
    expect(processed).toHaveLength(0);

    // Verify: response was written to outbound DB
    const outMessages = getUndeliveredMessages();
    expect(outMessages).toHaveLength(1);
    expect(JSON.parse(outMessages[0].content).text).toBe('The answer is 4');
    expect(outMessages[0].in_reply_to).toBe('m1');
  });
});

describe('isCorruptionError', () => {
  it('matches the Docker Desktop macOS torn-read symptom', () => {
    expect(isCorruptionError('database disk image is malformed')).toBe(true);
  });

  it('matches wrapped SQLite corruption codes', () => {
    expect(isCorruptionError('SqliteError: SQLITE_CORRUPT_VTAB: ...')).toBe(true);
    expect(isCorruptionError('file is not a database')).toBe(true);
  });

  it('returns false for unrelated errors', () => {
    expect(isCorruptionError('database is locked')).toBe(false);
    expect(isCorruptionError('no such table: messages_in')).toBe(false);
    expect(isCorruptionError('')).toBe(false);
  });
});

describe('isMissingDbError', () => {
  it('matches the host-deleted-session symptom', () => {
    expect(isMissingDbError('unable to open database file')).toBe(true);
    expect(isMissingDbError('SqliteError: SQLITE_CANTOPEN: unable to open database file')).toBe(true);
    expect(isMissingDbError('ENOENT: no such file or directory, open ...')).toBe(true);
  });

  it('returns false for unrelated errors', () => {
    expect(isMissingDbError('database is locked')).toBe(false);
    expect(isMissingDbError('database disk image is malformed')).toBe(false);
    expect(isMissingDbError('')).toBe(false);
  });
});

describe('friendlyProviderErrorFallback', () => {
  it('extracts message from JSON-formatted error', () => {
    const err = '{"type":"error","message":"Rate limit exceeded","code":429}';
    expect(friendlyProviderErrorFallback(err)).toBe(
      'The turn could not be completed: "Rate limit exceeded". No final response was produced.',
    );
  });

  it('surfaces short plain-text errors directly', () => {
    const err = 'Budget limit exceeded (weekly limit). Contact your org admin.';
    expect(friendlyProviderErrorFallback(err)).toBe(
      `The turn could not be completed: "${err}". No final response was produced.`,
    );
  });

  it('falls back to generic message for long errors', () => {
    const err = 'x'.repeat(201);
    expect(friendlyProviderErrorFallback(err)).toBe(
      "The turn could not be completed due to a provider error. No final response was produced.",
    );
  });

  it('falls back to generic message for JSON blobs without "message" key', () => {
    const err = '{"error": {"type": "server_error", "details": "something broke internally"}}';
    expect(friendlyProviderErrorFallback(err)).toBe(
      "The turn could not be completed due to a provider error. No final response was produced.",
    );
  });

  it('falls back to generic message for stack traces', () => {
    const err = 'TypeError: Cannot read properties\n    at Object.<anonymous> (file.js:1:1)';
    expect(friendlyProviderErrorFallback(err)).toBe(
      "The turn could not be completed due to a provider error. No final response was produced.",
    );
  });

  describe('partial-work failure notices', () => {
    function turn() {
      return beginTurn({ channelType: 'web', platformId: 'room', threadId: 'thread', inReplyTo: 'input' }, []);
    }

    it('does not claim that a turn without recorded tools was unprocessed', () => {
      expect(providerFailureSummary(turn().turnId, 'native')).toBe('The turn did not finish. No final response was produced.');
    });

    it('preserves native completed actions in direct and fallback notices', () => {
      const current = turn();
      appendActivity({ kind: 'tool', id: 'write', tool: 'write', status: 'completed' });
      const note = providerFailureSummary(current.turnId, 'native');
      expect(note).toContain('Completed tool actions remain in the conversation');
      expect(friendlyProviderErrorFallback('context overflow', note)).toContain(note);
      expect(providerFailureSummary(current.turnId, 'claude')).toContain('may already have run');
    });

    it('keeps interrupted outcomes uncertain', () => {
      const current = turn();
      appendActivity({ kind: 'tool', id: 'write', tool: 'write', status: 'running' });
      expect(providerFailureSummary(current.turnId, 'native')).toContain('may already have run');
      expect(providerFailureSummary(current.turnId, 'native')).not.toContain('Completed tool actions');
    });

    it('does not attribute another turn to the failed turn', () => {
      const prior = turn();
      appendActivity({ kind: 'tool', id: 'prior-write', tool: 'write', status: 'completed' });
      const current = turn();
      expect(providerFailureSummary(current.turnId, 'native')).not.toContain('Completed tool actions');
      expect(providerFailureSummary(prior.turnId, 'native')).toContain('Completed tool actions');
    });

    it('replays failures without telling the agent to repeat completed actions', () => {
      const replay = renderFailedTurnReplay({
        prompt: 'Fix the page', error: 'context overflow', recorded_at: 0,
        execution_note: 'The file edit completed.',
      });
      expect(replay).toContain('<previous_user_request>');
      expect(replay).toContain('The file edit completed.');
      expect(replay).toContain('complete only unfinished work');
      expect(replay).not.toContain('user_message_that_was_not_processed');
      const legacy = renderFailedTurnReplay({ prompt: 'Fix the page', error: 'context overflow', recorded_at: 0 });
      expect(legacy).toContain('Some tool actions may already have run');
    });
  });
});
