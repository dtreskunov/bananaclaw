import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { Database } from 'bun:sqlite';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { clearStaleProcessingAcks, closeSessionDb, getOutboundDb, initTestSessionDb } from './connection.js';
import { getMessageIn, type MessageInRow } from './messages-in.js';
import { writeMessageOut, writeMessageOutWithConnections } from './messages-out.js';
import { ensureRunnerStateSchema } from './runner-state.js';
import { allocateTimelinePosition } from './timeline.js';
import { readInputState, startInputProcessing, writeInputState } from '../steering.js';

let now: ReturnType<typeof spyOn<typeof Date, 'now'>>;
const epoch = 1_800_000_000_000;
beforeEach(() => {
  initTestSessionDb({ unifiedHostProjection: true });
  now = spyOn(Date, 'now').mockReturnValue(epoch);
});
afterEach(() => {
  now.mockRestore();
  closeSessionDb();
});

function input(id: string, seq: number): MessageInRow {
  getOutboundDb().prepare(
    `INSERT INTO messages_in (id, seq, kind, timestamp, channel_type, content)
     VALUES (?, ?, 'chat', '2026-09-26T00:00:00.000Z', 'web', ?)`,
  ).run(id, seq, JSON.stringify({ text: id }));
  return getMessageIn(id)!;
}

function output(id: string, kind = 'chat'): number {
  writeMessageOut({ id, kind, content: JSON.stringify({ text: id, timelinePosition: Number.MAX_SAFE_INTEGER }) });
  const row = getOutboundDb().prepare('SELECT content FROM messages_out WHERE id = ?').get(id) as { content: string };
  return JSON.parse(row.content).timelinePosition;
}

function clock(): number {
  return (getOutboundDb().prepare('SELECT position FROM timeline_clock WHERE id = 1').get() as { position: number }).position;
}

describe('durable consumption timeline', () => {
  it('shares a strictly increasing clock across inputs and outputs despite frozen/backwards time', () => {
    const a = input('A', 2);
    const b = input('B', 4);
    startInputProcessing([a]);
    const first = readInputState(a.id)!.timelinePosition!;
    const progress = output('A progress', 'internal');
    now.mockReturnValue(epoch - 60_000);
    const final = output('A final');
    startInputProcessing([b]);
    const second = readInputState(b.id)!.timelinePosition!;
    const nextProgress = output('B progress', 'system');
    expect([first, progress, final, second, nextProgress])
      .toEqual(Array.from({ length: 5 }, (_, index) => epoch * 1000 + index));
    expect(getMessageIn(a.id)?.timestamp).toBe(a.timestamp);
    expect(getMessageIn(b.id)?.timestamp).toBe(b.timestamp);
  });

  it('distinguishes ordinary unclaimed input from queued follow-ups and only allocates on consumption', () => {
    const first = input('first', 2);
    const queued = input('queued', 4);
    writeInputState({ messageId: first.id, status: 'queued' });
    writeInputState({ messageId: queued.id, status: 'queued', queuedForNextTurn: true });
    writeInputState({ messageId: queued.id, status: 'queued', reason: 'unsupported' });
    expect(readInputState(first.id)).toEqual({ messageId: first.id, status: 'queued' });
    expect(readInputState(queued.id)).toMatchObject({ status: 'queued', queuedForNextTurn: true });
    expect(readInputState(queued.id)?.timelinePosition).toBeUndefined();
    expect(clock()).toBe(0);
    startInputProcessing([first, queued]);
    expect(readInputState(first.id)?.timelinePosition).toBe(epoch * 1000);
    expect(readInputState(queued.id)?.timelinePosition).toBe(epoch * 1000 + 1);
    expect(readInputState(queued.id)?.queuedForNextTurn).toBeUndefined();
  });

  it('preserves first-consumption positions across dispositions, retry and stale-ack cleanup', () => {
    const messages = [input('first', 2), input('second', 4), input('third', 6)];
    startInputProcessing(messages);
    const positions = messages.map((message) => readInputState(message.id)!.timelinePosition);
    expect(positions).toEqual([epoch * 1000, epoch * 1000 + 1, epoch * 1000 + 2]);
    output('prior response');
    clearStaleProcessingAcks();
    writeInputState({ messageId: 'second', status: 'queued', queuedForNextTurn: true, timelinePosition: 1 });
    expect(readInputState('second')?.queuedForNextTurn).toBeUndefined();
    startInputProcessing(messages);
    writeInputState({ messageId: 'second', status: 'applied', turnId: 'retry-turn' });
    expect(messages.map((message) => readInputState(message.id)!.timelinePosition)).toEqual(positions);
    expect(clock()).toBe(epoch * 1000 + 3);
  });

  it('places steering on actual application, not acceptance, and never moves a recovery receipt', () => {
    const message = input('guidance', 2);
    const progress = output('earlier progress');
    writeInputState({ messageId: message.id, status: 'steering', turnId: 'current' });
    expect(readInputState(message.id)?.timelinePosition).toBeUndefined();
    writeInputState({ messageId: message.id, status: 'applied', turnId: 'current' });
    const position = readInputState(message.id)!.timelinePosition!;
    const final = output('current turn final');
    expect(progress).toBeLessThan(position);
    expect(position).toBeLessThan(final);
    writeInputState({ messageId: message.id, status: 'applied' });
    expect(readInputState(message.id)?.timelinePosition).toBe(position);
    expect(clock()).toBe(final);
  });

  it('persists clock, immutable positions and queued metadata across database reopening', () => {
    const consumed = input('consumed', 2);
    input('queued', 4);
    startInputProcessing([consumed]);
    const consumedState = readInputState(consumed.id)!;
    writeInputState({ messageId: 'queued', status: 'queued', queuedForNextTurn: true });
    const prior = output('before restart');
    const dbPath = path.join(process.cwd(), `.timeline-${randomUUID()}.db`);
    fs.writeFileSync(dbPath, getOutboundDb().serialize());
    let reopened: Database | undefined;
    try {
      reopened = new Database(dbPath);
      ensureRunnerStateSchema(reopened);
      const states = reopened.prepare("SELECT value FROM session_state WHERE key LIKE 'input:%'").all() as { value: string }[];
      expect(states.map((row) => JSON.parse(row.value))).toEqual(expect.arrayContaining([
        consumedState, { messageId: 'queued', status: 'queued', queuedForNextTurn: true },
      ]));
      now.mockReturnValue(epoch - 1000);
      writeMessageOutWithConnections({ id: 'after restart', kind: 'chat', content: '{}' }, reopened, reopened);
      const row = reopened.prepare("SELECT content FROM messages_out WHERE id = 'after restart'").get() as { content: string };
      expect(JSON.parse(row.content).timelinePosition).toBe(prior + 1);
    } finally {
      reopened?.close();
      fs.rmSync(dbPath, { force: true });
    }
  });

  it.each(['missing', 'empty', 'zero', 'existing'] as const)('seeds a %s fork clock from inherited input/output positions without resetting it', (mode) => {
    const db = getOutboundDb();
    const inheritedBase = epoch * 1000;
    const inheritedInput = JSON.stringify({
      messageId: 'inherited-input', status: 'processing', timelinePosition: inheritedBase + 3,
    });
    const inheritedOutput = JSON.stringify({ text: 'inherited output', timelinePosition: inheritedBase + 2 });
    db.prepare('INSERT INTO session_state (key, value, updated_at) VALUES (?, ?, ?)')
      .run('input:inherited', inheritedInput, '2026-09-26T00:00:00.000Z');
    db.prepare(
      "INSERT INTO messages_out (id, seq, timestamp, kind, content) VALUES ('inherited', 1, datetime('now'), 'chat', ?)",
    ).run(inheritedOutput);
    if (mode === 'missing') db.exec('DROP TABLE timeline_clock');
    else if (mode === 'empty') db.exec('DELETE FROM timeline_clock');
    else if (mode === 'existing') db.prepare('UPDATE timeline_clock SET position = ?').run(inheritedBase + 100);
    now.mockReturnValue(epoch - 60_000);
    ensureRunnerStateSchema(db);
    const expectedFloor = inheritedBase + (mode === 'existing' ? 100 : 3);
    expect(clock()).toBe(expectedFloor);
    expect(allocateTimelinePosition(db)).toBe(expectedFloor + 1);
    expect(db.prepare("SELECT value FROM session_state WHERE key = 'input:inherited'").get()).toEqual({ value: inheritedInput });
    expect(db.prepare("SELECT content FROM messages_out WHERE id = 'inherited'").get()).toEqual({ content: inheritedOutput });
    ensureRunnerStateSchema(db);
    expect(clock()).toBe(expectedFloor + 1);
  });

  it('rolls back an entire FIFO claim batch, including positions, if a state write fails', () => {
    const messages = [input('first', 2), input('second', 4)];
    getOutboundDb().exec(
      `CREATE TRIGGER reject_second BEFORE INSERT ON session_state
       WHEN json_extract(NEW.value, '$.messageId') = 'second'
       BEGIN SELECT RAISE(ABORT, 'test claim failure'); END`,
    );
    expect(() => startInputProcessing(messages)).toThrow('test claim failure');
    expect(readInputState('first')).toBeUndefined();
    expect(clock()).toBe(0);
    expect(getOutboundDb().prepare('SELECT COUNT(*) AS n FROM processing_ack').get()).toEqual({ n: 0 });
    expect(getOutboundDb().prepare('SELECT COUNT(*) AS n FROM claimed_inputs').get()).toEqual({ n: 0 });
  });

  it('validates enriched output size and structure and rolls back clock allocation on failure', () => {
    const maxBytes = Number.parseInt(process.env.NANOCLAW_MAX_OUTPUT_BYTES || '10485760', 10);
    const content = JSON.stringify({ text: 'x'.repeat(maxBytes - JSON.stringify({ text: '' }).length) });
    expect(Buffer.byteLength(content)).toBe(maxBytes);
    expect(() => writeMessageOut({ id: 'large', kind: 'chat', content })).toThrow('durable link limits');
    const fullObject = Object.fromEntries(Array.from({ length: 100 }, (_, index) => [String(index), index]));
    expect(() => writeMessageOut({ id: 'deep', kind: 'chat', content: JSON.stringify(fullObject) }))
      .toThrow('structural limits');
    expect(clock()).toBe(0);
    expect(getOutboundDb().prepare('SELECT COUNT(*) AS n FROM messages_out').get()).toEqual({ n: 0 });
    expect(getOutboundDb().prepare('SELECT COUNT(*) AS n FROM pending_runner_events').get()).toEqual({ n: 0 });
  });

  it('refuses unsafe clock values rather than persisting imprecise ordering', () => {
    now.mockReturnValue(Number.MAX_SAFE_INTEGER);
    expect(() => allocateTimelinePosition()).toThrow('Invalid timeline wall clock');
    now.mockReturnValue(epoch);
    getOutboundDb().prepare('UPDATE timeline_clock SET position = ?').run(Number.MAX_SAFE_INTEGER);
    expect(() => allocateTimelinePosition()).toThrow();
    expect(clock()).toBe(Number.MAX_SAFE_INTEGER);
  });
});
