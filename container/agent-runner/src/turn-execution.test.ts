import { afterEach, beforeEach, expect, it } from 'bun:test';
import { initTestSessionDb, getInboundDb, getOutboundDb, closeSessionDb } from './db/connection.js';
import { appendActivity, getContinuation, setContinuation } from './db/session-state.js';
import { getTurn } from './db/turns.js';
import { getTurnContext } from './current-batch.js';
import { beginTurn, completeUsageAttempt, finishUsageAttempt, recordCallUsage, settleTurn } from './turn-execution.js';
import { runPollLoop } from './poll-loop.js';
import { requestTurnStop, resetHostEventsForTesting } from './session-link.js';
import { invokeRegisteredTool, registerTools, unregisterTool } from './mcp-tools/tool-registry.js';
import { writeMessageOut } from './db/messages-out.js';
import type { ActivityStep, AgentProvider, ProviderEvent, QueryInput } from './providers/types.js';

const route = { channelType: 'web', platformId: 'room', threadId: 'thread', inReplyTo: 'input' };
const usage = { cost_usd: 0.25, input_tokens: 12, output_tokens: 3, cache_read_tokens: 0, cache_write_tokens: 0, model: 'model' };
beforeEach(() => {
  initTestSessionDb();
  getInboundDb().exec("INSERT INTO destinations (name, type, channel_type, platform_id) VALUES ('web', 'channel', 'web', 'room')");
});
afterEach(() => { resetHostEventsForTesting(); closeSessionDb(); });

function input() {
  getInboundDb().exec(`INSERT INTO messages_in (id, seq, kind, timestamp, content, channel_type, platform_id, thread_id)
    VALUES ('input', 2, 'chat', 'now', '{"text":"hello"}', 'web', 'room', 'thread')`);
}
async function until(predicate: () => boolean) {
  for (let n = 0; n < 300; n++) {
    if (predicate()) return;
    await Bun.sleep(5);
  }
  throw new Error('turn did not settle');
}
function provider(events: () => AsyncGenerator<ProviderEvent>): AgentProvider {
  return { supportsNativeSlashCommands: false, isSessionInvalid: () => false,
    query: () => ({ events: events(), push: () => true, end: () => {}, abort: () => {} }) };
}
function metadata(id: string) {
  return JSON.parse((getOutboundDb().prepare('SELECT value FROM session_state WHERE key = ?')
    .get(`turn-metadata:${id}`) as { value: string }).value);
}

function activitySteps(): ActivityStep[] {
  const rows = getOutboundDb().prepare('SELECT text FROM turn_activity ORDER BY ordinal')
    .all() as Array<{ text: string }>;
  return rows.map(({ text }) => JSON.parse(text) as ActivityStep);
}

function expectOutputBeforeSettlement(): void {
  const events = getOutboundDb().prepare('SELECT sequence, event_type, payload FROM pending_runner_events ORDER BY sequence')
    .all() as Array<{ sequence: number; event_type: string; payload: string }>;
  const settled = events.find((event) => event.event_type === 'turn.upsert' && JSON.parse(event.payload).phase === 'settled');
  expect(settled).toBeDefined();
  if (!settled) throw new Error('Turn was not settled');
  expect(JSON.parse(settled.payload).outcome).toBe('failed');
  expect(events.filter((event) => ['activity.persist', 'message.upsert', 'usage.persist'].includes(event.event_type))
    .every((event) => event.sequence < settled.sequence)).toBe(true);
}

it('persists every call\'s model time across retries', async () => {
  const turn = beginTurn(route, []);
  recordCallUsage(turn, { ...usage, duration_api_ms: 100 });
  finishUsageAttempt(turn);
  recordCallUsage(turn, { ...usage, duration_api_ms: 200 });
  recordCallUsage(turn, { ...usage, duration_api_ms: 300 });
  completeUsageAttempt(turn);
  await settleTurn(turn, 'silent');
  expect(getOutboundDb().prepare('SELECT duration_api_ms, num_turns FROM turn_usage WHERE turn_id = ?').get(turn.turnId))
    .toEqual({ duration_api_ms: 600, num_turns: 3 });
  expect(metadata(turn.turnId)).toMatchObject({ status: 'partial', final: true });
});

it('preserves main-model occupancy and billed summary calls in failed-turn partial accounting', async () => {
  const turn = beginTurn(route, []);
  recordCallUsage(turn, { ...usage, context_tokens: 786_376, context_window: 1_000_000, duration_api_ms: 100 });
  recordCallUsage(turn, { ...usage, input_tokens: 900_000, context_tokens: undefined,
    context_window: 1_000_000, duration_api_ms: 200 });
  finishUsageAttempt(turn);
  await settleTurn(turn, 'failed');
  expect(getOutboundDb().prepare(
    'SELECT input_tokens, context_tokens, duration_api_ms, num_turns FROM turn_usage WHERE turn_id = ?',
  ).get(turn.turnId)).toEqual({ input_tokens: 900_012, context_tokens: 786_376, duration_api_ms: 300, num_turns: 2 });
  expect(metadata(turn.turnId)).toMatchObject({ status: 'partial', final: true });
});

it('reports completed native tool work when the turn fails before its final answer', async () => {
  input();
  const controller = new AbortController();
  const loop = runPollLoop({ provider: provider(async function* () {
    yield { type: 'progress', step: { kind: 'tool', id: 'write-once', tool: 'write', status: 'completed' } };
    yield { type: 'error', message: 'context recovery failed', retryable: false };
  }), providerName: 'native', cwd: process.cwd(), signal: controller.signal });
  try {
    await until(() => !!getOutboundDb().prepare("SELECT 1 FROM turns WHERE phase='settled'").get());
    const output = getOutboundDb().prepare('SELECT content FROM messages_out ORDER BY seq DESC LIMIT 1')
      .get() as { content: string };
    expect(JSON.parse(output.content).text).toContain('Completed tool actions remain in the conversation');
    expect(JSON.parse(output.content).text).not.toContain('Your message was not processed');
  } finally { controller.abort(); await loop; }
});

it.each([
  { name: 'success', events: [{ type: 'result', text: '<message to="web">answer</message>' }], outcome: 'replied' },
  { name: 'empty warning', events: [{ type: 'result', text: '' }], outcome: 'warning' },
  { name: 'intentional silence', events: [{ type: 'result', text: 'unwrapped' },
    { type: 'result', text: '<internal>No response needed.</internal>' }], outcome: 'silent' },
  { name: 'provider error', events: [{ type: 'error', message: 'failed', retryable: false }], outcome: 'failed' },
  { name: 'outputless interruption', events: [{ type: 'activity' }], outcome: 'interrupted' },
])('persists $name as $outcome with unavailable rather than invented usage', async ({ events, outcome }) => {
  input();
  const controller = new AbortController();
  const loop = runPollLoop({ provider: provider(async function* () { yield* events as ProviderEvent[]; }),
    providerName: 'test', cwd: process.cwd(), signal: controller.signal });
  try {
    await until(() => !!getOutboundDb().prepare("SELECT 1 FROM turns WHERE phase='settled'").get());
    const turn = getOutboundDb().prepare('SELECT * FROM turns').get() as { id: string; outcome: string; ended_at: string };
    expect(turn.outcome).toBe(outcome);
    expect(turn.ended_at).toBeTruthy();
    expect(metadata(turn.id)).toMatchObject({ final: true, status: 'unavailable', usageId: null });
    expect(getOutboundDb().prepare('SELECT COUNT(*) AS n FROM turn_usage').get()).toEqual({ n: 0 });
    const rows = getOutboundDb().prepare('SELECT sequence, event_type, payload FROM pending_runner_events ORDER BY sequence')
      .all() as Array<{ sequence: number; event_type: string; payload: string }>;
    const final = rows.find((row) => row.event_type === 'turn.upsert' && JSON.parse(row.payload).phase === 'settled')!;
    expect(rows.filter((row) => ['message.upsert', 'activity.persist', 'usage.persist'].includes(row.event_type))
      .every((row) => row.sequence < final.sequence)).toBe(true);
    if (outcome === 'failed') {
      expect(activitySteps()).toEqual([
        expect.objectContaining({ kind: 'notification', text: 'Provider request failed', detail: 'failed' }),
      ]);
    }
  } finally { controller.abort(); await loop; }
});

it('records provider construction failures and fallback output on one failed turn', async () => {
  input();
  const controller = new AbortController();
  const failing: AgentProvider = { ...provider(async function* () {}), query() { throw new Error('constructor failed'); } };
  const loop = runPollLoop({ provider: failing, providerName: 'test', cwd: process.cwd(), signal: controller.signal });
  try {
    await until(() => !!getOutboundDb().prepare("SELECT 1 FROM turns WHERE outcome='failed'").get());
    expect(getOutboundDb().prepare('SELECT COUNT(*) AS n FROM turns').get()).toEqual({ n: 1 });
    expect(getOutboundDb().prepare('SELECT COUNT(*) AS n FROM messages_out WHERE turn_id IS NOT NULL').get()).toEqual({ n: 1 });
    expect(activitySteps().filter((step) => step.kind === 'notification').map((step) => step.text)).toEqual([
      'Provider request failed',
      'Asking model to explain failure',
      'Failure explanation unavailable',
      'Error notice recorded',
    ]);
  } finally { controller.abort(); await loop; }
});

it('records a model-handled failure on the original turn without losing activity, usage or continuation', async () => {
  input();
  setContinuation('test', 'good-session');
  let attempts = 0;
  const inputs: QueryInput[] = [];
  const p = provider(async function* () {
    if (++attempts === 1) {
      yield { type: 'init', continuation: 'incomplete-session' };
      appendActivity({ kind: 'tool', id: 'original-work', tool: 'read', status: 'completed', detail: 'input.txt' });
      yield { type: 'usage_call', data: usage };
      throw new Error('provider rejected the request');
    }
    yield { type: 'init', continuation: 'explanation-session' };
    yield { type: 'usage_call', data: usage };
    yield { type: 'result', text: '<message to="web">The provider rejected your request.</message>' };
  });
  const query = p.query.bind(p);
  p.query = (parameters) => {
    inputs.push(parameters);
    return query(parameters);
  };
  const controller = new AbortController();
  const loop = runPollLoop({ provider: p, providerName: 'test', cwd: process.cwd(), signal: controller.signal });
  try {
    await until(() => !!getOutboundDb().prepare("SELECT 1 FROM turns WHERE outcome='failed'").get());
    expect(inputs).toHaveLength(2);
    expect(inputs[0].continuation).toBe('good-session');
    expect(inputs[1].continuation).toBeUndefined();
    expect(inputs[1].prompt).toContain('Do not retry the failed action.');
    expect(getContinuation('test')).toBe('good-session');
    expect(getOutboundDb().prepare('SELECT COUNT(*) AS n FROM turns').get()).toEqual({ n: 1 });
    expect(getOutboundDb().prepare('SELECT SUM(cost_usd) AS cost FROM turn_usage').get()).toEqual({ cost: 0.5 });
    expect(activitySteps()).toEqual([
      // Marks when the turn's first model call could start.
      { kind: 'model', id: expect.stringMatching(/^model:ready:/), durationMs: 0 },
      expect.objectContaining({ kind: 'tool', id: 'original-work' }),
      expect.objectContaining({ kind: 'notification', text: 'Provider request failed', detail: 'provider rejected the request' }),
      expect.objectContaining({ kind: 'notification', text: 'Asking model to explain failure' }),
      expect.objectContaining({ kind: 'notification', text: 'Model output recorded after failure' }),
    ]);
    const output = getOutboundDb().prepare('SELECT content FROM messages_out').get() as { content: string };
    expect(JSON.parse(output.content)).toMatchObject({ text: 'The provider rejected your request.', delivery_origin: 'response' });
    expect(JSON.parse(output.content).system_generated).not.toBe(true);
    expectOutputBeforeSettlement();
  } finally { controller.abort(); await loop; }
});

it('marks model readiness at the first model request for providers that report requests', async () => {
  input();
  const p: AgentProvider = {
    ...provider(async function* () {
      yield { type: 'init', continuation: 'reporting-session' };
      appendActivity({ kind: 'tool', id: 'setup-work', tool: 'read', status: 'completed', detail: 'input.txt' });
      yield { type: 'model_request' };
      yield { type: 'model_request' };
      yield { type: 'result', text: '<message to="web">done</message>' };
    }),
    reportsModelRequests: true,
  };
  const controller = new AbortController();
  const loop = runPollLoop({ provider: p, providerName: 'test', cwd: process.cwd(), signal: controller.signal });
  try {
    await until(() => !!getOutboundDb().prepare("SELECT 1 FROM turns WHERE outcome IS NOT NULL").get());
    expect(activitySteps().filter((step) => step.kind !== 'notification')).toEqual([
      expect.objectContaining({ kind: 'tool', id: 'setup-work' }),
      { kind: 'model', id: expect.stringMatching(/^model:ready:/), durationMs: 0 },
    ]);
  } finally { controller.abort(); await loop; }
});

it.each(['throw', 'event'] as const)('records an unsuccessful %s acknowledgement before its static notice and settlement', async (mode) => {
  input();
  let attempts = 0;
  const p = provider(async function* () {
    if (++attempts === 1) throw new Error('original failure');
    if (mode === 'throw') throw new Error('explanation offline');
    yield { type: 'error', retryable: false, message: 'explanation offline' };
  });
  const controller = new AbortController();
  const loop = runPollLoop({ provider: p, providerName: 'test', cwd: process.cwd(), signal: controller.signal });
  try {
    await until(() => !!getOutboundDb().prepare("SELECT 1 FROM turns WHERE outcome='failed'").get());
    expect(attempts).toBe(2);
    const steps = activitySteps();
    expect(steps).toEqual([
      expect.objectContaining({ text: 'Provider request failed', detail: 'original failure' }),
      expect.objectContaining({ text: 'Asking model to explain failure' }),
      expect.objectContaining({ text: 'Failure explanation unavailable', detail: expect.stringContaining('explanation offline') }),
      expect.objectContaining({ text: 'Error notice recorded' }),
    ]);
    expect(getOutboundDb().prepare('SELECT COUNT(*) AS n FROM messages_out').get()).toEqual({ n: 1 });
    const output = getOutboundDb().prepare('SELECT content FROM messages_out').get() as { content: string };
    expect(JSON.parse(output.content).system_generated).toBe(true);
    expectOutputBeforeSettlement();
  } finally { controller.abort(); await loop; }
});

it('does not describe a runner notice from an empty acknowledgement as model output', async () => {
  input();
  let attempts = 0;
  const p = provider(async function* () {
    if (++attempts === 1) throw new Error('original failure');
    yield { type: 'result', text: '' };
  });
  const controller = new AbortController();
  const loop = runPollLoop({ provider: p, providerName: 'test', cwd: process.cwd(), signal: controller.signal });
  try {
    await until(() => !!getOutboundDb().prepare("SELECT 1 FROM turns WHERE outcome='failed'").get());
    expect(activitySteps()).toEqual([
      expect.objectContaining({ text: 'Provider request failed' }),
      expect.objectContaining({ text: 'Asking model to explain failure' }),
      expect.objectContaining({ text: 'System notice recorded after failure' }),
    ]);
    expect(getOutboundDb().prepare('SELECT COUNT(*) AS n FROM messages_out').get()).toEqual({ n: 1 });
  } finally { controller.abort(); await loop; }
});

it('records a provider failure even when its final result contains partial output', async () => {
  input();
  const p = provider(async function* () {
    yield { type: 'error', message: 'quota exhausted mid-turn', classification: 'quota', retryable: false };
    yield { type: 'result', text: '<message to="web">Partial answer.</message>' };
  });
  const controller = new AbortController();
  const loop = runPollLoop({ provider: p, providerName: 'test', cwd: process.cwd(), signal: controller.signal });
  try {
    await until(() => !!getOutboundDb().prepare("SELECT 1 FROM turns WHERE outcome='failed'").get());
    expect(activitySteps()).toEqual([
      expect.objectContaining({ text: 'Provider request failed', detail: '[quota] quota exhausted mid-turn' }),
    ]);
    expect(getOutboundDb().prepare('SELECT COUNT(*) AS n FROM messages_out').get()).toEqual({ n: 1 });
  } finally { controller.abort(); await loop; }
});

it('does not append acknowledgement completion activity after the user stops and settles the turn', async () => {
  input();
  let attempts = 0;
  const p = provider(async function* () {
    if (++attempts === 1) throw new Error('original failure');
    requestTurnStop(getTurnContext()!.turnId);
    yield { type: 'activity' };
  });
  const controller = new AbortController();
  const loop = runPollLoop({ provider: p, providerName: 'test', cwd: process.cwd(), signal: controller.signal });
  try {
    await until(() => !!getOutboundDb().prepare("SELECT 1 FROM turns WHERE phase='settled'").get());
    expect(activitySteps()).toEqual([
      expect.objectContaining({ text: 'Provider request failed' }),
      expect.objectContaining({ text: 'Asking model to explain failure' }),
      expect.objectContaining({ text: 'Stopped by user.' }),
    ]);
    expectOutputBeforeSettlement();
  } finally { controller.abort(); await loop; }
});

it('settles only after the outer fallback when a failure acknowledgement is outputless', async () => {
  input();
  let queries = 0;
  const p = provider(async function* () {
    if (++queries === 1) throw new Error('provider failed');
  });

  const controller = new AbortController();
  const loop = runPollLoop({ provider: p, providerName: 'test', cwd: process.cwd(), signal: controller.signal });
  try {
    await until(() => !!getOutboundDb().prepare("SELECT 1 FROM turns WHERE outcome='failed'").get());
    const rows = getOutboundDb().prepare('SELECT sequence, event_type, payload FROM pending_runner_events ORDER BY sequence')
      .all() as Array<{ sequence: number; event_type: string; payload: string }>;
    const output = rows.find((row) => row.event_type === 'message.upsert')!;
    const settled = rows.find((row) => row.event_type === 'turn.upsert' && JSON.parse(row.payload).phase === 'settled')!;
    expect(output).toBeDefined();
    expect(output.sequence).toBeLessThan(settled.sequence);
    expect(getOutboundDb().prepare('SELECT COUNT(*) AS n FROM turns').get()).toEqual({ n: 1 });
  } finally { controller.abort(); await loop; }
});

it('does not turn an idle warm transport error into a second answer or mutate settled accounting', async () => {
  input();
  let ended = false;
  const p = provider(async function* () {
    yield { type: 'usage_call', data: usage };
    yield { type: 'result', text: '<message to="web">answer</message>' };
    ended = true;
    throw new Error('idle transport closed');
  });
  const controller = new AbortController();
  const loop = runPollLoop({ provider: p, providerName: 'test', cwd: process.cwd(), signal: controller.signal });
  try {
    await until(() => ended);
    expect(getOutboundDb().prepare('SELECT outcome FROM turns').get()).toEqual({ outcome: 'replied' });
    expect(getOutboundDb().prepare('SELECT COUNT(*) AS n FROM messages_out').get()).toEqual({ n: 1 });
    expect(getOutboundDb().prepare('SELECT SUM(cost_usd) AS cost FROM turn_usage').get()).toEqual({ cost: 0.25 });
    expect(activitySteps()).toEqual([]);
  } finally { controller.abort(); await loop; }
});

it('records a hidden model step for each timed model call', async () => {
  input();
  const p = provider(async function* () {
    yield { type: 'usage_call', data: { ...usage, duration_api_ms: 1200 } };
    yield { type: 'usage_call', data: usage };
    yield { type: 'usage_call', data: { ...usage, id: 'replayed', duration_api_ms: 500 } };
    yield { type: 'usage_call', data: { ...usage, id: 'replayed', duration_api_ms: 700 } };
    yield { type: 'result', text: '<message to="web">answer</message>' };
  });
  const controller = new AbortController();
  const loop = runPollLoop({ provider: p, providerName: 'test', cwd: process.cwd(), signal: controller.signal });
  try {
    await until(() => !!getOutboundDb().prepare("SELECT 1 FROM turns WHERE phase='settled'").get());
    expect(activitySteps()).toEqual([
      { kind: 'model', id: expect.stringMatching(/^model:/), durationMs: 1200 },
      { kind: 'model', id: expect.stringMatching(/^model:/), durationMs: 500 },
    ]);
    expect(getOutboundDb().prepare('SELECT duration_api_ms, num_turns FROM turn_usage').get())
      .toEqual({ duration_api_ms: null, num_turns: 3 });
  } finally { controller.abort(); await loop; }
});

it('retains one usage ID and full walltime across a stale retry, counting each attempt\'s calls once', async () => {
  input();
  setContinuation('test', 'stale');
  let attempt = 0;
  const seen: string[] = [];
  const p = provider(async function* () {
    seen.push(getTurnContext()!.turnId);
    yield { type: 'usage_call', data: usage };
    appendActivity({ kind: 'notification', id: `attempt-${attempt}`, text: 'work' });
    if (++attempt === 1) {
      await Bun.sleep(30);
      throw new Error('stale');
    }
    yield { type: 'result', text: '<message to="web">answer</message>' };
  });
  p.isSessionInvalid = () => true;
  const controller = new AbortController();
  const loop = runPollLoop({ provider: p, providerName: 'test', cwd: process.cwd(), signal: controller.signal });
  try {
    await until(() => !!getOutboundDb().prepare("SELECT 1 FROM turns WHERE phase='settled'").get());
    expect(new Set(seen).size).toBe(1);
    const rows = getOutboundDb().prepare('SELECT id, turn_id, cost_usd, input_tokens, duration_ms FROM turn_usage').all() as
      Array<{ id: string; turn_id: string; cost_usd: number; input_tokens: number; duration_ms: number }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: `tu-${seen[0]}`, turn_id: seen[0], cost_usd: 0.5, input_tokens: 24 });
    expect(rows[0].duration_ms).toBeGreaterThanOrEqual(30);
    expect(metadata(seen[0])).toMatchObject({ status: 'partial', final: true });
    expect(getOutboundDb().prepare('SELECT COUNT(*) AS n FROM turn_activity').get()).toEqual({ n: 2 });
    expect(activitySteps().filter((step) => step.kind === 'notification')).toEqual([
      expect.objectContaining({ text: 'work' }),
      expect.objectContaining({ text: 'work' }),
    ]);
  } finally { controller.abort(); await loop; }
});

it('persists Stop with reported partial usage exactly once and no successor attribution', async () => {
  input();
  const controller = new AbortController();
  const p = provider(async function* () {
    yield { type: 'usage_call', data: usage };
    requestTurnStop(getTurnContext()!.turnId);
    yield { type: 'activity' };
  });
  const loop = runPollLoop({ provider: p, providerName: 'test', cwd: process.cwd(), signal: controller.signal });
  try {
    await until(() => !!getOutboundDb().prepare("SELECT 1 FROM turns WHERE outcome='stopped'").get());
    const row = getOutboundDb().prepare('SELECT turn_id, cost_usd FROM turn_usage').get() as { turn_id: string };
    expect(metadata(row.turn_id)).toMatchObject({ final: true, status: 'partial' });
    expect(getOutboundDb().prepare('SELECT SUM(cost_usd) AS cost FROM turn_usage').get()).toEqual({ cost: 0.25 });
  } finally { controller.abort(); await loop; }
});

it('waits for captured asynchronous tool output before durable settlement', async () => {
  const turn = beginTurn(route, []);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  registerTools([{ tool: { name: 'settlement-late', description: 'test', inputSchema: { type: 'object' } },
    async handler() { await gate; writeMessageOut({ id: 'late-final', kind: 'chat', content: '{"text":"late"}' }); return { content: [] }; },
  }]);
  const tool = invokeRegisteredTool('settlement-late');
  const settlement = settleTurn(turn, 'replied');
  await Bun.sleep(20);
  expect(getTurn(getOutboundDb(), turn.turnId)?.phase).toBe('running');
  release();
  await Promise.all([tool.finally(() => unregisterTool('settlement-late')), settlement]);
  expect(getTurn(getOutboundDb(), turn.turnId)?.phase).toBe('settled');
  const events = getOutboundDb().prepare('SELECT event_type, payload FROM pending_runner_events ORDER BY sequence').all() as
    Array<{ event_type: string; payload: string }>;
  expect(events.at(-1)!.event_type).toBe('turn.upsert');
  expect(JSON.parse(events.at(-1)!.payload).outcome).toBe('replied');
});

it('a re-reported call replaces its earlier report, preserves the accounting ID/time and survives output relinking', async () => {
  const turn = beginTurn(route, []);
  recordCallUsage(turn, { ...usage, id: 'call', cost_usd: 0 });
  const before = getOutboundDb().prepare('SELECT id, timestamp FROM turn_usage').get();
  recordCallUsage(turn, { ...usage, id: 'call' });
  completeUsageAttempt(turn);
  writeMessageOut({ id: 'final-output', kind: 'chat', content: '{"text":"answer"}' });
  await settleTurn(turn, 'replied');
  expect(getOutboundDb().prepare('SELECT id, timestamp FROM turn_usage').get()).toEqual(before);
  expect(getOutboundDb().prepare('SELECT cost_usd, message_out_id FROM turn_usage').get())
    .toEqual({ cost_usd: usage.cost_usd, message_out_id: 'final-output' });
  expect(metadata(turn.turnId)).toMatchObject({ status: 'final', final: true });
});

it('does not publish settlement when its durable metadata commit fails', async () => {
  const turn = beginTurn(route, []);
  getOutboundDb().exec(`CREATE TRIGGER reject_metadata BEFORE UPDATE ON session_state
    WHEN NEW.key LIKE 'turn-metadata:%' BEGIN SELECT RAISE(ABORT, 'metadata failure'); END;`);
  await expect(settleTurn(turn, 'silent')).rejects.toThrow('metadata failure');
  expect(getTurn(getOutboundDb(), turn.turnId)?.phase).toBe('running');
  expect(turn.settled).toBe(false);
  expect(getOutboundDb().prepare(
    "SELECT COUNT(*) AS n FROM pending_runner_events WHERE event_type='turn.upsert' AND json_extract(payload,'$.phase')='settled'",
  ).get()).toEqual({ n: 0 });
});

it('a replacement runner interrupts abandoned outputless turns without dropping reported usage', async () => {
  const prior = beginTurn(route, []);
  recordCallUsage(prior, usage);
  appendActivity({ kind: 'notification', id: 'prior', text: 'working' });
  const controller = new AbortController();
  const loop = runPollLoop({ provider: provider(async function* () {}), providerName: 'test', cwd: process.cwd(), signal: controller.signal });
  try {
    await until(() => getTurn(getOutboundDb(), prior.turnId)?.phase === 'settled');
    expect(getTurn(getOutboundDb(), prior.turnId)?.outcome).toBe('interrupted');
    expect(metadata(prior.turnId)).toMatchObject({ status: 'partial', final: true });
    expect(getOutboundDb().prepare('SELECT message_out_id FROM turn_activity').get()).toEqual({ message_out_id: null });
  } finally { controller.abort(); await loop; }
});
