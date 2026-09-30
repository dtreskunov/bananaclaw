import { describe, expect, it, vi } from 'vitest';
import type { ConversationMessage, ConversationTurn } from '../../../shared/conversation';
import { testSnapshot, testTurn } from './conversation-test-fixtures';
import { turnRowView } from './turn-row';

vi.hoisted(() => vi.stubGlobal('window', { matchMedia: () => ({ matches: false }) }));
const { conversationMessages } = await import('./conversation-state');

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

  it('places imported history (no start time) directly above its own reply, not after the shared input', () => {
    const messages = [message('ask', 'in', 100), message('first', 'out', 200), message('later', 'out', 900)];
    const imported = (id: string, output: string): ConversationTurn =>
      settled({ id, startedAt: null, endedAt: null, inputIds: ['ask'], outputIds: [output] });
    const view = testSnapshot({ messages, turns: [imported('a', 'first'), imported('b', 'later')] }).conversation;
    expect(conversationMessages(view).map((m) => m.id)).toEqual(['ask', 'turn:a', 'first', 'turn:b', 'later']);
  });

  it('keeps native turns at their start, after their first input', () => {
    const us = start * 1000;
    const messages = [message('ask', 'in', us - 1000), message('reply', 'out', us + 5_000_000)];
    const turn = settled({ id: 'n', inputIds: ['ask'], outputIds: ['reply'] });
    const view = testSnapshot({ messages, turns: [turn] }).conversation;
    expect(conversationMessages(view).map((m) => m.id)).toEqual(['ask', 'turn:n', 'reply']);
  });
});
