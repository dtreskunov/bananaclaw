import { describe, expect, it } from 'vitest';

import type { ChatMessage, PendingQuestionDto } from './types';
import { testSnapshot } from './conversation-test-fixtures';
import type { ConversationTimelineRow } from '../../../shared/conversation';

function mergeQuestionTimeline(messages: ChatMessage[], questions: PendingQuestionDto[], threadId: string) {
  return testSnapshot({
    threadId,
    messages: messages.map(({ ts, files: _files, ...message }) => ({
      ...message,
      id: message.id!,
      timestamp: ts,
    })),
    questions,
  }).conversation.timeline;
}
function rowId(row: ConversationTimelineRow): string {
  return row.kind === 'message' ? row.messageId : row.kind === 'question' ? row.questionId : row.turnId;
}

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

describe('host question presentation order', () => {
  it('places a SQLite-timestamped question between surrounding ISO messages', () => {
    const result = mergeQuestionTimeline(
      [message('before', '2026-07-15T05:33:48.707Z'), message('after', '2026-07-15T05:35:43.000Z')],
      [question()],
      'thread-1',
    );

    expect(result.map(rowId)).toEqual(['before', 'question-1', 'after']);
  });

  it('excludes questions belonging to another thread', () => {
    expect(mergeQuestionTimeline([], [question({ threadId: 'thread-2' })], 'thread-1')).toEqual([]);
  });

  it('places a question after a message with the same timestamp', () => {
    const result = mergeQuestionTimeline([message('message-1', '2026-07-15T05:34:20Z')], [question()], 'thread-1');
    expect(result.map(rowId)).toEqual(['message-1', 'question-1']);
  });

  it('keeps questions after precise input positions in their millisecond without losing normal ordering', () => {
    const timestamp = '2026-07-15T05:34:20.000Z';
    const position = Date.parse(timestamp) * 1000;
    const result = mergeQuestionTimeline(
      [
        { ...message('later-in-bucket', timestamp), timelinePosition: position + 9 },
        { ...message('triggering-input', timestamp), direction: 'in', timelinePosition: position + 1 },
        { ...message('later-output', timestamp), timelinePosition: position + 1001 },
      ],
      [question({ createdAt: timestamp })],
      'thread-1',
    );
    expect(result.map(rowId)).toEqual(['triggering-input', 'later-in-bucket', 'question-1', 'later-output']);
    expect(result[0]).toEqual({ kind: 'message', messageId: 'triggering-input' });
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

    expect(result.map(rowId)).toEqual(['before', 'question-1', 'after']);
    expect(result[1]).toEqual({ kind: 'question', questionId: 'question-1' });
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

    expect(result[0]).toEqual({ kind: 'question', questionId: 'question-1' });
  });
});
