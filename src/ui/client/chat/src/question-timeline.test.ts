import { describe, expect, it } from 'vitest';

import type { ChatMessage, PendingQuestionDto } from './types';
import { mergeQuestionTimeline } from './question-timeline';

function message(id: string, ts: string): ChatMessage {
  return { id, direction: 'out', text: id, files: null, ts };
}

function question(overrides: Partial<PendingQuestionDto> = {}): PendingQuestionDto {
  return {
    questionId: 'question-1',
    title: 'Release note',
    question: 'What should it say?',
    responseMode: 'text',
    options: [],
    status: 'pending',
    answerValue: null,
    answerType: null,
    answeredAt: null,
    threadId: 'thread-1',
    agentGroupId: 'group-1',
    createdAt: '2026-07-15 05:34:20',
    ...overrides,
  };
}

describe('mergeQuestionTimeline', () => {
  it('places a SQLite-timestamped question between surrounding ISO messages', () => {
    const result = mergeQuestionTimeline(
      [message('before', '2026-07-15T05:33:48.707Z'), message('after', '2026-07-15T05:35:43.000Z')],
      [question()],
      'thread-1',
    );

    expect(result.map((entry) => entry.id)).toEqual(['before', 'question-1', 'after']);
  });

  it('excludes questions belonging to another thread', () => {
    expect(mergeQuestionTimeline([], [question({ threadId: 'thread-2' })], 'thread-1')).toEqual([]);
  });

  it('places a question after a message with the same timestamp', () => {
    const result = mergeQuestionTimeline([message('message-1', '2026-07-15T05:34:20Z')], [question()], 'thread-1');
    expect(result.map((entry) => entry.id)).toEqual(['message-1', 'question-1']);
  });

  it('places an answered question at its answer time', () => {
    const result = mergeQuestionTimeline(
      [message('before', '2026-07-15T05:52:30.000Z'), message('after', '2026-07-15T05:53:20.000Z')],
      [
        question({
          status: 'answered',
          answerValue: 'Dude',
          answerType: 'text',
          createdAt: '2026-07-15T05:52:33.695Z',
          answeredAt: '2026-07-15T05:53:18.606Z',
        }),
      ],
      'thread-1',
    );

    expect(result.map((entry) => entry.id)).toEqual(['before', 'question-1', 'after']);
    expect(result[1]).toMatchObject({
      direction: 'question',
      ts: '2026-07-15T05:53:18.606Z',
      question: { answerValue: 'Dude' },
    });
  });

  it('keeps a pending question at its ask time', () => {
    const result = mergeQuestionTimeline(
      [],
      [
        question({
          createdAt: '2026-07-15T05:34:20Z',
        }),
      ],
      'thread-1',
    );

    expect(result[0]).toMatchObject({ direction: 'question', ts: '2026-07-15T05:34:20Z' });
  });
});
