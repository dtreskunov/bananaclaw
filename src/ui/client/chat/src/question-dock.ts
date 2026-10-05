import type { ConversationMessage } from '../../../shared/conversation';
import { timelineSortKey } from '../../../shared/timeline';
import type { PendingQuestionDto } from './types';

export function dockQuestions(
  questions: PendingQuestionDto[],
  messages: ConversationMessage[],
  groupId: string | null,
  threadId: string | null,
): PendingQuestionDto[] {
  const answered = new Set(
    messages
      .filter((message) => message.direction === 'in' && message.inputState?.status !== 'cancelled')
      .map((message) => message.questionId),
  );
  return questions
    .filter(
      (question) =>
        question.agentGroupId === groupId &&
        (!question.threadId || question.threadId === threadId) &&
        question.status !== 'cancelled' &&
        !answered.has(question.questionId),
    )
    .sort(
      (a, b) => timelineSortKey(a.createdAt, a.timelinePosition) - timelineSortKey(b.createdAt, b.timelinePosition),
    );
}
