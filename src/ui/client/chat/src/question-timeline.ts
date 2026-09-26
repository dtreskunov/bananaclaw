import type { ChatMessage, PendingQuestionDto } from './types';
import { timelineSortKey } from '../../../shared/timeline';

export function mergeQuestionTimeline(
  messages: ChatMessage[],
  questions: PendingQuestionDto[],
  currentThreadId: string | null,
): ChatMessage[] {
  const questionMessages = questions
    .filter((question) => !question.threadId || question.threadId === currentThreadId)
    .map(
      (question): ChatMessage => ({
        id: question.questionId,
        direction: 'question',
        text: question.question,
        files: null,
        ts: question.status === 'answered' && question.answeredAt ? question.answeredAt : question.createdAt,
        question,
      }),
    );

  return [...messages, ...questionMessages].sort((left, right) => {
    const leftKey = timelineSortKey(left.ts, left.timelinePosition);
    const rightKey = timelineSortKey(right.ts, right.timelinePosition);
    const byMillisecond = Math.floor(leftKey / 1000) - Math.floor(rightKey / 1000);
    if (byMillisecond !== 0) return byMillisecond;
    const byQuestion = Number(left.direction === 'question') - Number(right.direction === 'question');
    return byQuestion || leftKey - rightKey;
  });
}
