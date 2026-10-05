import { describe, expect, it } from 'vitest';
import { BUILTIN_TOOL_PRESENTATIONS, parseStep, stepHeadline } from './activity-presentation.js';
import { conversationActivity } from './conversation-activity.js';
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
  liveUsage: null,
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

  it('represents every builtin call once and adds only turn completion', () => {
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
    expect(steps.filter((step) => step.kind !== 'tool')).toEqual([
      { kind: 'notification', id: 'ui:done:turn', text: 'Done' },
    ]);
  });

  it.each(['running', 'stopping', 'settling'] as const)('does not invent Done while %s', (phase) => {
    expect(conversationActivity({ ...turn, phase }).map((line) => parseStep(line.text).text)).not.toContain('Done');
  });

  it.each(['replied', 'silent', 'stopped', 'failed', 'warning', 'interrupted', 'unknown'] as const)(
    'adds exactly one display-only Done marker after %s settlement',
    (outcome) => {
      const settled = { ...turn, phase: 'settled' as const, outcome, endedAt: '2026-10-04T19:01:00Z' };
      const before = JSON.stringify(settled);
      const lines = conversationActivity(settled);
      expect(lines).toHaveLength(4);
      expect(parseStep(lines.at(-1)!.text)).toEqual({
        kind: 'notification',
        id: 'ui:done:turn',
        text: 'Done',
      });
      expect(lines.at(-1)!.ts).toBe(String(Date.parse(settled.endedAt)));
      expect(conversationActivity(settled)).toEqual(lines);
      expect(JSON.stringify(settled)).toBe(before);
      expect(settled.activity).toHaveLength(3);
    },
  );

  it('retains Done for an outputless turn without recorded activities or timestamps', () => {
    const lines = conversationActivity({ ...turn, phase: 'settled', outcome: 'silent', activity: [] });
    expect(lines).toHaveLength(1);
    expect(lines[0].ts).toBe('');
    expect(stepHeadline(parseStep(lines[0].text))).toEqual({ action: 'Done' });
  });
});
