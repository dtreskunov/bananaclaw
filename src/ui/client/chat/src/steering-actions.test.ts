import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearChat, openChat, runSync, sendChat } from './actions';
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
import { showsTurnActivity } from './chat-protocol';
import { ActiveTurnStopButton } from './components/ActiveTurnStopButton';
import { TurnStopButton } from './components/TurnStopButton';
import type { InputState, PendingFile } from './types';

vi.hoisted(() => {
  vi.stubGlobal('window', { matchMedia: () => ({ matches: false }) });
});
vi.mock('./components/PromptModal', () => ({ requestChoice: vi.fn() }));
vi.mock('./hash', () => ({ writeHash: vi.fn() }));

beforeEach(() => {
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
      activeTurn: { id: 'captured-turn', status: 'running', supportsSteering: true },
      connected: true,
      messages: [
        {
          id: 'message',
          direction: 'in',
          text: 'Update',
          timestamp: '2026-09-25T00:00:00Z',
          inputState: { messageId: 'message', status: 'queued' },
        },
      ],
    });
    expect(chatMessages.value[0].inputState?.status).toBe('queued');
    expect(activeTurn.value?.supportsSteering).toBe(true);
    receive({
      kind: 'input-state',
      states: [{ messageId: 'message', inputState: { messageId: 'message', status: 'applied' } }],
    });
    receive({
      kind: 'inbound',
      id: 'message',
      text: 'Update',
      inputHandling: { mode: 'steer', turnId: 'captured-turn' },
    });
    expect(chatMessages.value).toHaveLength(1);
    expect(chatMessages.value[0].inputState?.status).toBe('applied');
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
