import { describe, expect, it } from 'vitest';

import type { ConversationMessage, ConversationQuestion } from '../../shared/conversation.js';
import { conversationTimeline } from './conversation-timeline.js';

function questionTimeline(messages: ConversationMessage[], questions: ConversationQuestion[], threadId: string) {
  return conversationTimeline({
    threadId,
    messages,
    turns: [],
    questions,
    connection: { connected: true, activeTurnId: null },
    capabilities: { canSend: true, stop: false, steer: false, editInput: false, cancelInput: false },
  });
}

function message(id: string, timestamp: string): ConversationMessage {
  return { id, direction: 'out', text: id, timestamp };
}

function question(overrides: Partial<ConversationQuestion> = {}): ConversationQuestion {
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
    const result = questionTimeline(
      [message('before', '2026-07-15T05:33:48.707Z'), message('after', '2026-07-15T05:35:43.000Z')],
      [question()],
      'thread-1',
    );

    expect(result).toEqual([
      { kind: 'message', messageId: 'before' },
      { kind: 'question', questionId: 'question-1' },
      { kind: 'message', messageId: 'after' },
    ]);
  });

  it('excludes questions belonging to another thread', () => {
    expect(questionTimeline([], [question({ threadId: 'thread-2' })], 'thread-1')).toEqual([]);
  });

  it('places a question after a message with the same timestamp', () => {
    const result = questionTimeline([message('message-1', '2026-07-15T05:34:20Z')], [question()], 'thread-1');
    expect(result).toEqual([
      { kind: 'message', messageId: 'message-1' },
      { kind: 'question', questionId: 'question-1' },
    ]);
  });

  it('keeps questions after precise input positions in their millisecond without losing normal ordering', () => {
    const timestamp = '2026-07-15T05:34:20.000Z';
    const position = Date.parse(timestamp) * 1000;
    const result = questionTimeline(
      [
        { ...message('later-in-bucket', timestamp), timelinePosition: position + 9 },
        { ...message('triggering-input', timestamp), direction: 'in', timelinePosition: position + 1 },
        { ...message('later-output', timestamp), timelinePosition: position + 1001 },
      ],
      [question({ createdAt: timestamp })],
      'thread-1',
    );
    expect(result).toEqual([
      { kind: 'message', messageId: 'triggering-input' },
      { kind: 'message', messageId: 'later-in-bucket' },
      { kind: 'question', questionId: 'question-1' },
      { kind: 'message', messageId: 'later-output' },
    ]);
  });

  it('keeps the asked event at its ask time even after the question is answered', () => {
    const result = questionTimeline(
      [message('before', '2026-07-15T05:53:00.000Z'), message('after', '2026-07-15T05:53:20.000Z')],
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

    expect(result).toEqual([
      { kind: 'question', questionId: 'question-1' },
      { kind: 'message', messageId: 'before' },
      { kind: 'message', messageId: 'after' },
    ]);
  });

  it('orders asked and answered records independently despite backwards answer timestamps', () => {
    const base = Date.parse('2026-07-15T05:52:00Z') * 1000;
    const result = questionTimeline(
      [
        { ...message('asking-reply', '2026-07-15T05:52:20Z'), timelinePosition: base + 20_000_000 },
        { ...message('answer-reply', '2026-07-15T05:52:40Z'), timelinePosition: base + 40_000_000 },
        {
          ...message('answer-input', '2026-07-15T05:52:15Z'),
          direction: 'in',
          questionId: 'question-1',
          timelinePosition: base + 30_000_000,
        },
      ],
      [
        question({
          status: 'answered',
          answerValue: 'Dude',
          answerType: 'text',
          createdAt: '2026-07-15T05:52:10Z',
          answeredAt: '2026-07-15T05:52:15Z',
          timelinePosition: base + 10_000_000,
        }),
      ],
      'thread-1',
    );
    expect(
      result.map((row) =>
        row.kind === 'question' ? row.questionId : row.kind === 'message' ? row.messageId : row.turnId,
      ),
    ).toEqual(['question-1', 'asking-reply', 'answer-input', 'answer-reply']);
  });

  it('keeps a pending question at its ask time', () => {
    const result = questionTimeline(
      [],
      [
        question({
          createdAt: '2026-07-15T05:34:20Z',
        }),
      ],
      'thread-1',
    );

    expect(result).toEqual([{ kind: 'question', questionId: 'question-1' }]);
  });
});
