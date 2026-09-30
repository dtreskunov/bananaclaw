import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { canEditMessageInBranch, canEditPendingMessage, PendingEditDraft, savePendingMessage } from './pending-edit';
import {
  activeTurn,
  channelType,
  chatMessages,
  groupId,
  messagingGroupId,
  pending,
  pinnedContext,
  stopRequest,
  threadId,
  turnConnected,
} from './state';
import type { ChatMessage, Thread } from './types';
import type { PendingEditBody, PendingEditResult } from './pending-edit';

vi.hoisted(() => vi.stubGlobal('window', { matchMedia: () => ({ matches: false }) }));

const thread: Thread = {
  threadId: 'thread/id',
  channelType: 'web',
  messagingGroupId: 'web/group',
  title: 'Chat',
  lastActivityAt: '',
};
const message: ChatMessage = {
  id: 'web-message/id',
  direction: 'in',
  text: 'Original',
  files: [{ filename: 'keep.txt' }],
  ts: '1',
  author: { userId: 'owner', displayName: 'Owner' },
  canEditPending: true,
  inputState: { messageId: 'web-message/id', status: 'queued', turnId: 'turn' },
};
const success = (): PendingEditResult => ({
  ok: true,
  status: 200,
  data: { ok: true, id: message.id, text: 'Revised' },
});
const failure = (error: string, status = 409): PendingEditResult => ({ ok: false, status, data: { error } });

beforeEach(() => {
  groupId.value = 'group';
  threadId.value = thread.threadId;
  channelType.value = 'web';
  messagingGroupId.value = thread.messagingGroupId!;
  chatMessages.value = [message];
  activeTurn.value = { id: 'turn', status: 'running', supportsInputEditing: true };
  turnConnected.value = true;
  stopRequest.value = null;
});
afterEach(() => vi.restoreAllMocks());

describe('pending edit eligibility', () => {
  it.each(['queued', 'steering'] as const)('edits owned %s web inputs, never branches them', (status) => {
    const input = { ...message, inputState: { ...message.inputState!, status } };
    expect(canEditPendingMessage(input, thread, activeTurn.value, true)).toBe(true);
    expect(canEditMessageInBranch(input)).toBe(false);
  });
  it('hides other authors, external inputs, disconnected and old runners', () => {
    expect(canEditPendingMessage({ ...message, canEditPending: false }, thread, activeTurn.value, true)).toBe(false);
    expect(canEditPendingMessage({ ...message, canEditPending: undefined }, thread, activeTurn.value, true)).toBe(
      false,
    );
    expect(canEditPendingMessage(message, { ...thread, channelType: 'telegram' }, activeTurn.value, true)).toBe(false);
    expect(canEditPendingMessage(message, thread, activeTurn.value, false)).toBe(false);
    expect(canEditPendingMessage(message, thread, { ...activeTurn.value!, status: 'stopping' }, true)).toBe(false);
    expect(canEditPendingMessage(message, thread, { id: 'old', status: 'running', supportsSteering: true }, true)).toBe(
      false,
    );
  });
  it.each(['processing', 'applied'] as const)('never branch-edits %s even after completion', (status) => {
    const input = { ...message, inputState: { ...message.inputState!, status } };
    expect(canEditMessageInBranch(input)).toBe(false);
    expect(canEditPendingMessage(input, thread, null, true)).toBe(false);
  });
  it('preserves historical normal message branching regardless of original author', () => {
    expect(canEditMessageInBranch({ ...message, inputState: undefined, canEditPending: false })).toBe(true);
  });
});

describe('durable in-place edit action', () => {
  it('waits for acknowledgement and preserves attachments, order, intent, composer and Stop', async () => {
    let finish!: (response: unknown) => void;
    vi.stubGlobal(
      'fetch',
      vi.fn(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      ),
    );
    const outgoing: ChatMessage = { ...message, direction: 'out', id: 'out', text: 'Response' };
    chatMessages.value = [message, outgoing];
    const composer = { value: 'Unsent composer draft' } as HTMLTextAreaElement;
    const lookup = vi.fn(() => composer);
    vi.stubGlobal('document', { getElementById: lookup });
    const files = pending.value;
    const pins = pinnedContext.value;
    const turn = activeTurn.value;
    const body = { requestId: 'retry-id', expectedText: message.text, text: 'Revised' };
    const saving = savePendingMessage('group', thread, message.id!, body);
    expect(chatMessages.value[0]).toBe(message);
    expect(fetch).toHaveBeenCalledWith(
      'api/groups/group/chat/thread%2Fid/messages/web-message%2Fid?channel=web&mg=web%2Fgroup',
      expect.objectContaining({ method: 'PATCH', body: JSON.stringify(body) }),
    );
    finish({ ok: true, status: 200, json: async () => success().data });
    await saving;
    expect(chatMessages.value).toEqual([message, outgoing]);
    expect(chatMessages.value[0].files).toBe(message.files);
    expect(chatMessages.value[0].inputState).toBe(message.inputState);
    expect(composer.value).toBe('Unsent composer draft');
    expect(lookup).not.toHaveBeenCalled();
    expect(pending.value).toBe(files);
    expect(pinnedContext.value).toBe(pins);
    expect(activeTurn.value).toBe(turn);
    expect(stopRequest.value).toBeNull();
  });
  it('does not modify a newly navigated conversation', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        groupId.value = 'another-group';
        return { ok: true, status: 200, json: async () => success().data };
      }),
    );
    await savePendingMessage('group', thread, message.id!, {
      requestId: 'id',
      expectedText: 'Original',
      text: 'Revised',
    });
    expect(chatMessages.value[0]).toBe(message);
  });
  it('does not overwrite newer projected text when retrying an older accepted edit', async () => {
    chatMessages.value = [{ ...message, text: 'Newer edit from another tab' }];
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ ok: true, id: message.id, text: 'Newer edit from another tab' }),
      }),
    );
    await savePendingMessage('group', thread, message.id!, {
      requestId: 'older-accepted-request',
      expectedText: 'Original',
      text: 'Older edit',
    });
    expect(chatMessages.value[0].text).toBe('Newer edit from another tab');
    expect(chatMessages.value[0].files).toBe(message.files);
    expect(chatMessages.value[0].inputState).toBe(message.inputState);
  });
});

describe('pending draft lifecycle', () => {
  it('does not mutate the original on draft changes or cancel without saving', () => {
    const submit = vi.fn();
    const draft = new PendingEditDraft(message.text, submit);
    draft.setText('Revised');
    expect(chatMessages.value[0]).toBe(message);
    expect(submit).not.toHaveBeenCalled();
  });
  it.each(['input_not_pending', 'text_changed', 'steering_consumed'])(
    'keeps draft on %s and status transitions',
    async (code) => {
      const draft = new PendingEditDraft(message.text, vi.fn().mockResolvedValue(failure(code)));
      draft.setText('Revised');
      expect(await draft.save()).toBe(false);
      chatMessages.value = [
        {
          ...message,
          text: 'Changed elsewhere',
          canEditPending: false,
          inputState: { ...message.inputState!, status: 'applied' },
        },
      ];
      activeTurn.value = null;
      expect(draft.state.value.text).toBe('Revised');
      expect(draft.state.value.error).toContain('draft has been kept');
      expect(draft.originalText).toBe('Original');
    },
  );
  it.each(['runner_disconnected', 'editing_unsupported'])(
    'retries %s with same body; new text gets new identity',
    async (code) => {
      const submit = vi.fn().mockResolvedValue(failure(code, 503));
      const draft = new PendingEditDraft('Original', submit);
      draft.setText('Revised');
      await draft.save();
      await draft.save();
      expect(submit.mock.calls[0][0]).toEqual(submit.mock.calls[1][0]);
      draft.setText('Another revision');
      await draft.save();
      expect(submit.mock.calls[2][0].requestId).not.toBe(submit.mock.calls[0][0].requestId);
    },
  );
  it('locks an ambiguous pending save and resolves it using the same request', async () => {
    const submit = vi.fn().mockResolvedValueOnce(failure('edit_pending', 503)).mockResolvedValueOnce(success());
    const draft = new PendingEditDraft('Original', submit);
    draft.setText('Revised');
    expect(await draft.save()).toBe(false);
    expect(draft.state.value.unresolved).toBe(true);
    draft.setText('Must not submit');
    expect(draft.state.value.text).toBe('Revised');
    expect(await draft.save()).toBe(true);
    expect(submit.mock.calls[1][0]).toEqual(submit.mock.calls[0][0]);
  });
  it('locks network failures and blocks duplicate submissions while saving', async () => {
    let reject!: (reason: Error) => void;
    const submit = vi.fn(
      (_body: PendingEditBody) =>
        new Promise<PendingEditResult>((_resolve, fail) => {
          reject = fail;
        }),
    );
    const draft = new PendingEditDraft('Original', submit);
    draft.setText('Revised');
    const saving = draft.save();
    expect(draft.state.value.busy).toBe(true);
    expect(await draft.save()).toBe(false);
    reject(new Error('Connection lost'));
    await saving;
    expect(draft.state.value.unresolved).toBe(true);
    expect(submit).toHaveBeenCalledOnce();
  });
});
