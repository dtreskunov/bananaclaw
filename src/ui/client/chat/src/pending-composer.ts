import { useLayoutEffect, useRef } from 'preact/hooks';
import {
  pending,
  groupId,
  threadId,
  channelType,
  messagingGroupId,
  chatMessages,
  activeTurn,
  turnConnected,
} from './state';
import {
  canEditPendingMessage,
  currentPendingEditor,
  exitPendingEditor,
  setPendingEditorSession,
  pendingEditorSessions,
} from './pending-edit';
import { cancellationOutstanding } from './pending-cancel';
import type { PendingFile } from './types';

// Backups belong to a conversation, not a mounted Composer or the currently
// selected thread. A late save must never restore a draft into another chat.
export const pendingComposerBackups = new Map<string, { text: string; files: PendingFile[] }>();

export function composerConversationKey(): string {
  return JSON.stringify([groupId.value, channelType.value, messagingGroupId.value, threadId.value]);
}

export function usePendingComposer(inputRef: { current: HTMLTextAreaElement | null }, autosize: () => void) {
  const conversation = composerConversationKey();
  const editing = currentPendingEditor();
  const key = editing?.[0];
  const session = editing?.[1];
  const state = session?.draft.state.value;
  const previousKey = useRef<string | undefined>(undefined);
  const previousConversation = useRef(conversation);
  const message =
    session && chatMessages.value.find((message) => message.direction === 'in' && message.id === session.messageId);
  const eligible = !!(
    message && canEditPendingMessage(message, session!.thread, activeTurn.value, turnConnected.value)
  );
  const changed = !!message && message.text !== session?.draft.originalText;
  const cancellation = !!key && cancellationOutstanding(key);
  const error =
    state?.error ||
    (session &&
      (!eligible
        ? 'This message is no longer editable or the runner is unavailable. Your draft has been kept.'
        : changed
          ? 'The saved text changed while you were editing. Your draft has been kept.'
          : ''));
  const disabled =
    !!state &&
    (state.busy ||
      cancellation ||
      (!state.retry && (!eligible || changed || !state.text.trim() || state.text === session?.draft.originalText)));

  useLayoutEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    if (previousConversation.current !== conversation) {
      if (!previousKey.current) {
        pendingComposerBackups.set(previousConversation.current, { text: input.value, files: pending.value });
      }
      input.value = '';
      pending.value = [];
      previousConversation.current = conversation;
    }
    if (session) {
      if (!pendingComposerBackups.has(conversation)) {
        pendingComposerBackups.set(conversation, { text: input.value, files: pending.value });
      }
      pending.value = [];
      input.value = session.draft.state.value.text;
      if (key !== previousKey.current) input.focus();
    } else {
      const backup = pendingComposerBackups.get(conversation);
      if (backup) {
        input.value = backup.text;
        pending.value = backup.files;
        pendingComposerBackups.delete(conversation);
      }
    }
    previousKey.current = key;
    autosize();
  }, [conversation, key, state?.text]);

  return {
    editing: !!session,
    state,
    error,
    disabled,
    input(text: string) {
      session?.draft.setText(text);
    },
    exit() {
      if (key) exitPendingEditor(key);
    },
    async save() {
      if (!session || !key || disabled) return;
      if (await session.draft.save()) {
        if (pendingEditorSessions.value.get(key)?.draft === session.draft) setPendingEditorSession(key, null);
      }
    },
  };
}
