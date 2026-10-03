import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearChat, openChat } from './actions';
import { completedResponse, conversationState } from './conversation-state';
import { activityTraceView, toggleActivityTrace, updateActivityTraceView } from './activity-trace-state';
import { diffConversation } from '../../../shared/conversation-protocol';
import type { Conversation } from '../../../shared/conversation';
import { testSnapshot, testTurn } from './conversation-test-fixtures';
import {
  activeTurn,
  chatMessages,
  chatReady,
  chatStatus,
  groupId,
  highlightMessageId,
  pending,
  threadId,
} from './state';

vi.hoisted(() => vi.stubGlobal('window', { matchMedia: () => ({ matches: false }) }));
vi.mock('./hash', () => ({ writeHash: vi.fn() }));
let receive: (payload: unknown) => void;
const initial: Conversation = testSnapshot({
  turns: [testTurn],
  connection: { connected: true, activeTurnId: testTurn.id },
  capabilities: { canSend: true, stop: true, steer: true, editInput: true, cancelInput: true },
}).conversation;
function update(next: Conversation): void {
  const state = conversationState.value!;
  receive({
    kind: 'update',
    protocolVersion: 1,
    streamId: state.streamId,
    baseRevision: state.revision,
    revision: state.revision + 1,
    changes: diffConversation(state.conversation, next),
  });
}
beforeEach(async () => {
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
  vi.useRealTimers();
  vi.restoreAllMocks();
});
describe('authoritative turn presentation', () => {
  it('moves an expanded live trace to the reply and requests its top on completion', () => {
    updateActivityTraceView('turn:turn-1', (view) => toggleActivityTrace(view, testTurn.activity));
    const settled: Conversation = {
      ...initial,
      messages: [
        { id: 'reply', direction: 'out', turnId: testTurn.id, text: 'Done', timestamp: '2026-09-29T00:00:02Z' },
      ],
      turns: [{ ...testTurn, phase: 'settled', outcome: 'replied', outputIds: ['reply'] }],
      connection: { connected: true, activeTurnId: null },
    };
    update(settled);
    expect(activityTraceView('reply').expanded).toBe(true);
    expect(activityTraceView('reply').openChapter).toBeNull();
    expect(completedResponse.value).toBe('reply');
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
    expect(chatMessages.value[0].turn?.usage).toEqual([{ id: 'original-bill', value: { input_tokens: 17 } }]);
  });
  it('renders the initial live trace from the snapshot without waiting for another signal', () => {
    expect(chatReady.value).toBe(true);
    expect(chatMessages.value[0]).toMatchObject({ id: 'turn:turn-1', turn: { activity: testTurn.activity } });
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
      expect(chatMessages.value).toHaveLength(1);
      expect(chatMessages.value[0]).toMatchObject({
        id: 'turn:turn-1',
        turn: { phase: 'settled', outcome, activity: testTurn.activity, usage: [] },
      });
      expect(activeTurn.value).toBeNull();
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
    expect(chatMessages.value.some((m) => m.direction === 'turn')).toBe(false);
    expect(chatMessages.value.find((m) => m.statsTurn)?.statsTurn?.usage).toEqual([{ id: 'usage-1', value }]);
    receive(testSnapshot(settled, 'reconnect'));
    expect(conversationState.value?.conversation).toEqual(settled);
  });
  it('does not invent a completion after time passes or the runner disconnects', async () => {
    await vi.advanceTimersByTimeAsync(60_000);
    update({ ...initial, connection: { connected: false, activeTurnId: testTurn.id } });
    expect(chatMessages.value[0].turn?.phase).toBe('running');
    expect(chatMessages.value[0].turn?.activity).toEqual(testTurn.activity);
  });
  it('rejects gaps without partially replacing state or local drafts', () => {
    pending.value = [{ name: 'draft.txt', size: 1 }];
    const before = chatMessages.value;
    receive({
      kind: 'update',
      protocolVersion: 1,
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
    expect(chatStatus.value).toContain('Reload');
  });
});
