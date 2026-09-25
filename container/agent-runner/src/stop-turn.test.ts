import { afterEach, beforeEach, expect, it, spyOn } from 'bun:test';
import { closeSessionDb, getInboundDb, getOutboundDb, initTestSessionDb } from './db/connection.js';
import { getPendingMessages } from './db/messages-in.js';
import { writeMessageOut } from './db/messages-out.js';
import { getContinuation, getFailedTurn, setContinuation } from './db/session-state.js';
import { runPollLoop } from './poll-loop.js';
import type { AgentProvider, ProviderEvent, QueryInput } from './providers/types.js';
import { MockProvider } from './providers/mock.js';
import { loadConfig, setConfigForTest } from './config.js';
import * as link from './session-link.js';

const sleep = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(test: () => boolean) {
  for (let i = 0; i < 200; i++) {
    if (test()) return;
    await sleep();
  }
  throw new Error('Condition timed out');
}

beforeEach(() => initTestSessionDb());
afterEach(() => {
  link.resetHostEventsForTesting();
  closeSessionDb();
});

function insert(id: string) {
  getInboundDb()
    .prepare(
      `INSERT INTO messages_in
    (id, kind, timestamp, status, channel_type, platform_id, content)
    VALUES (?, 'chat', datetime('now'), 'pending', 'web', 'chat-1', ?)`,
    )
    .run(id, JSON.stringify({ text: id }));
  link.emitHostEventForTesting();
}

it.each(['none', 'calls', 'final', 'recovery'] as const)('persists elapsed time, model and truthful %s usage on Stop', async (usageMode) => {
  const config = loadConfig();
  setConfigForTest({ model: 'configured-model' });
  const controller = new AbortController();
  let active: link.ActiveTurn | null = null;
  const publish = spyOn(link, 'signalTurnState').mockImplementation((state) => { active = state; });
  let settle!: () => void;
  const waiting = new Promise<void>((resolve) => { settle = resolve; });
  const data = {
    model: 'reported-model', input_tokens: 11, output_tokens: 2,
    cache_read_tokens: 0, cache_write_tokens: 0, cost_usd: 0.001,
  };
  const provider: AgentProvider = {
    supportsNativeSlashCommands: false,
    isSessionInvalid: () => false,
    query: () => ({
      push: () => false, end() {}, abort: settle,
      events: (async function* (): AsyncGenerator<ProviderEvent> {
        yield { type: 'init', continuation: 'stats-session' };
        await waiting;
        if (usageMode === 'calls') {
          yield { type: 'usage_call', data };
          yield { type: 'usage_call', data };
        } else if (usageMode === 'final' || usageMode === 'recovery') {
          yield { type: 'usage_call', data };
          yield { type: 'usage', data: { ...data, duration_ms: 999999 } };
          if (usageMode === 'recovery') yield { type: 'usage_call', data };
        }
      })(),
    }),
  };
  insert('stats-input');
  const loop = runPollLoop({ provider, providerName: 'stats-stop', cwd: process.cwd(), signal: controller.signal });
  try {
    await until(() => active !== null);
    await sleep(20);
    link.requestTurnStop(active!.id);
    await until(() => active === null);
    const row = getOutboundDb().prepare('SELECT id, content FROM messages_out').get() as { id: string; content: string };
    const stats = JSON.parse(row.content).stopped_stats;
    expect(stats.model).toBe(usageMode === 'none' ? 'configured-model' : 'reported-model');
    expect(stats.durationMs).toBeGreaterThanOrEqual(20);
    expect(stats.durationMs).toBeLessThan(999999);
    const usage = getOutboundDb().prepare('SELECT * FROM turn_usage WHERE message_out_id = ?').get(row.id);
    if (usageMode === 'none') expect(usage).toBeNull();
    else expect(usage).toMatchObject({
      model: 'reported-model',
      duration_ms: stats.durationMs,
      input_tokens: usageMode === 'calls' || usageMode === 'recovery' ? 22 : 11,
      output_tokens: usageMode === 'calls' || usageMode === 'recovery' ? 4 : 2,
    });
  } finally {
    settle();
    controller.abort();
    await loop;
    publish.mockRestore();
    setConfigForTest(config);
  }
});

it('stops only the matching active turn, waits for settlement, preserves queue and continuation without replay', async () => {
  const states: Array<link.ActiveTurn | null> = [];
  const publish = spyOn(link, 'signalTurnState').mockImplementation((state) => states.push(state));
  const controller = new AbortController();
  const prompts: QueryInput[] = [];
  let aborts = 0;
  let release!: () => void;
  const settled = new Promise<void>((resolve) => {
    release = resolve;
  });
  let acknowledge!: () => void;
  const committed = new Promise<void>((resolve) => {
    acknowledge = resolve;
  });
  const drain = spyOn(link, 'drainSessionJournal').mockImplementation(() => committed);
  const provider: AgentProvider = {
    supportsNativeSlashCommands: false,
    isSessionInvalid: () => true,
    query(input) {
      prompts.push(input);
      const first = prompts.length === 1;
      return {
        push: () => false,
        end() {},
        abort() {
          aborts++;
        },
        events: (async function* (): AsyncGenerator<ProviderEvent> {
          if (!first) {
            controller.abort();
            return;
          }
          yield { type: 'init', continuation: 'valid-partial-session' };
          yield { type: 'progress', step: { kind: 'tool', id: 'done', tool: 'write', status: 'completed' } };
          yield { type: 'progress', step: { kind: 'tool', id: 'unknown', tool: 'bash', status: 'running' } };
          await settled;
          yield { type: 'checkpoint', ref: 'partial-checkpoint' };
          yield { type: 'result', text: 'must not deliver or retry this' };
          throw new Error('cancelled session, not an invalid session');
        })(),
      };
    },
  };
  setContinuation('stop-test', 'old-session');
  insert('cancelled-input');
  const loop = runPollLoop({ provider, providerName: 'stop-test', cwd: process.cwd(), signal: controller.signal });
  try {
    await until(() => getContinuation('stop-test') === 'valid-partial-session');
    const running = states.find((s) => s?.status === 'running')!;
    insert('queued-input');
    link.requestTurnStop('stale-id');
    expect(aborts).toBe(0);
    link.requestTurnStop(running.id);
    link.requestTurnStop(running.id);
    expect(aborts).toBe(1);
    expect(states.at(-1)?.status).toBe('stopping');
    expect(getPendingMessages().map((m) => m.id)).toEqual(['queued-input']);
    expect(getOutboundDb().prepare('SELECT COUNT(*) AS n FROM messages_out').get()).toEqual({ n: 0 });
    release();
    await until(
      () => (getOutboundDb().prepare('SELECT COUNT(*) AS n FROM messages_out').get() as { n: number }).n === 1,
    );
    expect(states.at(-1)?.status).toBe('stopping');
    expect(prompts).toHaveLength(1);
    expect(getPendingMessages().map((m) => m.id)).toEqual(['queued-input']);
    acknowledge();
    await loop;
    const rows = getOutboundDb().prepare('SELECT id, content FROM messages_out').all() as {
      id: string;
      content: string;
    }[];
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0].content)).toMatchObject({ text: 'Stopped by user.', stopped: true, turn_id: running.id });
    const activity = getOutboundDb().prepare('SELECT text FROM turn_activity WHERE message_out_id = ?').all(rows[0].id);
    expect(JSON.stringify(activity)).toContain('completed');
    expect(JSON.stringify(activity)).toContain('outcome unknown');
    expect(JSON.stringify(activity)).toContain('interrupted');
    expect(getOutboundDb().prepare(
      'SELECT provider, continuation, provider_turn_ref FROM turn_checkpoints WHERE message_out_id = ?',
    ).get(rows[0].id)).toEqual({
      provider: 'stop-test', continuation: 'valid-partial-session', provider_turn_ref: 'partial-checkpoint',
    });
    expect(prompts).toHaveLength(2);
    expect(prompts[1].prompt).toContain('queued-input');
    expect(prompts[1].prompt).not.toContain('cancelled-input');
    expect(prompts[1].continuation).toBe('valid-partial-session');
    expect(getFailedTurn()).toBeUndefined();
    expect(states.at(-1)).toBeNull();
    expect(new Set(states.filter((s) => s?.status === 'running').map((s) => s!.id)).size).toBe(2);
  } finally {
    release();
    acknowledge();
    controller.abort();
    await loop;
    publish.mockRestore();
    drain.mockRestore();
  }
});

it('assigns a new ID to a warm follow-up and rejects the prior completed turn ID', async () => {
  const states: Array<link.ActiveTurn | null> = [];
  const publish = spyOn(link, 'signalTurnState').mockImplementation((state) => states.push(state));
  const controller = new AbortController();
  let aborts = 0;
  let queries = 0;
  class WarmProvider extends MockProvider {
    override query(input: QueryInput) {
      queries++;
      const query = super.query(input);
      const abort = query.abort.bind(query);
      query.abort = () => {
        aborts++;
        abort();
      };
      return query;
    }
  }
  getInboundDb()
    .prepare(
      `INSERT INTO destinations (name, display_name, type, channel_type, platform_id)
    VALUES ('web', 'web', 'channel', 'web', 'chat-1')`,
    )
    .run();
  const provider = new WarmProvider({}, (prompt) => {
    if (prompt.includes('follow-up')) {
      const running = states.filter((state) => state?.status === 'running');
      link.requestTurnStop(running[0]!.id);
      expect(aborts).toBe(0);
      link.requestTurnStop(running.at(-1)!.id);
    }
    return '<message to="web">first completed</message>';
  });

  insert('first');
  const loop = runPollLoop({ provider, providerName: 'warm-stop', cwd: process.cwd(), signal: controller.signal });
  try {
    await until(() => states.includes(null));
    insert('follow-up');
    await until(
      () => (getOutboundDb().prepare('SELECT COUNT(*) AS n FROM messages_out').get() as { n: number }).n === 2,
    );
    expect(queries).toBe(1);
    expect(aborts).toBe(1);
    const running = states.filter((state) => state?.status === 'running');
    expect(running).toHaveLength(2);
    expect(running[0]!.id).not.toBe(running[1]!.id);
  } finally {
    controller.abort();
    await loop;
    publish.mockRestore();
  }
});

it('persists Stop without changing an existing question card', async () => {
  const states: Array<link.ActiveTurn | null> = [];
  const publish = spyOn(link, 'signalTurnState').mockImplementation((state) => states.push(state));
  const controller = new AbortController();
  let settle!: () => void;
  const waiting = new Promise<void>((resolve) => {
    settle = resolve;
  });
  const provider: AgentProvider = {
    supportsNativeSlashCommands: false,
    isSessionInvalid: () => false,
    query() {
      return {
        push: () => false,
        end() {},
        abort: settle,
        events: (async function* (): AsyncGenerator<ProviderEvent> {
          yield { type: 'init', continuation: 'question-session' };
          writeMessageOut({
            id: 'question-row',
            kind: 'chat-sdk',
            channel_type: 'web',
            platform_id: 'chat-1',
            content: JSON.stringify({
              type: 'ask_question',
              questionId: 'question-id',
              responseMode: 'text',
              question: 'Which?',
            }),
          });
          await waiting;
        })(),
      };
    },
  };
  insert('asking-turn');
  const loop = runPollLoop({ provider, providerName: 'questions-stop', cwd: process.cwd(), signal: controller.signal });
  try {
    await until(() => !!getOutboundDb().prepare("SELECT id FROM messages_out WHERE id = 'question-row'").get());
    link.requestTurnStop(states.find((state) => state?.status === 'running')!.id);
    await until(
      () => (getOutboundDb().prepare('SELECT COUNT(*) AS n FROM messages_out').get() as { n: number }).n === 2,
    );
    const journal = getOutboundDb()
      .prepare("SELECT payload FROM pending_runner_events WHERE event_type = 'message.upsert' ORDER BY sequence")
      .all() as Array<{ payload: string }>;
    expect(journal).toHaveLength(2);
    const original = JSON.parse(journal[0].payload);
    const stopped = JSON.parse(journal[1].payload);
    const originalContent = JSON.parse(original.content);
    const stoppedContent = JSON.parse(stopped.content);
    const activeTurnId = states.find((state) => state?.status === 'running')!.id;
    expect(original.id).toBe('question-row');
    expect(originalContent.cancelled).toBeUndefined();
    expect(originalContent.turn_id).toBeUndefined();
    expect(stoppedContent.turn_id).toBe(activeTurnId);
    expect(stopped.id).not.toBe(original.id);
    expect(stopped.seq).toBeGreaterThan(original.seq);
    expect(stoppedContent).toMatchObject({
      text: 'Stopped by user.',
      stopped: true,
    });
    expect(stoppedContent.cancelled_question_ids).toBeUndefined();
  } finally {
    settle();
    controller.abort();
    await loop;
    publish.mockRestore();
  }
});
