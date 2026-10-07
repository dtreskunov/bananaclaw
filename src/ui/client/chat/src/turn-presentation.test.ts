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
  activityTraceView,
  pauseActivityTrace,
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
  it('follows new live steps through protocol updates without changing the count-only disclosure', () => {
    const steps = [0, 1].map((ordinal) => ({
      ordinal,
      ts: String(1000 + ordinal),
      timelinePosition: 100 + ordinal,
      text: JSON.stringify({ kind: 'tool', id: `step-${ordinal}`, tool: 'bash', status: 'running' }),
    }));
    const traceId = 'turn:turn-1';
    toggleActivityTrace(traceId, true);
    update({ ...initial, turns: [{ ...testTurn, activity: steps }] });
    expect(activityTraceView(traceId, true)).toEqual({ expanded: true, following: true });
    pauseActivityTrace(traceId);
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
    expect(activityTraceView(traceId, true)).toEqual({ expanded: true, following: false });
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
    expect(activityTraceView(traceId)).toEqual({ expanded: true, following: false });
    expect(completedResponse.value).toBe('reply');
  });

  it('keeps turn ownership on one live bubble across intermediate responses and tail activity', () => {
    const traceId = 'turn:turn-1';
    toggleActivityTrace(traceId, true);
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
      activity: [...testTurn.activity],
    });
    expect(activityTraceView(traceId, true).following).toBe(true);

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
    expect(activityTraceView(traceId, true).following).toBe(true);
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
      expect(steps.map((step) => step.id)).toEqual(recorded ? ['question-call'] : []);
      expect(projection.messages[0].turnTraceOwner).toBe(true);
    },
  );

  it('preserves both disclosures on a same-conversation reconnect snapshot', () => {
    toggleActivityTrace('turn:turn-1', true);
    toggleActivityMetrics('turn:turn-1');
    receive(testSnapshot(initial, 'reconnect'));
    expect(activityTraceView('turn:turn-1', true)).toEqual({ expanded: true, following: true });
    expect(activityMetricsExpanded('turn:turn-1')).toBe(true);
  });

  it.each([false, true])(
    'automatically opens a snapshot live turn only when technical info is enabled (%s)',
    (technical) => {
      appearance.value = {
        ...appearance.peek(),
        preferences: { ...DEFAULT_APPEARANCE, showTechnicalStatus: technical },
      };
      resetConversation();
      receive(testSnapshot(initial));
      expect(activityTraceView('turn:turn-1', true)).toEqual({ expanded: technical, following: technical });
    },
  );

  it.each(['none', 'browse', 'collapse', 'history'] as const)(
    'preserves manual trace browsing and collapse with tech enabled after %s',
    (action) => {
      appearance.value = { ...appearance.peek(), preferences: { ...DEFAULT_APPEARANCE, showTechnicalStatus: true } };
      if (action === 'history') toggleActivityTrace('message:history');
      else if (action !== 'none') {
        toggleActivityTrace('turn:turn-1', true);
        if (action === 'collapse') toggleActivityTrace('turn:turn-1');
        else pauseActivityTrace('turn:turn-1');
      }
      const next = { ...testTurn, id: 'turn-2', activity: [] };
      const view = {
        ...initial,
        turns: [{ ...testTurn, phase: 'settled' as const, outcome: 'silent' as const }, next],
        connection: { connected: true, activeTurnId: next.id },
      };
      update(view);
      expect(activityTraceView('turn:turn-1').expanded).toBe(action === 'browse');
      expect(activityTraceView('message:history').expanded).toBe(action === 'history');
      expect(activityTraceView('turn:turn-2', true)).toEqual({ expanded: false, following: false });
      update({
        ...view,
        turns: [view.turns[0], { ...next, activity: [{ ...testTurn.activity[0], timelinePosition: 300 }] }],
      });
      receive(testSnapshot(conversationState.peek()!.conversation, 'reconnect'));
      expect(activityTraceView('turn:turn-2', true).expanded).toBe(false);
      expect(activityTraceView('turn:turn-1').expanded).toBe(action === 'browse');
      expect(activityTraceView('message:history').expanded).toBe(action === 'history');
    },
  );

  it.each([false, true])('inherits follow into a new turn with separate settlement = %s', (separate) => {
    toggleActivityTrace('turn:turn-1', true);
    const settled: Conversation = {
      ...initial,
      turns: [{ ...testTurn, phase: 'settled', outcome: 'silent' }],
      connection: { connected: true, activeTurnId: null },
    };
    if (separate) {
      update(settled);
      expect(activityTraceView('turn:turn-1')).toEqual({ expanded: true, following: false });
    }
    const next = { ...testTurn, id: 'turn-2', activity: [], startedAt: '2026-09-29T00:00:02Z' };
    update({ ...settled, turns: [...settled.turns, next], connection: { connected: true, activeTurnId: next.id } });
    expect(activityTraceView('turn:turn-1', true)).toEqual({ expanded: false, following: false });
    expect(activityTraceView('turn:turn-2', true)).toEqual({ expanded: true, following: true });
    update({
      ...settled,
      turns: [...settled.turns, { ...next, activity: [{ ...testTurn.activity[0], timelinePosition: 300 }] }],
      connection: { connected: true, activeTurnId: next.id },
    });
    expect(activityTraceView('turn:turn-2', true)).toEqual({ expanded: true, following: true });
  });

  it('does not move historical follow intent on updates to the same live turn', () => {
    toggleActivityTrace('turn:history', true);
    update({ ...initial, turns: [{ ...testTurn, metadata: { ...testTurn.metadata, model: 'updated' } }] });
    expect(activityTraceView('turn:history', true)).toEqual({ expanded: true, following: true });
    expect(activityTraceView('turn:turn-1', true).expanded).toBe(false);
  });

  it.each([false, true].flatMap((collapsed) => [false, true].map((snapshot) => ({ collapsed, snapshot }))))(
    'retains browsed traces while metrics transfer (collapsed=$collapsed, snapshot=$snapshot)',
    ({ collapsed, snapshot }) => {
      toggleActivityTrace('turn:turn-1', true);
      if (collapsed) toggleActivityTrace('turn:turn-1');
      else pauseActivityTrace('turn:turn-1');
      toggleActivityMetrics('turn:turn-1', true);
      const next = { ...testTurn, id: 'turn-2', startedAt: '2026-09-29T00:00:02Z' };
      const view: Conversation = {
        ...initial,
        turns: [{ ...testTurn, phase: 'settled', outcome: 'silent' }, next],
        connection: { connected: true, activeTurnId: next.id },
      };
      if (snapshot) receive(testSnapshot(view, 'next-turn'));
      else update(view);
      receive(testSnapshot(conversationState.peek()!.conversation, 'reconnect'));
      expect(activityTraceView('turn:turn-2', true)).toEqual({ expanded: false, following: false });
      expect(activityTraceView('turn:turn-1')).toEqual({ expanded: !collapsed, following: false });
      expect(activityMetricsExpanded('turn:turn-1')).toBe(false);
      expect(activityMetricsExpanded('turn:turn-2')).toBe(true);
    },
  );

  it.each(
    [false, true].flatMap((technical) =>
      [false, true].flatMap((trace) =>
        (['closed', 'open', 'follow'] as const).flatMap((metrics) =>
          [false, true].flatMap((separate) =>
            [false, true].map((snapshot) => ({ technical, trace, metrics, separate, snapshot })),
          ),
        ),
      ),
    ),
  )(
    'transfers disclosures (technical=$technical, trace=$trace, metrics=$metrics, separate settlement=$separate, snapshot=$snapshot)',
    ({ technical, trace, metrics, separate, snapshot }) => {
      appearance.value = {
        ...appearance.peek(),
        preferences: { ...DEFAULT_APPEARANCE, showTechnicalStatus: technical },
      };
      if (trace) toggleActivityTrace('turn:turn-1', true);
      const metricsOpen = metrics !== 'closed';
      const metricsFollow = metrics === 'follow';
      if (metricsOpen) toggleActivityMetrics('turn:turn-1', metricsFollow);
      const settled: Conversation = {
        ...initial,
        turns: [{ ...testTurn, phase: 'settled', outcome: 'silent' }],
        connection: { connected: true, activeTurnId: null },
      };
      if (separate) {
        update(settled);
        expect(activityTraceView('turn:turn-1').expanded).toBe(trace);
        expect(activityMetricsExpanded('turn:turn-1')).toBe(metricsOpen);
      }
      const next = { ...testTurn, id: 'turn-2', activity: [], usage: [], liveUsage: null };
      const view = {
        ...settled,
        turns: [...settled.turns, next],
        connection: { connected: true, activeTurnId: next.id },
      };
      if (snapshot) receive(testSnapshot(view, 'next-turn'));
      else update(view);
      expect(activityTraceView('turn:turn-1').expanded).toBe(false);
      expect(activityMetricsExpanded('turn:turn-1')).toBe(metrics === 'open');
      expect(activityTraceView('turn:turn-2', true)).toEqual({ expanded: trace, following: trace });
      expect(activityMetricsExpanded('turn:turn-2')).toBe(metricsFollow);

      update({ ...view, turns: [...settled.turns, { ...next, usage: [{ id: 'usage', value: { cost_usd: 0.01 } }] }] });
      receive(testSnapshot(conversationState.peek()!.conversation, 'reconnect'));
      expect(activityTraceView('turn:turn-2', true)).toEqual({ expanded: trace, following: trace });
      expect(activityMetricsExpanded('turn:turn-1')).toBe(metrics === 'open');
      expect(activityMetricsExpanded('turn:turn-2')).toBe(metricsFollow);
      if (trace) toggleActivityTrace('turn:turn-2');
      if (metricsOpen) toggleActivityMetrics(metricsFollow ? 'turn:turn-2' : 'turn:turn-1');
      receive(testSnapshot(conversationState.peek()!.conversation, 'reconnect-closed'));
      expect(activityTraceView('turn:turn-2', true).expanded).toBe(false);
      expect(activityMetricsExpanded('turn:turn-2')).toBe(false);
      expect(activityMetricsExpanded('turn:turn-1')).toBe(false);
    },
  );

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
      expect(row.activity.slice(0, testTurn.activity.length)).toEqual(testTurn.activity);
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
