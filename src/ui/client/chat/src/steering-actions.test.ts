import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearChat, respondQuestion, retryChatSend, sendChat, skipQuestion } from './actions';
import { requestChoice } from './components/PromptModal';
import { applyTurnState, stopActiveTurn } from './stop-turn';
import { applyConversationFrame, conversationState } from './conversation-state';
import { CONVERSATION_PROTOCOL_VERSION, diffConversation } from '../../../shared/conversation-protocol';
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
  respondingQuestionIds,
  threadId,
} from './state';
import { splitPendingInputs } from './queued-followups';
import { inputStatePresentation } from './input-state';
import { submissionPresentation } from './web-submissions';

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
  it.each(['permission', 'readiness', 'channel', 'messaging-group'])(
    'revalidates %s after a queue/steer choice before submitting',
    async (change) => {
      channelType.value = 'web';
      messagingGroupId.value = null;
      const release = vi.fn();
      vi.mocked(requestChoice).mockImplementation(async () => {
        if (change === 'permission') canSend.value = false;
        if (change === 'readiness') chatReady.value = false;
        if (change === 'channel') channelType.value = 'telegram';
        if (change === 'messaging-group') messagingGroupId.value = 'other-room';
        return 'steer';
      });
      expect(await sendChat('draft', null, { onSubmitted: release })).toBe(false);
      expect(fetch).not.toHaveBeenCalled();
      expect(release).not.toHaveBeenCalled();
      expect(pendingWebSends.value).toEqual([]);
    },
  );
  it('retains command identity on explicit retry after an ambiguous HTTP failure', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(fetch).mockRejectedValueOnce(new Error('network'));
    expect(await sendChat('retry', null)).toBe(false);
    applyTurnState({ id: 'successor', status: 'running', supportsSteering: true }, true);
    expect(await retryChatSend(pendingWebSends.value[0].messageId)).toBe(true);
    expect(vi.mocked(fetch).mock.calls[0][1]?.body).toEqual(vi.mocked(fetch).mock.calls[1][1]?.body);
    expect(requestChoice).toHaveBeenCalledOnce();
  });
  it('treats identical text submitted again as a new command with current intent', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(fetch).mockRejectedValueOnce(new Error('network'));
    expect(await sendChat('repeat', null)).toBe(false);
    const failed = pendingWebSends.value[0];
    applyTurnState({ id: 'successor', status: 'running', supportsSteering: true }, true);
    vi.mocked(requestChoice).mockResolvedValue('queue');
    expect(await sendChat('repeat', null)).toBe(true);
    const original = JSON.parse(vi.mocked(fetch).mock.calls[0][1]?.body as string);
    const fresh = JSON.parse(vi.mocked(fetch).mock.calls[1][1]?.body as string);
    expect(fresh.clientMessageId).not.toBe(original.clientMessageId);
    expect(fresh.text).toBe(original.text);
    expect(fresh.inputHandling).toEqual({ mode: 'queue', turnId: 'successor' });
    expect(pendingWebSends.value[0]).toEqual(failed);
    expect(requestChoice).toHaveBeenCalledTimes(2);
  });
});
describe('immediate web submission feedback', () => {
  beforeEach(() => {
    channelType.value = 'web';
    messagingGroupId.value = null;
    applyConversationFrame(testSnapshot(), 'thread');
  });
  function deferResponse() {
    let resolve: (response: Response) => void = () => {
      throw new Error('Missing request');
    };
    let reject: (error: Error) => void = () => {
      throw new Error('Missing request');
    };
    const response = new Promise<Response>((accept, fail) => {
      resolve = accept;
      reject = fail;
    });
    vi.mocked(fetch).mockReturnValueOnce(response);
    return { resolve, reject };
  }
  function echo() {
    const submission = pendingWebSends.value[0];
    if (!submission) throw new Error('Missing submission');
    const message = {
      id: submission.messageId,
      direction: 'in' as const,
      text: submission.text,
      timestamp: submission.timestamp,
      timelinePosition: 200,
      inputState: { messageId: submission.messageId, status: 'queued' as const },
    };
    applyConversationFrame(testSnapshot({ messages: [message] }, 'echo-stream'), 'thread');
    return message;
  }
  it('renders feedback before HTTP and clears the draft only after a real submission starts', async () => {
    const response = deferResponse();
    const release = vi.fn();
    const sent = sendChat('Hello', null, { onSubmitted: release });
    expect(release).toHaveBeenCalledOnce();
    expect(chatMessages.value).toEqual([]);
    expect(
      submissionPresentation(
        [],
        pendingWebSends.value,
        conversationState.value?.conversation ?? null,
        'group',
        'thread',
      ).map((row) => row.kind),
    ).toEqual(['message', 'starting']);
    expect(pendingWebSends.value[0].status).toBe('sending');
    response.resolve(new Response('{}', { status: 200 }));
    expect(await sent).toBe(true);
    expect(pendingWebSends.value[0].status).toBe('accepted');
    const message = echo();
    expect(pendingWebSends.value).toHaveLength(1);
    applyConversationFrame(
      testSnapshot(
        {
          messages: [message],
          turns: [{ ...testTurn, inputIds: [message.id] }],
          connection: { connected: true, activeTurnId: testTurn.id },
        },
        'turn-stream',
      ),
      'thread',
    );
    expect(pendingWebSends.value).toEqual([]);
  });
  it.each(['http', 'network'] as const)(
    'uses a prior canonical echo rather than a later %s failure',
    async (failure) => {
      const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
      vi.spyOn(console, 'error').mockImplementation(() => {});
      const response = deferResponse();
      const sent = sendChat('Hello', null);
      echo();
      if (failure === 'http') response.resolve(new Response('{"error":"transport failure"}', { status: 503 }));
      else response.reject(new Error('network failure'));
      expect(await sent).toBe(true);
      expect(pendingWebSends.value[0].status).toBe('accepted');
      expect(warning).toHaveBeenCalledOnce();
    },
  );
  it('retains attachments, text, identity and intent on failed-message retry without consuming a new draft', async () => {
    applyTurnState({ id: 'captured-turn', status: 'running', supportsSteering: true }, true);
    const file = new File(['draft'], 'draft.txt');
    vi.mocked(fetch).mockResolvedValueOnce(new Response('{"error":"Unavailable"}', { status: 503 }));
    expect(await sendChat('Original', [{ name: file.name, size: file.size, file }])).toBe(false);
    const submission = pendingWebSends.value[0];
    expect(submission).toMatchObject({ status: 'failed', error: 'Unavailable' });
    applyTurnState({ id: 'successor', status: 'running', supportsSteering: true }, true);
    pending.value = [{ name: 'new.txt', size: 1 }];
    expect(await retryChatSend(submission.messageId)).toBe(true);
    const first = vi.mocked(fetch).mock.calls[0][1]?.body;
    const retry = vi.mocked(fetch).mock.calls[1][1]?.body;
    if (!(first instanceof FormData) || !(retry instanceof FormData)) throw new Error('Expected multipart requests');
    expect(retry.get('clientMessageId')).toBe(first.get('clientMessageId'));
    expect(retry.get('text')).toBe('Original');
    expect(retry.get('inputHandling')).toBe(first.get('inputHandling'));
    expect((retry.get('file') as File).name).toBe(file.name);
    expect(pendingWebSends.value[0].timestamp).toBe(submission.timestamp);
    expect(pendingWebSends.value[0]).not.toHaveProperty('error');
    expect(pending.value[0].name).toBe('new.txt');
    expect(requestChoice).toHaveBeenCalledOnce();
  });
  it('does not repurpose a failed packet when new text is submitted', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response('{"error":"Unavailable"}', { status: 503 }));
    await sendChat('Original', null);
    const failed = pendingWebSends.value[0];
    expect(await sendChat('Changed', null)).toBe(true);
    expect(pendingWebSends.value.find((send) => send.messageId === failed.messageId)).toEqual(failed);
    expect(pendingWebSends.value[1].clientMessageId).not.toBe(failed.clientMessageId);
    expect(pendingWebSends.value[1].text).toBe('Changed');
  });
  it.each([true, false])(
    'creates a new message for identical text and attachments regardless of descriptor identity (%s)',
    async (sameReferences) => {
      const file = new File(['draft'], 'draft.txt');
      const original = { name: file.name, size: file.size, file };
      vi.mocked(fetch).mockResolvedValueOnce(new Response('{"error":"Unavailable"}', { status: 503 }));
      await sendChat('Original', [original]);
      const failed = pendingWebSends.value[0];
      expect(await sendChat('Original', [sameReferences ? original : { ...original }])).toBe(true);
      const body = vi.mocked(fetch).mock.calls[1][1]?.body;
      if (!(body instanceof FormData)) throw new Error('Expected multipart request');
      expect(body.get('clientMessageId')).not.toBe(failed.clientMessageId);
      expect(pendingWebSends.value).toHaveLength(2);
      expect(pendingWebSends.value[0]).toEqual(failed);
    },
  );
  it('posts the captured files even when releasing the draft mutates the original input array', async () => {
    const file = new File(['draft'], 'draft.txt');
    const files = [{ name: file.name, size: file.size, file }];
    expect(
      await sendChat('Original', files, {
        onSubmitted: () => {
          files.length = 0;
        },
      }),
    ).toBe(true);
    const body = vi.mocked(fetch).mock.calls[0][1]?.body;
    if (!(body instanceof FormData)) throw new Error('Expected multipart request');
    expect((body.get('file') as File).name).toBe(file.name);
    expect(pendingWebSends.value[0].files).toHaveLength(1);
  });
  it('does not retry a web packet through an external channel', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response('{"error":"Unavailable"}', { status: 503 }));
    await sendChat('Original', null);
    channelType.value = 'telegram';
    messagingGroupId.value = 'room';
    expect(await retryChatSend(pendingWebSends.value[0].messageId)).toBe(false);
    expect(fetch).toHaveBeenCalledOnce();
  });
  it('ignores late acknowledgement for a navigated composer and scopes retained failures by group', async () => {
    const response = deferResponse();
    const sent = sendChat('Original', null);
    groupId.value = 'another-group';
    response.resolve(new Response('{"error":"Unavailable"}', { status: 503 }));
    expect(await sent).toBe(false);
    expect(pendingWebSends.value[0]).toMatchObject({ groupId: 'group', status: 'failed' });
    expect(await retryChatSend(pendingWebSends.value[0].messageId)).toBe(false);
    expect(fetch).toHaveBeenCalledOnce();
  });
});
describe('question response requests', () => {
  it('uses the existing endpoint for typed skips and ordinary answers without submitting files or context', async () => {
    channelType.value = 'web';
    respondingQuestionIds.value = new Set();
    const files = [{ name: 'draft.txt', size: 1, file: new File(['x'], 'draft.txt') }];
    pending.value = files;
    pinnedContext.value = ['keep/context.txt'];
    expect(await skipQuestion('q:one')).toBe(true);
    expect(fetch).toHaveBeenLastCalledWith(
      'api/approvals/q%3Aone/respond',
      expect.objectContaining({ body: JSON.stringify({ responseType: 'skipped' }) }),
    );
    expect(await respondQuestion('q:one', 'Yes')).toBe(true);
    expect(fetch).toHaveBeenLastCalledWith(
      'api/approvals/q%3Aone/respond',
      expect.objectContaining({ body: JSON.stringify({ value: 'Yes' }) }),
    );
    expect(pending.value).toBe(files);
    expect(pinnedContext.value).toEqual(['keep/context.txt']);
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
        protocolVersion: CONVERSATION_PROTOCOL_VERSION,
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
        protocolVersion: CONVERSATION_PROTOCOL_VERSION,
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
