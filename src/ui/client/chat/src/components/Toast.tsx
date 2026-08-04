// Top-center feedback button for transient messages and sticky actions.
import './Toast.css';
import { useEffect } from 'preact/hooks';
import { toastMessage } from '../state';

let nextId = 1;
let hideTimer: ReturnType<typeof setTimeout> | null = null;

export function showToast(text: string, kind: 'ok' | 'err' = 'ok', ms = 1800): void {
  if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
  const id = nextId++;
  toastMessage.value = { id, text, kind };
  hideTimer = setTimeout(() => {
    if (toastMessage.value && toastMessage.value.id === id) toastMessage.value = null;
    hideTimer = null;
  }, ms);
}

// Sticky toast action — does not auto-hide. Caller's onClick is responsible
// for dismissing (by calling dismissToast or reloading the page).
export function showStickyToast(
  text: string,
  onClick: () => void,
  kind: 'ok' | 'err' = 'ok',
): void {
  if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
  const id = nextId++;
  toastMessage.value = { id, text, kind, action: onClick };
}

export function dismissToast(): void {
  if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
  toastMessage.value = null;
}

export function Toast() {
  const t = toastMessage.value;
  // Re-mount on each new id so the CSS animation re-plays.
  useEffect(() => undefined, [t?.id]);
  if (!t) return null;
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
