import { describe, expect, it } from 'vitest';
import {
  activityChapters,
  activityStepCount,
  BUILTIN_TOOL_PRESENTATIONS,
  parseStep,
  stepHeadline,
} from './activity-presentation.js';
import { conversationActivity, turnModelTime, withModelTime } from './conversation-activity.js';
import type { ConversationTurn } from './conversation.js';

const turn: ConversationTurn = {
  id: 'turn',
  phase: 'running',
  outcome: 'pending',
  startedAt: null,
  endedAt: null,
  inputIds: [],
  outputIds: ['question-output'],
  usage: [],
  metadata: { status: 'provisional', durationMs: null, model: null },
  activity: [
    {
      ordinal: 0,
      ts: '9000',
      text: '{"kind":"tool","id":"first","tool":"bash","status":"completed"}',
      timelinePosition: 100,
    },
    {
      ordinal: 1,
      ts: '5000',
      text: JSON.stringify({
        kind: 'tool',
        id: 'question-call',
        tool: 'mcp__nanoclaw__ask_user_question',
        status: 'completed',
        detail: 'Which option do you prefer?\nKeep <literal> text.',
      }),
      timelinePosition: 200,
    },
    {
      ordinal: 2,
      ts: '1000',
      text: '{"kind":"tool","id":"last","tool":"read","status":"completed"}',
      timelinePosition: 300,
    },
  ],
};
describe('whole-turn activity presentation', () => {
  it('keeps the recorded question call once, without a duplicate synthetic marker', () => {
    const lines = conversationActivity(turn);
    expect(lines.map((line) => parseStep(line.text).id)).toEqual(['first', 'question-call', 'last']);
    expect(stepHeadline(parseStep(lines[1].text))).toEqual({
      action: 'Requested an answer to',
      subject: 'Which option do you prefer? Keep <literal> text.',
      codeSubject: true,
    });
    expect(parseStep(lines[1].text).detail).toBe('Which option do you prefer?\nKeep <literal> text.');
    expect(lines).toEqual(turn.activity);
  });

  it('sorts by recorded position without changing the journal or relying on timestamps', () => {
    const shuffled = { ...turn, activity: [...turn.activity].reverse() };
    const before = JSON.stringify(shuffled);
    expect(conversationActivity(shuffled)).toEqual(turn.activity);
    expect(JSON.stringify(shuffled)).toBe(before);
  });

  it('represents every builtin call once without appending a synthetic completion entry', () => {
    const activity = [...BUILTIN_TOOL_PRESENTATIONS.keys()].map((tool, ordinal) => ({
      ordinal,
      ts: String(ordinal),
      timelinePosition: ordinal,
      text: JSON.stringify({ kind: 'tool', id: `call-${ordinal}`, tool: `nanoclaw.${tool}`, status: 'completed' }),
    }));
    const steps = conversationActivity({ ...turn, phase: 'settled', activity }).map((line) => parseStep(line.text));
    expect(steps.filter((step) => step.kind === 'tool').map((step) => step.id)).toEqual(
      activity.map((line) => `call-${line.ordinal}`),
    );
    expect(steps.filter((step) => step.kind !== 'tool')).toEqual([]);
  });

  it.each(['running', 'stopping', 'settling'] as const)('does not invent Done while %s', (phase) => {
    expect(conversationActivity({ ...turn, phase }).map((line) => parseStep(line.text).text)).not.toContain('Done');
  });

  it.each(['replied', 'failed', 'unknown', 'pending'] as const)(
    'retains only recorded activities after %s settlement without changing the journal',
    (outcome) => {
      const settled = { ...turn, phase: 'settled' as const, outcome, endedAt: '2026-10-04T19:01:00Z' };
      const before = JSON.stringify(settled);
      const lines = conversationActivity(settled);
      expect(lines).toEqual(settled.activity);
      expect(lines.map((line) => parseStep(line.text).text)).not.toContain('Done');
      expect(conversationActivity(settled)).toEqual(lines);
      expect(JSON.stringify(settled)).toBe(before);
      expect(settled.activity).toHaveLength(3);
    },
  );

  it.each([
    { outcome: 'silent', text: 'No reply' },
    { outcome: 'stopped', text: 'Stopped by user' },
    { outcome: 'warning', text: 'Ended with a warning' },
    { outcome: 'interrupted', text: 'Interrupted; outcome unknown' },
  ] as const)(
    'appends a stable display-only outcome for $outcome without changing recorded steps',
    ({ outcome, text }) => {
      const settled = {
        ...turn,
        phase: 'settled' as const,
        outcome,
        endedAt: '1970-01-01T00:00:00.500Z',
        activity: [...turn.activity].reverse(),
      };
      const before = JSON.stringify(settled);
      const lines = conversationActivity(settled);
      expect(lines.slice(0, -1)).toEqual(turn.activity);
      expect(lines.at(-1)).toEqual({
        ts: '500',
        text: JSON.stringify({
          kind: 'notification',
          id: 'ui:outcome:turn',
          text,
          ...(outcome === 'interrupted' ? { status: 'interrupted' } : {}),
        }),
      });
      expect(activityStepCount(lines)).toBe(3);
      expect(activityChapters(lines).at(-1)?.entries[0].step.text).toBe(text);
      expect(conversationActivity(settled)).toEqual(lines);
      expect(JSON.stringify(settled)).toBe(before);
      for (const phase of ['running', 'stopping', 'settling'] as const)
        expect(conversationActivity({ ...settled, phase })).toEqual(turn.activity);
    },
  );

  it('offers an outcome for an outputless settled turn without inventing a timestamp or recorded step', () => {
    const lines = conversationActivity({ ...turn, phase: 'settled', outcome: 'silent', activity: [] });
    expect(lines).toHaveLength(1);
    expect(lines[0].ts).toBe('');
    expect(lines[0]).not.toHaveProperty('ordinal');
    expect(parseStep(lines[0].text).text).toBe('No reply');
    expect(activityStepCount(lines)).toBe(0);
  });

  it('reuses a recorded stop notification, including when it belongs to another trace segment', () => {
    const stop = {
      ordinal: 3,
      ts: '10000',
      timelinePosition: 400,
      text: JSON.stringify({ kind: 'notification', id: 'stopped:turn', text: 'Stopped by user.' }),
    };
    const settled = {
      ...turn,
      phase: 'settled' as const,
      outcome: 'stopped' as const,
      activity: [...turn.activity, stop],
    };
    expect(conversationActivity(settled)).toEqual(settled.activity);
    expect(conversationActivity(settled, turn.activity)).toEqual(turn.activity);
    const otherTurn = {
      ...stop,
      text: JSON.stringify({ kind: 'notification', id: 'stopped:other', text: 'Stopped by user.' }),
    };
    expect(conversationActivity({ ...settled, activity: [otherTurn] })).toHaveLength(2);
  });

  it.each(['running', 'stopping', 'settling', 'settled'] as const)(
    'does not retain historical Thinking while %s or change the journal',
    (phase) => {
      const startedAt = '2026-10-05T20:07:00Z';
      const value = { ...turn, phase, startedAt };
      const before = JSON.stringify(value);
      const lines = conversationActivity(value);
      expect(lines[0]).toEqual(turn.activity[0]);
      expect(lines.filter((line) => parseStep(line.text).text === 'Thinking…')).toHaveLength(0);
      expect(JSON.stringify(value)).toBe(before);
    },
  );
});

describe('model time', () => {
  const t0 = Date.parse('2026-09-29T00:00:00Z');
  const tool = (ordinal: number, at: number, status: string, durationMs?: number) => ({
    ordinal,
    ts: String(t0 + at),
    text: JSON.stringify({ kind: 'tool', id: `t${ordinal}`, tool: 'bash', status, durationMs }),
    timelinePosition: ordinal,
  });
  const call = (ordinal: number, endAt: number, durationMs: number) => ({
    ordinal,
    ts: String(t0 + endAt),
    text: JSON.stringify({ kind: 'model', id: `m${ordinal}`, durationMs }),
    timelinePosition: ordinal,
  });
  const timed = (
    activity: ConversationTurn['activity'],
    partial: Partial<ConversationTurn> = {},
  ): ConversationTurn => ({
    ...turn,
    startedAt: new Date(t0).toISOString(),
    activity,
    ...partial,
  });
  const settle = (activity: ConversationTurn['activity'], endAt: number) =>
    timed(activity, { phase: 'settled', outcome: 'replied', endedAt: new Date(t0 + endAt).toISOString() });
  it('without reported calls, only the live tail ticks, from the step ending last', () => {
    const times = turnModelTime(timed([tool(0, 2000, 'completed', 3000), tool(1, 9000, 'completed', 1000)]));
    expect(Object.fromEntries(times)).toEqual({ 1: { ms: 0, since: t0 + 10_000 } });
    expect(Object.fromEntries(turnModelTime(timed([])))).toEqual({ '-1': { ms: 0, since: t0 } });
    const parallel = turnModelTime(timed([tool(0, 0, 'completed', 5000), tool(1, 1000, 'completed', 2000)]));
    expect(Object.fromEntries(parallel)).toEqual({ 0: { ms: 0, since: t0 + 5000 } });
  });

  it('attributes nothing while a tool runs or to a settled turn without reported calls', () => {
    expect(Object.fromEntries(turnModelTime(timed([tool(0, 1000, 'running')])))).toEqual({});
    expect(Object.fromEntries(turnModelTime(settle([tool(0, -500, 'completed', 1000)], 4000)))).toEqual({});
  });

  it('attributes reported calls to the step that prompted them, excluding runner overhead', () => {
    // Overhead 0–1.5s, call 1 1.5–3s emits a tool 2.5–4s, call 2 4–6s, overhead until 7s.
    const turnWithCalls = settle([call(0, 3000, 1500), tool(1, 2500, 'completed', 1500), call(2, 6000, 2000)], 7000);
    expect(Object.fromEntries(turnModelTime(turnWithCalls))).toEqual({ '-1': { ms: 1500 }, 1: { ms: 2000 } });
    const sequential = settle(
      [call(0, 1000, 1000), tool(1, 1000, 'completed', 100), tool(2, 1100, 'completed', 100), call(3, 2200, 1000)],
      2200,
    );
    expect(Object.fromEntries(turnModelTime(sequential))).toEqual({ '-1': { ms: 1000 }, 2: { ms: 1000 } });
  });

  it('ticks the live tail from the latest reported call end', () => {
    const live = timed([call(0, 2000, 1500), tool(1, 1800, 'completed', 500), call(2, 4000, 1500)]);
    expect(Object.fromEntries(turnModelTime(live))).toEqual({ '-1': { ms: 1500 }, 1: { ms: 1500, since: t0 + 4000 } });
    const running = timed([call(0, 2000, 1500), tool(1, 1800, 'running')]);
    expect(Object.fromEntries(turnModelTime(running))).toEqual({ '-1': { ms: 1500 } });
  });

  it('prepends a counted start row only to the segment that hosts the turn start, hiding call rows', () => {
    const live = timed([]);
    const [start] = withModelTime(live, [], turnModelTime(live), true);
    expect(parseStep(start.text)).toMatchObject({ id: 'ui:start:turn', text: 'Starting response…', status: 'running' });
    expect(start.modelTime).toEqual({ ms: 0, since: t0 });
    expect(activityStepCount([start])).toBe(1);
    const busy = timed([tool(0, 2000, 'completed', 1000)]);
    const lines = withModelTime(busy, busy.activity, turnModelTime(busy), true);
    expect(parseStep(lines[0].text)).toMatchObject({ text: 'Started response', status: 'completed' });
    expect(lines[1].modelTime).toEqual({ ms: 0, since: t0 + 3000 });
    expect(withModelTime(busy, busy.activity, turnModelTime(busy), false)).toHaveLength(1);
    const reported = settle([call(0, 2000, 1500), tool(1, 1800, 'completed', 500)], 2500);
    const shown = withModelTime(reported, reported.activity, turnModelTime(reported), true);
    expect(shown.map((line) => parseStep(line.text).kind)).toEqual(['notification', 'tool']);
    expect(shown.map((line) => line.modelTime)).toEqual([{ ms: 1500 }, undefined]);
  });
});
