import { activeTurn, turnConnected } from '../state';
import { canEditPendingMessage, composerSendInFlight, openPendingEditor, pendingEditorKey, pendingEditorSessions } from '../pending-edit';
import { canCancelPendingMessage, cancellationOutstanding, editRequestOutstanding, PendingCancellation, pendingCancellations } from '../pending-cancel';
import { isRecording } from '../recorder';
import { voice } from '../voice-audio';
import type { ChatMessage, Thread } from '../types';

export function PendingMessageActions({ message, thread, gid }: { message: ChatMessage; thread: Thread | null; gid: string | null }) {
  if (!gid || !thread || !message.id || message.direction !== 'in') return null;
  const key = pendingEditorKey(gid, thread, message.id);
  const editor = pendingEditorSessions.value.get(key);
  const cancellation = pendingCancellations.value.get(key);
  const cancelState = cancellation?.state.value;
  const editAllowed = canEditPendingMessage(message, thread, activeTurn.value, turnConnected.value);
  const cancelAllowed = canCancelPendingMessage(message, thread, activeTurn.value, turnConnected.value);
  const recording = isRecording.value || !['idle', 'error'].includes(voice.state.value.phase) || voice.state.value.sending;
  return <>
    {(editAllowed || editor) && <button type="button" class="pending-input-action"
      disabled={cancellationOutstanding(key) || recording || composerSendInFlight.value}
      onClick={() => {
        if (!cancellationOutstanding(key) && !recording) openPendingEditor(gid, thread, message);
      }}
      aria-label="Edit pending message">Edit</button>}
    {(cancelAllowed || cancelState?.unresolved) && <button type="button" class="pending-input-action"
      disabled={cancelState?.busy || editRequestOutstanding(key)}
      aria-busy={cancelState?.busy}
      onClick={() => {
        const request = cancellation ?? new PendingCancellation(gid, { ...thread }, message.id!);
        if (!cancellation) pendingCancellations.value = new Map(pendingCancellations.value).set(key, request);
        void request.cancel();
      }}>{cancelState?.busy ? 'Cancelling…' : cancelState?.unresolved ? 'Retry cancel' : 'Cancel'}</button>}
    {cancelState?.error && <span class="pending-input-error" role="alert">{cancelState.error}</span>}
  </>;
}
