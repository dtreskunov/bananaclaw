import { computed, effect } from '@preact/signals';
import { agentActivity } from './state';

let initialized = false;

export function initBadge(): void {
  if (initialized || typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
  const installed = window.matchMedia('(display-mode: standalone)').matches ||
    ('standalone' in navigator && navigator.standalone === true);
  if (!installed || !('setAppBadge' in navigator) || typeof navigator.setAppBadge !== 'function') return;
  initialized = true;
  const unread = computed(() => agentActivity.value.reduce((sum, group) => sum + (group.unreadThreadCount ?? 0), 0));
  effect(() => {
    // The worker is the single badge writer, including when no page is open.
    void unread.value;
    void navigator.serviceWorker.ready.then(registration => {
      registration.active?.postMessage({ type: 'READ_STATE_CHANGED', badgeEnabled: true });
    }).catch(error => console.warn('Unread badge update failed', error));
  });
}
