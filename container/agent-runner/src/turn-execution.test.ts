import { afterEach, beforeEach, expect, it } from 'bun:test';
import { initTestSessionDb, getInboundDb, getOutboundDb, closeSessionDb } from './db/connection.js';
import { appendActivity, setContinuation } from './db/session-state.js';
import { getTurn } from './db/turns.js';
import { getTurnContext } from './current-batch.js';
import { beginTurn, recordTurnUsage, settleTurn } from './turn-execution.js';
import { runPollLoop } from './poll-loop.js';
import { requestTurnStop, resetHostEventsForTesting } from './session-link.js';
import { invokeRegisteredTool, registerTools } from './mcp-tools/tool-registry.js';
import { writeMessageOut } from './db/messages-out.js';
import type { AgentProvider, ProviderEvent } from './providers/types.js';

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
    yield { type: 'usage', data: usage };
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
  } finally { controller.abort(); await loop; }
});

it('retains one usage ID and full walltime across a stale retry, without double counting call summaries', async () => {
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
    yield { type: 'usage', data: { ...usage, duration_ms: 1 } };
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
  await Promise.all([tool, settlement]);
  expect(getTurn(getOutboundDb(), turn.turnId)?.phase).toBe('settled');
  const events = getOutboundDb().prepare('SELECT event_type, payload FROM pending_runner_events ORDER BY sequence').all() as
    Array<{ event_type: string; payload: string }>;
  expect(events.at(-1)!.event_type).toBe('turn.upsert');
  expect(JSON.parse(events.at(-1)!.payload).outcome).toBe('replied');
});

it('final aggregate replaces live deltas, preserves the accounting ID/time and survives output relinking', async () => {
  const turn = beginTurn(route, []);
  recordTurnUsage(turn, usage, false);
  const before = getOutboundDb().prepare('SELECT id, timestamp FROM turn_usage').get();
  recordTurnUsage(turn, usage, true);
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
  recordTurnUsage(prior, usage, false);
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
