import { describe, expect, it, vi } from 'vitest';
import type { ConversationMessage, ConversationTurn } from '../../../shared/conversation';
import { testSnapshot, testTurn } from './conversation-test-fixtures';
import { activeTurnNotices, hasTurnStats, latestTraceHeadline, liveTurnActivity, turnRowView } from './turn-row';
import {
  activityChapters,
  displayStep,
  parseStep,
  stepHeadline,
  traceStatusClass,
  type TraceLine,
  type TraceStep,
} from '../../../shared/activity-presentation';
import { conversationActivity } from '../../../shared/conversation-activity';

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

describe('Stats availability', () => {
  it.each([
    {
      phase: 'running' as const,
      metadata: { status: 'provisional' as const, model: 'model', durationMs: null },
      expected: false,
    },
    { phase: 'running' as const, usage: [{ id: 'zero', value: { cost_usd: 0 } }], expected: true },
    { phase: 'settled' as const, metadata: { status: 'final' as const, model: null, durationMs: 0 }, expected: true },
    {
      phase: 'settled' as const,
      metadata: { status: 'partial' as const, model: 'model', durationMs: null },
      expected: true,
    },
    {
      phase: 'settled' as const,
      metadata: { status: 'unavailable' as const, model: null, durationMs: null },
      expected: false,
    },
  ])('offers reportable Stats without rejecting zero totals (%j)', ({ expected, ...partial }) => {
    const turn = { ...testTurn, startedAt: null, endedAt: null, ...partial };
    expect(hasTurnStats(turn, turnRowView(turn, start))).toBe(expected);
  });
});

describe('latest trace headline', () => {
  const line = (step: TraceStep): TraceLine => ({ ts: '1000', text: JSON.stringify(step) });
  const tool: TraceStep = { kind: 'tool', id: 'call', tool: 'bash', detail: 'pnpm test' };

  it('falls back to Thinking only before any activity', () => {
    expect(latestTraceHeadline([], true)).toEqual({ headline: { action: 'Thinking…' }, repetitions: 1 });
  });

  it.each(['running', 'pending', 'completed', 'error', 'interrupted'] as const)(
    'mirrors the latest %s entry without changing its trace record',
    (status) => {
      const lines = [line({ ...tool, status })];
      const before = JSON.stringify(lines);
      const { headline, repetitions } = latestTraceHeadline(lines, true);
      expect(headline).toEqual(stepHeadline(displayStep(lines[0], true)));
      expect(headline.subject).toContain('pnpm test');
      expect(repetitions).toBe(1);
      expect(JSON.stringify(lines)).toBe(before);
    },
  );

  it('mirrors a grouped chapter with its repetition count', () => {
    const lines = ['a', 'b', 'c'].map((id) => line({ ...tool, id, status: 'completed' }));
    const chapters = activityChapters(lines, true);
    expect(chapters).toHaveLength(1);
    expect(latestTraceHeadline(lines, true)).toEqual({ headline: chapters[0].headline, repetitions: 3 });
  });

  it('follows the trace list: the newest chapter leads, outcome rows never do', () => {
    const lines = [
      line({ ...tool, status: 'running' }),
      line({ kind: 'compaction', id: 'compact', auto: true, status: 'completed' }),
    ];
    const chapters = activityChapters(lines, true);
    const latest = chapters.at(-1)!;
    expect(latestTraceHeadline(lines, true).headline).toEqual(stepHeadline(latest.entries[0].step));
    expect(
      latestTraceHeadline([...lines, line({ kind: 'notification', id: 'ui:outcome:t', text: 'Replied' })], true),
    ).toEqual(latestTraceHeadline(lines, true));
  });

  it('shows legacy text entries by their text', () => {
    expect(latestTraceHeadline([{ ts: '1000', text: 'Earlier work' }], true).headline).toEqual({
      action: 'Earlier work',
    });
  });
});

describe('model time versus wall time', () => {
  it('sums independently measured call timing, not provider wall duration', () => {
    const turn = settled({
      usage: [
        { ...usage, value: { ...usage.value, duration_api_ms: 1000 } },
        { id: 'other', value: { ...usage.value, duration_api_ms: 2000 } },
      ],
    });
    expect(turnRowView(turn, start)).toMatchObject({ elapsedMs: 5000, modelCallMs: 3000 });
  });
  it('measures the total from submission, including the wait before the turn started', () => {
    const requestedAt = new Date(start - 2000).toISOString();
    expect(turnRowView(settled({ requestedAt }), start).elapsedMs).toBe(7000);
    const live = { ...testTurn, startedAt: new Date(start).toISOString(), requestedAt };
    expect(turnRowView(live, start + 1000).elapsedMs).toBe(3000);
    expect(turnRowView({ ...live, requestedAt: null }, start + 1000).elapsedMs).toBe(1000);
  });
  it('uses live usage records and preserves measured zero', () => {
    expect(
      turnRowView({ ...testTurn, usage: [{ id: 'live', value: { ...usage.value, duration_api_ms: 0 } }] }, start),
    ).toMatchObject({ modelCallMs: 0 });
  });
  it('does not invent model timing when any record is missing it', () => {
    const turn = settled({
      usage: [
        { ...usage, value: { ...usage.value, duration_api_ms: 1000 } },
        { id: 'missing', value: usage.value },
      ],
    });
    expect(turnRowView(turn, start).modelCallMs).toBeNull();
    expect(turnRowView(testTurn, start).modelCallMs).toBeNull();
  });
  it('counts overlapping tool time once and live tools up to now', () => {
    const tool = (id: string, at: number, status: string, durationMs?: number) => ({
      ordinal: at,
      ts: String(start + at),
      timelinePosition: at,
      text: JSON.stringify({ kind: 'tool', id, tool: 'bash', status, durationMs }),
    });
    const activity = [tool('a', 0, 'completed', 2000), tool('b', 1000, 'completed', 500), tool('c', 3000, 'running')];
    expect(turnRowView(settled({ activity }), start + 5000).toolCallMs).toBe(2000);
    expect(turnRowView({ ...testTurn, activity }, start + 5000).toolCallMs).toBe(4000);
  });
});

describe('live status and trace notices', () => {
  const line = (step: TraceStep): TraceLine => ({ ts: '1000', text: JSON.stringify(step) });
  const initial = conversationActivity({ ...testTurn, activity: [], startedAt: null });
  const finished = line({ kind: 'tool', id: 'call', tool: 'bash', status: 'completed', detail: 'pnpm test' });
  const running = line({ kind: 'tool', id: 'next', tool: 'read', status: 'running', detail: 'file.ts' });

  it('shows initial Thinking… only in the status line without inventing trace activity', () => {
    const result = liveTurnActivity(testTurn, initial, true, null)!;
    expect(initial).toEqual([]);
    expect(result.lines).toBe(initial);
    expect(result.lines).toHaveLength(0);
    expect(result.headline).toEqual({ action: 'Thinking…' });
  });

  it('keeps mirroring the completed entry without closing the recorded chapter', () => {
    const lines = [...initial, finished];
    const before = JSON.stringify(lines);
    const result = liveTurnActivity(testTurn, lines, true, null)!;
    expect(result.lines).toBe(lines);
    expect(result.headline).toEqual(latestTraceHeadline(lines, true).headline);
    expect(result.headline.action).toBe('Ran');
    expect(liveTurnActivity(testTurn, lines, true, null)).toEqual(result);
    expect(result.lines.filter((entry) => parseStep(entry.text).text === 'Thinking…')).toHaveLength(0);
    const resumed = [...lines, running];
    expect(liveTurnActivity(testTurn, resumed, true, null)!.lines).toBe(resumed);
    expect(JSON.stringify(lines)).toBe(before);
  });

  it('does not duplicate the current tool as a standalone marker after parallel or grouped activity', () => {
    for (const lines of [
      [...initial, running, finished],
      [...initial, running, line({ kind: 'tool', id: 'other', tool: 'read', status: 'running', detail: 'other.ts' })],
    ]) {
      const result = liveTurnActivity(testTurn, lines, true, null)!;
      expect(result.lines).toBe(lines);
      expect(activityChapters(result.lines, true).flatMap((chapter) => chapter.entries)).toHaveLength(lines.length);
      expect(result.lines.some((entry) => parseStep(entry.text).id?.startsWith('ui:current:'))).toBe(false);
    }
  });

  it.each([
    { phase: 'stopping' as const, connected: true, error: '', text: 'Stopping…' },
    { phase: 'running' as const, connected: false, error: '', text: 'Runner disconnected' },
    { phase: 'running' as const, connected: true, error: 'Stop failed.', text: 'Stop failed.' },
    { phase: 'stopping' as const, connected: true, error: 'Stop failed.', text: 'Stop failed. · Stopping…' },
  ])('puts $text in both the status slot and the trailing trace marker', ({ phase, connected, error, text }) => {
    const lines = [...initial, running];
    const result = liveTurnActivity(
      { ...testTurn, phase },
      lines,
      connected,
      error ? { turnId: testTurn.id, error } : null,
    )!;
    expect(result.headline).toEqual({ action: text });
    expect(result).toMatchObject({ notice: true, error: !!error });
    expect(activityChapters(result.lines, true).at(-1)!.title).toBe(text);
    expect(result.lines.slice(0, -1)).toEqual(lines);
    expect(traceStatusClass(parseStep(result.lines.at(-1)!.text))).toBe(
      error ? 'trace-status-failed' : connected ? 'trace-status-running' : 'trace-status-interrupted',
    );
  });

  it('ignores stale Stop errors and never adds a current-state marker after settlement', () => {
    expect(liveTurnActivity(testTurn, initial, true, { turnId: 'other', error: 'Old error.' })!.headline).toEqual({
      action: 'Thinking…',
    });
    expect(
      liveTurnActivity({ ...testTurn, phase: 'settled' }, initial, false, {
        turnId: testTurn.id,
        error: 'Stop failed.',
      }),
    ).toBeNull();
  });
});

describe('active turn notices', () => {
  const turn = { id: 'active', status: 'running' as const };
  it('shows the concise disconnect notice only while an active runner is disconnected', () => {
    expect(activeTurnNotices(turn, false, null)).toEqual([{ text: 'Runner disconnected', error: false }]);
    expect(activeTurnNotices(turn, true, null)).toEqual([]);
    expect(activeTurnNotices(null, false, null)).toEqual([]);
  });
  it('keeps stopping and errors separate from historical outcomes', () => {
    expect(activeTurnNotices({ ...turn, status: 'stopping' }, true, null)).toEqual([
      { text: 'Stopping…', error: false },
    ]);
    expect(activeTurnNotices(turn, false, { turnId: turn.id, error: 'Stop failed.' })).toEqual([
      { text: 'Stop failed.', error: true },
    ]);
    expect(activeTurnNotices(turn, false, { turnId: 'previous', error: 'Old error.' })).toEqual([
      { text: 'Runner disconnected', error: false },
    ]);
  });
});

describe('turn row presentation', () => {
  it('ticks elapsed time live while running and strips stale checkpoint timing from usage', () => {
    const turn = { ...testTurn, usage: [usage] };
    expect(turnRowView(turn, start + 7000)).toMatchObject({ elapsedMs: 7000, status: 'Thinking…' });
    expect(turnRowView(turn, start + 9000).elapsedMs).toBe(9000);
    expect(turnRowView(turn, start).usage[0].value).toMatchObject({ duration_ms: undefined, model: undefined });
  });

  it('keeps settled elapsed time separate from model and usage metadata', () => {
    const view = turnRowView(settled({ usage: [usage] }), start + 60_000);
    expect(view).toMatchObject({ elapsedMs: 5000, status: null });
    expect(view.usage).toEqual([usage]);
  });

  it('keeps settling live without flashing a finalization notice or settled accounting', () => {
    const turn: ConversationTurn = { ...testTurn, phase: 'settling', usage: [usage] };
    expect(turnRowView(turn, start + 7000)).toMatchObject({
      hidden: false,
      status: null,
      elapsedMs: 7000,
    });
    expect(turnRowView(turn, start).usage[0].value).toMatchObject({ duration_ms: undefined, model: undefined });
  });

  it('does not expose completed outcome labels and keeps stopping as a live notice', () => {
    for (const outcome of [
      'replied',
      'failed',
      'unknown',
      'pending',
      'stopped',
      'silent',
      'warning',
      'interrupted',
    ] as const)
      expect(turnRowView(settled({ outcome }), 0)).not.toHaveProperty('note');
    expect(turnRowView({ ...testTurn, phase: 'stopping' }, 0).status).toBeNull();
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
    expect(turnRowView({ ...empty, outcome: 'failed' }, 0).hidden).toBe(true);
    for (const outcome of ['stopped', 'silent', 'warning', 'interrupted'] as const)
      expect(turnRowView({ ...empty, outcome }, 0).hidden).toBe(false);
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
      ['first', 1, 'a'],
      ['later', 1, 'b'],
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
            lines: row.message.activity?.map((line) => parseStep(line.text).text ?? line.text),
            status: false,
            stats: row.message.statsTurn?.id,
          }
        : row.kind === 'turn'
          ? {
              id: `trace:${row.turn.id}:after:${row.afterId}`,
              lines: row.activity.map((line) => parseStep(line.text).text ?? line.text),
              status: row.status,
              stats: undefined,
            }
          : row.kind === 'question-answer'
            ? { id: row.question.questionId, status: false }
            : { id: row.submission.messageId, status: true },
    );

  it('keeps recorded activity across steering in the final response without a completion marker', () => {
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
      { id: 'reply', lines: ['Started response', 'step 0', 'step 1'], status: false, stats: 's' },
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
      activity: [
        // The runner marks when the first model call can start; the start row then completes.
        {
          ordinal: 2,
          ts: String(start + 500),
          text: JSON.stringify({ kind: 'model', id: 'model:ready', durationMs: 0 }),
          timelinePosition: us + 500_000,
        },
        step(0, 1000),
        step(1, 5000),
      ],
    };
    const messages = [message('ask', 'in', -1), message('update', 'out', 3000)];
    expect(rows(testSnapshot({ messages, turns: [running] }).conversation)).toEqual([
      { id: 'ask', lines: undefined, status: false, stats: undefined },
      { id: 'update', lines: undefined, status: false, stats: undefined },
      { id: 'trace:m:after:update', lines: ['Started response', 'step 0', 'step 1'], status: true, stats: undefined },
    ]);
  });

  it('keeps settled stats on the last system row when the turn has no reply', () => {
    const turn = settled({ id: 'q', outcome: 'silent', inputIds: ['ask'], activity: [step(0, 1000)] });
    expect(rows(testSnapshot({ messages: [message('ask', 'in', -1)], turns: [turn] }).conversation)).toEqual([
      { id: 'ask', lines: undefined, status: false, stats: undefined },
      { id: 'trace:q:after:ask', lines: ['Started response', 'step 0', 'No reply'], status: true, stats: undefined },
    ]);
  });

  it('retains stats without inventing trace activity on a reply without recorded activities', () => {
    const turn = settled({ id: 'p', inputIds: ['ask'], outputIds: ['reply'], activity: [] });
    const messages = [message('ask', 'in', -1), message('reply', 'out', 2000)];
    expect(rows(testSnapshot({ messages, turns: [turn] }).conversation).map((r) => [r.id, r.stats])).toEqual([
      ['ask', undefined],
      ['reply', 'p'],
    ]);
    expect(conversationMessages(testSnapshot({ messages, turns: [turn] }).conversation)[1].activity).toEqual([]);
  });
});
