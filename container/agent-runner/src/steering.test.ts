import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { closeSessionDb, getInboundDb, getOutboundDb, initTestSessionDb } from './db/connection.js';
import { getPendingMessages, getSteeringCandidates, markProcessing, type MessageInRow } from './db/messages-in.js';
import { writeMessageOut } from './db/messages-out.js';
import { getContinuation, setContinuation } from './db/session-state.js';
import { loadConfig, setConfigForTest } from './config.js';
import { runPollLoop } from './poll-loop.js';
import type { AgentProvider, ProviderEvent, QueryInput, SteeringInput } from './providers/types.js';
import * as link from './session-link.js';
import { inputHandling, readInputEditReceipt, readInputState, steeringDisposition, writeInputState } from './steering.js';

let sequence = 0;
beforeEach(() => {
  initTestSessionDb();
  sequence = 0;
});
afterEach(() => {
  link.resetHostEventsForTesting();
  closeSessionDb();
});

const routing = { channelType: 'web', platformId: 'room', threadId: 'thread', inReplyTo: 'initial' };
function insert(
  id: string,
  content: Record<string, unknown> = {},
  options: { channel?: string; platform?: string; thread?: string | null; kind?: string; trigger?: number } = {},
): MessageInRow {
  getInboundDb().prepare(
    `INSERT INTO messages_in (id, seq, kind, timestamp, status, channel_type, platform_id, thread_id, trigger, content)
     VALUES (?, ?, ?, datetime('now'), 'pending', ?, ?, ?, ?, ?)`,
  ).run(
    id, sequence += 2, options.kind ?? 'chat', options.channel ?? 'web', options.platform ?? 'room',
    options.thread === undefined ? 'thread' : options.thread, options.trigger ?? 1,
    JSON.stringify({ text: id, ...content }),
  );
  link.emitHostEventForTesting();
  return getInboundDb().prepare('SELECT * FROM messages_in WHERE id = ?').get(id) as MessageInRow;
}
async function until(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 250; i++) {
    if (predicate()) return;
    await Bun.sleep(4);
  }
  throw new Error('Timed out waiting for steering state');
}

describe('steering selection', () => {
  it('only explicitly steers web messages and rejects stale turn targets', () => {
    const plain = insert('plain');
    expect(steeringDisposition(plain, routing, 'turn', true).status).toBe('queued');
    const steer = insert('steer', { inputHandling: { mode: 'steer', turnId: 'turn' } });
    expect(steeringDisposition(steer, routing, 'turn', true).status).toBe('steering');
    expect(steeringDisposition(steer, routing, 'later', true)).toMatchObject({
      status: 'queued', reason: 'turn_finished',
    });
    expect(steeringDisposition(steer, routing, 'turn', false)).toMatchObject({
      status: 'queued', reason: 'unsupported',
    });
  });

  it('automatically steers external conversations, not cross-thread or passive input', () => {
    const context = { ...routing, channelType: 'telegram' };
    const message = insert('external', { inputHandling: { mode: 'queue' } }, { channel: 'telegram' });
    expect(inputHandling(message)).toBeUndefined();
    expect(steeringDisposition(message, context, 'turn', true).status).toBe('steering');
    for (const other of [
      { ...message, platform_id: 'another-room' },
      { ...message, thread_id: 'another-thread' },
      { ...message, channel_type: 'slack' },
    ]) expect(steeringDisposition(other, context, 'turn', true).reason).toBe('different_conversation');
    for (const ineligible of [
      { ...message, trigger: 0 },
      { ...message, source_session_id: 'other-session' },
      { ...message, kind: 'task' },
      { ...message, kind: 'interactive_response' },
      { ...message, content: '{"text":"/clear"}' },
    ]) expect(steeringDisposition(ineligible, context, 'turn', true).status).toBe('queued');
  });

  it('finds old steering input even behind more than a prompt cap of queued input', () => {
    const config = loadConfig();
    setConfigForTest({ maxMessagesPerPrompt: 2 });
    try {
      insert('old-steer', { inputHandling: { mode: 'steer', turnId: 'turn' } });
      for (let i = 0; i < 5; i++) insert(`queue-${i}`, { inputHandling: { mode: 'queue' } });
      expect(getPendingMessages()).toHaveLength(2);
      expect(getSteeringCandidates(routing, []).map((m) => m.id)).toEqual(['old-steer']);
      expect(getSteeringCandidates(routing, ['old-steer'])).toEqual([]);
      markProcessing(['old-steer']);
      expect(getSteeringCandidates(routing, [])).toEqual([]);
    } finally {
      setConfigForTest(config);
    }
  });

  it('writes idempotent durable dispositions for long message IDs', () => {
    const messageId = 'a'.repeat(256);
    writeInputState({ messageId, status: 'queued' });
    writeInputState({ messageId, status: 'queued' });
    expect(readInputState(messageId)).toEqual({ messageId, status: 'queued' });
    const rows = getOutboundDb().prepare('SELECT key FROM session_state').all() as { key: string }[];
    expect(rows).toHaveLength(1);
    expect(rows[0].key.length).toBeLessThan(256);
  });
});

function harness(supportsSteering = true, onPush?: (prompt: string) => boolean) {
  const controller = new AbortController();
  const prompts: QueryInput[] = [];
  const steering: SteeringInput[] = [];
  const states: Array<link.ActiveTurn | null> = [];
  let active: link.ActiveTurn | null = null;
  const publish = spyOn(link, 'signalTurnState').mockImplementation((turn) => {
    active = turn;
    states.push(turn);
  });
  let events: ProviderEvent[] = [];
  let wake: (() => void) | undefined;
  let ended = false;
  const provider: AgentProvider = {
    supportsNativeSlashCommands: false,
    supportsSteering,
    supportsInputEditing: supportsSteering,
    isSessionInvalid: () => false,
    query(input) {
      prompts.push(input);
      ended = false;
      events = [];
      return {
        push: (prompt) => onPush?.(prompt) ?? false,
        steer(input) { steering.push(input); return !ended; },
        end() { ended = true; wake?.(); },
        abort() { ended = true; wake?.(); },
        events: (async function* (): AsyncGenerator<ProviderEvent> {
          yield { type: 'init', continuation: 'steering-session' };
          while (!ended) {
            if (events.length) yield events.shift()!;
            else await new Promise<void>((resolve) => { wake = resolve; });
          }
        })(),
      };
    },
  };
  return {
    provider, controller, prompts, steering, states,
    get active() { return active; },
    emit(event: ProviderEvent) { events.push(event); wake?.(); },
    start() {
      return runPollLoop({ provider, providerName: 'steering-test', cwd: process.cwd(), signal: controller.signal });
    },
    async stop(loop: Promise<void>) {
      controller.abort();
      ended = true;
      wake?.();
      try { await loop; } finally { publish.mockRestore(); }
    },
  };
}

it('applies steering to the existing batch without claiming queued or other-conversation messages', async () => {
  getInboundDb().prepare(
    "INSERT INTO destinations (name, type, channel_type, platform_id) VALUES ('web-test', 'channel', 'web', 'room')",
  ).run();
  insert('initial');
  const h = harness();
  const loop = h.start();
  try {
    await until(() => h.active !== null && getContinuation('steering-test') === 'steering-session');
    const turn = h.active!;
    expect(turn.supportsSteering).toBe(true);
    insert('queued', { inputHandling: { mode: 'queue', turnId: turn.id } });
    insert('other', { inputHandling: { mode: 'steer', turnId: turn.id } }, { thread: 'other' });
    insert('guidance', { inputHandling: { mode: 'steer', turnId: turn.id } });
    await until(() => h.steering.length === 1);
    expect(h.steering[0].prompt).toContain('guidance');
    expect(readInputState('guidance')?.status).toBe('steering');
    expect(getPendingMessages().map((m) => m.id)).toContain('guidance');
    h.emit({ type: 'steering_applied', id: 'guidance' });
    await until(() => readInputState('guidance')?.status === 'applied');
    expect(h.active?.id).toBe(turn.id);
    expect(getPendingMessages().map((m) => m.id)).toEqual(['queued', 'other']);
    expect(getOutboundDb().prepare('SELECT status FROM processing_ack WHERE message_id = ?').get('guidance'))
      .toEqual({ status: 'processing' });
    h.emit({ type: 'result', text: '<message to="web-test">Done</message>' });
    await until(() => h.prompts.length > 1);
    expect(getOutboundDb().prepare('SELECT status FROM processing_ack WHERE message_id = ?').get('guidance'))
      .toEqual({ status: 'completed' });
    expect(h.prompts[1].prompt).not.toContain('guidance');
    const out = getOutboundDb().prepare('SELECT platform_id, thread_id FROM messages_out ORDER BY seq LIMIT 1').get();
    expect(out).toEqual({ platform_id: 'room', thread_id: 'thread' });
  } finally { await h.stop(loop); }
});

it('does not steer a provider that lacks the capability', async () => {
  insert('initial');
  const h = harness(false);
  const loop = h.start();
  try {
    await until(() => h.active !== null);
    insert('guidance', { inputHandling: { mode: 'steer', turnId: h.active!.id } });
    await until(() => readInputState('guidance') !== undefined);
    expect(h.steering).toEqual([]);
    expect(h.active?.supportsSteering).toBeUndefined();
    expect(readInputState('guidance')?.reason).toBe('unsupported');
  } finally { await h.stop(loop); }
});

it('claims a queued follow-up after the prior final reply and before synchronous next-turn output', async () => {
  const now = spyOn(Date, 'now').mockReturnValue(1_800_000_000_000);
  getInboundDb().prepare(
    "INSERT INTO destinations (name, type, channel_type, platform_id) VALUES ('web-test', 'channel', 'web', 'room')",
  ).run();
  insert('A');
  let consumedPosition: number | undefined;
  const h = harness(false, (prompt) => {
    expect(prompt).toContain('B');
    consumedPosition = readInputState('B')?.timelinePosition;
    expect(consumedPosition).toBeDefined();
    writeMessageOut({
      id: 'B-progress', kind: 'chat', channel_type: 'web', platform_id: 'room', thread_id: 'thread',
      content: JSON.stringify({ text: 'B progress' }),
    });
    return true;
  });
  const loop = h.start();
  try {
    await until(() => h.active !== null);
    insert('B', { inputHandling: { mode: 'queue', turnId: h.active!.id } });
    await until(() => readInputState('B')?.queuedForNextTurn === true);
    expect(readInputState('B')?.timelinePosition).toBeUndefined();
    expect(consumedPosition).toBeUndefined();
    expect(getOutboundDb().prepare("SELECT 1 FROM processing_ack WHERE message_id = 'B'").get()).toBeNull();
    expect(getOutboundDb().prepare('SELECT COUNT(*) AS n FROM messages_out').get()).toEqual({ n: 0 });
    h.emit({ type: 'result', text: '<message to="web-test">A final reply</message>' });
    await until(() => consumedPosition !== undefined);
    h.emit({ type: 'result', text: '<message to="web-test">B final reply</message>' });
    await until(() => getOutboundDb().prepare("SELECT 1 FROM processing_ack WHERE message_id = 'B' AND status = 'completed'").get() !== null);
    const rows = getOutboundDb().prepare('SELECT content FROM messages_out ORDER BY seq').all() as { content: string }[];
    const messages = rows.map((row) => JSON.parse(row.content) as { text: string; timelinePosition: number });
    expect(messages.map((message) => message.text)).toEqual(['A final reply', 'B progress', 'B final reply']);
    expect(readInputState('A')!.timelinePosition!).toBeLessThan(messages[0].timelinePosition);
    expect(messages[0].timelinePosition).toBeLessThan(consumedPosition!);
    expect(consumedPosition!).toBeLessThan(messages[1].timelinePosition);
    expect(messages[1].timelinePosition).toBeLessThan(messages[2].timelinePosition);
    expect(readInputState('B')?.queuedForNextTurn).toBeUndefined();
  } finally {
    await h.stop(loop);
    now.mockRestore();
  }
});

it('marks all active queued inputs beyond the prompt cap without assigning timeline positions', async () => {
  const config = loadConfig();
  setConfigForTest({ maxMessagesPerPrompt: 2 });
  insert('initial');
  const h = harness(false);
  const loop = h.start();
  try {
    await until(() => h.active !== null);
    const wake = spyOn(link, 'emitHostEventForTesting').mockImplementation(() => {});
    try {
      for (let index = 0; index < 5; index++) insert(`queued-${index}`, { inputHandling: { mode: 'queue' } });
    } finally { wake.mockRestore(); }
    link.emitHostEventForTesting();
    await until(() => readInputState('queued-0')?.queuedForNextTurn === true);
    for (let index = 0; index < 5; index++) {
      expect(readInputState(`queued-${index}`)).toMatchObject({ status: 'queued', queuedForNextTurn: true });
      expect(readInputState(`queued-${index}`)?.timelinePosition).toBeUndefined();
    }
  } finally {
    await h.stop(loop);
    setConfigForTest(config);
  }
});

it('automatically steers external messages without redirecting cross-conversation work', async () => {
  insert('initial', {}, { channel: 'telegram' });
  const h = harness();
  const loop = h.start();
  try {
    await until(() => h.active !== null);
    const turnId = h.active!.id;
    insert('other-channel', {}, { channel: 'slack' });
    insert('other-thread', {}, { channel: 'telegram', thread: 'elsewhere' });
    insert('external-guidance', {}, { channel: 'telegram' });
    await until(() => h.steering.length === 1);
    expect(h.steering[0].id).toBe('external-guidance');
    h.emit({ type: 'steering_applied', id: 'external-guidance' });
    await until(() => readInputState('external-guidance')?.status === 'applied');
    expect(h.active).toMatchObject({ id: turnId, channelType: 'telegram', threadId: 'thread' });
    expect(getPendingMessages().map((m) => m.id)).toEqual(['other-channel', 'other-thread']);
  } finally { await h.stop(loop); }
});

it('does not hide valid steering behind a full page of stale targets', async () => {
  const config = loadConfig();
  setConfigForTest({ maxMessagesPerPrompt: 2 });
  insert('initial');
  const h = harness();
  const loop = h.start();
  try {
    await until(() => h.active !== null);
    const wake = spyOn(link, 'emitHostEventForTesting').mockImplementation(() => {});
    try {
      for (let i = 0; i < 5; i++) insert(`stale-${i}`, { inputHandling: { mode: 'steer', turnId: 'old-turn' } });
      insert('valid-guidance', { inputHandling: { mode: 'steer', turnId: h.active!.id } });
    } finally { wake.mockRestore(); }
    link.emitHostEventForTesting();
    await until(() => h.steering.length === 1);
    expect(h.steering[0].id).toBe('valid-guidance');
  } finally {
    await h.stop(loop);
    setConfigForTest(config);
  }
});

it('preserves unapplied steering across Stop, as a distinct follow-up', async () => {
  insert('initial');
  const h = harness();
  const loop = h.start();
  try {
    await until(() => h.active !== null);
    const turnId = h.active!.id;
    insert('guidance', { inputHandling: { mode: 'steer', turnId } });
    await until(() => h.steering.length === 1);
    link.requestTurnStop(turnId);
    await until(() => h.prompts.length > 1);
    expect(h.prompts[1].prompt).toContain('guidance');
    expect(h.prompts[1].prompt).not.toContain('initial');
    expect(h.active?.id).not.toBe(turnId);
    expect(readInputState('guidance')).toMatchObject({ status: 'processing', reason: 'turn_finished' });
  } finally { await h.stop(loop); }
});

it('Stop completes applied steering but preserves queued and not-yet-applied messages', async () => {
  insert('initial');
  const h = harness();
  let release!: () => void;
  const drained = new Promise<void>((resolve) => { release = resolve; });
  const drain = spyOn(link, 'drainSessionJournal').mockImplementation(() => drained);
  const loop = h.start();
  try {
    await until(() => h.active !== null);
    const turnId = h.active!.id;
    insert('applied-guidance', { inputHandling: { mode: 'steer', turnId } });
    await until(() => h.steering.length === 1);
    h.emit({ type: 'steering_applied', id: 'applied-guidance' });
    await until(() => readInputState('applied-guidance')?.status === 'applied');
    insert('waiting-guidance', { inputHandling: { mode: 'steer', turnId } });
    insert('queued-next', { inputHandling: { mode: 'queue', turnId } });
    await until(() => h.steering.length === 2);
    link.requestTurnStop(turnId);
    await until(() => (getOutboundDb().prepare('SELECT COUNT(*) AS n FROM messages_out').get() as { n: number }).n > 0);
    expect(h.active).toMatchObject({ id: turnId, status: 'stopping' });
    expect(getPendingMessages().map((m) => m.id)).toEqual(['waiting-guidance', 'queued-next']);
    expect(readInputState('waiting-guidance')).toMatchObject({ status: 'queued', queuedForNextTurn: true });
    expect(readInputState('queued-next')).toMatchObject({ status: 'queued', queuedForNextTurn: true });
    expect(readInputState('waiting-guidance')?.timelinePosition).toBeUndefined();
    expect(readInputState('queued-next')?.timelinePosition).toBeUndefined();
    const stopped = getOutboundDb().prepare('SELECT content FROM messages_out ORDER BY seq DESC LIMIT 1').get() as { content: string };
    const stoppedPosition = JSON.parse(stopped.content).timelinePosition as number;
    expect(getOutboundDb().prepare('SELECT status FROM processing_ack WHERE message_id = ?').get('applied-guidance'))
      .toEqual({ status: 'completed' });
    release();
    await until(() => h.prompts.length > 1);
    expect(readInputState('waiting-guidance')!.timelinePosition!).toBeGreaterThan(stoppedPosition);
    expect(readInputState('queued-next')!.timelinePosition!).toBeGreaterThan(readInputState('waiting-guidance')!.timelinePosition!);
    expect(h.prompts[1].prompt).toContain('waiting-guidance');
    expect(h.prompts[1].prompt).toContain('queued-next');
    expect(h.prompts[1].prompt).not.toContain('applied-guidance');
    expect(h.active?.id).not.toBe(turnId);
    link.requestTurnStop(turnId);
    expect(h.active?.status).toBe('running');
  } finally {
    release();
    await h.stop(loop);
    drain.mockRestore();
  }
});

it('recovers already-persisted steering without appending the same guidance again', async () => {
  insert('already-applied');
  insert('new-input');
  setContinuation('steering-test', 'steering-session');
  const h = harness();
  h.provider.appliedSteering = (_continuation, ids) => ids.filter((id) => id === 'already-applied');
  const loop = h.start();
  try {
    await until(() => h.prompts.length === 1);
    expect(h.prompts[0].prompt).not.toContain('already-applied');
    expect(h.prompts[0].prompt).toContain('new-input');
    expect(readInputState('already-applied')?.status).toBe('applied');
    expect(getOutboundDb().prepare('SELECT status FROM processing_ack WHERE message_id = ?').get('already-applied'))
      .toEqual({ status: 'completed' });
  } finally { await h.stop(loop); }
});

it('processes startup edit requests before claiming and formatting the initial batch', async () => {
  insert('target', { text: 'original text', inputHandling: { mode: 'queue' } });
  getInboundDb().prepare("UPDATE messages_in SET sender_identity = 'web:owner' WHERE id = 'target'").run();
  const requestId = randomUUID();
  insert(`edit-${requestId}`, {
    action: 'edit_input', requestId, messageId: 'target', expectedText: 'original text', replacementText: 'new text',
  }, { kind: 'system', trigger: 0 });
  getInboundDb().prepare("UPDATE messages_in SET sender_identity = 'web:owner' WHERE id = ?").run(`edit-${requestId}`);
  const h = harness();
  const loop = h.start();
  try {
    await until(() => h.prompts.length === 1);
    expect(h.prompts[0].prompt).toContain('new text');
    expect(h.prompts[0].prompt).not.toContain('original text');
    expect(h.prompts[0].prompt).not.toContain('edit_input');
    expect(readInputEditReceipt(requestId)?.status).toBe('accepted');
  } finally { await h.stop(loop); }
});

it('rejects pending startup edits to durably applied guidance before recovery acknowledges it', async () => {
  insert('already-applied', { text: 'original text' });
  insert('new-input');
  getInboundDb().prepare("UPDATE messages_in SET sender_identity = 'web:owner' WHERE id = 'already-applied'").run();
  const requestId = randomUUID();
  insert(`edit-${requestId}`, {
    action: 'edit_input', requestId, messageId: 'already-applied', expectedText: 'original text', replacementText: 'corruption',
  }, { kind: 'system', trigger: 0 });
  getInboundDb().prepare("UPDATE messages_in SET sender_identity = 'web:owner' WHERE id = ?").run(`edit-${requestId}`);
  setContinuation('steering-test', 'steering-session');
  const h = harness();
  h.provider.appliedSteering = (_continuation, ids) => ids.filter((id) => id === 'already-applied');
  const loop = h.start();
  try {
    await until(() => h.prompts.length === 1);
    expect(h.prompts[0].prompt).not.toContain('corruption');
    expect(h.prompts[0].prompt).not.toContain('original text');
    expect(readInputEditReceipt(requestId)).toMatchObject({ status: 'conflict', reason: 'not_pending' });
    expect(readInputState('already-applied')?.status).toBe('applied');
  } finally { await h.stop(loop); }
});
