// Shared feedback: errors persist until dismissed; successes are transient.
import './Toast.css';
import { toastMessage } from '../state';
import type { ToastMessage } from '../types';

let nextId = 1;
let hideTimer: ReturnType<typeof setTimeout> | null = null;
const pending: { message: ToastMessage; ms: number }[] = [];

function displayToast(message: ToastMessage, ms: number): void {
  if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
  toastMessage.value = message;
  if (message.kind === 'err' || message.action) return;
  hideTimer = setTimeout(() => {
    hideTimer = null;
    if (toastMessage.value?.id === message.id) dismissToast();
  }, ms);
}

function enqueueToast(message: ToastMessage, ms = 1800): void {
  // A later success, error, or reload prompt must not erase an unread error.
  if (toastMessage.value?.kind === 'err') {
    pending.push({ message, ms });
  } else {
    displayToast(message, ms);
  }
}

export function showToast(text: string, kind: 'ok' | 'err' = 'ok', ms = 1800): void {
  enqueueToast({ id: nextId++, text, kind }, ms);
}

// Sticky toast action — does not auto-hide. Caller's onClick is responsible
// for dismissing (by calling dismissToast or reloading the page).
export function showStickyToast(
  text: string,
  onClick: () => void,
  kind: 'ok' | 'err' = 'ok',
): void {
  enqueueToast({ id: nextId++, text, kind, action: onClick });
}

export function dismissToast(): void {
  if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
  const next = pending.shift();
  if (next) displayToast(next.message, next.ms);
  else toastMessage.value = null;
}

export function Toast() {
  const t = toastMessage.value;
  if (!t) return null;
  if (t.kind === 'err') {
    return (
      <div class="toast toast-err toast-sticky" key={t.id}>
        <span class="toast-text" role="alert">{t.text}</span>
        <div class="toast-controls">
          {t.action ? <button type="button" onClick={t.action}>Continue</button> : null}
          <button type="button" onClick={dismissToast} aria-label="Dismiss error">Dismiss</button>
        </div>
      </div>
    );
  }
  const sticky = !!t.action;
  return (
    <button
      type="button"
      class={'toast accent-icon-btn toast-' + (t.kind || 'ok') + (sticky ? ' toast-sticky' : '')}
      aria-live="polite"
      key={t.id}
      onClick={t.action || dismissToast}
    >
      <span class="toast-text">{t.text}</span>
    </button>
  );
}
