import { describe, expect, it, vi } from 'vitest';
import type { ConversationMessage, ConversationTurn } from '../../../shared/conversation';
import { testSnapshot, testTurn } from './conversation-test-fixtures';
import { turnRowView } from './turn-row';

vi.hoisted(() => vi.stubGlobal('window', { matchMedia: () => ({ matches: false }) }));
const { conversationPresentation } = await import('./conversation-state');
const conversationMessages = (view: ReturnType<typeof testSnapshot>['conversation']) =>
  conversationPresentation(view).messages;

const start = Date.parse('2026-09-29T00:00:00Z');
const usage = { id: 'u', value: { cost_usd: 0.1, duration_ms: 4000, model: 'm', input_tokens: 10, output_tokens: 1 } };
const settled = (partial: Partial<ConversationTurn> = {}): ConversationTurn => ({
  ...testTurn,
  phase: 'settled',
  outcome: 'replied',
  endedAt: '2026-09-29T00:00:05Z',
  metadata: { status: 'final', durationMs: 5000, model: 'm' },
  ...partial,
});

describe('turn row presentation', () => {
  it('ticks elapsed time live while running and strips stale checkpoint timing from usage', () => {
    const turn = { ...testTurn, usage: [usage] };
    expect(turnRowView(turn, start + 7000)).toMatchObject({ elapsedMs: 7000, status: 'Working…', note: null });
    expect(turnRowView(turn, start + 9000).elapsedMs).toBe(9000);
    expect(turnRowView(turn, start).usage[0].value).toMatchObject({ duration_ms: undefined, model: undefined });
    expect(turnRowView(turn, start).showTiming).toBe(true);
  });

  it('shows settled timing once, through the usage summary when there is one', () => {
    const view = turnRowView(settled({ usage: [usage] }), start + 60_000);
    expect(view).toMatchObject({ elapsedMs: 5000, showTiming: false, showTokensUnavailable: false, status: null });
    expect(view.usage).toEqual([usage]);
    expect(turnRowView(settled(), 0)).toMatchObject({ showTiming: true, showTokensUnavailable: true });
  });

  it('labels only outcomes that change how the reply reads', () => {
    for (const outcome of ['replied', 'unknown', 'pending'] as const)
      expect(turnRowView(settled({ outcome }), 0).note).toBeNull();
    expect(turnRowView(settled({ outcome: 'stopped' }), 0).note).toBe('Stopped');
    expect(turnRowView(settled({ outcome: 'silent' }), 0).note).toBe('No reply');
    expect(turnRowView({ ...testTurn, phase: 'stopping' }, 0)).toMatchObject({ note: 'Stopping…', status: null });
  });

  it('hides a settled turn with nothing to show, but never a notable or traced one', () => {
    const empty = settled({
      outcome: 'unknown',
      activity: [],
      startedAt: null,
      endedAt: null,
      metadata: { status: 'unavailable', durationMs: null, model: null },
    });
    expect(turnRowView(empty, 0).hidden).toBe(true);
    expect(turnRowView({ ...empty, outcome: 'failed' }, 0).hidden).toBe(false);
    expect(turnRowView({ ...empty, activity: testTurn.activity }, 0).hidden).toBe(false);
    expect(turnRowView({ ...empty, usage: [usage] }, 0).hidden).toBe(false);
  });
});

describe('turn row placement', () => {
  const message = (id: string, direction: 'in' | 'out', position: number): ConversationMessage => ({
    id,
    direction,
    timestamp: '2026-09-29T00:00:00Z',
    text: id,
    timelinePosition: position,
  });

  it('puts imported history (no start time) inside its own reply, not after the shared input', () => {
    const messages = [message('ask', 'in', 100), message('first', 'out', 200), message('later', 'out', 900)];
    const imported = (id: string, output: string): ConversationTurn =>
      settled({ id, startedAt: null, endedAt: null, inputIds: ['ask'], outputIds: [output] });
    const view = testSnapshot({ messages, turns: [imported('a', 'first'), imported('b', 'later')] }).conversation;
    expect(conversationMessages(view).map((m) => [m.id, m.activity?.length, m.statsTurn?.id])).toEqual([
      ['ask', undefined, undefined],
      ['first', 2, 'a'],
      ['later', 2, 'b'],
    ]);
  });

  it('keeps native turns at their start, after their first input', () => {
    const us = start * 1000;
    const messages = [message('ask', 'in', us - 1000), message('reply', 'out', us + 5_000_000)];
    const turn = settled({ id: 'n', inputIds: ['ask'], outputIds: ['reply'] });
    const view = testSnapshot({ messages, turns: [turn] }).conversation;
    expect(conversationMessages(view).map((m) => [m.id, m.activity?.length])).toEqual([
      ['ask', undefined],
      ['reply', 2],
    ]);
  });
});

describe('turn activity placement', () => {
  const us = start * 1000;
  const message = (
    id: string,
    direction: 'in' | 'out',
    offsetMs: number,
    status?: 'applied' | 'steering',
  ): ConversationMessage => ({
    id,
    direction,
    timestamp: '2026-09-29T00:00:00Z',
    text: id,
    timelinePosition: us + offsetMs * 1000,
    ...(status ? { inputState: { messageId: id, status } } : {}),
  });
  const step = (ordinal: number, offsetMs: number) => ({
    ordinal,
    ts: String(start + offsetMs),
    text: `step ${ordinal}`,
    timelinePosition: us + offsetMs * 1000,
  });
  const rows = (view: ReturnType<typeof testSnapshot>['conversation']) =>
    conversationPresentation(view).transcript.map((row) =>
      row.kind === 'message'
        ? {
            id: row.message.id,
            lines: row.message.activity?.map((line) => (line.text.includes('"text":"Done"') ? 'Done' : line.text)),
            status: false,
            stats: row.message.statsTurn?.id,
          }
        : row.kind === 'turn'
          ? {
              id: `trace:${row.turn.id}:after:${row.afterId}`,
              lines: row.activity.map((line) => (line.text.includes('"text":"Done"') ? 'Done' : line.text)),
              status: row.status,
              stats: undefined,
            }
          : { id: row.question.questionId, status: false },
    );

  it('keeps activity across steering in the final response with a display-only Done marker', () => {
    const messages = [message('ask', 'in', -1), message('steer', 'in', 3000, 'applied'), message('reply', 'out', 9000)];
    const turn = settled({
      id: 's',
      inputIds: ['ask', 'steer'],
      outputIds: ['reply'],
      activity: [step(0, 1000), step(1, 5000)],
    });
    expect(rows(testSnapshot({ messages, turns: [turn] }).conversation)).toEqual([
      { id: 'ask', lines: undefined, status: false, stats: undefined },
      { id: 'steer', lines: undefined, status: false, stats: undefined },
      { id: 'reply', lines: ['step 0', 'step 1', 'Done'], status: false, stats: 's' },
    ]);
  });

  it('shows live status after the newest applied steer, but not for one still waiting', () => {
    const running = { ...testTurn, id: 'r', inputIds: ['ask', 'steer'], activity: [step(0, 1000)] };
    const applied = [message('ask', 'in', -1), message('steer', 'in', 3000, 'applied')];
    expect(
      rows(testSnapshot({ messages: applied, turns: [running] }).conversation).map((r) => [r.id, r.status]),
    ).toEqual([
      ['ask', false],
      ['steer', false],
      ['trace:r:after:steer', true],
    ]);
    const waiting = [message('ask', 'in', -1), message('steer', 'in', 3000, 'steering')];
    expect(
      rows(testSnapshot({ messages: waiting, turns: [running] }).conversation).map((r) => [r.id, r.status]),
    ).toEqual([
      ['ask', false],
      ['trace:r:after:ask', true],
      ['steer', false],
    ]);
  });

  it('keeps work across mid-turn messages in the same live synthetic bubble', () => {
    const running = {
      ...testTurn,
      id: 'm',
      inputIds: ['ask'],
      outputIds: ['update'],
      activity: [step(0, 1000), step(1, 5000)],
    };
    const messages = [message('ask', 'in', -1), message('update', 'out', 3000)];
    expect(rows(testSnapshot({ messages, turns: [running] }).conversation)).toEqual([
      { id: 'ask', lines: undefined, status: false, stats: undefined },
      { id: 'update', lines: undefined, status: false, stats: undefined },
      { id: 'trace:m:after:update', lines: ['step 0', 'step 1'], status: true, stats: undefined },
    ]);
  });

  it('keeps settled stats on the last system row when the turn has no reply', () => {
    const turn = settled({ id: 'q', outcome: 'silent', inputIds: ['ask'], activity: [step(0, 1000)] });
    expect(rows(testSnapshot({ messages: [message('ask', 'in', -1)], turns: [turn] }).conversation)).toEqual([
      { id: 'ask', lines: undefined, status: false, stats: undefined },
      { id: 'trace:q:after:ask', lines: ['step 0', 'Done'], status: true, stats: undefined },
    ]);
  });

  it('retains a display-only Done trace and stats on a reply without recorded activities', () => {
    const turn = settled({ id: 'p', inputIds: ['ask'], outputIds: ['reply'], activity: [] });
    const messages = [message('ask', 'in', -1), message('reply', 'out', 2000)];
    expect(rows(testSnapshot({ messages, turns: [turn] }).conversation).map((r) => [r.id, r.stats])).toEqual([
      ['ask', undefined],
      ['reply', 'p'],
    ]);
    expect(conversationMessages(testSnapshot({ messages, turns: [turn] }).conversation)[1].activity).toHaveLength(1);
  });
});
