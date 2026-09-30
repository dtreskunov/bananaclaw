import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearChat, openChat } from './actions';
import { showsTurnActivity } from './chat-protocol';
import { MessageTurnMetadata } from './components/ChatMain';
import {
  activeTurn,
  activityLog,
  chatLoading,
  chatMessages,
  groupId,
  highlightMessageId,
  isTyping,
  responseReceived,
  threadId,
  typingEndedAt,
  typingModel,
  typingStartedAt,
  typingUsage,
} from './state';

vi.hoisted(() => {
  vi.stubGlobal('window', { matchMedia: () => ({ matches: false }) });
});
vi.mock('./hash', () => ({ writeHash: vi.fn() }));

const trace = [{ ts: '1000', text: '{"kind":"tool","id":"tool-1","tool":"budget","status":"completed"}' }];
const usage = {
  cost_usd: 0.25,
  input_tokens: 1200,
  output_tokens: 30,
  cache_read_tokens: 1000,
  cache_write_tokens: 0,
  model: 'minimax/MiniMax-M3',
};
const turn = { id: 'turn-1', status: 'running', supportsSteering: true };
let receive: (payload: object) => void;

function visible() {
  return showsTurnActivity(
    activeTurn.value,
    isTyping.value,
    threadId.value,
    chatLoading.value,
    responseReceived.value,
    typingEndedAt.value !== null,
  );
}

beforeEach(async () => {
  vi.useFakeTimers();
  vi.setSystemTime(10000);
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
  threadId.value = null;
  highlightMessageId.value = 'skip-focus';
  await openChat('group', 'thread', null);
  receive = (payload) => sockets[0].onmessage?.({ data: JSON.stringify(payload) });
  receive({ kind: 'history', threadId: 'thread', messages: [], activeTurn: turn, connected: true });
  receive({ kind: 'ready', threadId: 'thread' });
  receive({ kind: 'typing', on: true, items: trace, usage, model: usage.model, startedAt: 1000 });
});

afterEach(() => {
  clearChat();
  groupId.value = null;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('live response handoff', () => {
  it.each([
    ['typing-off', 'turn-end', 'response'],
    ['typing-off', 'response', 'turn-end'],
    ['response', 'typing-off', 'turn-end'],
    ['response', 'turn-end', 'typing-off'],
    ['turn-end', 'response', 'typing-off'],
    ['turn-end', 'typing-off', 'response'],
  ])('reconciles %s / %s / %s without an empty bubble or metadata gap', (...order) => {
    let responded = false;
    for (const event of order) {
      if (event === 'typing-off') receive({ kind: 'typing', on: false });
      if (event === 'turn-end') receive({ kind: 'turn', turn: null, connected: true });
      if (event === 'response') {
        receive({
          kind: 'outbound',
          id: 'answer',
          content: { text: 'Done', delivery_origin: 'response' },
          timestamp: 'now',
        });
        responded = true;
      }
      expect(visible()).toBe(!responded);
      if (!responded) {
        expect(activityLog.value).toEqual(trace);
        expect(typingUsage.value).toEqual(usage);
      }
    }
    const message = chatMessages.value[0];
    expect(message.activity).toEqual(trace);
    expect(message.provisionalTurn).toEqual({
      usage: { ...usage, duration_ms: 9000 },
      model: usage.model,
      durationMs: 9000,
    });
    expect(MessageTurnMetadata({ message })?.props).toMatchObject({
      u: { ...usage, duration_ms: 9000 },
      provisional: true,
    });
    receive({ kind: 'usage', id: 'answer', usage: { ...usage, cost_usd: 0.4, duration_ms: 9100 } });
    expect(chatMessages.value[0].provisionalTurn).toBeUndefined();
    expect(MessageTurnMetadata({ message: chatMessages.value[0] })?.props).toMatchObject({
      u: { ...usage, cost_usd: 0.4, duration_ms: 9100 },
      provisional: false,
    });
  });

  it('waits beyond the former timeout for a warning without losing or extending elapsed time', async () => {
    receive({ kind: 'typing', on: false });
    receive({ kind: 'turn', turn: null, connected: true });
    await vi.advanceTimersByTimeAsync(5000);
    expect(visible()).toBe(true);
    expect(isTyping.value).toBe(false);
    expect(typingEndedAt.value).toBe(10000);
    receive({ kind: 'outbound', id: 'warning', content: { text: 'No response', delivery_origin: 'response' } });
    expect(visible()).toBe(false);
    expect(chatMessages.value[0].activity).toEqual(trace);
    expect(chatMessages.value[0].provisionalTurn?.durationMs).toBe(9000);
  });

  it('preserves provisional metadata through a history snapshot until final usage is available', () => {
    receive({ kind: 'outbound', id: 'answer', content: { text: 'Done' } });
    const message = { id: 'answer', direction: 'out', text: 'Done', timestamp: 'now' };
    receive({ kind: 'history', threadId: 'thread', messages: [message], activeTurn: turn });
    expect(chatMessages.value[0].provisionalTurn?.usage).toMatchObject(usage);
    expect(chatMessages.value[0].activity).toEqual(trace);
    receive({ kind: 'history', threadId: 'thread', messages: [{ ...message, usage }], activeTurn: null });
    expect(chatMessages.value[0].provisionalTurn).toBeUndefined();
    expect(chatMessages.value[0].usage).toEqual(usage);
  });

  it('shows model and elapsed time without fabricating missing token usage', () => {
    typingUsage.value = null;
    receive({ kind: 'outbound', id: 'answer', content: { text: 'Done' } });
    const message = chatMessages.value[0];
    expect(message.usage).toBeUndefined();
    expect(message.provisionalTurn).toEqual({ durationMs: 9000, model: usage.model });
    expect(MessageTurnMetadata({ message })?.props.children).toContain('MiniMax-M3');
  });

  it('preserves live work during steering and re-arms only for the next turn, not late typing frames', async () => {
    receive({
      kind: 'inbound',
      id: 'steer',
      text: 'Use my account',
      inputHandling: { mode: 'steer', turnId: turn.id },
    });
    receive({
      kind: 'input-state',
      states: [{ messageId: 'steer', inputState: { messageId: 'steer', status: 'applied' } }],
    });
    expect(activityLog.value).toEqual(trace);
    expect(typingStartedAt.value).toBe(1000);
    receive({ kind: 'outbound', id: 'answer', content: { text: 'Done' } });
    receive({ kind: 'typing', on: true, items: trace, usage, startedAt: 1000 });
    expect(visible()).toBe(false);
    receive({ kind: 'turn', turn: { ...turn, id: 'turn-2' }, connected: true });
    expect(visible()).toBe(true);
    expect(typingModel.value).toBe('');
    expect(activityLog.value).toEqual([]);
    receive({ kind: 'typing', on: true, items: [{ ts: '2', text: 'Next work' }], startedAt: 10000 });
    await vi.advanceTimersByTimeAsync(3000);
    expect(activityLog.value).toEqual([{ ts: '2', text: 'Next work' }]);
    expect(visible()).toBe(true);
  });

  it('clears retained presentation on navigation rather than leaking it into the next conversation', () => {
    receive({ kind: 'typing', on: false });
    clearChat();
    expect(typingEndedAt.value).toBeNull();
    expect(activityLog.value).toEqual([]);
    expect(responseReceived.value).toBe(false);
    expect(visible()).toBe(false);
  });

  it('reloads persisted warning timing without claiming token usage was reported', () => {
    const turnStats = { durationMs: 12000, model: usage.model };
    receive({
      kind: 'history',
      threadId: 'thread',
      messages: [
        {
          id: 'warning',
          direction: 'out',
          text: 'No response',
          timestamp: 'now',
          turnStats,
          activity: trace,
        },
      ],
    });
    expect(chatMessages.value[0].usage).toBeUndefined();
    expect(chatMessages.value[0].activity).toEqual(trace);
    expect(MessageTurnMetadata({ message: chatMessages.value[0] })?.props.children).toContain('MiniMax-M3');
  });
});
