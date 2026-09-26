import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  canCancelPendingMessage,
  cancellationOutstanding,
  cancelledInputs,
  confirmCancelledInput,
  PendingCancellation,
  pendingCancellations,
} from './pending-cancel';
import {
  chatMessages,
  groupId,
  threadId,
  channelType,
  messagingGroupId,
  activeTurn,
  turnConnected,
  pending,
  stopRequest,
} from './state';
import { currentPendingEditor, openPendingEditor, pendingEditorKey, pendingEditorSessions } from './pending-edit';
import { PendingMessageActions } from './components/PendingMessageActions';
import type { ChatMessage, Thread } from './types';

vi.hoisted(() => vi.stubGlobal('window', { matchMedia: () => ({ matches: false }) }));
const thread: Thread = {
  threadId: 'thread/id',
  channelType: 'web',
  messagingGroupId: 'web/group',
  title: '',
  lastActivityAt: '',
};
const message: ChatMessage = {
  id: 'message/id',
  text: 'Original',
  ts: '1',
  direction: 'in',
  files: [{ filename: 'keep.txt' }],
  canEditPending: true,
  inputState: { messageId: 'message/id', status: 'queued', queuedForNextTurn: true },
};
const key = pendingEditorKey('group', thread, message.id);
function request(): PendingCancellation {
  const request = new PendingCancellation('group', thread, message.id!);
  pendingCancellations.value = new Map([[key, request]]);
  return request;
}
beforeEach(() => {
  groupId.value = 'group';
  threadId.value = thread.threadId;
  channelType.value = 'web';
  messagingGroupId.value = thread.messagingGroupId!;
  chatMessages.value = [message, { ...message, direction: 'out' }];
  activeTurn.value = { id: 'active', status: 'running', supportsInputEditing: true, supportsInputCancellation: true };
  turnConnected.value = true;
  pendingCancellations.value = new Map();
  pendingEditorSessions.value = new Map();
  cancelledInputs.clear();
  stopRequest.value = null;
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ ok: true, id: message.id }) }),
  );
});

describe('pending input cancellation', () => {
  it('requires an owned web pending target and explicit native cancellation support', () => {
    expect(canCancelPendingMessage(message, thread, activeTurn.value, true)).toBe(true);
    expect(canCancelPendingMessage(message, thread, { ...activeTurn.value!, supportsInputEditing: false }, true)).toBe(
      true,
    );
    expect(
      canCancelPendingMessage(message, thread, { id: 'old', status: 'running', supportsInputEditing: true }, true),
    ).toBe(false);
    expect(canCancelPendingMessage(message, thread, activeTurn.value, false)).toBe(false);
    expect(canCancelPendingMessage(message, thread, { ...activeTurn.value!, status: 'stopping' }, true)).toBe(false);
    expect(canCancelPendingMessage({ ...message, canEditPending: false }, thread, activeTurn.value, true)).toBe(false);
    expect(canCancelPendingMessage(message, { ...thread, channelType: 'telegram' }, activeTurn.value, true)).toBe(
      false,
    );
    for (const status of ['processing', 'applied', 'cancelled'] as const) {
      expect(
        canCancelPendingMessage(
          { ...message, inputState: { messageId: message.id!, status } },
          thread,
          activeTurn.value,
          true,
        ),
      ).toBe(false);
    }
  });

  it('uses DELETE with a UUID body and waits for authoritative success, preserving Stop and unsent attachments', async () => {
    const turn = activeTurn.value;
    const files = pending.value;
    let finish!: (response: any) => void;
    vi.mocked(fetch).mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const cancellation = request();
    const cancelling = cancellation.cancel();
    expect(chatMessages.value).toHaveLength(2);
    expect(cancellation.state.value.busy).toBe(true);
    expect(fetch).toHaveBeenCalledWith(
      'api/groups/group/chat/thread%2Fid/messages/message%2Fid?channel=web&mg=web%2Fgroup',
      expect.objectContaining({
        method: 'DELETE',
        body: JSON.stringify({ requestId: cancellation.requestId }),
      }),
    );
    expect(cancellation.requestId).toMatch(/^[0-9a-f-]{36}$/);
    finish({ ok: true, status: 200, json: async () => ({ ok: true, id: message.id }) });
    expect(await cancelling).toBe(true);
    expect(chatMessages.value).toEqual([{ ...message, direction: 'out' }]);
    expect(activeTurn.value).toBe(turn);
    expect(pending.value).toBe(files);
    expect(stopRequest.value).toBeNull();
  });

  it.each(['cancel_pending', 'network', 'malformed'])(
    'retains bubble and retry identity after %s, blocking edits',
    async (failure) => {
      if (failure === 'network') vi.mocked(fetch).mockRejectedValue(new Error('lost'));
      else
        vi.mocked(fetch).mockResolvedValue({
          ok: failure === 'malformed',
          status: failure === 'malformed' ? 200 : 503,
          json: async () => (failure === 'malformed' ? { ok: true, id: 'wrong-id' } : { error: 'cancel_pending' }),
        } as Response);
      const cancellation = request();
      expect(await cancellation.cancel()).toBe(false);
      expect(chatMessages.value).toHaveLength(2);
      expect(cancellationOutstanding(key)).toBe(true);
      const actions = PendingMessageActions({ message, thread, gid: 'group' })!;
      const buttons = [actions.props.children].flat(Infinity).filter((node: any) => node?.type === 'button') as any[];
      expect(buttons.find((button) => button.props.children === 'Edit').props.disabled).toBe(true);
      await cancellation.cancel();
      expect(vi.mocked(fetch).mock.calls[1][1]?.body).toBe(vi.mocked(fetch).mock.calls[0][1]?.body);
    },
  );

  it.each(['input_not_pending', 'steering_consumed'])('does not remove a bubble on %s conflict', async (error) => {
    vi.mocked(fetch).mockResolvedValue({ ok: false, status: 409, json: async () => ({ error }) } as Response);
    const cancellation = request();
    expect(await cancellation.cancel()).toBe(false);
    expect(cancellation.state.value.unresolved).toBe(false);
    expect(cancellation.state.value.error).toContain('not cancelled');
    expect(chatMessages.value).toHaveLength(2);
  });

  it.each([
    ['runner_disconnected', 503],
    ['cancellation_unsupported', 503],
    ['cancel_in_progress', 409],
    ['edit_in_progress', 409],
  ] as const)('retains the bubble without an ambiguous lock for explicit %s rejection', async (error, status) => {
    vi.mocked(fetch).mockResolvedValue({ ok: false, status, json: async () => ({ error }) } as Response);
    const cancellation = request();
    expect(await cancellation.cancel()).toBe(false);
    expect(cancellation.state.value.unresolved).toBe(false);
    expect(chatMessages.value).toHaveLength(2);
    expect(cancellation.state.value.error).not.toBe('');
    await cancellation.cancel();
    expect(vi.mocked(fetch).mock.calls[1][1]?.body).toBe(vi.mocked(fetch).mock.calls[0][1]?.body);
  });

  it('ignores late network failure after a durable live cancellation and closes its editor', async () => {
    openPendingEditor('group', thread, message);
    let reject!: (error: Error) => void;
    vi.mocked(fetch).mockImplementation(
      () =>
        new Promise((_resolve, fail) => {
          reject = fail;
        }),
    );
    const cancellation = request();
    const result = cancellation.cancel();
    confirmCancelledInput(message.id!);
    expect(currentPendingEditor()).toBeUndefined();
    reject(new Error('lost'));
    expect(await result).toBe(true);
    expect(cancellation.state.value.confirmed).toBe(true);
    expect(cancellation.state.value.error).toBe('');
  });

  it('never cancels while a submitted edit remains unresolved', async () => {
    openPendingEditor('group', thread, message);
    const draft = currentPendingEditor()![1].draft;
    draft.setText('Revision');
    vi.mocked(fetch).mockResolvedValue({
      ok: false,
      status: 503,
      json: async () => ({ error: 'edit_pending' }),
    } as Response);
    await draft.save();
    expect(await request().cancel()).toBe(false);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('does not remove an identically named input after navigation', async () => {
    vi.mocked(fetch).mockImplementation(async () => {
      messagingGroupId.value = 'other';
      return { ok: true, status: 200, json: async () => ({ ok: true, id: message.id }) } as Response;
    });
    await request().cancel();
    expect(chatMessages.value).toHaveLength(2);
  });
});
