import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearChat, openChat, runSync, sendChat } from './actions';
import { applyTurnState, stopActiveTurn } from './stop-turn';
import {
  activeTurn,
  canSend,
  channelType,
  chatMessages,
  chatReady,
  groupId,
  messagingGroupId,
  pendingQuestions,
  pendingWebSends,
  stopRequest,
  threadId,
  turnConnected,
} from './state';

vi.hoisted(() => {
  vi.stubGlobal('window', { matchMedia: () => ({ matches: false }) });
});

afterEach(() => {
  clearChat();
  groupId.value = null;
  pendingWebSends.value = [];
  vi.restoreAllMocks();
});

describe('Stop integration with chat actions', () => {
  it.each([false, true])(
    'retains stopped metadata when loading history (replace=%s)',
    async (replaceThreadMessages) => {
      groupId.value = 'group';
      threadId.value = 'thread';
      channelType.value = 'telegram';
      const stoppedStats = { durationMs: 12500, model: 'native/MiniMax-M3' };
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          json: async () => ({
            approvals: [],
            threadMessages: [
              {
                id: 'stopped',
                direction: 'out',
                text: 'Stopped by user.',
                timestamp: '2026-09-25T00:00:00Z',
                stoppedStats,
              },
            ],
          }),
        }),
      );
      await runSync({ replaceThreadMessages });
      expect(chatMessages.value).toEqual([expect.objectContaining({ id: 'stopped', stoppedStats })]);
      expect(chatMessages.value[0].usage).toBeUndefined();
    },
  );

  it('keeps enqueueing follow-ups while Stop is pending', async () => {
    groupId.value = 'group';
    threadId.value = 'thread';
    chatReady.value = true;
    canSend.value = true;
    applyTurnState({ id: 'turn-1', status: 'running' }, true);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 202 }));
    await stopActiveTurn('turn-1');
    expect(stopRequest.value?.busy).toBe(true);
    expect(await sendChat('Follow up after this turn stops', null)).toBe(true);
    expect(fetch).toHaveBeenLastCalledWith(
      'api/groups/group/chat/thread/send',
      expect.objectContaining({ method: 'POST', body: expect.stringContaining('Follow up after this turn stops') }),
    );
    expect(pendingWebSends.value).toHaveLength(1);
    expect(activeTurn.value?.id).toBe('turn-1');
    expect(stopRequest.value?.busy).toBe(true);
  });

  it('preserves the stop identity for a no-op navigation and clears it when leaving', async () => {
    groupId.value = 'group';
    threadId.value = 'thread';
    applyTurnState({ id: 'turn-1', status: 'running' }, true);
    await openChat('group', 'thread', null);
    expect(activeTurn.value?.id).toBe('turn-1');
    clearChat();
    expect(activeTurn.value).toBeNull();
    expect(stopRequest.value).toBeNull();
  });

  it('loads authoritative turn state for external channels through sync', async () => {
    groupId.value = 'group';
    threadId.value = 'thread';
    channelType.value = 'telegram';
    messagingGroupId.value = 'chat';
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ approvals: [], activeTurn: { id: 'external-turn', status: 'running' }, connected: true }),
      }),
    );
    await runSync();
    expect(activeTurn.value).toEqual({ id: 'external-turn', status: 'running' });
    expect(turnConnected.value).toBe(true);
    expect(fetch).toHaveBeenCalledWith('api/sync?gid=group&tid=thread&channel=telegram&mg=chat', expect.anything());
  });

  it('does not let a web sync snapshot overwrite newer WebSocket turn state', async () => {
    groupId.value = 'group';
    threadId.value = 'thread';
    applyTurnState({ id: 'live-turn', status: 'running' }, true);
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ approvals: [], activeTurn: { id: 'stale-turn', status: 'stopping' }, connected: false }),
      }),
    );
    await runSync();
    expect(activeTurn.value?.id).toBe('live-turn');
    expect(turnConnected.value).toBe(true);
  });

  it('does not restore an old external turn after navigation', async () => {
    groupId.value = 'group';
    threadId.value = 'thread';
    channelType.value = 'telegram';
    let resolve!: (value: object) => void;
    vi.stubGlobal(
      'fetch',
      vi.fn(
        () =>
          new Promise((r) => {
            resolve = r;
          }),
      ),
    );
    const syncing = runSync();
    clearChat();
    resolve({
      ok: true,
      json: async () => ({ approvals: [], activeTurn: { id: 'old-turn', status: 'running' }, connected: true }),
    });
    await syncing;
    expect(activeTurn.value).toBeNull();
    expect(turnConnected.value).toBe(false);
  });

  it('leaves pending question cards actionable after stopping a turn', async () => {
    groupId.value = 'group';
    threadId.value = 'thread';
    canSend.value = true;
    applyTurnState({ id: 'turn-1', status: 'running' }, true);
    const question = {
      questionId: 'question',
      title: 'Choose',
      question: 'Continue?',
      responseMode: 'text' as const,
      options: [],
      status: 'pending' as const,
      answerValue: null,
      answerType: null,
      answeredAt: null,
      threadId: 'thread',
      agentGroupId: 'group',
      createdAt: '2026-09-25T00:00:00Z',
    };
    pendingQuestions.value = [question];
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ approvals: [], questions: [question] }),
      }),
    );
    await stopActiveTurn('turn-1');
    applyTurnState(null, true);
    expect(pendingQuestions.value).toEqual([question]);
    await runSync();
    expect(pendingQuestions.value).toEqual([question]);
  });
});
