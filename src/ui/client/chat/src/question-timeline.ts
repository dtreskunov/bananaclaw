import type { ChatMessage, PendingQuestionDto } from './types';

function timestampMs(timestamp: string): number {
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(timestamp)
    ? timestamp.replace(' ', 'T') + 'Z'
    : timestamp;
  const value = Date.parse(normalized);
  return Number.isNaN(value) ? 0 : value;
}

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
    const byTime = timestampMs(left.ts) - timestampMs(right.ts);
    if (byTime !== 0) return byTime;
    return left.direction === 'question' ? 1 : right.direction === 'question' ? -1 : 0;
  });
}
