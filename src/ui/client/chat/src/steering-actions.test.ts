import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearChat, sendChat } from './actions';
import { requestChoice } from './components/PromptModal';
import { applyTurnState, stopActiveTurn } from './stop-turn';
import { applyConversationFrame, conversationState } from './conversation-state';
import { diffConversation } from '../../../shared/conversation-protocol';
import { presentedConversation, testSnapshot, testTurn } from './conversation-test-fixtures';
import {
  activeTurn,
  canSend,
  channelType,
  chatMessages,
  chatReady,
  groupId,
  highlightMessageId,
  messagingGroupId,
  pending,
  pendingWebSends,
  pinnedContext,
  scrollToBottomTick,
  threadId,
} from './state';
import { splitPendingInputs } from './queued-followups';
import { inputStatePresentation } from './input-state';

vi.hoisted(() => vi.stubGlobal('window', { matchMedia: () => ({ matches: false }) }));
vi.mock('./components/PromptModal', () => ({ requestChoice: vi.fn() }));
vi.mock('./hash', () => ({ writeHash: vi.fn() }));
beforeEach(() => {
  groupId.value = 'group';
  threadId.value = 'thread';
  chatReady.value = true;
  canSend.value = true;
  highlightMessageId.value = null;
  scrollToBottomTick.value = 0;
  applyTurnState({ id: 'captured-turn', status: 'running', supportsSteering: true }, true);
  vi.mocked(requestChoice).mockReset().mockResolvedValue('steer');
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ approvals: [] }) }));
});
afterEach(() => {
  clearChat();
  groupId.value = null;
  pending.value = [];
  pinnedContext.value = [];
  pendingWebSends.value = [];
  vi.restoreAllMocks();
});
describe('native command intent', () => {
  it.each(['steer', 'queue'] as const)('sends %s with immutable identity, not proof of application', async (mode) => {
    vi.mocked(requestChoice).mockResolvedValue(mode);
    highlightMessageId.value = 'earlier-search-result';
    expect(await sendChat('New direction', null)).toBe(true);
    expect(highlightMessageId.value).toBeNull();
    expect(scrollToBottomTick.value).toBe(1);
    expect(JSON.parse(vi.mocked(fetch).mock.calls[0][1]?.body as string)).toMatchObject({
      text: 'New direction',
      inputHandling: { mode, turnId: 'captured-turn' },
    });
    expect(chatMessages.value).toEqual([]);
    expect(pendingWebSends.value).toHaveLength(1);
  });
  it.each([null, 'cancel'])('preserves attachments and pins when choice is %s', async (choice) => {
    vi.mocked(requestChoice).mockResolvedValue(choice);
    const files = [{ name: 'draft.txt', size: 1, file: new File(['x'], 'draft.txt') }];
    pending.value = files;
    pinnedContext.value = ['docs/spec.md'];
    highlightMessageId.value = 'earlier-search-result';
    expect(await sendChat('draft', files)).toBe(false);
    expect(highlightMessageId.value).toBe('earlier-search-result');
    expect(scrollToBottomTick.value).toBe(0);
    expect(pending.value).toBe(files);
    expect(pinnedContext.value).toEqual(['docs/spec.md']);
    expect(fetch).not.toHaveBeenCalled();
  });
  it('preserves intent in multipart requests', async () => {
    const file = new File(['voice'], 'voice.webm');
    await sendChat('Voice', [{ name: file.name, size: file.size, file }]);
    const body = vi.mocked(fetch).mock.calls[0][1]?.body as FormData;
    expect(JSON.parse(body.get('inputHandling') as string)).toEqual({ mode: 'steer', turnId: 'captured-turn' });
    expect(body.get('clientMessageId')).toBeTruthy();
    expect((body.get('file') as File).name).toBe('voice.webm');
  });
  it('does not prompt for unsupported, stopping or external turns', async () => {
    for (const turn of [
      { id: 'other', status: 'running' as const },
      { id: 'stop', status: 'stopping' as const },
      null,
    ]) {
      applyTurnState(turn, true);
      expect(await sendChat('follow-up', null)).toBe(true);
    }
    channelType.value = 'telegram';
    messagingGroupId.value = 'room';
    applyTurnState({ id: 'outside', status: 'running', supportsSteering: true }, true);
    expect(await sendChat('external', null)).toBe(true);
    expect(requestChoice).not.toHaveBeenCalled();
  });
  it.each(['web', 'telegram'])('leaves search navigation and scrolls when submitting on %s', async (channel) => {
    channelType.value = channel;
    messagingGroupId.value = channel === 'web' ? null : 'room';
    applyTurnState(null, true);
    highlightMessageId.value = 'earlier-search-result';
    expect(await sendChat('new message', null)).toBe(true);
    expect(highlightMessageId.value).toBeNull();
    expect(scrollToBottomTick.value).toBe(1);
  });
  it('keeps a failed send at the bottom without discarding the draft attachments', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({ error: 'Rejected' }), { status: 400 }));
    const files = [{ name: 'draft.txt', size: 1, file: new File(['x'], 'draft.txt') }];
    pending.value = files;
    highlightMessageId.value = 'earlier-search-result';
    expect(await sendChat('draft', files)).toBe(false);
    expect(highlightMessageId.value).toBeNull();
    expect(scrollToBottomTick.value).toBe(1);
    expect(pending.value).toBe(files);
  });
  it('never retargets an open choice to the successor turn', async () => {
    vi.mocked(requestChoice).mockImplementation(async () => {
      applyTurnState({ id: 'successor', status: 'running', supportsSteering: true }, true);
      return 'steer';
    });
    await sendChat('input', null);
    expect(JSON.parse(vi.mocked(fetch).mock.calls[0][1]?.body as string).inputHandling.turnId).toBe('captured-turn');
  });
  it('does not send after navigation during choice', async () => {
    vi.mocked(requestChoice).mockImplementation(async () => {
      clearChat();
      return 'steer';
    });
    expect(await sendChat('wrong destination', null)).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });
  it('retains command identity on an ambiguous HTTP failure', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(fetch).mockRejectedValueOnce(new Error('network'));
    expect(await sendChat('retry', null)).toBe(false);
    applyTurnState({ id: 'successor', status: 'running', supportsSteering: true }, true);
    expect(await sendChat('retry', null)).toBe(true);
    expect(vi.mocked(fetch).mock.calls[0][1]?.body).toEqual(vi.mocked(fetch).mock.calls[1][1]?.body);
    expect(requestChoice).toHaveBeenCalledOnce();
  });
});
describe('authoritative input dispositions', () => {
  it.each(['queued', 'steering', 'applied', 'processing'] as const)(
    'keeps Stop bound to the turn with %s input',
    async (status) => {
      applyConversationFrame(
        testSnapshot({
          turns: [testTurn],
          connection: { connected: true, activeTurnId: testTurn.id },
          capabilities: { canSend: true, stop: true, steer: true, editInput: true, cancelInput: true },
          messages: [
            {
              id: 'input',
              direction: 'in',
              text: 'guide',
              timestamp: '2026-09-29T00:00:01Z',
              inputState: { messageId: 'input', status, turnId: testTurn.id },
            },
          ],
        }),
        'thread',
      );
      const prior = chatMessages.value;
      await stopActiveTurn(testTurn.id);
      expect(activeTurn.value?.id).toBe(testTurn.id);
      expect(chatMessages.value).toBe(prior);
      expect(fetch).toHaveBeenLastCalledWith(
        'api/groups/group/chat/thread/stop',
        expect.objectContaining({ body: JSON.stringify({ turnId: testTurn.id }) }),
      );
    },
  );
  it('moves queued input at its consumed timeline position and removes cancelled input atomically', () => {
    applyConversationFrame(
      testSnapshot({
        messages: [
          { id: 'answer', direction: 'out', text: 'old', timestamp: '2026-09-29T00:00:02Z' },
          {
            id: 'input',
            direction: 'in',
            text: 'queued',
            timestamp: '2026-09-29T00:00:01Z',
            inputState: { messageId: 'input', status: 'queued', queuedForNextTurn: true },
          },
        ],
      }),
      'thread',
    );
    expect(splitPendingInputs(chatMessages.value).queued.map((m) => m.id)).toEqual(['input']);
    const before = conversationState.value!;
    const next = {
      ...before.conversation,
      messages: before.conversation.messages.map((m) =>
        m.id === 'input'
          ? {
              ...m,
              timelinePosition: Date.parse('2026-09-29T00:00:03Z') * 1000,
              inputState: { messageId: 'input', status: 'processing' as const },
            }
          : m,
      ),
    };
    applyConversationFrame(
      {
        kind: 'update',
        protocolVersion: 2,
        streamId: before.streamId,
        baseRevision: 0,
        revision: 1,
        changes: diffConversation(before.conversation, presentedConversation(next)),
      },
      'thread',
    );
    expect(chatMessages.value.map((m) => m.id)).toEqual(['answer', 'input']);
    const after = { ...next, messages: [next.messages[0]] };
    applyConversationFrame(
      {
        kind: 'update',
        protocolVersion: 2,
        streamId: before.streamId,
        baseRevision: 1,
        revision: 2,
        changes: diffConversation(presentedConversation(next), presentedConversation(after)),
      },
      'thread',
    );
    expect(chatMessages.value.map((m) => m.id)).toEqual(['answer']);
  });
  it('presents application only from an applied receipt', () => {
    const queued = inputStatePresentation({ messageId: 'input', status: 'queued' });
    const applied = inputStatePresentation({ messageId: 'input', status: 'applied', turnId: testTurn.id });
    expect(queued).not.toEqual(applied);
  });
});
