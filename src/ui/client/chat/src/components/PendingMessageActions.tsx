import type { ComponentChildren } from 'preact';
import { activeTurn, turnConnected } from '../state';
import { canEditPendingMessage, composerSendInFlight, openPendingEditor, pendingEditorKey, pendingEditorSessions } from '../pending-edit';
import { canCancelPendingMessage, cancellationOutstanding, editRequestOutstanding, PendingCancellation, pendingCancellations } from '../pending-cancel';
import { isRecording } from '../recorder';
import { voice } from '../voice-audio';
import type { ChatMessage, Thread } from '../types';
import { EditIcon, TrashIcon } from './ActionIcons';

export function PendingMessageActions({ message, thread, gid, children }: {
  message: ChatMessage; thread: Thread | null; gid: string | null; children?: ComponentChildren;
}) {
  if (!gid || !thread || !message.id || message.direction !== 'in')
    return children ? <span class="msg-inline-actions">{children}</span> : null;
  const key = pendingEditorKey(gid, thread, message.id);
  const editor = pendingEditorSessions.value.get(key);
  const cancellation = pendingCancellations.value.get(key);
  const cancelState = cancellation?.state.value;
  const showEdit = canEditPendingMessage(message, thread, activeTurn.value, turnConnected.value) || !!editor;
  const showCancel = canCancelPendingMessage(message, thread, activeTurn.value, turnConnected.value) || !!cancelState?.unresolved;
  const hasPendingActions = showEdit || showCancel;
  const recording = isRecording.value || !['idle', 'error'].includes(voice.state.value.phase) || voice.state.value.sending;
  let cancelLabel = 'Cancel pending message';
  if (cancelState?.busy) cancelLabel = 'Cancelling…';
  else if (cancelState?.unresolved) cancelLabel = 'Retry cancel';
  return <>
    <span class={`msg-inline-actions${hasPendingActions ? ' pending-input-actions' : ''}`}>
      {showEdit && <button type="button" class="msg-action-btn msg-edit-btn"
        disabled={cancellationOutstanding(key) || recording || composerSendInFlight.value}
        onClick={() => {
          if (!cancellationOutstanding(key) && !recording) openPendingEditor(gid, thread, message);
        }}
        title="Edit pending message" aria-label="Edit pending message"><EditIcon /></button>}
      {showCancel && <button type="button" class="msg-action-btn msg-cancel-btn"
        disabled={cancelState?.busy || editRequestOutstanding(key)}
        aria-busy={cancelState?.busy}
        title={cancelLabel} aria-label={cancelLabel}
        onClick={() => {
          const request = cancellation ?? new PendingCancellation(gid, { ...thread }, message.id!);
          if (!cancellation) pendingCancellations.value = new Map(pendingCancellations.value).set(key, request);
          void request.cancel();
        }}><TrashIcon /></button>}
      {children}
    </span>
    {cancelState?.error && <span class="pending-input-error" role="alert">{cancelState.error}</span>}
  </>;
}
