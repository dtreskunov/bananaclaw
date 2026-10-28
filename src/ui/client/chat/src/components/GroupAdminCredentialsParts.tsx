// Shared pieces for group settings → Credentials (also used by the MCP editor).
import { useEffect, useState } from 'preact/hooks';
import type { JSX } from 'preact';

import { call, errMsg } from './GroupAdminApi';
import {
  credPath,
  type AccountProgressDto,
  type AccountStartDto,
  type AccountStartInput,
  type InjectionDto,
  type OAuthCompleteMessage,
} from './GroupAdminCredentialsApi';
import { showToast } from './Toast';

export const KEY_NAME_RE = /^[A-Z][A-Z0-9_]*$/;
const SIGN_IN_TIMEOUT_MS = 10 * 60 * 1000;
const SIGN_IN_POLL_MS = 2000;

export function ago(iso: string | null | undefined): string {
  if (!iso) return 'never';
  const ms = Date.now() - Date.parse(iso);
  if (Number.isNaN(ms)) return 'unknown';
  const min = 60_000;
  const hour = 60 * min;
  const day = 24 * hour;
  if (ms < min) return 'just now';
  if (ms < hour) return `${Math.floor(ms / min)} min ago`;
  if (ms < day) return `${Math.floor(ms / hour)} h ago`;
  if (ms < 30 * day) return `${Math.floor(ms / day)} d ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

export function describeInjection(injection: InjectionDto, key: string): string {
  switch (injection.type) {
    case 'bearer':
      return `Authorization: Bearer ${key}`;
    case 'basic':
      return `Authorization: Basic ${key}`;
    case 'api-key':
      return `${injection.name || 'Authorization'}: ${injection.prefix ?? ''}${key}`;
    case 'query':
      return `${injection.name || `__${key}__`} in the URL query → ${key}`;
    case 'custom':
      return injection.template || 'Custom header';
  }
}

export function SecretInput({
  id,
  value,
  onInput,
  placeholder = 'Paste the value',
  autoFocus,
  disabled,
}: {
  id?: string;
  value: string;
  onInput: (value: string) => void;
  placeholder?: string;
  autoFocus?: boolean;
  disabled?: boolean;
}): JSX.Element {
  const [shown, setShown] = useState(false);
  return (
    <div class="ga-cred-secret">
      <input
        id={id}
        type={shown ? 'text' : 'password'}
        value={value}
        placeholder={placeholder}
        autocomplete="new-password"
        spellcheck={false}
        autoFocus={autoFocus}
        disabled={disabled}
        onInput={(event) => onInput(event.currentTarget.value)}
      />
      <button
        type="button"
        class="ga-cred-secret-toggle"
        aria-pressed={shown}
        aria-label={shown ? 'Hide value' : 'Show value'}
        disabled={disabled}
        onClick={() => setShown(!shown)}
      >
        {shown ? 'Hide' : 'Show'}
      </button>
    </div>
  );
}

/**
 * Escape closes only the topmost credentials dialog. Runs in the capture phase
 * so Agent Settings' own Escape handler doesn't close the whole settings dialog.
 */
export function useEscapeClose(onClose: () => void, busy = false): void {
  useEffect(() => {
    function onKey(event: KeyboardEvent): void {
      if (event.key !== 'Escape') return;
      event.stopImmediatePropagation();
      event.preventDefault();
      if (!busy) onClose();
    }
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose, busy]);
}

export interface SignInWaiting {
  state: string;
  label: string;
  url: string;
}

function openSignInWindow(url: string): boolean {
  return window.open(url, 'nanoclaw-oauth', 'popup,width=520,height=720') !== null;
}

/**
 * Starts an OAuth sign-in in a popup and waits for the host's callback page.
 * Completion is detected by polling, with the callback's postMessage as a
 * fast path; the code exchange itself happens inside the gateway.
 */
export function useSignIn(gid: string, onFinished: () => void, targetOnly = false): {
  waiting: SignInWaiting | null;
  start: (input: AccountStartInput) => Promise<boolean>;
  reopen: () => void;
  cancel: () => void;
} {
  const [waiting, setWaiting] = useState<SignInWaiting | null>(null);

  async function start(input: AccountStartInput): Promise<boolean> {
    const r = await call<AccountStartDto>(credPath(gid, '/accounts/start', targetOnly), 'POST', input);
    if (!r.ok) {
      showToast(errMsg(r.data, `HTTP ${r.status}`), 'err');
      return false;
    }
    setWaiting({ state: r.data.state, label: r.data.label, url: r.data.authorizeUrl });
    if (!openSignInWindow(r.data.authorizeUrl)) {
      showToast('Your browser blocked the sign-in window. Use "Open sign-in window".', 'err');
    }
    return true;
  }

  useEffect(() => {
    if (!waiting) return undefined;
    let settled = false;
    const progressUrl = credPath(gid, `/accounts/start/${encodeURIComponent(waiting.state)}`, targetOnly);
    async function poll(): Promise<void> {
      const r = await call<AccountProgressDto>(progressUrl);
      if (settled || !r.ok || r.data.status === 'pending') return;
      settled = true;
      setWaiting(null);
      if (r.data.status === 'connected') showToast(r.data.account ? `Connected ${r.data.account}` : `Connected ${waiting!.label}`);
      else showToast(r.data.error ?? 'Sign-in failed', 'err');
      onFinished();
    }
    function onMessage(event: MessageEvent): void {
      const message = event.data as OAuthCompleteMessage | null;
      if (event.origin !== location.origin || message?.type !== 'nanoclaw-oauth-complete') return;
      if (message.state === waiting!.state) void poll();
    }
    window.addEventListener('message', onMessage);
    const timer = setInterval(() => void poll(), SIGN_IN_POLL_MS);
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      setWaiting(null);
      showToast('Sign-in timed out. Start again when you are ready.', 'err');
    }, SIGN_IN_TIMEOUT_MS);
    return () => {
      settled = true;
      window.removeEventListener('message', onMessage);
      clearInterval(timer);
      clearTimeout(timeout);
    };
  }, [waiting?.state, gid, targetOnly]);

  return {
    waiting,
    start,
    reopen: () => {
      if (waiting && !openSignInWindow(waiting.url)) showToast('Your browser blocked the sign-in window.', 'err');
    },
    cancel: () => setWaiting(null),
  };
}

export function SignInBanner({ waiting, onReopen, onCancel }: {
  waiting: SignInWaiting;
  onReopen: () => void;
  onCancel: () => void;
}): JSX.Element {
  return (
    <div class="ga-cred-banner" role="status" aria-live="polite">
      <span class="ga-cred-spinner" aria-hidden="true" />
      <span class="ga-cred-banner-text">Finish signing in to {waiting.label} in the window that opened.</span>
      <span class="ga-cred-banner-actions">
        <button type="button" onClick={onReopen}>Open sign-in window</button>
        <button type="button" class="ghost" onClick={onCancel}>Cancel</button>
      </span>
    </div>
  );
}
