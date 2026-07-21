// Entry point: bootstrap data, mount Preact App.
import './styles/global.css';
import { render } from 'preact';
import { batch } from '@preact/signals';
import { api } from './api';
import { me, groups, settingsOpen, chatLoading, isElevatedUser } from './state';
import { App } from './components/App';
import { initNotif, shouldShowIosInstallHint } from './notify';
import { initSound } from './sound';
import { initInstall } from './install';
import { initBadge } from './badge';
import { restorePanelState, applyPanelClasses } from './panels';
import { applyHash, parseHash } from './hash';
import { router } from './router';
import { installLivenessHandlers, startSyncPoll } from './actions';
import type { Group } from './types';

interface MeResponse { displayName?: string; userId: string; isElevated?: boolean }
interface GroupsResponse { groups: Group[] }

function sortGroups(list: Group[]): Group[] {
  return list.slice().sort((a, b) => {
    const parseTs = (s: string | undefined): number => {
      if (!s) return 0;
      const norm = s.includes('T') ? s : s.replace(' ', 'T') + 'Z';
      return Date.parse(norm) || 0;
    };
    const ta = parseTs(a.lastActivityAt);
    const tb = parseTs(b.lastActivityAt);
    if (tb !== ta) return tb - ta;
    return a.name.localeCompare(b.name);
  });
}

function setupViewportFit(): void {
  const vv = window.visualViewport;
  if (!vv) return;
  const apply = (): void => { document.documentElement.style.setProperty('--app-height', vv.height + 'px'); };
  apply();
  vv.addEventListener('resize', apply);
  vv.addEventListener('scroll', apply);
  document.addEventListener('focusin', (ev: FocusEvent) => {
    const t = ev.target as HTMLElement | null;
    if (t?.id === 'chat-input') {
      setTimeout(() => {
        try { (t as HTMLElement).scrollIntoView({ block: 'end', behavior: 'smooth' }); } catch { /* ignore */ }
      }, 250);
    }
  });
}

const IOS_HINT_DISMISSED_KEY = 'nanoclaw:ios-install-hint-dismissed';

function maybeShowIosInstallHint(): void {
  if (!shouldShowIosInstallHint()) return;
  try {
    if (localStorage.getItem(IOS_HINT_DISMISSED_KEY) === '1') return;
  } catch { /* ignore */ }
  const el = document.createElement('div');
  el.setAttribute('role', 'note');
  el.style.cssText =
    'position:fixed;left:12px;right:12px;bottom:12px;z-index:9999;' +
    'background:#1f2937;color:#e5e7eb;border:1px solid #374151;border-radius:8px;' +
    'padding:12px 14px;font:13px system-ui;-webkit-font-smoothing:antialiased;' +
    'box-shadow:0 4px 12px rgba(0,0,0,0.3);display:flex;gap:10px;align-items:flex-start';
  el.innerHTML =
    '<div style="flex:1">Add to Home Screen to receive notifications when the app is closed. ' +
    'Tap the Share button, then "Add to Home Screen".</div>' +
    '<button type="button" aria-label="Dismiss" ' +
    'style="background:transparent;color:#9ca3af;border:0;font-size:18px;line-height:1;cursor:pointer;padding:0 4px">×</button>';
  const btn = el.querySelector('button');
  if (btn) {
    btn.addEventListener('click', () => {
      try { localStorage.setItem(IOS_HINT_DISMISSED_KEY, '1'); } catch { /* ignore */ }
      el.remove();
    });
  }
  document.body.appendChild(el);
}

async function init(): Promise<void> {
  initNotif();
  initSound();
  initInstall();
  initBadge();
  setupViewportFit();
  installLivenessHandlers();
  restorePanelState();
  applyPanelClasses();
  maybeShowIosInstallHint();
  try {
    const [meRes, groupsRes] = await Promise.all([
      api<MeResponse>('api/me'),
      api<GroupsResponse>('api/groups'),
    ]);
    batch(() => {
      me.value = meRes.displayName || meRes.userId;
      isElevatedUser.value = meRes.isElevated === true;
      groups.value = sortGroups(groupsRes.groups);
    });
  } catch {
    return;
  }
  if (groups.value.length === 0) {
    const app = document.getElementById('app');
    if (app) app.innerHTML = '<div style="padding:24px;font:14px system-ui">No accessible groups.</div>';
    return;
  }
  const parsed = parseHash();
  if (parsed && parsed.groupId) chatLoading.value = true;
  const app = document.getElementById('app');
  if (app) render(<App />, app);
  await applyHash(router).catch((err) => console.error('initial route failed', err));
  startSyncPoll();
  try {
    const sp = new URLSearchParams(window.location.search);
    if (sp.get('settings') === '1') {
      settingsOpen.value = true;
      sp.delete('settings');
      const q = sp.toString();
      const url = window.location.pathname + (q ? '?' + q : '') + window.location.hash;
      window.history.replaceState(null, '', url);
    }
    handleShareTarget();
  } catch { /* ignore */ }
}

// Web Share Target: if the user shared from another app, the manifest's
// share_target landing route (/ui/chat/share) preserves the title/text/url
// query params. Stuff them into the composer once it mounts, then rewrite
// the URL so a reload doesn't re-share.
function handleShareTarget(): void {
  const onShareRoute = window.location.pathname.endsWith('/share');
  const sp = new URLSearchParams(window.location.search);
  const title = sp.get('title') || '';
  const text = sp.get('text') || '';
  const url = sp.get('url') || '';
  if (!title && !text && !url) {
    // Even if we landed on /share with no params, normalize back to /.
    if (onShareRoute) window.history.replaceState(null, '', '/ui/chat/' + window.location.hash);
    return;
  }
  const combined = [title, text, url].filter(Boolean).join('\n').trim();
  const apply = (): boolean => {
    const el = document.getElementById('chat-input') as HTMLTextAreaElement | null;
    if (!el) return false;
    el.value = (el.value ? el.value + '\n\n' : '') + combined;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.focus();
    return true;
  };
  if (!apply()) {
    let tries = 0;
    const t = window.setInterval(() => {
      if (apply() || ++tries > 50) window.clearInterval(t);
    }, 100);
  }
  const nextPath = onShareRoute ? '/ui/chat/' : window.location.pathname;
  window.history.replaceState(null, '', nextPath + window.location.hash);
}

init().catch((err) => console.error(err));
