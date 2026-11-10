import { afterEach, beforeEach, expect, it, mock } from 'bun:test';
import { closeSessionDb, getOutboundDb, initTestSessionDb } from '../db/connection.js';
import { beginTurn, interruptAbandonedTurns, recordCallUsage, settleTurn, turnUsage } from '../turn-execution.js';
import type { AgentQuery } from '../providers/types.js';
import { offerUsageAdvisory, recordUsageAdvisory } from './usage-advisory.js';
import { parseSoftTurnTokenBudget } from '../config.js';

beforeEach(() => {
  initTestSessionDb();
});
afterEach(closeSessionDb);
const begin = () => beginTurn({ channelType: 'web', platformId: 'room', threadId: null, inReplyTo: null }, []);
const call = (id: string, count: number | undefined) => ({
  id,
  reported_tokens: count,
  input_tokens: count ?? 0,
  output_tokens: 0,
  cache_read_tokens: 0,
  cache_write_tokens: 0,
  cost_usd: 0,
  model: 'stub',
});
function query(accept = true): AgentQuery {
  return {
    adviseUsage: mock(() => accept),
    push: () => false,
    end() {},
    abort() {},
    events: { async *[Symbol.asyncIterator]() {} },
  };
}
function metadata(id: string) {
  const row = getOutboundDb().prepare('SELECT value FROM session_state WHERE key=?').get(`turn-metadata:${id}`) as {
    value: string;
  };
  return JSON.parse(row.value);
}
function usage(id: string) {
  return getOutboundDb().prepare('SELECT reported_tokens FROM turn_usage WHERE turn_id=?').get(id) as {
    reported_tokens: number | null;
  };
}

it('uses corrected shared snapshots, triggers exactly at the threshold, and never rearms', () => {
  const turn = begin();
  const q = query();
  recordCallUsage(turn, call('first', 9));
  offerUsageAdvisory(turn, q, 10);
  expect(q.adviseUsage).not.toHaveBeenCalled();
  recordCallUsage(turn, call('first', 10));
  offerUsageAdvisory(turn, q, 10);
  expect(q.adviseUsage).toHaveBeenCalledTimes(1);
  expect(q.adviseUsage).toHaveBeenCalledWith({
    turnId: turn.turnId,
    prompt: expect.stringContaining('10 reported tokens'),
  });
  expect(turnUsage(turn)?.num_turns).toBe(1);
  recordCallUsage(turn, call('summary', 100));
  offerUsageAdvisory(turn, q, 10);
  expect(q.adviseUsage).toHaveBeenCalledTimes(1);
  expect(metadata(turn.turnId)).toMatchObject({
    usageAdvisory: { status: 'queued', reportedTokens: 10, threshold: 10, appliedAt: null },
  });
  expect(usage(turn.turnId).reported_tokens).toBe(110);
  expect(metadata(turn.turnId)).not.toHaveProperty('reportedTokens');
});

it('keeps unavailable measurements unknown and leaves disabled policy independent of telemetry', () => {
  const turn = begin();
  const q = query();
  recordCallUsage(turn, call('unknown', undefined));
  recordCallUsage(turn, call('known', 20));
  offerUsageAdvisory(turn, q, 10);
  expect(usage(turn.turnId).reported_tokens).toBeNull();
  expect(q.adviseUsage).not.toHaveBeenCalled();
  recordCallUsage(turn, call('unknown', 0));
  offerUsageAdvisory(turn, q);
  expect(usage(turn.turnId).reported_tokens).toBe(20);
  expect(q.adviseUsage).not.toHaveBeenCalled();
});

it('records actual application once and preserves it when settling or reopening', async () => {
  const turn = begin();
  recordCallUsage(turn, call('first', 10));
  offerUsageAdvisory(turn, query(), 10);
  const event = {
    type: 'usage_advisory' as const,
    turnId: turn.turnId,
    status: 'applied' as const,
    timestamp: Date.now(),
  };
  expect(recordUsageAdvisory(turn, event)).toBe(true);
  expect(recordUsageAdvisory(turn, event)).toBe(false);
  await settleTurn(turn, 'silent');
  interruptAbandonedTurns();
  expect(metadata(turn.turnId).usageAdvisory).toMatchObject({ status: 'applied', appliedAt: event.timestamp });
});

it('keeps one shared snapshot and does not journal usage again for advisory-only changes', () => {
  const turn = begin();
  recordCallUsage(turn, call('first', 10));
  const snapshot = turnUsage(turn);
  const events = () =>
    getOutboundDb()
      .prepare("SELECT sequence,payload FROM pending_runner_events WHERE event_type='usage.persist' ORDER BY sequence")
      .all();
  const before = events();
  offerUsageAdvisory(turn, query(), 10);
  recordUsageAdvisory(turn, {
    type: 'usage_advisory',
    turnId: turn.turnId,
    status: 'applied',
    timestamp: Date.now(),
  });
  expect(turnUsage(turn)).toBe(snapshot);
  expect(events()).toEqual(before);
  expect(before).toHaveLength(1);
});

it('marks unapplied guidance skipped when a turn is cancelled or recovered after restart', async () => {
  const stopped = begin();
  recordCallUsage(stopped, call('first', 10));
  offerUsageAdvisory(stopped, query(), 10);
  await settleTurn(stopped, 'stopped');
  expect(metadata(stopped.turnId).usageAdvisory).toMatchObject({ status: 'skipped', appliedAt: null });
  const abandoned = begin();
  recordCallUsage(abandoned, call('second', 11));
  offerUsageAdvisory(abandoned, query(), 10);
  interruptAbandonedTurns();
  expect(metadata(abandoned.turnId)).toMatchObject({
    final: true,
    status: 'partial',
    usageAdvisory: { status: 'skipped', reportedTokens: 11, appliedAt: null },
  });
  expect(usage(abandoned.turnId).reported_tokens).toBe(11);
});

it('does not acknowledge unrelated guidance or claim rejected delivery was applied', () => {
  const turn = begin();
  recordCallUsage(turn, call('first', 10));
  offerUsageAdvisory(turn, query(false), 10);
  expect(metadata(turn.turnId).usageAdvisory).toMatchObject({ status: 'skipped', appliedAt: null });
  expect(() =>
    recordUsageAdvisory(turn, {
      type: 'usage_advisory',
      turnId: 'another-turn',
      status: 'applied',
      timestamp: Date.now(),
    }),
  ).toThrow('unrelated usage advisory');
});

it.each([0, -1, 1.5, '100', NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
  'rejects invalid runner budget %s',
  (value) => {
    expect(() => parseSoftTurnTokenBudget(value)).toThrow('positive safe integer');
  },
);
it('accepts a positive runner budget and leaves missing configuration disabled', () => {
  expect(parseSoftTurnTokenBudget(100)).toBe(100);
  expect(parseSoftTurnTokenBudget(null)).toBeUndefined();
  expect(parseSoftTurnTokenBudget(undefined)).toBeUndefined();
});
