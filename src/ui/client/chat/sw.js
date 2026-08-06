/* eslint-disable */
/**
 * NanoClaw chat PWA service worker.
 *
 * Two responsibilities:
 *   1. Web Push: receive thin payloads, fetch notification details via the
 *      authenticated `/ui/chat/api/push/notification` endpoint, show the
 *      notification, and route clicks back to the right thread.
 *   2. Offline shell: precache the app shell (HTML, JS, CSS, manifest, icon)
 *      so the UI loads with no network. API calls, downloads, and the WS
 *      bypass the cache entirely — the UI shows its existing "Disconnected"
 *      states when the network is gone.
 *
 * Hand-written, no bundler — served by routes.ts at /ui/chat/sw.js with
 * `Service-Worker-Allowed: /ui/chat/`. The server replaces the cache version
 * placeholder below with a per-deploy stamp before serving, so each new dist
 * invalidates the cache and the browser detects an update.
 */

const SCOPE_PATH = '/ui/chat/';
const NOTIF_DETAILS_URL = '/ui/chat/api/push/notification';
const SUBSCRIBE_URL = '/ui/chat/api/push/subscribe';

const CACHE_VERSION = '__CACHE_VERSION__';
const SHELL_CACHE = 'nanoclaw-shell-' + CACHE_VERSION;
const SHELL_ASSETS = [
  '/ui/chat/',
  '/ui/chat/dist/app.js',
  '/ui/chat/dist/app.css',
  '/ui/chat/icon.svg',
  '/ui/chat/icon-192.png',
  '/ui/chat/icon-512.png',
  '/ui/chat/icon-maskable-512.png',
  '/ui/chat/manifest.webmanifest',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      try {
        const cache = await caches.open(SHELL_CACHE);
        await cache.addAll(SHELL_ASSETS);
      } catch (_e) {
        // First install with no network — fetch handler will repopulate on
        // the next successful navigation.
      }
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((k) => k.startsWith('nanoclaw-shell-') && k !== SHELL_CACHE)
          .map((k) => caches.delete(k)),
      );
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('message', (event) => {
  // Triggered by the client when the user accepts the "Reload to update" toast.
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (!url.pathname.startsWith(SCOPE_PATH)) return;
  // Bypass: API, downloads, the SW itself.
  if (url.pathname.startsWith('/ui/chat/api/')) return;
  if (url.pathname.startsWith('/ui/chat/dl')) return;
  if (url.pathname === '/ui/chat/sw.js') return;

  // App-shell navigation — serve cached shell when offline.
  if (req.mode === 'navigate') {
    event.respondWith(handleNavigation(req));
    return;
  }

  // Static assets: stale-while-revalidate.
  if (
    url.pathname.startsWith('/ui/chat/dist/') ||
    url.pathname === '/ui/chat/icon.svg' ||
    url.pathname === '/ui/chat/icon-192.png' ||
    url.pathname === '/ui/chat/icon-512.png' ||
    url.pathname === '/ui/chat/icon-maskable-512.png' ||
    url.pathname === '/ui/chat/manifest.webmanifest'
  ) {
    event.respondWith(handleStatic(req));
    return;
  }
});

async function handleNavigation(req) {
  const cache = await caches.open(SHELL_CACHE);
  try {
    const fresh = await fetch(req);
    if (fresh && fresh.ok) {
      cache.put('/ui/chat/', fresh.clone()).catch(() => {});
      return fresh;
    }
    if (fresh) return fresh;
  } catch (_e) {
    /* fall through to cache */
  }
  const cached = (await cache.match('/ui/chat/')) || (await cache.match(req));
  return cached || new Response('Offline', { status: 503, statusText: 'Offline' });
}

async function handleStatic(req) {
  const cache = await caches.open(SHELL_CACHE);
  const cached = await cache.match(req);
  const networkPromise = fetch(req)
    .then((r) => {
      if (r && r.ok) cache.put(req, r.clone()).catch(() => {});
      return r;
    })
    .catch(() => null);
  if (cached) {
    networkPromise.catch(() => {}); // fire-and-forget revalidate
    return cached;
  }
  const fresh = await networkPromise;
  return fresh || new Response('Offline', { status: 503, statusText: 'Offline' });
}

self.addEventListener('push', (event) => {
  event.waitUntil(handlePush(event));
});

async function handlePush(event) {
  let payload = null;
  try {
    payload = event.data ? event.data.json() : null;
  } catch (_e) {
    payload = null;
  }
  if (payload && payload.kind === 'test') {
    return self.registration.showNotification('{{BRAND_NAME}}', {
      body: 'Notifications are working',
      icon: '/ui/chat/icon.svg',
      tag: 'nanoclaw-test',
      data: {},
    });
  }
  if (!payload || payload.kind !== 'message') {
    return self.registration.showNotification('{{BRAND_NAME}}', {
      body: 'New activity',
      icon: '/ui/chat/icon.svg',
      tag: 'nanoclaw-generic',
    });
  }
  const { groupId, threadId, msgId } = payload;
  const tag = `nanoclaw-${groupId}-${threadId}`;

  // Skip if any visible window is already showing this thread — the user
  // can see the message and a notification would be spam. `visibilityState`
  // (not `focused`) is the right signal: a side-by-side / split-screen tab
  // is "visible" but not "focused" and the user can still see it.
  const clientsList = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  const visibleOnThread = clientsList.some(
    (c) => c.visibilityState === 'visible' && c.url.includes(`#g/${groupId}/t/${threadId}`),
  );
  if (visibleOnThread) return;

  let title = '{{BRAND_NAME}}';
  let body = 'New message';
  let icon = '/ui/chat/icon.svg';
  let timestamp = null;
  let deliveryOrigin = null;
  try {
    const url = `${NOTIF_DETAILS_URL}?groupId=${encodeURIComponent(groupId)}&threadId=${encodeURIComponent(
      threadId,
    )}&msgId=${encodeURIComponent(msgId)}`;
    const resp = await fetch(url, { credentials: 'include' });
    if (resp.ok) {
      const detail = await resp.json();
      if (detail.title) title = detail.title;
      if (detail.body) body = detail.body;
      if (detail.icon) icon = detail.icon;
      if (detail.deliveryOrigin) deliveryOrigin = detail.deliveryOrigin;
      if (detail.timestamp) {
        // Server returns SQLite UTC format "YYYY-MM-DD HH:MM:SS" (no tz).
        // Normalize to ISO so Date.parse interprets as UTC, matching the
        // client's fmtRelative/fmtAbsolute helpers in utils.ts.
        const iso = detail.timestamp.includes('T') ? detail.timestamp : detail.timestamp.replace(' ', 'T') + 'Z';
        const t = Date.parse(iso);
        if (!isNaN(t)) timestamp = t;
      }
    }
  } catch (_e) {
    // Network/auth failed — fall through with generic body.
  }

  // Alert on the first mid-turn update, then silently replace it with newer
  // progress from the same thread. A final response always alerts again.
  let renotify = true;
  if (deliveryOrigin === 'send_message') {
    try {
      const existing = await self.registration.getNotifications({ tag });
      renotify = shouldRenotify(deliveryOrigin, existing.length > 0);
    } catch (_e) {
      /* retain normal alert behavior when notification lookup is unavailable */
    }
  }

  await self.registration.showNotification(title, {
    body,
    icon,
    tag,
    renotify,
    timestamp: timestamp || undefined,
    data: { groupId, threadId, msgId },
    actions: [
      { action: 'open', title: 'Open' },
      { action: 'dismiss', title: 'Dismiss' },
    ],
  });
  try {
    if (self.navigator && typeof self.navigator.setAppBadge === 'function') {
      await self.navigator.setAppBadge();
    }
  } catch (_e) {
    /* Badging API is optional */
  }
}

function shouldRenotify(deliveryOrigin, hasExistingNotification) {
  return deliveryOrigin !== 'send_message' || !hasExistingNotification;
}

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  if (event.action === 'dismiss') return;
  event.waitUntil(focusOrOpen(event.notification.data));
});

async function focusOrOpen(data) {
  const groupId = data && data.groupId;
  const threadId = data && data.threadId;
  const target = groupId && threadId ? `${SCOPE_PATH}#g/${groupId}/t/${threadId}` : SCOPE_PATH;
  const threadHash = groupId && threadId ? `#g/${groupId}/t/${threadId}` : null;
  const clientsList = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  // Prefer a window already on the target thread — focusing it avoids
  // hijacking another window (e.g. one parked on a different thread) and
  // redirecting it to the notification's thread.
  const candidates = clientsList
    .filter((c) => c.url.includes(SCOPE_PATH))
    .sort((a, b) => {
      if (!threadHash) return 0;
      const aMatch = a.url.includes(threadHash) ? 0 : 1;
      const bMatch = b.url.includes(threadHash) ? 0 : 1;
      return aMatch - bMatch;
    });
  for (const c of candidates) {
    try {
      await c.focus();
      if ('navigate' in c && !c.url.includes(threadHash || '\0')) {
        try {
          await c.navigate(target);
        } catch (_e) {
          // Cross-origin or unsupported — leave the existing URL.
        }
      }
      return;
    } catch (_e) {
      /* try next */
    }
  }
  if (self.clients.openWindow) {
    await self.clients.openWindow(target);
  }
}

self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil(resubscribe());
});

async function resubscribe() {
  try {
    const keyResp = await fetch('/ui/chat/api/push/public-key', { credentials: 'include' });
    if (!keyResp.ok) return;
    const { publicKey } = await keyResp.json();
    if (!publicKey) return;
    const sub = await self.registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey),
    });
    await fetch(SUBSCRIBE_URL, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(sub.toJSON()),
    });
  } catch (_e) {
    /* drop — client will re-subscribe on next open */
  }
}

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; ++i) outputArray[i] = rawData.charCodeAt(i);
  return outputArray;
}
