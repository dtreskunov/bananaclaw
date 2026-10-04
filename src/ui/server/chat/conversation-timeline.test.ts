import { describe, expect, it } from 'vitest';
import type { Conversation, ConversationMessage, ConversationTurn } from '../../shared/conversation.js';
import { parseConversationFrame, reduceConversation } from '../../shared/conversation-protocol.js';
import { conversationTimeline } from './conversation-timeline.js';

const turn: ConversationTurn = {
  id: 'turn',
  phase: 'running',
  outcome: 'pending',
  startedAt: 'not-an-order-key',
  endedAt: null,
  inputIds: ['ask'],
  outputIds: [],
  activity: [],
  usage: [],
  liveUsage: null,
  metadata: { status: 'provisional', durationMs: null, model: null },
};
const message = (id: string, direction: 'in' | 'out', timelinePosition: number): ConversationMessage => ({
  id,
  direction,
  timelinePosition,
  timestamp: 'identical-or-invalid',
  text: id,
});
const activity = (ordinal: number, timelinePosition: number) => ({
  ordinal,
  ts: String(1000 - ordinal),
  text: `step ${ordinal}`,
  timelinePosition,
});
function present(messages: ConversationMessage[], current: ConversationTurn = turn): Conversation {
  const view = {
    threadId: 'thread',
    messages,
    turns: [current],
    questions: [],
    connection: { connected: true, activeTurnId: current.phase === 'settled' ? null : current.id },
    capabilities: { canSend: true, stop: true, steer: true, editInput: true, cancelInput: true },
  };
  return { ...view, timeline: conversationTimeline(view) };
}
function validate(view: Conversation): void {
  expect(
    reduceConversation(
      null,
      parseConversationFrame({
        kind: 'snapshot',
        protocolVersion: 2,
        streamId: 'test',
        revision: 0,
        conversation: view,
      }),
    ).conversation,
  ).toEqual(view);
}

describe('explicit host trace placement', () => {
  it('uses recorded order across mid-turn output and steering despite colliding/backwards timestamps and final reanchoring', () => {
    const messages = [
      message('final', 'out', 600),
      message('steer', 'in', 400),
      message('ask', 'in', 100),
      message('early', 'out', 200),
    ];
    const view = present(messages, {
      ...turn,
      phase: 'settled',
      outcome: 'replied',
      inputIds: ['ask', 'steer'],
      outputIds: ['early', 'final'],
      activity: [activity(0, 150), activity(1, 250), activity(2, 450), activity(3, 650)],
    });
    expect(view.timeline).toEqual([
      { kind: 'message', messageId: 'ask' },
      { kind: 'message', messageId: 'early' },
      { kind: 'message', messageId: 'steer' },
      {
        kind: 'message',
        messageId: 'final',
        statsTurnId: 'turn',
        trace: { turnId: 'turn', ordinals: [0, 1, 2, 3], ownsTurn: true },
      },
    ]);
    validate(view);
  });

  it('requires activity positions instead of interpreting older payloads', () => {
    const view = present([message('ask', 'in', 100), message('early', 'out', 200), message('final', 'out', 300)], {
      ...turn,
      phase: 'settled',
      outcome: 'replied',
      outputIds: ['early', 'final'],
      activity: [activity(0, 150)],
    });
    expect(view.timeline[1]).toEqual({ kind: 'message', messageId: 'early' });
    expect(view.timeline[2]).toMatchObject({ messageId: 'final', trace: { ordinals: [0], ownsTurn: true } });
    validate(view);
    const invalid = structuredClone(view);
    Reflect.deleteProperty(invalid.turns[0].activity[0], 'timelinePosition');
    expect(() =>
      parseConversationFrame({
        kind: 'snapshot',
        protocolVersion: 2,
        streamId: 'test',
        revision: 0,
        conversation: invalid,
      }),
    ).toThrow('invalid_frame');
  });

  it('keeps the whole live trace in one synthetic bubble across intermediate outputs', () => {
    const messages = [message('ask', 'in', 100), message('early', 'out', 200)];
    const current = { ...turn, outputIds: ['early'], activity: [activity(0, 150)] };
    const early = present(messages, current);
    expect(early.timeline[1]).toEqual({ kind: 'message', messageId: 'early' });
    expect(early.timeline[2]).toMatchObject({
      kind: 'turn',
      afterId: 'early',
      status: true,
      trace: { ordinals: [0], ownsTurn: true },
    });
    validate(early);
    const tail = present(messages, { ...current, activity: [...current.activity, activity(1, 250)] });
    expect(tail.timeline[1]).toEqual({ kind: 'message', messageId: 'early' });
    expect(tail.timeline[2]).toMatchObject({ kind: 'turn', trace: { ordinals: [0, 1], ownsTurn: true } });
    validate(tail);
  });

  it('keeps questions in conversation order without splitting or hosting the turn trace', () => {
    const view = present([message('ask', 'in', 100)], {
      ...turn,
      outputIds: ['question-output'],
      activity: [activity(0, 150)],
    });
    view.questions = [
      {
        questionId: 'question',
        messageId: 'question-output',
        timelinePosition: 200,
        turnId: turn.id,
        title: '',
        question: 'Choose?',
        responseMode: 'text',
        options: [],
        status: 'pending',
        answerValue: null,
        answerType: null,
        answeredAt: null,
        threadId: 'thread',
        agentGroupId: 'group',
        createdAt: 'not-an-order-key',
      },
    ];
    view.timeline = conversationTimeline(view);
    expect(view.timeline[1]).toEqual({
      kind: 'question',
      questionId: 'question',
    });
    expect(view.timeline[2]).toEqual({
      kind: 'turn',
      turnId: 'turn',
      afterId: 'question-output',
      status: true,
      trace: { turnId: 'turn', ordinals: [0], ownsTurn: true },
    });
    expect(view.messages.map((item) => item.id)).toEqual(['ask']);
    validate(view);
  });

  it.each(['silent', 'stopped', 'failed', 'interrupted', 'unknown'] as const)(
    'uses a synthetic bubble for %s turns with no final response, even after intermediate output',
    (outcome) => {
      const view = present(
        [
          message('ask', 'in', 100),
          { ...message('update', 'out', 200), deliveryOrigin: 'send_message' },
          { ...message('queued', 'in', 500), inputState: { messageId: 'queued', status: 'queued' } },
        ],
        {
          ...turn,
          phase: 'settled',
          outcome,
          outputIds: ['update'],
          activity: [activity(0, 150)],
        },
      );
      expect(view.timeline).toEqual([
        { kind: 'message', messageId: 'ask' },
        { kind: 'message', messageId: 'update' },
        {
          kind: 'turn',
          turnId: 'turn',
          afterId: 'update',
          status: true,
          trace: { turnId: 'turn', ordinals: [0], ownsTurn: true },
        },
        { kind: 'message', messageId: 'queued' },
      ]);
      validate(view);
    },
  );

  it('moves one live trace after all applied steering without changing its owner or activity membership', () => {
    const view = present(
      [
        message('ask', 'in', 100),
        { ...message('steer-1', 'in', 200), inputState: { messageId: 'steer-1', status: 'applied' } },
        { ...message('steer-2', 'in', 400), inputState: { messageId: 'steer-2', status: 'applied' } },
      ],
      { ...turn, inputIds: ['ask', 'steer-1', 'steer-2'], activity: [activity(0, 150), activity(1, 300)] },
    );
    expect(view.timeline.at(-1)).toEqual({
      kind: 'turn',
      turnId: 'turn',
      afterId: 'steer-2',
      status: true,
      trace: { turnId: 'turn', ordinals: [0, 1], ownsTurn: true },
    });
    expect(view.timeline.filter((row) => row.trace)).toHaveLength(1);
    validate(view);
  });

  it('rejects invented activity references and duplicate owners before changing state', () => {
    const view = present([message('ask', 'in', 100)], { ...turn, activity: [activity(0, 150)] });
    for (const timeline of [
      [
        { kind: 'message' as const, messageId: 'ask' },
        {
          kind: 'turn' as const,
          turnId: 'turn',
          afterId: 'ask',
          status: true,
          trace: { turnId: 'turn', ordinals: [99], ownsTurn: true },
        },
      ],
      [
        ...view.timeline,
        {
          kind: 'turn' as const,
          turnId: 'turn',
          afterId: null,
          status: false,
          trace: { turnId: 'turn', ordinals: [], ownsTurn: true },
        },
      ],
    ]) {
      expect(() =>
        reduceConversation(
          null,
          parseConversationFrame({
            kind: 'snapshot',
            protocolVersion: 2,
            streamId: 'test',
            revision: 0,
            conversation: { ...view, timeline },
          }),
        ),
      ).toThrow('invalid_frame');
    }
  });
});
