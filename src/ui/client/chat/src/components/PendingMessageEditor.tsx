import { useState } from 'preact/hooks';
import { activeTurn, turnConnected } from '../state';
import { canEditPendingMessage, PendingEditDraft, savePendingMessage } from '../pending-edit';
import type { ChatMessage, Thread } from '../types';
import './PendingMessageEditor.css';

export function PendingMessageEditor({ message, thread, gid }: { message: ChatMessage; thread: Thread | null; gid: string | null }) {
  const [draft, setDraft] = useState<PendingEditDraft | null>(null);
  const [open, setOpen] = useState(false);
  const eligible = canEditPendingMessage(message, thread, activeTurn.value, turnConnected.value);
  if (!open || !draft) {
    const unresolved = draft && (draft.state.value.unresolved || draft.state.value.busy);
    if ((!eligible && !unresolved) || !gid || !thread) return null;
    return (
      <button type="button" class="msg-action-btn msg-edit-btn"
        title="Edit pending message" aria-label="Edit pending message"
        onClick={() => {
          setOpen(true);
          if (unresolved) return;
          const targetThread = { ...thread };
          const messageId = message.id!;
          setDraft(new PendingEditDraft(message.text, (body) => savePendingMessage(gid, targetThread, messageId, body)));
        }}
      >{'\u270e'}</button>
    );
  }
  const state = draft.state.value;
  const changed = message.text !== draft.originalText;
  const stateError = !eligible
    ? 'This message is no longer editable or the runner is unavailable. Your draft has been kept.'
    : changed ? 'The saved text changed while you were editing. Your draft has been kept.' : '';
  return (
    <form class="pending-message-editor" onPointerDown={(event) => event.stopPropagation()} onSubmit={(event) => {
      event.preventDefault();
      if (!state.retry && (!eligible || changed)) return;
      void draft.save().then((saved) => { if (saved) { setDraft(null); setOpen(false); } });
    }}>
      <label>
        Edit pending message (text only)
        <textarea autoFocus aria-label="Pending message text" value={state.text} disabled={state.busy || state.unresolved}
          onInput={(event) => draft.setText(event.currentTarget.value)} />
      </label>
      {(state.error || stateError) && <p role="alert">{state.error || stateError}</p>}
      {(state.unresolved || state.busy) && <p role="status">
        This request may still apply. Cancel only closes the editor; it cannot withdraw a submitted save.
      </p>}
      <div class="pending-edit-actions">
        <button type="submit" disabled={state.busy || (!state.retry && (!eligible || changed || !state.text.trim() || state.text === draft.originalText))}
          aria-busy={state.busy}>
          {state.busy ? 'Saving…' : state.retry ? 'Retry save' : 'Save'}
        </button>
        <button type="button" onClick={() => setOpen(false)}>Cancel</button>
      </div>
    </form>
  );
}
