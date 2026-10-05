import { describe, expect, it } from 'vitest';
import { dockQuestions } from './question-dock';
import type { PendingQuestionDto } from './types';
import type { ConversationMessage } from '../../../shared/conversation';

const question: PendingQuestionDto = {
  questionId: 'q',
  question: 'Choose?',
  responseMode: 'text',
  options: [],
  status: 'pending',
  answerValue: null,
  answerType: null,
  answeredAt: null,
  threadId: 'thread',
  agentGroupId: 'group',
  createdAt: '2026-10-05T17:00:00Z',
  timelinePosition: 100,
};
const answer: ConversationMessage = {
  id: 'question-response:q',
  direction: 'in',
  text: 'Yes',
  questionId: 'q',
  timestamp: 'later',
};
describe('question input dock', () => {
  it('keeps pending and metadata-only answered prompts until an actual input answer is available', () => {
    expect(dockQuestions([question], [], 'group', 'thread')).toEqual([question]);
    const answered: PendingQuestionDto = { ...question, status: 'answered', answerValue: 'Yes' };
    expect(dockQuestions([answered], [], 'group', 'thread')).toEqual([answered]);
    expect(dockQuestions([answered], [answer], 'group', 'thread')).toEqual([]);
    expect(dockQuestions([question], [answer], 'group', 'thread')).toEqual([]);
  });
  it('scopes prompts to the current group and thread and omits cancellations', () => {
    expect(
      dockQuestions(
        [
          question,
          { ...question, questionId: 'off-thread', threadId: 'other' },
          { ...question, questionId: 'off-group', agentGroupId: 'other' },
          { ...question, questionId: 'cancelled', status: 'cancelled' },
          { ...question, questionId: 'unthreaded', threadId: null },
        ],
        [],
        'group',
        'thread',
      ).map((q) => q.questionId),
    ).toEqual(['q', 'unthreaded']);
  });
  it('waits for the actual skip event, then removes only the resolved prompt', () => {
    const skipped: PendingQuestionDto = { ...question, status: 'answered', answerType: 'skipped' };
    const other = { ...question, questionId: 'other' };
    expect(dockQuestions([skipped, other], [], 'group', 'thread')).toEqual([skipped, other]);
    expect(
      dockQuestions(
        [skipped, other],
        [{ ...answer, text: 'Question skipped', questionResponseType: 'skipped' }],
        'group',
        'thread',
      ),
    ).toEqual([other]);
  });
  it('orders multiple prompts by recorded position without changing records', () => {
    const questions = [{ ...question, questionId: 'second', timelinePosition: 200 }, question];
    expect(dockQuestions(questions, [], 'group', 'thread').map((q) => q.questionId)).toEqual(['q', 'second']);
    expect(questions[0].questionId).toBe('second');
  });
  it('does not treat outbound or cancelled inputs as answer events', () => {
    expect(
      dockQuestions(
        [question],
        [
          { ...answer, direction: 'out' },
          { ...answer, inputState: { messageId: answer.id, status: 'cancelled' } },
        ],
        'group',
        'thread',
      ),
    ).toEqual([question]);
  });
});
