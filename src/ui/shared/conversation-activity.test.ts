import { describe, expect, it } from 'vitest';
import { parseStep, stepHeadline } from './activity-presentation.js';
import { conversationActivity } from './conversation-activity.js';
import type { ConversationQuestion, ConversationTurn } from './conversation.js';

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
      ts: '1000',
      text: '{"kind":"tool","id":"last","tool":"read","status":"completed"}',
      timelinePosition: 300,
    },
  ],
};
const question: ConversationQuestion = {
  questionId: 'question',
  messageId: 'question-output',
  turnId: turn.id,
  timelinePosition: 200,
  title: '',
  question: 'Which option do you prefer?\nKeep <literal> text.',
  responseMode: 'text',
  options: [],
  status: 'pending',
  answerValue: null,
  answerType: null,
  answeredAt: null,
  threadId: 'thread',
  agentGroupId: 'group',
  createdAt: '2026-10-04T19:00:00Z',
};

describe('whole-turn activity presentation', () => {
  it('inserts question markers by recorded order, not activity or answer timestamps', () => {
    const lines = conversationActivity(turn, [question]);
    expect(lines.map((line) => parseStep(line.text).id)).toEqual(['first', 'ui:question:question', 'last']);
    expect(stepHeadline(parseStep(lines[1].text))).toEqual({
      action: 'Asked a question',
      subject: 'Which option do you prefer? Keep <literal> text.',
      codeSubject: true,
    });
    expect(parseStep(lines[1].text).detail).toBe(question.question);
    expect(
      conversationActivity(turn, [
        {
          ...question,
          status: 'answered',
          answeredAt: '2026-10-05T00:00:00Z',
          answerValue: 'First option',
        },
      ]),
    ).toEqual(lines);
  });

  it('uses explicit turn/output associations and never takes another turn question', () => {
    expect(conversationActivity(turn, [{ ...question, turnId: 'other' }])).toEqual(turn.activity);
    expect(conversationActivity(turn, [{ ...question, turnId: undefined, messageId: 'unrelated' }])).toEqual(
      turn.activity,
    );
    expect(conversationActivity(turn, [{ ...question, turnId: undefined }])).toHaveLength(3);
  });

  it.each(['running', 'stopping', 'settling'] as const)('does not invent Done while %s', (phase) => {
    expect(conversationActivity({ ...turn, phase }, []).map((line) => parseStep(line.text).text)).not.toContain('Done');
  });

  it.each(['replied', 'silent', 'stopped', 'failed', 'warning', 'interrupted', 'unknown'] as const)(
    'adds exactly one display-only Done marker after %s settlement',
    (outcome) => {
      const settled = { ...turn, phase: 'settled' as const, outcome, endedAt: '2026-10-04T19:01:00Z' };
      const before = JSON.stringify({ settled, question });
      const lines = conversationActivity(settled, [question]);
      expect(lines).toHaveLength(4);
      expect(parseStep(lines.at(-1)!.text)).toEqual({
        kind: 'notification',
        id: 'ui:done:turn',
        text: 'Done',
      });
      expect(lines.at(-1)!.ts).toBe(String(Date.parse(settled.endedAt)));
      expect(conversationActivity(settled, [question])).toEqual(lines);
      expect(JSON.stringify({ settled, question })).toBe(before);
      expect(settled.activity).toHaveLength(2);
    },
  );

  it('retains Done for an outputless turn without recorded activities or timestamps', () => {
    const lines = conversationActivity({ ...turn, phase: 'settled', outcome: 'silent', activity: [] }, []);
    expect(lines).toHaveLength(1);
    expect(lines[0].ts).toBe('');
    expect(stepHeadline(parseStep(lines[0].text))).toEqual({ action: 'Done' });
  });
});
