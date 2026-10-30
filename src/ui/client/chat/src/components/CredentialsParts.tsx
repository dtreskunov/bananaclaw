import { useEffect, useRef, useState } from 'preact/hooks';
import type { ComponentChildren, JSX } from 'preact';
import {
  connectionPath, credentialRequest, credentialsPath, errorMessage,
  CredentialsError,
  type Connection, type CredentialGroup, type OAuthCompleteMessage, type SignInInput,
  type SignInProgress, type SignInStart,
} from './CredentialsApi';
import { MobileDialog, MobileDialogFooter } from './MobileDialog';
import { showToast } from './Toast';
import { serviceDestination } from './credential-presentation';

export function SecretInput({ value, onInput, placeholder = 'New value', disabled, label }: {
  value: string; onInput: (value: string) => void; placeholder?: string; disabled?: boolean; label?: string;
}): JSX.Element {
  const [shown, setShown] = useState(false);
  return <div class="ga-cred-secret">
    <input type={shown ? 'text' : 'password'} aria-label={label} value={value} autocomplete="new-password" spellcheck={false}
      placeholder={placeholder} disabled={disabled} onInput={(event) => onInput(event.currentTarget.value)} />
    <button type="button" disabled={disabled} aria-pressed={shown} aria-label={shown ? 'Hide value' : 'Show value'}
      onClick={() => setShown(!shown)}>{shown ? 'Hide' : 'Show'}</button>
  </div>;
}

export function useEscapeClose(onClose: () => void, busy = false): void {
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      event.stopImmediatePropagation();
      event.preventDefault();
      if (!busy) onClose();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose, busy]);
}

export function CredentialDialog({ title, children, onClose, busy, footer }: {
  title: string; children: ComponentChildren; onClose: () => void; busy?: boolean; footer?: ComponentChildren;
}): JSX.Element {
  useEscapeClose(onClose, busy);
  return <MobileDialog title={title} onClose={onClose} maxWidth="760px" className="ga-cred-dialog" closeDisabled={busy}>
    <div class="settings-body ga-cred ga-cred-dialog-body">{children}</div>
    <MobileDialogFooter className="ga-cred-foot">{footer}</MobileDialogFooter>
  </MobileDialog>;
}

export function Impact({ connection, groups }: { connection: Connection; groups: CredentialGroup[] }): JSX.Element {
  return <div class="ga-cred-callout ga-cred-impact">
    <strong>Affected agents</strong>
    {connection.grants.length ? <ul>
      {connection.grants.map((grant) => <li key={grant.vault}>
        {groups.find((group) => group.id === grant.vault)?.name ?? 'Unavailable agent'}
        {' · '}{connection.services.filter((service) => grant.services.includes(service.name)).map(serviceDestination).join(', ')}
        {grant.status === 'suspended' ? ' · access needs review' : ''}
      </li>)}
    </ul> : <p>No agents currently have access.</p>}
  </div>;
}

export function Review({ checked, onChange, children }: {
  checked: boolean; onChange: (value: boolean) => void; children: ComponentChildren;
}): JSX.Element {
  return <label class="group-admin-check">
    <input type="checkbox" checked={checked} onChange={(event) => onChange(event.currentTarget.checked)} />
    <span>{children}</span>
  </label>;
}

export function ErrorNotice({ message }: { message: string }): JSX.Element | null {
  return message ? <p class="ga-cred-error" role="alert">{message}</p> : null;
}

export function useCredentialResource<T>(url: string): {
  data: T | null; error: string; loading: boolean; refresh: () => Promise<void>;
} {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const sequence = useRef(0);
  async function refresh(): Promise<void> {
    const request = ++sequence.current;
    setLoading(true);
    setError('');
    try {
      const result = await credentialRequest<T>(url);
      if (request === sequence.current) setData(result);
    } catch (error) {
      if (!(error instanceof CredentialsError || error instanceof TypeError)) throw error;
      if (request === sequence.current) setError(errorMessage(error));
    } finally {
      if (request === sequence.current) setLoading(false);
    }
  }
  useEffect(() => {
    setData(null);
    void refresh();
    return () => { sequence.current++; };
  }, [url]);
  return { data, error, loading, refresh };
}

export function ConfirmCredentialAction({ title, label, children, onClose, onConfirm }: {
  title: string; label: string; children: ComponentChildren; onClose: () => void; onConfirm: () => Promise<void>;
}): JSX.Element {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [reviewed, setReviewed] = useState(false);
  async function confirm(): Promise<void> {
    setBusy(true);
    setError('');
    try { await onConfirm(); onClose(); }
    catch (error) {
      if (!(error instanceof CredentialsError || error instanceof TypeError)) throw error;
      setError(errorMessage(error));
    }
    finally { setBusy(false); }
  }
  return <CredentialDialog title={title} onClose={onClose} busy={busy} footer={<>
    <button type="button" disabled={busy} onClick={onClose}>Cancel</button>
    <button type="button" class="danger" disabled={busy || !reviewed} onClick={() => void confirm()}>{busy ? 'Working…' : label}</button>
  </>}>
    {children}
    <Review checked={reviewed} onChange={setReviewed}>I reviewed the affected agents and the connection-wide impact.</Review>
    <ErrorNotice message={error} />
  </CredentialDialog>;
}

export function useConnectionSignIn(onFinished: () => void): {
  waiting: SignInStart | null; start: (id: string, input: SignInInput) => Promise<void>;
  reopen: () => void; stop: () => void;
} {
  const [waiting, setWaiting] = useState<SignInStart | null>(null);
  const popup = useRef<Window | null>(null);
  const pending = useRef(false);
  const currentState = useRef<string | null>(null);
  const finished = useRef(onFinished);
  finished.current = onFinished;
  const closePopup = (): void => { popup.current?.close(); popup.current = null; };
  const openPopup = (url: string): void => {
    popup.current = window.open(url, 'nanoclaw-oauth', 'popup,width=520,height=720');
    if (!popup.current) showToast('Sign-in popup blocked. Use “Open sign-in window”.', 'err');
  };
  async function start(id: string, input: SignInInput): Promise<void> {
    if (pending.current) throw new CredentialsError('Finish or stop waiting for the current sign-in first.');
    pending.current = true;
    // Reserve the popup while still in the user gesture, before awaiting the host.
    popup.current = window.open('about:blank', 'nanoclaw-oauth', 'popup,width=520,height=720');
    try {
      const result = await credentialRequest<SignInStart>(connectionPath(id, '/start'), 'POST', input);
      const url = new URL(result.authorizeUrl, location.origin);
      if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new CredentialsError('Invalid OAuth authorization URL.');
      setWaiting(result);
      currentState.current = result.state;
      if (popup.current && !popup.current.closed) popup.current.location.href = url.href;
      else showToast('Sign-in popup blocked. Use “Open sign-in window”.', 'err');
    } catch (error) {
      pending.current = false;
      closePopup();
      throw error;
    }
  }
  useEffect(() => {
    if (!waiting) return;
    let active = true;
    let polling = false;
    let timer: ReturnType<typeof setTimeout>;
    const settle = (): void => {
      active = false;
      currentState.current = null;
      pending.current = false;
      closePopup();
      setWaiting(null);
      finished.current();
    };
    async function poll(): Promise<void> {
      if (!active || polling || currentState.current !== waiting!.state) return;
      polling = true;
      try {
        const progress = await credentialRequest<SignInProgress>(credentialsPath(`/sign-ins/${encodeURIComponent(waiting!.state)}`));
        if (!active || currentState.current !== waiting!.state) return;
        if (progress.status === 'connected') {
          showToast(progress.account ? `Connected ${progress.account}` : 'Account connected');
          settle();
        } else if (progress.status === 'failed') {
          showToast(progress.error ?? 'Sign-in failed. Reconnect to try again.', 'err');
          settle();
        }
      } catch (error) {
        if (!(error instanceof CredentialsError || error instanceof TypeError)) throw error;
        if (active && currentState.current === waiting!.state) {
          showToast(`Cannot check sign-in: ${errorMessage(error)}. Refresh connections before starting again.`, 'err');
          settle();
        }
      } finally {
        polling = false;
        if (active) timer = setTimeout(() => void poll(), 2000);
      }
    }
    function onMessage(event: MessageEvent): void {
      const message = event.data as OAuthCompleteMessage | null;
      if (event.origin !== location.origin || message?.type !== 'nanoclaw-oauth-complete' ||
        message.state !== waiting!.state || (popup.current && event.source !== popup.current)) return;
      clearTimeout(timer);
      void poll();
    }
    window.addEventListener('message', onMessage);
    void poll();
    const timeout = setTimeout(() => {
      if (!active) return;
      showToast('Stopped waiting after ten minutes. Refresh connections before signing in again.', 'err');
      settle();
    }, 10 * 60 * 1000);
    return () => {
      active = false;
      clearTimeout(timer);
      clearTimeout(timeout);
      window.removeEventListener('message', onMessage);
    };
  }, [waiting?.state]);
  useEffect(() => () => { pending.current = false; closePopup(); }, []);
  return {
    waiting, start,
    reopen: () => { if (waiting) openPopup(waiting.authorizeUrl); },
    stop: () => {
      currentState.current = null;
      pending.current = false;
      closePopup();
      setWaiting(null);
      showToast('Stopped waiting locally; this does not revoke or cancel upstream authorization. Refresh to check completion.');
      finished.current();
    },
  };
}
