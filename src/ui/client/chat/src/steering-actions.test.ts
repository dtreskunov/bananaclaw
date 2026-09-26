import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearChat, openChat, reconnectChatNow, runSync, sendChat } from './actions';
import { requestChoice } from './components/PromptModal';
import { applyTurnState } from './stop-turn';
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
  refs,
  threadId,
} from './state';
import { inputStatePresentation } from './input-state';
import { cancelledInputs, PendingCancellation } from './pending-cancel';
import { showsTurnActivity } from './chat-protocol';
import { mergeQuestionTimeline } from './question-timeline';
import { splitQueuedFollowups } from './queued-followups';
import { ActiveTurnStopButton } from './components/ActiveTurnStopButton';
import { TurnStopButton } from './components/TurnStopButton';
import type { InputState, PendingFile } from './types';

vi.hoisted(() => {
  vi.stubGlobal('window', { matchMedia: () => ({ matches: false }) });
});
vi.mock('./components/PromptModal', () => ({ requestChoice: vi.fn() }));
vi.mock('./hash', () => ({ writeHash: vi.fn() }));

beforeEach(() => {
  cancelledInputs.clear();
  groupId.value = 'group';
  threadId.value = 'thread';
  chatReady.value = true;
  canSend.value = true;
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

describe('native web send choice', () => {
  it('keeps confirmed cancellation tombstones through late duplicate echoes/history without clearing unrelated drafts or sends', async () => {
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
    threadId.value = null;
    highlightMessageId.value = 'skip-focus';
    await openChat('group', 'thread', null);
    const receive = (payload: object) => sockets[0].onmessage?.({ data: JSON.stringify(payload) });
    const cancelled = {
      id: 'confirmed-cancellation',
      direction: 'in',
      text: 'Never revive',
      timestamp: '1',
      inputState: { messageId: 'confirmed-cancellation', status: 'queued', queuedForNextTurn: true },
    };
    receive({ kind: 'history', threadId: 'thread', messages: [cancelled] });
    pendingWebSends.value = [
      { threadId: 'thread', messageId: cancelled.id },
      { threadId: 'thread', messageId: 'unrelated-optimistic-send' },
      { threadId: 'another-thread', messageId: 'another-send' },
    ];
    const files = [{ name: 'unsent.txt', size: 3, file: new File(['new'], 'unsent.txt') }];
    const pins = ['docs/unsent-context.md'];
    pending.value = files;
    pinnedContext.value = pins;
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ ok: true, id: cancelled.id }),
    } as Response);
    const request = new PendingCancellation(
      'group',
      { threadId: 'thread', channelType: 'web', title: '', lastActivityAt: '' },
      cancelled.id,
    );
    expect(await request.cancel()).toBe(true);
    expect(chatMessages.value).toEqual([]);
    expect(pendingWebSends.value).toEqual([
      { threadId: 'thread', messageId: 'unrelated-optimistic-send' },
      { threadId: 'another-thread', messageId: 'another-send' },
    ]);
    receive({ ...cancelled, kind: 'inbound' });
    receive({ kind: 'history', threadId: 'thread', messages: [cancelled] });
    receive({ ...cancelled, kind: 'inbound' });
    expect(chatMessages.value).toEqual([]);
    expect(pending.value).toBe(files);
    expect(pinnedContext.value).toBe(pins);
    expect(pendingWebSends.value.map((send) => send.messageId)).toEqual(['unrelated-optimistic-send', 'another-send']);
    // The same ID in another conversation is not this tombstone's target.
    await openChat('group', 'another-thread', null);
    sockets[1].onmessage?.({
      data: JSON.stringify({ kind: 'history', threadId: 'another-thread', messages: [cancelled] }),
    });
    expect(chatMessages.value.map((message) => message.id)).toEqual([cancelled.id]);
  });

  it.each([false, true])(
    'reconciles a cancellation missed while offline on reconnect (redacted tombstone=%s)',
    async (tombstone) => {
      const sockets: Array<{ onmessage?: (event: { data: string }) => void; onclose?: () => void }> = [];
      vi.stubGlobal('location', { protocol: 'https:', host: 'example.test' });
      vi.stubGlobal(
        'WebSocket',
        class {
          constructor() {
            sockets.push(this);
          }
          onmessage?: (event: { data: string }) => void;
          onclose?: () => void;
          close() {}
        },
      );
      threadId.value = null;
      highlightMessageId.value = 'skip-focus';
      await openChat('group', 'thread', null);
      const receive = (index: number, payload: object) => sockets[index].onmessage?.({ data: JSON.stringify(payload) });
      const cancelled = {
        id: 'missed-cancellation',
        direction: 'in',
        text: 'Must disappear',
        timestamp: '1',
        files: [{ filename: 'private-attachment.txt' }],
        inputState: { messageId: 'missed-cancellation', status: 'queued', queuedForNextTurn: true },
      };
      const answer = { id: 'answer', direction: 'out', text: 'Still running', timestamp: '2' };
      receive(0, { kind: 'history', threadId: 'thread', messages: [cancelled, answer] });
      expect(chatMessages.value).toHaveLength(2);
      sockets[0].onclose?.();
      // No live tombstone or successful DELETE is delivered to this tab.
      expect(cancelledInputs.size).toBe(0);
      reconnectChatNow();
      expect(sockets).toHaveLength(2);
      const messages = tombstone
        ? [
            { ...cancelled, text: '', files: null, inputState: { messageId: cancelled.id, status: 'cancelled' } },
            answer,
          ]
        : [answer];
      receive(1, { kind: 'history', threadId: 'thread', messages });
      expect(chatMessages.value.map((message) => message.id)).toEqual(['answer']);
      receive(0, { ...cancelled, kind: 'inbound' });
      expect(chatMessages.value.map((message) => message.id)).toEqual(['answer']);
      if (tombstone) {
        receive(1, { ...cancelled, kind: 'inbound' });
        receive(1, { kind: 'history', threadId: 'thread', messages: [cancelled, answer] });
        expect(chatMessages.value.map((message) => message.id)).toEqual(['answer']);
      }
    },
  );

  it('removes cancelled inputs in live states and history without reviving them on a stale echo', async () => {
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
    threadId.value = null;
    highlightMessageId.value = 'skip-focus';
    await openChat('group', 'thread', null);
    const receive = (payload: object) => sockets[0].onmessage?.({ data: JSON.stringify(payload) });
    const input = {
      id: 'cancel-me',
      direction: 'in',
      text: 'Draft',
      timestamp: '1',
      inputState: { messageId: 'cancel-me', status: 'queued' },
    };
    receive({
      kind: 'history',
      threadId: 'thread',
      messages: [input, { ...input, id: 'answer', direction: 'out', inputState: undefined }],
    });
    receive({
      kind: 'input-state',
      states: [{ messageId: 'cancel-me', inputState: { messageId: 'cancel-me', status: 'cancelled' } }],
    });
    expect(chatMessages.value.map((message) => message.id)).toEqual(['answer']);
    receive({ ...input, kind: 'inbound' });
    expect(chatMessages.value.map((message) => message.id)).toEqual(['answer']);
    receive({
      kind: 'history',
      threadId: 'thread',
      messages: [
        {
          ...input,
          id: 'cancelled-in-history',
          inputState: { messageId: 'cancelled-in-history', status: 'cancelled' },
        },
        input,
      ],
    });
    expect(chatMessages.value).toEqual([]);
  });
  it('queues echoed follow-ups below the turn and restores durable consumption order on reload', async () => {
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
    threadId.value = null;
    highlightMessageId.value = 'skip-focus';
    await openChat('group', 'thread', null);
    const receive = (payload: object) => sockets[0].onmessage?.({ data: JSON.stringify(payload) });
    const timestamp = '2026-09-26T00:00:00Z';
    const position = Date.parse(timestamp) * 1000;
    const layout = () => splitQueuedFollowups(mergeQuestionTimeline(chatMessages.value, [], 'thread'));
    receive({
      kind: 'history',
      threadId: 'thread',
      messages: [{ id: 'initial', direction: 'in', text: 'Initial', timestamp, timelinePosition: position + 1 }],
    });
    receive({
      kind: 'inbound',
      id: 'later',
      text: 'Follow up',
      timestamp,
      files: [{ filename: 'keep.txt' }],
      inputHandling: { mode: 'queue', turnId: 'turn' },
    });
    expect(layout().queued.map((m) => m.id)).toEqual(['later']);
    receive({
      kind: 'outbound',
      id: 'prior-answer',
      content: { text: 'Prior answer' },
      timestamp,
      timelinePosition: position + 2,
    });
    expect(layout().transcript.map((m) => m.id)).toEqual(['initial', 'prior-answer']);
    const count = chatMessages.value.length;
    receive({
      kind: 'input-state',
      states: [
        {
          messageId: 'later',
          canEditPending: false,
          inputState: { messageId: 'later', status: 'processing', queuedForNextTurn: true },
        },
      ],
    });
    expect(layout().queued.map((m) => m.id)).toEqual(['later']);
    expect(layout().transcript.map((m) => m.id)).toEqual(['initial', 'prior-answer']);
    receive({
      kind: 'input-state',
      states: [
        {
          messageId: 'later',
          text: 'Follow up',
          canEditPending: false,
          timelinePosition: position + 3,
          inputState: {
            messageId: 'later',
            status: 'processing',
            queuedForNextTurn: true,
            timelinePosition: position + 3,
          },
        },
      ],
    });
    expect(chatMessages.value).toHaveLength(count);
    expect(layout().queued).toEqual([]);
    expect(layout().transcript.map((m) => m.id)).toEqual(['initial', 'prior-answer', 'later']);
    receive({
      kind: 'outbound',
      id: 'own-answer',
      content: { text: 'Next answer' },
      timestamp,
      timelinePosition: position + 4,
    });
    receive({ kind: 'input-state', states: [{ messageId: 'later', inputState: null }] });
    expect(chatMessages.value.find((m) => m.id === 'later')?.timelinePosition).toBe(position + 3);
    const expected = layout();
    const history = chatMessages.value.map(({ ts, ...message }) => ({ ...message, timestamp: ts }));
    receive({ kind: 'history', threadId: 'thread', messages: history.reverse() });
    const placement = (messages: typeof chatMessages.value) =>
      messages.map(({ id, timelinePosition, text, files, ts }) => ({ id, timelinePosition, text, files, ts }));
    expect(placement(layout().transcript)).toEqual(placement(expected.transcript));
    expect(layout().queued).toEqual(expected.queued);
    expect(layout().transcript.map((m) => m.id)).toEqual(['initial', 'prior-answer', 'later', 'own-answer']);
    expect(layout().transcript.find((m) => m.id === 'later')?.files).toEqual([{ filename: 'keep.txt' }]);
  });
  it.each(['steer', 'queue'] as const)(
    'sends %s with the captured turn and focuses steering by default',
    async (mode) => {
      vi.mocked(requestChoice).mockResolvedValue(mode);
      const activity = [{ ts: '1', text: 'Existing active-turn work' }];
      refs.carryActivity = activity;
      expect(await sendChat('New direction', null)).toBe(true);
      expect(refs.carryActivity).toBe(activity);
      expect(requestChoice).toHaveBeenCalledWith(
        expect.objectContaining({
          options: [
            { value: 'cancel', label: 'Cancel' },
            { value: 'queue', label: 'Queue for later' },
            { value: 'steer', label: 'Steer current turn', tone: 'primary' },
          ],
        }),
      );
      expect(JSON.parse(vi.mocked(fetch).mock.calls[0][1]?.body as string)).toMatchObject({
        text: 'New direction',
        inputHandling: { mode, turnId: 'captured-turn' },
      });
      // HTTP acceptance alone never paints applied provenance.
      expect(chatMessages.value).toEqual([]);
      expect(pendingWebSends.value).toHaveLength(1);
    },
  );

  it.each([null, 'cancel'])('cancelling (%s) leaves draft attachments and pins untouched', async (choice) => {
    vi.mocked(requestChoice).mockResolvedValue(choice);
    const files: PendingFile[] = [{ name: 'note.txt', size: 1, file: new File(['x'], 'note.txt') }];
    pending.value = files;
    const pins = ['docs/spec.md'];
    pinnedContext.value = pins;
    expect(await sendChat('Keep this draft', files)).toBe(false);
    expect(pending.value).toBe(files);
    expect(pinnedContext.value).toBe(pins);
    expect(fetch).not.toHaveBeenCalled();
    expect(pendingWebSends.value).toEqual([]);
    expect(showsTurnActivity(activeTurn.value, false, threadId.value, false)).toBe(true);
    const button = TurnStopButton(ActiveTurnStopButton()!.props);
    expect(button.props.class).toContain('turn-stop');
    expect(button.props['aria-label']).toBe('Stop response');
    expect(button.props.disabled).toBe(false);
  });

  it('uses the same metadata for multipart attachment submissions', async () => {
    const file = new File(['recording'], 'voice.webm', { type: 'audio/webm' });
    expect(await sendChat('Voice transcript', [{ name: file.name, size: file.size, file }])).toBe(true);
    const body = vi.mocked(fetch).mock.calls[0][1]?.body as FormData;
    expect(body.get('text')).toBe('Voice transcript');
    expect(JSON.parse(body.get('inputHandling') as string)).toEqual({ mode: 'steer', turnId: 'captured-turn' });
    expect(body.get('clientMessageId')).toBeTruthy();
    expect((body.get('file') as File).name).toBe('voice.webm');
  });

  it('does not prompt for unsupported providers, stopping turns, or external threads', async () => {
    for (const turn of [
      { id: 'claude', status: 'running' as const },
      { id: 'native', status: 'stopping' as const, supportsSteering: true },
      null,
    ]) {
      applyTurnState(turn, true);
      expect(await sendChat('Follow up', null)).toBe(true);
    }
    applyTurnState({ id: 'external', status: 'running', supportsSteering: true }, true);
    channelType.value = 'telegram';
    messagingGroupId.value = 'room';
    expect(await sendChat('External context', null)).toBe(true);
    expect(requestChoice).not.toHaveBeenCalled();
    const sends = vi.mocked(fetch).mock.calls.filter(([url]) => String(url).includes('/send'));
    expect(sends).toHaveLength(4);
    for (const [, init] of sends) expect(JSON.parse(init?.body as string).inputHandling).toBeUndefined();
  });

  it('keeps the original turn if it finishes while the choice is open', async () => {
    vi.mocked(requestChoice).mockImplementation(async () => {
      applyTurnState({ id: 'successor', status: 'running', supportsSteering: true }, true);
      return 'steer';
    });
    await sendChat('Follow up', null);
    expect(JSON.parse(vi.mocked(fetch).mock.calls[0][1]?.body as string).inputHandling.turnId).toBe('captured-turn');
    expect(activeTurn.value?.id).toBe('successor');
  });

  it('does not send to another conversation after navigation during the choice', async () => {
    vi.mocked(requestChoice).mockImplementation(async () => {
      clearChat();
      return 'steer';
    });
    expect(await sendChat('Wrong destination', null)).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('reuses the client identity and intent after an ambiguous network failure', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(fetch).mockRejectedValueOnce(new Error('connection lost'));
    expect(await sendChat('Retry me', null)).toBe(false);
    applyTurnState({ id: 'new-turn', status: 'running', supportsSteering: true }, true);
    expect(await sendChat('Retry me', null)).toBe(true);
    const first = JSON.parse(vi.mocked(fetch).mock.calls[0][1]?.body as string);
    const second = JSON.parse(vi.mocked(fetch).mock.calls[1][1]?.body as string);
    expect(first).toEqual(second);
    expect(requestChoice).toHaveBeenCalledOnce();
  });
});

describe('Stop with queued and steering messages', () => {
  it.each([
    { mode: 'queue' as const, status: 'queued' as const },
    { mode: 'steer' as const, status: 'queued' as const },
    { mode: 'steer' as const, status: 'steering' as const },
    { mode: 'steer' as const, status: 'applied' as const },
  ])('keeps Stop bound to the active turn for $mode/$status input', async ({ mode, status }) => {
    vi.mocked(requestChoice).mockResolvedValue(mode);
    await sendChat('Additional input', null);
    expect(pendingWebSends.value).toHaveLength(1);
    const pendingSends = pendingWebSends.value;
    const messageId = pendingSends[0].messageId;
    chatMessages.value = [
      {
        id: messageId,
        direction: 'in',
        text: 'Additional input',
        files: null,
        ts: '2026-09-25T00:00:00Z',
        inputState: { messageId, status, turnId: 'captured-turn' },
      },
    ];
    const inputs = chatMessages.value;

    // The latest bubble is inbound and its HTTP/echo acknowledgement may still
    // be pending; neither is a reason to hide the active response's controls.
    expect(showsTurnActivity(activeTurn.value, false, threadId.value, false)).toBe(true);
    const stopView = ActiveTurnStopButton()!;
    const originalButton = TurnStopButton(stopView.props);
    expect(originalButton.props.class).toContain('turn-stop');
    expect(originalButton.props['aria-label']).toBe('Stop response');
    expect(originalButton.props.children.props.children).toBe('\u25A0');
    expect(originalButton.props.disabled).toBe(false);
    originalButton.props.onClick();
    expect(fetch).toHaveBeenLastCalledWith(
      'api/groups/group/chat/thread/stop',
      expect.objectContaining({ body: JSON.stringify({ turnId: 'captured-turn' }) }),
    );
    expect(chatMessages.value).toBe(inputs);
    expect(pendingWebSends.value).toBe(pendingSends);
    expect(TurnStopButton(ActiveTurnStopButton()!.props).props.disabled).toBe(true);

    applyTurnState(null, true);
    expect(ActiveTurnStopButton()).toBeNull();
    expect(showsTurnActivity(activeTurn.value, false, threadId.value, false)).toBe(false);
    expect(chatMessages.value).toBe(inputs);
    expect(pendingWebSends.value).toBe(pendingSends);

    applyTurnState({ id: 'follow-up-turn', status: 'running', supportsSteering: true }, true);
    expect(showsTurnActivity(activeTurn.value, false, threadId.value, false)).toBe(true);
    const nextButton = TurnStopButton(ActiveTurnStopButton()!.props);
    expect(nextButton.props.disabled).toBe(false);
    const beforeStaleClick = vi.mocked(fetch).mock.calls.length;
    originalButton.props.onClick();
    expect(fetch).toHaveBeenCalledTimes(beforeStaleClick);
    nextButton.props.onClick();
    expect(fetch).toHaveBeenLastCalledWith(
      'api/groups/group/chat/thread/stop',
      expect.objectContaining({ body: JSON.stringify({ turnId: 'follow-up-turn' }) }),
    );
  });
});
describe('durable receipt rendering', () => {
  it('uses distinct queued/steering styling and applied provenance, not acceptance as confirmation', () => {
    const state = { messageId: 'message', turnId: 'turn' };
    expect(inputStatePresentation({ ...state, status: 'queued' })).toEqual({
      className: 'input-queued',
      caption: 'Queued',
    });
    expect(inputStatePresentation({ ...state, status: 'steering' })).toEqual({
      className: 'input-steering',
      caption: 'Waiting to steer',
    });
    expect(inputStatePresentation({ ...state, status: 'applied' })).toEqual({
      className: 'input-applied',
      caption: 'Applied to current turn',
    });
    expect(inputStatePresentation({ ...state, status: 'processing' })).toBeNull();
    expect(inputStatePresentation()).toBeNull();
    expect(inputStatePresentation({ ...state, status: 'queued', reason: 'turn_finished' })?.caption).toContain(
      'Queued for follow-up',
    );
    expect(inputStatePresentation({ ...state, status: 'processing', reason: 'turn_finished' })?.caption).toBe(
      'Handled as follow-up — the target turn finished',
    );
  });

  it.each([false, true])(
    'applies explicit cancellation tombstones from scoped sync (replace=%s)',
    async (replaceThreadMessages) => {
      channelType.value = 'telegram';
      messagingGroupId.value = 'external-group';
      const input = {
        id: 'missed-cancellation',
        direction: 'in',
        text: 'Must disappear',
        timestamp: '1',
        files: [{ filename: 'private-attachment.txt' }],
        inputState: { messageId: 'missed-cancellation', status: 'steering' },
      };
      const answer = { id: 'answer', direction: 'out', text: 'Keep answer', timestamp: '2' };
      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        json: async () => ({ approvals: [], threadMessages: [input, answer] }),
      } as Response);
      await runSync({ replaceThreadMessages });
      expect(chatMessages.value).toHaveLength(2);
      expect(cancelledInputs.size).toBe(0);
      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        json: async () => ({
          approvals: [],
          threadMessages: [
            { ...input, text: '', files: null, inputState: { messageId: input.id, status: 'cancelled' } },
            answer,
          ],
        }),
      } as Response);
      await runSync({ replaceThreadMessages });
      expect(chatMessages.value.map((message) => message.id)).toEqual(['answer']);
      await runSync({ replaceThreadMessages });
      expect(chatMessages.value.map((message) => message.id)).toEqual(['answer']);
    },
  );

  it('retains other absent optimistic inputs when merging a cancellation tombstone', async () => {
    channelType.value = 'telegram';
    messagingGroupId.value = 'external-group';
    chatMessages.value = [
      {
        id: 'cancelled',
        direction: 'in',
        text: 'Remove me',
        ts: '1',
        files: null,
        inputState: { messageId: 'cancelled', status: 'queued' },
      },
      {
        id: 'unrelated',
        direction: 'in',
        text: 'Keep me',
        ts: '2',
        files: null,
        inputState: { messageId: 'unrelated', status: 'queued' },
      },
      { direction: 'in', text: 'Unconfirmed local echo', ts: '3', files: null },
    ];
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => ({
        approvals: [],
        threadMessages: [
          {
            id: 'cancelled',
            direction: 'in',
            text: '',
            timestamp: '1',
            files: null,
            inputState: { messageId: 'cancelled', status: 'cancelled' },
          },
        ],
      }),
    } as Response);
    await runSync();
    expect(chatMessages.value.map((message) => message.text)).toEqual(['Keep me', 'Unconfirmed local echo']);
  });

  it('does not reconcile a sync snapshot into a different messaging group after navigation', async () => {
    channelType.value = 'telegram';
    messagingGroupId.value = 'original-group';
    chatMessages.value = [
      {
        id: 'keep',
        direction: 'in',
        text: 'New conversation',
        files: null,
        ts: '1',
        inputState: { messageId: 'keep', status: 'queued' },
      },
    ];
    vi.mocked(fetch).mockImplementation(async () => {
      messagingGroupId.value = 'other-group';
      return { ok: true, json: async () => ({ approvals: [], threadMessages: [] }) } as Response;
    });
    await runSync();
    expect(chatMessages.value.map((message) => message.id)).toEqual(['keep']);
  });

  it.each([false, true])(
    'refreshes existing external messages from sync (replace=%s)',
    async (replaceThreadMessages) => {
      channelType.value = 'telegram';
      const base = { id: 'external', direction: 'in', text: 'Update', timestamp: '2026-09-25T00:00:00Z' };
      const state: InputState = { messageId: 'external', status: 'queued' };
      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        json: async () => ({ approvals: [], threadMessages: [{ ...base, inputState: state }] }),
      } as Response);
      await runSync({ replaceThreadMessages });
      expect(chatMessages.value[0].inputState?.status).toBe('queued');
      state.status = 'applied';
      await runSync({ replaceThreadMessages });
      expect(chatMessages.value).toHaveLength(1);
      expect(chatMessages.value[0].inputState?.status).toBe('applied');
      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        json: async () => ({ approvals: [], threadMessages: [base] }),
      } as Response);
      await runSync({ replaceThreadMessages });
      expect(chatMessages.value[0].inputState).toBeUndefined();
    },
  );

  it('restores socket snapshots and updates receipts without regressing on duplicate echoes', async () => {
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
    threadId.value = null;
    highlightMessageId.value = 'skip-focus';
    await openChat('group', 'thread', null);
    const receive = (payload: object) => sockets[0].onmessage?.({ data: JSON.stringify(payload) });
    receive({
      kind: 'history',
      threadId: 'thread',
      canSend: true,
      activeTurn: { id: 'captured-turn', status: 'running', supportsSteering: true, supportsInputEditing: true },
      connected: true,
      messages: [
        {
          id: 'message',
          direction: 'in',
          text: 'Update',
          timestamp: '2026-09-25T00:00:00Z',
          inputState: { messageId: 'message', status: 'queued' },
          canEditPending: true,
        },
      ],
    });
    expect(chatMessages.value[0].inputState?.status).toBe('queued');
    expect(activeTurn.value?.supportsSteering).toBe(true);
    expect(activeTurn.value?.supportsInputEditing).toBe(true);
    expect(chatMessages.value[0].canEditPending).toBe(true);
    receive({
      kind: 'input-state',
      states: [
        {
          messageId: 'message',
          text: 'Edited update',
          canEditPending: true,
          inputState: { messageId: 'message', status: 'steering' },
        },
      ],
    });
    expect(chatMessages.value[0].text).toBe('Edited update');
    expect(chatMessages.value[0].canEditPending).toBe(true);
    receive({
      kind: 'input-state',
      states: [{ messageId: 'message', inputState: { messageId: 'message', status: 'queued' } }],
    });
    expect(chatMessages.value[0].text).toBe('Edited update');
    expect(chatMessages.value[0].canEditPending).toBe(true);
    receive({
      kind: 'input-state',
      states: [
        { messageId: 'message', canEditPending: false, inputState: { messageId: 'message', status: 'applied' } },
      ],
    });
    receive({
      kind: 'inbound',
      id: 'message',
      text: 'Update',
      inputHandling: { mode: 'steer', turnId: 'captured-turn' },
    });
    expect(chatMessages.value).toHaveLength(1);
    expect(chatMessages.value[0].inputState?.status).toBe('applied');
    expect(chatMessages.value[0].canEditPending).toBe(false);
    receive({ kind: 'input-state', states: [{ messageId: 'message', inputState: null }] });
    expect(chatMessages.value[0].inputState).toBeUndefined();
    const activity = [{ ts: '1', text: 'Current turn trace waiting for its result' }];
    refs.carryActivity = activity;
    receive({
      kind: 'inbound',
      id: 'new-message',
      text: 'Steer request',
      inputHandling: { mode: 'steer', turnId: 'captured-turn' },
    });
    expect(refs.carryActivity).toBe(activity);
    expect(chatMessages.value[1].inputState?.status).toBe('queued');
    receive({
      kind: 'input-state',
      states: [{ messageId: 'new-message', inputState: { messageId: 'new-message', status: 'steering' } }],
    });
    expect(chatMessages.value[1].inputState?.status).toBe('steering');
    receive({
      kind: 'turn',
      turn: { id: 'captured-turn', status: 'running', supportsSteering: true },
      connected: true,
    });
    expect(refs.carryActivity).toBe(activity);
    receive({
      kind: 'turn',
      turn: { id: 'actual-next-turn', status: 'running', supportsSteering: true },
      connected: true,
    });
    expect(refs.carryActivity).toEqual([]);
  });
});
