import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearChat, openChat } from './actions';
import {
  chatTranscript,
  completedResponse,
  conversationPresentation,
  conversationState,
  resetConversation,
} from './conversation-state';
import {
  activityTraceOwner,
  activityTraceExpanded,
  toggleActivityTrace,
  activityMetricsExpanded,
  toggleActivityMetrics,
} from './activity-trace-state';
import { CONVERSATION_PROTOCOL_VERSION, diffConversation } from '../../../shared/conversation-protocol';
import { dockQuestions } from './question-dock';
import type { Conversation } from '../../../shared/conversation';
import { presentedConversation, testSnapshot, testTurn } from './conversation-test-fixtures';
import {
  activeTurn,
  chatMessages,
  chatReady,
  chatReloadRequired,
  chatStatus,
  groupId,
  highlightMessageId,
  pending,
  threadId,
  toastMessage,
} from './state';
import { dismissToast } from './components/Toast';
import { appearance } from './appearance-state';
import { DEFAULT_APPEARANCE } from './appearance';
import { isOutcomeTraceStep, parseStep } from '../../../shared/activity-presentation';

vi.hoisted(() => vi.stubGlobal('window', { matchMedia: () => ({ matches: false }) }));
vi.mock('./hash', () => ({ writeHash: vi.fn() }));
let receive: (payload: unknown) => void;
const initial: Conversation = testSnapshot({
  turns: [testTurn],
  connection: { connected: true, activeTurnId: testTurn.id },
  capabilities: { canSend: true, stop: true, steer: true, editInput: true, cancelInput: true },
}).conversation;
function update(next: Conversation): void {
  next = presentedConversation(next);
  const state = conversationState.value!;
  receive({
    kind: 'update',
    protocolVersion: CONVERSATION_PROTOCOL_VERSION,
    streamId: state.streamId,
    baseRevision: state.revision,
    revision: state.revision + 1,
    changes: diffConversation(state.conversation, next),
  });
}
beforeEach(async () => {
  appearance.value = { preferences: { ...DEFAULT_APPEARANCE }, resolvedMode: 'light', error: null };
  vi.useFakeTimers();
  const sockets: Array<{ onmessage?: (event: { data: string }) => void }> = [];
  vi.stubGlobal('location', { protocol: 'https:', host: 'example.test' });
  vi.stubGlobal(
    'WebSocket',
    class {
      constructor() {
        sockets.push(this);
      }
      onmessage?: (event: { data: string }) => void;
      close() {}
    },
  );
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ approvals: [] }) }));
  vi.spyOn(console, 'error').mockImplementation(() => {});
  threadId.value = null;
  highlightMessageId.value = 'skip-focus';
  await openChat('group', 'thread', null);
  receive = (payload) => sockets[0].onmessage?.({ data: JSON.stringify(payload) });
  receive(testSnapshot(initial));
});
afterEach(() => {
  clearChat();
  groupId.value = null;
  pending.value = [];
  while (toastMessage.value) dismissToast();
  vi.useRealTimers();
  vi.restoreAllMocks();
});
describe('authoritative turn presentation', () => {
  it('resolves the supplied layout without parsing timestamps or fabricating messages', () => {
    const view = testSnapshot({
      messages: [{ id: 'input', direction: 'in', text: 'ask', timestamp: 'invalid', timelinePosition: 50 }],
      turns: [{ ...testTurn, inputIds: ['input'], startedAt: null }],
    }).conversation;
    const parse = vi.spyOn(Date, 'parse').mockImplementation(() => {
      throw new Error('Timestamp inference is forbidden');
    });
    const projection = conversationPresentation(view);
    expect(projection.messages.map((message) => message.id)).toEqual(['input']);
    expect(projection.transcript.map((row) => row.kind)).toEqual(['message', 'turn']);
    expect(projection.transcript[1]).not.toHaveProperty('id');
    parse.mockRestore();
  });
  it('preserves an open disclosure through activity updates', () => {
    const steps = [0, 1].map((ordinal) => ({
      ordinal,
      ts: String(1000 + ordinal),
      timelinePosition: 100 + ordinal,
      text: JSON.stringify({ kind: 'tool', id: `step-${ordinal}`, tool: 'bash', status: 'running' }),
    }));
    const traceId = 'turn:turn-1';
    toggleActivityTrace(traceId);
    update({ ...initial, turns: [{ ...testTurn, activity: steps }] });
    expect(activityTraceExpanded(traceId)).toBe(true);
    update({
      ...initial,
      turns: [
        {
          ...testTurn,
          activity: [
            ...steps,
            {
              ordinal: 2,
              ts: '1002',
              timelinePosition: 102,
              text: JSON.stringify({ kind: 'tool', id: 'step-2', tool: 'read', status: 'running' }),
            },
          ],
        },
      ],
    });
    expect(activityTraceExpanded(traceId)).toBe(true);
  });
  it('moves an expanded live trace to the reply and requests its top on completion', () => {
    const traceId = 'turn:turn-1';
    toggleActivityTrace(traceId);
    const settled: Conversation = {
      ...initial,
      messages: [
        { id: 'reply', direction: 'out', turnId: testTurn.id, text: 'Done', timestamp: '2026-09-29T00:00:02Z' },
      ],
      turns: [{ ...testTurn, phase: 'settled', outcome: 'replied', outputIds: ['reply'] }],
      connection: { connected: true, activeTurnId: null },
    };
    update(settled);
    const reply = chatMessages.value.find((message) => message.id === 'reply')!;
    expect(reply.turnTraceOwner).toBe(true);
    expect(activityTraceOwner(reply)).toBe(traceId);
    expect(activityTraceExpanded(traceId)).toBe(true);
    expect(completedResponse.value).toBe('reply');
  });

  it('keeps turn ownership on one live bubble across intermediate responses and tail activity', () => {
    const traceId = 'turn:turn-1';
    toggleActivityTrace(traceId);
    const reply = {
      id: 'early-reply',
      direction: 'out' as const,
      deliveryOrigin: 'send_message' as const,
      turnId: testTurn.id,
      text: 'Still working',
      timestamp: '2026-09-29T00:00:02Z',
      timelinePosition: 200,
    };
    const early = {
      ...initial,
      messages: [reply],
      turns: [{ ...testTurn, outputIds: [reply.id] }],
    };
    update(early);
    expect(chatMessages.value.find((message) => message.id === reply.id)?.activity).toBeUndefined();
    expect(chatTranscript.value.find((row) => row.kind === 'turn')).toMatchObject({
      traceOwner: traceId,
      afterId: reply.id,
      activity: [expect.objectContaining({ text: expect.stringContaining('"ui:start:turn-1"') }), ...testTurn.activity],
    });
    expect(activityTraceExpanded(traceId)).toBe(true);

    const tail = {
      ordinal: 1,
      ts: String(Date.parse('2026-09-29T00:00:03Z')),
      text: JSON.stringify({ kind: 'tool', id: 'tail', tool: 'bash', status: 'running' }),
      timelinePosition: 300,
    };
    update({ ...early, turns: [{ ...testTurn, outputIds: [reply.id], activity: [...testTurn.activity, tail] }] });
    expect(chatMessages.value.find((message) => message.id === reply.id)?.turnTraceOwner).toBeUndefined();
    expect(
      chatTranscript.value.find(
        (row) => row.kind === 'turn' && row.activity.some((line) => line.ordinal === tail.ordinal),
      ),
    ).toMatchObject({ traceOwner: traceId });
    expect(activityTraceExpanded(traceId)).toBe(true);
  });

  it('does not request completion scrolling for a settled reconnect snapshot', () => {
    const settled: Conversation = {
      ...initial,
      messages: [
        { id: 'old-reply', direction: 'out', turnId: testTurn.id, text: 'Done', timestamp: '2026-09-29T00:00:02Z' },
      ],
      turns: [{ ...testTurn, phase: 'settled', outcome: 'replied', outputIds: ['old-reply'] }],
      connection: { connected: true, activeTurnId: null },
    };
    receive(testSnapshot(settled, 'reconnect'));
    expect(completedResponse.value).toBeNull();
  });

  it.each([
    ['text', false],
    ['text', true],
    ['skipped', false],
    ['skipped', true],
  ] as const)('keeps the %s dock lifecycle separate from turn traces; final response = %s', (responseType, final) => {
    const question: Conversation['questions'][number] = {
      questionId: 'q',
      messageId: 'q-output',
      turnId: testTurn.id,
      timelinePosition: 100,
      question: 'Choose?',
      responseMode: 'text',
      options: [],
      status: 'pending',
      answerValue: null,
      answerType: null,
      answeredAt: null,
      threadId: 'thread',
      agentGroupId: 'group',
      createdAt: '2026-09-29T00:00:01Z',
    };
    const asking: Conversation = presentedConversation({
      ...initial,
      questions: [question],
      messages: final
        ? [
            {
              id: 'reply',
              direction: 'out',
              text: 'Waiting',
              turnId: testTurn.id,
              deliveryOrigin: 'response',
              timestamp: '2026-09-29T00:00:02Z',
              timelinePosition: 200,
            },
          ]
        : [],
      turns: [
        {
          ...testTurn,
          phase: 'settled',
          outcome: final ? 'replied' : 'silent',
          outputIds: final ? ['q-output', 'reply'] : ['q-output'],
        },
      ],
      connection: { connected: true, activeTurnId: null },
    });
    receive(testSnapshot(asking, 'asking'));
    const metadataOnly: Conversation = {
      ...asking,
      questions: [
        {
          ...question,
          status: 'answered',
          answerValue: responseType === 'skipped' ? null : 'Stale metadata',
          answerType: responseType,
          answeredAt: '2026-09-29T00:00:09Z',
        },
      ],
    };
    update(metadataOnly);
    expect(dockQuestions(metadataOnly.questions, metadataOnly.messages, 'group', 'thread')).toEqual(
      metadataOnly.questions,
    );
    const answer: Conversation['messages'][number] = {
      id: 'question-response:q',
      direction: 'in',
      questionId: 'q',
      text: responseType === 'skipped' ? 'Question skipped' : 'Yes',
      ...(responseType === 'skipped' ? { questionResponseType: 'skipped' as const } : {}),
      timestamp: '2026-09-29T00:00:03Z',
      timelinePosition: 300,
    };
    const answered: Conversation = presentedConversation({
      ...metadataOnly,
      messages: [...asking.messages, answer],
      turns: [...asking.turns, { ...testTurn, id: 'answer-turn', activity: [], inputIds: [answer.id] }],
      connection: { connected: true, activeTurnId: 'answer-turn' },
    });
    update(answered);
    const cardRows = chatTranscript.value.filter((row) => row.kind === 'question-answer');
    const { timestamp: answerTimestamp, ...answerFields } = answer;
    expect(cardRows).toEqual([
      {
        kind: 'question-answer',
        question: metadataOnly.questions[0],
        answer: { ...answerFields, ts: answerTimestamp, files: null },
      },
    ]);
    expect(dockQuestions(answered.questions, answered.messages, 'group', 'thread')).toEqual([]);
    expect(conversationState.value?.conversation.timeline.slice(0, asking.timeline.length)).toEqual(asking.timeline);
    const originalTrace = chatTranscript.value.find((row) =>
      row.kind === 'turn' ? row.turn.id === testTurn.id : row.kind === 'message' && row.message.turnId === testTurn.id,
    );
    expect(originalTrace).toBeDefined();
    expect(chatTranscript.value.at(-1)).toMatchObject({
      kind: 'turn',
      turn: { id: 'answer-turn' },
      afterId: answer.id,
    });
    receive(testSnapshot(answered, 'reconnected'));
    expect(chatTranscript.value.filter((row) => row.kind === 'question-answer')).toEqual(cardRows);
    expect(completedResponse.value).toBeNull();
  });

  it.each([false, true])(
    'keeps the question in the dock without synthesizing question activity; recorded call = %s',
    (recorded) => {
      const question: Conversation['questions'][number] = {
        questionId: 'question',
        messageId: 'question-output',
        turnId: testTurn.id,
        timelinePosition: 200,
        question: 'Which option?',
        responseMode: 'text',
        options: [],
        status: 'pending',
        answerValue: null,
        answerType: null,
        answeredAt: null,
        threadId: 'thread',
        agentGroupId: 'group',
        createdAt: '2026-09-29T00:00:01Z',
      };
      const activity = recorded
        ? [
            {
              ordinal: 0,
              ts: '1000',
              timelinePosition: 100,
              text: JSON.stringify({
                kind: 'tool',
                id: 'question-call',
                tool: 'nanoclaw.ask_user_question',
                status: 'completed',
                detail: question.question,
              }),
            },
          ]
        : [];
      const view = testSnapshot({
        questions: [question],
        turns: [
          { ...testTurn, phase: 'settled', outcome: 'replied', activity, outputIds: ['question-output', 'reply'] },
        ],
        messages: [
          {
            id: 'reply',
            direction: 'out',
            turnId: testTurn.id,
            text: 'Waiting for your answer',
            timestamp: '2026-09-29T00:00:02Z',
            timelinePosition: 300,
            deliveryOrigin: 'response',
          },
        ],
      }).conversation;
      const projection = conversationPresentation(view);
      expect(dockQuestions(view.questions, view.messages, 'group', 'thread')).toEqual([question]);
      const steps = projection.messages[0].activity!.map((line) => JSON.parse(line.text));
      expect(steps.map((step) => step.id)).toEqual(recorded ? ['ui:start:turn-1', 'question-call'] : []);
      expect(projection.messages[0].turnTraceOwner).toBe(true);
    },
  );

  it('preserves both disclosures on a same-conversation reconnect snapshot', () => {
    toggleActivityTrace('turn:turn-1');
    toggleActivityMetrics('turn:turn-1');
    receive(testSnapshot(initial, 'reconnect'));
    expect(activityTraceExpanded('turn:turn-1')).toBe(true);
    expect(activityMetricsExpanded('turn:turn-1')).toBe(true);
  });

  it.each(['steps', 'stats'] as const)('keeps user selections as %s arrives first', (first) => {
    const previousTurn = {
      ...testTurn,
      phase: 'settled' as const,
      outcome: 'replied' as const,
      usage: [{ id: 'previous-usage', value: { cost_usd: 0.01 } }],
    };
    update({ ...initial, turns: [previousTurn], connection: { connected: true, activeTurnId: null } });
    toggleActivityTrace('turn:turn-1');
    toggleActivityMetrics('turn:turn-1');
    const nextTurn = { ...testTurn, id: 'turn-2', activity: [], usage: [] };
    const view: Conversation = {
      ...initial,
      turns: [previousTurn, nextTurn],
      connection: { connected: true, activeTurnId: nextTurn.id },
    };
    update(view);
    receive(testSnapshot(conversationState.peek()!.conversation, 'reconnect-empty'));
    expect(activityTraceExpanded('turn:turn-1')).toBe(true);
    expect(activityMetricsExpanded('turn:turn-1')).toBe(true);
    expect(activityTraceExpanded('turn:turn-2')).toBe(false);
    expect(activityMetricsExpanded('turn:turn-2')).toBe(false);
    const usage = [
      {
        id: 'usage',
        value: {
          cost_usd: 0.002,
          input_tokens: 100,
          output_tokens: 0,
          cache_read_tokens: 0,
          cache_write_tokens: 0,
          model: 'model',
        },
      },
    ];
    const ready = {
      ...nextTurn,
      ...(first === 'steps' ? { activity: testTurn.activity } : { usage }),
    };
    update({ ...view, turns: [previousTurn, ready] });
    expect(conversationState.peek()!.conversation.turns[1]).toMatchObject(ready);
    expect(activityTraceExpanded('turn:turn-1')).toBe(true);
    expect(activityMetricsExpanded('turn:turn-1')).toBe(true);
    expect(activityTraceExpanded('turn:turn-2')).toBe(false);
    expect(activityMetricsExpanded('turn:turn-2')).toBe(false);
    update({ ...view, turns: [previousTurn, { ...ready, activity: testTurn.activity, usage }] });
    receive(testSnapshot(conversationState.peek()!.conversation, 'reconnect-ready'));
    expect(activityTraceExpanded('turn:turn-1')).toBe(true);
    expect(activityMetricsExpanded('turn:turn-1')).toBe(true);
    expect(activityTraceExpanded('turn:turn-2')).toBe(false);
    expect(activityMetricsExpanded('turn:turn-2')).toBe(false);
  });

  it.each([false, true].flatMap((technical) => [false, true].map((settled) => ({ technical, settled }))))(
    'starts both panels closed (technical=$technical, settled=$settled)',
    ({ technical, settled }) => {
      appearance.value = {
        ...appearance.peek(),
        preferences: { ...DEFAULT_APPEARANCE, showTechnicalStatus: technical },
      };
      resetConversation();
      receive(
        testSnapshot({
          ...initial,
          turns: [{ ...testTurn, phase: settled ? 'settled' : 'running', outcome: settled ? 'silent' : 'pending' }],
          connection: { connected: true, activeTurnId: settled ? null : testTurn.id },
        }),
      );
      expect(activityTraceExpanded('turn:turn-1')).toBe(false);
      expect(activityMetricsExpanded('turn:turn-1')).toBe(false);
      appearance.value = {
        ...appearance.peek(),
        preferences: { ...DEFAULT_APPEARANCE, showTechnicalStatus: !technical },
      };
      expect(activityTraceExpanded('turn:turn-1')).toBe(false);
      expect(activityMetricsExpanded('turn:turn-1')).toBe(false);
    },
  );

  it('preserves selections across separate settlement, live registration and terminal outcomes', () => {
    toggleActivityTrace('turn:turn-1');
    toggleActivityMetrics('turn:turn-1');
    const expectSelection = () => {
      expect(activityTraceExpanded('turn:turn-1')).toBe(true);
      expect(activityMetricsExpanded('turn:turn-1')).toBe(true);
      expect(activityTraceExpanded('turn:turn-2')).toBe(false);
      expect(activityMetricsExpanded('turn:turn-2')).toBe(false);
    };
    const settled: Conversation = {
      ...initial,
      turns: [{ ...testTurn, phase: 'settled', outcome: 'silent' }],
      connection: { connected: true, activeTurnId: null },
    };
    update(settled);
    expectSelection();
    const next = { ...testTurn, id: 'turn-2', activity: [], startedAt: '2026-09-29T00:00:02Z' };
    const view: Conversation = {
      ...settled,
      turns: [...settled.turns, next],
    };
    receive(testSnapshot(view, 'before-live-registration'));
    expect(conversationState.peek()!.conversation.turns.at(-1)?.phase).toBe('running');
    expectSelection();
    update({ ...view, connection: { connected: true, activeTurnId: next.id } });
    expect(activeTurn.value?.id).toBe(next.id);
    expectSelection();
    update({
      ...view,
      turns: [
        ...settled.turns,
        {
          ...next,
          phase: 'settled',
          outcome: 'silent',
          endedAt: '2026-09-29T00:00:05Z',
        },
      ],
    });
    expect(conversationState.peek()!.conversation.turns.at(-1)?.phase).toBe('settled');
    expect(activeTurn.value).toBeNull();
    receive(testSnapshot(conversationState.peek()!.conversation, 'terminal-reconnect'));
    expectSelection();
  });

  it('does not move a historical selection on updates to the same turn', () => {
    toggleActivityTrace('turn:history');
    update({ ...initial, turns: [{ ...testTurn, metadata: { ...testTurn.metadata, model: 'updated' } }] });
    expect(activityTraceExpanded('turn:history')).toBe(true);
    expect(activityTraceExpanded('turn:turn-1')).toBe(false);
  });

  it.each(
    [false, true].flatMap((trace) =>
      [false, true].flatMap((metrics) => [false, true].map((snapshot) => ({ trace, metrics, snapshot }))),
    ),
  )(
    'changes disclosures only on toggles (trace=$trace, metrics=$metrics, snapshot=$snapshot)',
    ({ trace, metrics, snapshot }) => {
      if (trace) toggleActivityTrace('turn:turn-1');
      if (metrics) toggleActivityMetrics('turn:turn-1');
      const settled: Conversation = {
        ...initial,
        turns: [{ ...testTurn, phase: 'settled', outcome: 'silent' }],
        connection: { connected: true, activeTurnId: null },
      };
      const next = { ...testTurn, id: 'turn-2', activity: [], usage: [] };
      const view = {
        ...settled,
        turns: [...settled.turns, next],
        connection: { connected: true, activeTurnId: next.id },
      };
      if (snapshot) receive(testSnapshot(view, 'next-turn'));
      else update(view);
      expect(activityTraceExpanded('turn:turn-1')).toBe(trace);
      expect(activityMetricsExpanded('turn:turn-1')).toBe(metrics);
      expect(activityTraceExpanded('turn:turn-2')).toBe(false);
      expect(activityMetricsExpanded('turn:turn-2')).toBe(false);

      update({ ...view, turns: [...settled.turns, { ...next, usage: [{ id: 'usage', value: { cost_usd: 0.01 } }] }] });
      receive(testSnapshot(conversationState.peek()!.conversation, 'reconnect'));
      expect(activityTraceExpanded('turn:turn-1')).toBe(trace);
      expect(activityTraceExpanded('turn:turn-2')).toBe(false);
      expect(activityMetricsExpanded('turn:turn-1')).toBe(metrics);
      expect(activityMetricsExpanded('turn:turn-2')).toBe(false);
      update({
        ...view,
        turns: [
          ...settled.turns,
          {
            ...next,
            activity: testTurn.activity,
            usage: [{ id: 'usage', value: { cost_usd: 0.01 } }],
          },
        ],
      });
      expect(activityTraceExpanded('turn:turn-1')).toBe(trace);
      expect(activityTraceExpanded('turn:turn-2')).toBe(false);
      if (trace) toggleActivityTrace('turn:turn-2');
      expect(activityTraceExpanded('turn:turn-1')).toBe(false);
      expect(activityTraceExpanded('turn:turn-2')).toBe(trace);
      expect(activityMetricsExpanded('turn:turn-1')).toBe(metrics);
      if (metrics) toggleActivityMetrics('turn:turn-2');
      expect(activityMetricsExpanded('turn:turn-1')).toBe(false);
      expect(activityMetricsExpanded('turn:turn-2')).toBe(metrics);
      if (trace) toggleActivityTrace('turn:turn-2');
      if (metrics) toggleActivityMetrics('turn:turn-2');
      receive(testSnapshot(conversationState.peek()!.conversation, 'reconnect-closed'));
      expect(activityTraceExpanded('turn:turn-2')).toBe(false);
      expect(activityMetricsExpanded('turn:turn-2')).toBe(false);
      expect(activityMetricsExpanded('turn:turn-1')).toBe(false);
    },
  );

  it('does not transfer for step-free turns, synthetic live notices or accounting updates', () => {
    const previousTurn = {
      ...testTurn,
      phase: 'settled' as const,
      outcome: 'replied' as const,
      usage: [{ id: 'previous-usage', value: { cost_usd: 0.01 } }],
    };
    update({ ...initial, turns: [previousTurn], connection: { connected: true, activeTurnId: null } });
    toggleActivityTrace('turn:turn-1');
    toggleActivityMetrics('turn:turn-1');
    const empty = { ...testTurn, id: 'empty', phase: 'settled' as const, outcome: 'replied' as const, activity: [] };
    const current = {
      ...testTurn,
      id: 'current',
      activity: [
        {
          ordinal: 0,
          ts: '1000',
          timelinePosition: 200,
          text: JSON.stringify({
            kind: 'notification',
            id: 'ui:current:current',
            text: 'Thinking…',
            status: 'running',
          }),
        },
      ],
      usage: [{ id: 'current-usage', value: { cost_usd: 0.002 } }],
    };
    const view = {
      ...initial,
      turns: [previousTurn, empty, current],
      connection: { connected: true, activeTurnId: current.id },
    };
    update(view);
    expect(activityTraceExpanded('turn:turn-1')).toBe(true);
    expect(activityTraceExpanded('turn:empty')).toBe(false);
    expect(activityTraceExpanded('turn:current')).toBe(false);
    expect(activityMetricsExpanded('turn:turn-1')).toBe(true);
    expect(activityMetricsExpanded('turn:current')).toBe(false);
    update({
      ...view,
      turns: [
        { ...previousTurn, usage: [...previousTurn.usage, { id: 'late-old', value: { cost_usd: 0.02 } }] },
        empty,
        current,
      ],
    });
    expect(activityTraceExpanded('turn:turn-1')).toBe(true);
    expect(activityMetricsExpanded('turn:turn-1')).toBe(true);
    expect(activityMetricsExpanded('turn:current')).toBe(false);
    update({ ...view, turns: [previousTurn, empty, { ...current, activity: testTurn.activity }] });
    expect(activityTraceExpanded('turn:turn-1')).toBe(true);
    expect(activityTraceExpanded('turn:current')).toBe(false);
  });

  it('retains a migrated partial accounting record without synthesizing the absent counters', () => {
    const imported = {
      ...testTurn,
      phase: 'settled' as const,
      outcome: 'unknown' as const,
      usage: [{ id: 'original-bill', value: { input_tokens: 17 } }],
      metadata: { status: 'partial' as const, model: null, durationMs: null },
    };
    update({ ...initial, turns: [imported], connection: { connected: false, activeTurnId: null } });
    expect(chatReady.value).toBe(true);
    expect(chatTranscript.value[0]).toMatchObject({
      kind: 'turn',
      turn: { usage: [{ id: 'original-bill', value: { input_tokens: 17 } }] },
    });
  });
  it('renders the initial live trace from the snapshot without waiting for another signal', () => {
    expect(chatReady.value).toBe(true);
    expect(chatMessages.value).toEqual([]);
    expect(chatTranscript.value[0]).toMatchObject({ kind: 'turn', turn: { activity: testTurn.activity } });
    expect(activeTurn.value?.id).toBe(testTurn.id);
  });
  it.each(['silent', 'warning', 'stopped', 'interrupted', 'failed'] as const)(
    'retains the stable trace row for outputless %s settlement',
    (outcome) => {
      update({
        ...initial,
        turns: [
          {
            ...testTurn,
            phase: 'settled',
            outcome,
            metadata: {
              status: 'unavailable',
              model: 'model',
              durationMs: 2000,
            },
          },
        ],
        connection: { connected: true, activeTurnId: null },
      });
      expect(chatMessages.value).toHaveLength(0);
      expect(chatTranscript.value).toHaveLength(1);
      expect(chatTranscript.value[0]).toMatchObject({
        kind: 'turn',
        turn: { phase: 'settled', outcome, activity: testTurn.activity, usage: [] },
      });
      const row = chatTranscript.value[0];
      if (row.kind !== 'turn') throw new Error('Expected a turn trace');
      expect(parseStep(row.activity[0].text)).toMatchObject({ id: 'ui:start:turn-1', text: 'Started response' });
      expect(row.activity.slice(1, testTurn.activity.length + 1)).toEqual(testTurn.activity);
      expect(row.activity.filter((line) => isOutcomeTraceStep(parseStep(line.text)))).toHaveLength(
        outcome === 'failed' ? 0 : 1,
      );
      expect(conversationState.value?.conversation.turns[0].activity).toEqual(testTurn.activity);
      expect(activeTurn.value).toBeNull();
    },
  );
  it.each(['reply', 'system-notice', 'card', 'outputless'] as const)(
    'projects a terminal marker exactly once on its owning %s carrier without changing wire state',
    (carrier) => {
      const messages: Conversation['messages'] =
        carrier === 'outputless'
          ? []
          : [
              {
                id: 'mid-turn',
                direction: 'out',
                turnId: testTurn.id,
                text: 'Progress',
                timestamp: '',
                timelinePosition: 150,
                deliveryOrigin: 'send_message',
              },
              {
                id: 'reply',
                direction: 'out',
                turnId: testTurn.id,
                text: 'Response',
                timestamp: '',
                timelinePosition: 200,
                deliveryOrigin: 'response',
                ...(carrier === 'system-notice' ? { systemGenerated: true } : {}),
                ...(carrier === 'card' ? { card: { title: 'Card', description: '', children: [], actions: [] } } : {}),
              },
            ];
      const view = testSnapshot({
        messages,
        turns: [
          {
            ...testTurn,
            phase: 'settled',
            outcome: 'warning',
            endedAt: '2026-09-29T00:00:02Z',
            outputIds: messages.map((message) => message.id),
          },
        ],
        connection: { connected: true, activeTurnId: null },
      }).conversation;
      const before = JSON.stringify(view);
      const projection = conversationPresentation(view);
      const activity = projection.transcript.flatMap((row) =>
        row.kind === 'turn' ? row.activity : row.kind === 'message' ? (row.message.activity ?? []) : [],
      );
      expect(activity.filter((line) => isOutcomeTraceStep(parseStep(line.text)))).toHaveLength(1);
      expect(activity.map((line) => parseStep(line.text).text)).toContain('Ended with a warning');
      expect(JSON.stringify(view)).toBe(before);
    },
  );
  it('updates responses, metadata and completion in one envelope without copying usage onto outputs', () => {
    const value = {
      cost_usd: 0.25,
      input_tokens: 3,
      output_tokens: 4,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      model: 'model',
    };
    const settled: Conversation = {
      ...initial,
      turns: [
        {
          ...testTurn,
          phase: 'settled',
          outcome: 'replied',
          outputIds: ['a', 'b'],
          usage: [{ id: 'usage-1', value }],
          metadata: { status: 'final', model: 'model', durationMs: 2000 },
        },
      ],
      messages: ['a', 'b'].map((id) => ({
        id,
        turnId: testTurn.id,
        direction: 'out',
        text: id,
        timestamp: '2026-09-29T00:00:02Z',
      })),
      connection: { connected: true, activeTurnId: null },
    };
    update(settled);
    expect(chatTranscript.value.some((row) => row.kind === 'turn')).toBe(false);
    expect(chatMessages.value.find((m) => m.statsTurn)?.statsTurn?.usage).toEqual([{ id: 'usage-1', value }]);
    receive(testSnapshot(settled, 'reconnect'));
    expect(conversationState.value?.conversation).toEqual(presentedConversation(settled));
  });
  it('does not invent a completion after time passes or the runner disconnects', async () => {
    await vi.advanceTimersByTimeAsync(60_000);
    update({ ...initial, connection: { connected: false, activeTurnId: testTurn.id } });
    expect(chatTranscript.value[0]).toMatchObject({
      kind: 'turn',
      turn: { phase: 'running', activity: testTurn.activity },
    });
  });
  it('rejects gaps without partially replacing state or local drafts', () => {
    pending.value = [{ name: 'draft.txt', size: 1 }];
    const before = chatMessages.value;
    receive({
      kind: 'update',
      protocolVersion: CONVERSATION_PROTOCOL_VERSION,
      streamId: 'test-stream',
      baseRevision: 4,
      revision: 5,
      changes: diffConversation(initial, { ...initial, messages: [] }),
    });
    expect(chatMessages.value).toBe(before);
    expect(chatReady.value).toBe(false);
    expect(chatStatus.value).toContain('revision_gap');
    expect(pending.value[0].name).toBe('draft.txt');
  });
  it('provides an actionable reload error for an unsupported protocol', () => {
    receive({ kind: 'snapshot', protocolVersion: 99 });
    expect(chatReady.value).toBe(false);
    expect(chatReloadRequired.value).toBe(true);
    expect(chatStatus.value).toContain('Reload');
    expect(toastMessage.value).toMatchObject({ text: 'Chat protocol changed', kind: 'ok', actionLabel: 'Reload' });
    expect(toastMessage.value?.action).toBeTypeOf('function');
  });
  it('requires the same reload for incompatible non-Web snapshots', async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(
        JSON.stringify({
          approvals: [],
          conversation: { kind: 'snapshot', protocolVersion: 99 },
        }),
        { status: 200 },
      ),
    );
    await openChat('group', 'external-thread', {
      channelType: 'slack',
      messagingGroupId: 'slack-group',
      canSend: false,
    });
    expect(chatReady.value).toBe(false);
    expect(chatReloadRequired.value).toBe(true);
    expect(chatStatus.value).toContain('Reload');
  });
});
