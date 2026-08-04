// Notification + Web Push (PWA tier-2) integration.
//
// The service worker (`/ui/chat/sw.js`) owns notification display,
// including foreground tabs. This module is responsible for SW
// registration, permission flow, and pushManager subscription lifecycle.
//
// The legacy in-page `new Notification(...)` path was removed — the SW
// handles all notifications, foreground or background. `maybeNotify` is
// retained as a no-op shim so existing call sites compile.
import { effect } from '@preact/signals';
import { notifMutedSig, NOTIF_MUTE_KEY } from './state';
import type { ChatMessageFile } from './types';
import { showStickyToast } from './components/Toast';
import { bumpUnread } from './badge';

let registration: ServiceWorkerRegistration | null = null;
let updatePromptShown = false;
let updateReloadStarted = false;

function reloadForUpdate(): void {
  if (updateReloadStarted) return;
  updateReloadStarted = true;
  location.reload();
}

export function loadMuted(): boolean {
  try {
    return localStorage.getItem(NOTIF_MUTE_KEY) === '1';
  } catch {
    return false;
  }
}

export function initNotif(): void {
  notifMutedSig.value = loadMuted();
  effect(() => {
    try {
      localStorage.setItem(NOTIF_MUTE_KEY, notifMutedSig.value ? '1' : '0');
    } catch {
      /* ignore */
    }
  });
  void registerServiceWorker().then(() => {
    if (!notifMutedSig.value) void ensureSubscribed();
  });
}

async function registerServiceWorker(): Promise<void> {
  if (!('serviceWorker' in navigator)) return;
  try {
    // Recover from stuck/redundant registrations: if an existing registration
    // has no active/installing/waiting worker, unregister before re-registering.
    const existing = await navigator.serviceWorker.getRegistration('/ui/chat/');
    if (existing && !existing.active && !existing.installing && !existing.waiting) {
      await existing.unregister().catch(() => {});
    }
    registration = await navigator.serviceWorker.register('/ui/chat/sw.js', {
      scope: '/ui/chat/',
      updateViaCache: 'none',
    });
    watchForUpdates(registration);
  } catch (err) {
    console.warn('SW register failed', err);
  }
}

// Prompt the user to reload when a new SW version is waiting. The new
// worker only takes control after the client posts SKIP_WAITING; reload
// when either the controller changes or that worker finishes activating.
function watchForUpdates(reg: ServiceWorkerRegistration): void {
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    reloadForUpdate();
  });

  const onNewWorker = (worker: ServiceWorker): void => {
    worker.addEventListener('statechange', () => {
      // Only prompt when there's an existing controller — otherwise this
      // is the very first install and there's nothing to "update from".
      if (worker.state === 'installed' && navigator.serviceWorker.controller) {
        promptForUpdate(worker);
      }
    });
  };

  // A worker may already be waiting from a prior tab.
  if (reg.waiting && navigator.serviceWorker.controller) {
    promptForUpdate(reg.waiting);
  }
  reg.addEventListener('updatefound', () => {
    if (reg.installing) onNewWorker(reg.installing);
  });
}

function promptForUpdate(worker: ServiceWorker): void {
  if (updatePromptShown) return;
  updatePromptShown = true;
  showStickyToast('Reload to use new version', () => {
    const reloadWhenActivated = (): void => {
      if (worker.state === 'activated') reloadForUpdate();
    };
    worker.addEventListener('statechange', reloadWhenActivated);
    worker.postMessage({ type: 'SKIP_WAITING' });
    reloadWhenActivated();
  });
}

export function toggleMute(): void {
  notifMutedSig.value = !notifMutedSig.value;
  if (notifMutedSig.value) {
    void unsubscribePush();
  } else {
    void ensureSubscribed();
  }
}

async function ensureSubscribed(): Promise<void> {
  if (!('Notification' in window) || !('serviceWorker' in navigator) || !('PushManager' in window)) return;
  let permission = Notification.permission;
  if (permission === 'default') {
    try {
      permission = await Notification.requestPermission();
    } catch {
      return;
    }
  }
  if (permission !== 'granted') {
    notifMutedSig.value = true;
    return;
  }
  if (!registration) {
    try {
      registration = await navigator.serviceWorker.ready;
    } catch {
      return;
    }
  }
  try {
    let sub = await registration.pushManager.getSubscription();
    if (!sub) {
      const keyResp = await fetch('api/push/public-key', { credentials: 'include' });
      if (!keyResp.ok) return;
      const { publicKey } = (await keyResp.json()) as { publicKey?: string };
      if (!publicKey) return;
      sub = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicKey).buffer as ArrayBuffer,
      });
    }
    await fetch('api/push/subscribe', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(sub.toJSON()),
    });
  } catch (err) {
    console.warn('push subscribe failed', err);
  }
}

async function unsubscribePush(): Promise<void> {
  if (!registration) return;
  try {
    const sub = await registration.pushManager.getSubscription();
    if (!sub) return;
    const endpoint = sub.endpoint;
    await sub.unsubscribe();
    await fetch('api/push/subscribe', {
      method: 'DELETE',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ endpoint }),
    });
  } catch (err) {
    console.warn('push unsubscribe failed', err);
  }
}

/** Retained for source compatibility — SW now handles all notification display. */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function maybeNotify(_text: string, _files: ChatMessageFile[] | null | undefined): void {
  // SW shows the notification; we bump the installed-app badge here.
  if (notifMutedSig.value) return;
  bumpUnread();
}

/** True on iOS Safari that hasn't been installed as a PWA — Web Push on
 *  iOS only works after Add to Home Screen (16.4+). */
export function shouldShowIosInstallHint(): boolean {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent || '';
  const isIos = /iPad|iPhone|iPod/.test(ua) && !(window as unknown as { MSStream?: unknown }).MSStream;
  if (!isIos) return false;
  const standalone =
    (typeof window.matchMedia === 'function' && window.matchMedia('(display-mode: standalone)').matches) ||
    (navigator as unknown as { standalone?: boolean }).standalone === true;
  return !standalone;
}

function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; ++i) outputArray[i] = rawData.charCodeAt(i);
  return outputArray;
}
