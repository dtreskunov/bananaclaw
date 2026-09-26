import { signal } from '@preact/signals';
import { chatMessages, groupId, threadId, channelType, messagingGroupId, pendingWebSends } from './state';
import {
  canEditPendingMessage,
  exitPendingEditor,
  isCurrentConversation,
  pendingEditorKey,
  pendingEditorSessions,
  pendingMessageUrl,
} from './pending-edit';
import type { ActiveTurn, ChatMessage, Thread } from './types';

export function canCancelPendingMessage(
  message: ChatMessage,
  thread: Thread | null,
  turn: ActiveTurn | null,
  connected: boolean,
): boolean {
  return (
    turn?.supportsInputCancellation === true &&
    canEditPendingMessage(message, thread, { ...turn, supportsInputEditing: true }, connected)
  );
}

export const pendingCancellations = signal(new Map<string, PendingCancellation>());
export const cancelledInputs = new Set<string>();

function currentInputKey(id: string): string {
  return pendingEditorKey(
    groupId.value,
    {
      threadId: threadId.value!,
      channelType: channelType.value,
      messagingGroupId: messagingGroupId.value ?? undefined,
      title: '',
      lastActivityAt: '',
    },
    id,
  );
}

export function isCancelledInput(id?: string): boolean {
  return !!id && cancelledInputs.has(currentInputKey(id));
}

export function confirmCancelledInput(id: string, key = currentInputKey(id)): void {
  cancelledInputs.add(key);
  if (key === currentInputKey(id)) {
    pendingWebSends.value = pendingWebSends.value.filter(
      (send) => send.threadId !== threadId.value || send.messageId !== id,
    );
  }
  const request = pendingCancellations.value.get(key);
  if (request) request.state.value = { busy: false, unresolved: false, error: '', confirmed: true };
  exitPendingEditor(key);
}

export function editRequestOutstanding(key: string): boolean {
  const state = pendingEditorSessions.value.get(key)?.draft.state.value;
  return !!(state?.busy || state?.unresolved);
}

export function cancellationOutstanding(key: string): boolean {
  const state = pendingCancellations.value.get(key)?.state.value;
  return !!(state?.busy || state?.unresolved);
}

/** Never withdraw a bubble on an optimistic, timed-out, or malformed response. */
export class PendingCancellation {
  readonly state = signal({ busy: false, unresolved: false, error: '', confirmed: false });
  readonly requestId = crypto.randomUUID();

  constructor(
    readonly gid: string,
    readonly thread: Thread,
    readonly messageId: string,
  ) {}

  async cancel(): Promise<boolean> {
    if (this.state.value.confirmed) return true;
    if (this.state.value.busy || editRequestOutstanding(pendingEditorKey(this.gid, this.thread, this.messageId)))
      return false;
    this.state.value = { ...this.state.value, busy: true, error: '' };
    try {
      const response = await fetch(pendingMessageUrl(this.gid, this.thread, this.messageId), {
        method: 'DELETE',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requestId: this.requestId }),
      });
      const data = await response.json();
      if (response.status === 200 && data.ok === true && data.id === this.messageId) {
        confirmCancelledInput(this.messageId, pendingEditorKey(this.gid, this.thread, this.messageId));
        this.state.value = { busy: false, unresolved: false, error: '', confirmed: true };
        if (isCurrentConversation(this.gid, this.thread)) {
          chatMessages.value = chatMessages.value.filter(
            (message) => message.direction !== 'in' || message.id !== this.messageId,
          );
        }
        if (this.state.value.confirmed) return true;
        return true;
      }
      const conflict = ['input_not_pending', 'steering_consumed'].includes(data.error);
      this.state.value = {
        busy: false,
        confirmed: false,
        unresolved:
          data.error === 'cancel_pending' ||
          (response.status >= 500 && !['runner_disconnected', 'cancellation_unsupported'].includes(data.error)) ||
          response.ok,
        error: conflict
          ? 'This message has already been consumed or is no longer pending. It was not cancelled.'
          : data.error === 'edit_in_progress'
            ? 'An edit is still awaiting confirmation. Retry cancel after that edit finishes.'
            : data.error === 'cancel_in_progress'
              ? 'Another cancellation is still awaiting confirmation. Retry cancel after it finishes.'
              : data.error === 'runner_disconnected'
                ? 'The runner is disconnected. The message was not cancelled. Retry when connected.'
                : data.error === 'cancellation_unsupported'
                  ? 'The running agent does not support cancellation. The message was not cancelled.'
                  : 'Cancellation could not be confirmed. Retry cancel to check the same request.',
      };
    } catch {
      if (this.state.value.confirmed) return true;
      this.state.value = {
        busy: false,
        confirmed: false,
        unresolved: true,
        error: 'Cancellation could not be confirmed. Retry cancel to check the same request.',
      };
    }
    return false;
  }
}
