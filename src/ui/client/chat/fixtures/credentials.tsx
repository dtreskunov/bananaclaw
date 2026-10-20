// Credentials UI fixture: the real Agent Settings dialog with an in-page mock
// of the credential gateway routes. Open with `?consent=…` to act as the fake
// OAuth provider window.
import { render } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { GroupAdmin } from '../src/components/GroupAdmin';
import { Toast } from '../src/components/Toast';
import { initAppearance } from '../src/appearance-state';
import type { OAuthCompleteMessage } from '../src/components/GroupAdminCredentialsApi';
import {
  credentialsUiEnabled,
  currentUserId,
  groupAdminOpen,
  groupAdminTabRequest,
  groupId,
  groups,
  isMobile,
  me,
} from '../src/state';
import {
  FIXTURE_GROUP,
  callLog,
  completeSignIn,
  getOptions,
  installMockFetch,
  onMockChange,
  resetState,
  setOptions,
  type FixtureOptions,
} from './credentials-mock';
import '../src/styles/global.css';
import './credentials.css';

interface FixtureConsentMessage {
  type: 'fixture-consent';
  state: string;
  allow: boolean;
}

function Consent({ state, provider, scopes }: { state: string; provider: string; scopes: string[] }): preact.JSX.Element {
  const [done, setDone] = useState<string | null>(null);
  function answer(allow: boolean): void {
    if (!window.opener) {
      setDone('The settings page that started this sign-in is gone. Close this window and start again.');
      return;
    }
    const consent: FixtureConsentMessage = { type: 'fixture-consent', state, allow };
    window.opener.postMessage(consent, location.origin);
    const complete: OAuthCompleteMessage = { type: 'nanoclaw-oauth-complete', state, status: allow ? 'connected' : 'failed' };
    window.opener.postMessage(complete, location.origin);
    setDone(allow ? 'Connected. You can close this window.' : 'Access declined. You can close this window.');
    setTimeout(() => window.close(), 600);
  }
  return (
    <main class="cred-fixture-consent">
      <p class="cred-fixture-consent-badge">Simulated provider · fixture</p>
      <h1>Sign in to {provider}</h1>
      <p>
        <strong>NanoClaw (Assistant)</strong> wants to:
      </p>
      <ul>{(scopes.length ? scopes : ['Use this MCP server on your behalf']).map((s) => <li key={s}>{s}</li>)}</ul>
      <p class="muted">Signed in as alex@example.com</p>
      {done ? <p role="status">{done}</p> : (
        <div class="cred-fixture-consent-actions">
          <button type="button" onClick={() => answer(false)}>Deny</button>
          <button type="button" class="primary" onClick={() => answer(true)}>Allow</button>
        </div>
      )}
    </main>
  );
}

function useMockVersion(): number {
  const [version, setVersion] = useState(0);
  useEffect(() => onMockChange(() => setVersion((v) => v + 1)), []);
  return version;
}

function reopen(tab = 'credentials'): void {
  const show = (): void => {
    groupAdminTabRequest.value = tab;
    groupAdminOpen.value = true;
  };
  if (!groupAdminOpen.value) return show();
  // Closing pops the dialog's history entry asynchronously; reopening before
  // that popstate lands would let it close the new dialog.
  window.addEventListener('popstate', () => setTimeout(show, 0), { once: true });
  groupAdminOpen.value = false;
}

function Controls(): preact.JSX.Element {
  useMockVersion();
  const options = getOptions();
  const [popupBlocked, setPopupBlocked] = useState(false);
  const set = (next: Partial<FixtureOptions>, reload = true): void => {
    setOptions(next);
    if (reload) reopen();
  };
  return (
    <details class="cred-fixture-controls" open>
      <summary>Fixture</summary>
      <div class="cred-fixture-controls-body">
        <label>
          Data
          <select value={options.scenario} onChange={(e) => set({ scenario: e.currentTarget.value as FixtureOptions['scenario'] })}>
            <option value="typical">Typical group</option>
            <option value="empty">New group</option>
          </select>
        </label>
        <label>
          Latency
          <select value={String(options.latencyMs)} onChange={(e) => set({ latencyMs: Number(e.currentTarget.value) }, false)}>
            <option value="0">None</option>
            <option value="250">250 ms</option>
            <option value="1500">1.5 s</option>
          </select>
        </label>
        <label><input type="checkbox" checked={options.gatewayDown} onChange={(e) => set({ gatewayDown: e.currentTarget.checked })} /> Gateway down</label>
        <label><input type="checkbox" checked={options.viewOnly} onChange={(e) => set({ viewOnly: e.currentTarget.checked })} /> View only</label>
        <label><input type="checkbox" checked={options.failNextWrite} onChange={(e) => set({ failNextWrite: e.currentTarget.checked }, false)} /> Fail next change</label>
        <label>
          <input type="checkbox" checked={popupBlocked} onChange={(e) => {
            setPopupBlocked(e.currentTarget.checked);
            (window as { __fixturePopupBlocked?: boolean }).__fixturePopupBlocked = e.currentTarget.checked;
          }} /> Block sign-in popup
        </label>
        <div class="cred-fixture-buttons">
          <button type="button" onClick={() => reopen('credentials')}>Credentials</button>
          <button type="button" onClick={() => reopen('mcp')}>MCP servers</button>
          <button type="button" onClick={() => { resetState(); reopen(); }}>Reset</button>
        </div>
        <details class="cred-fixture-log">
          <summary>API calls ({callLog.length})</summary>
          <ol>
            {callLog.map((c) => (
              <li key={`${c.at}-${c.method}-${c.path}`} class={c.status >= 400 ? 'err' : ''}>
                <code>{c.status} {c.method} {c.path}</code>
                {c.body ? <code class="cred-fixture-log-body">{c.body}</code> : null}
              </li>
            ))}
          </ol>
        </details>
        <p>Mocked gateway; nothing leaves the page. Values are shown as ••• in the log.</p>
      </div>
    </details>
  );
}

function Fixture(): preact.JSX.Element {
  return (
    <>
      <main class="cred-fixture-page">
        <p>Agent Settings is closed.</p>
        <button type="button" onClick={() => reopen()}>Open Agent Settings</button>
      </main>
      <GroupAdmin />
      <Toast />
      <Controls />
    </>
  );
}

const disposeAppearance = initAppearance((message) => console.error(message));
window.addEventListener('pagehide', disposeAppearance, { once: true });
const root = document.getElementById('fixture-root');
if (!root) throw new Error('Fixture root is missing');

const params = new URLSearchParams(location.search);
const consentState = params.get('consent');
if (consentState) {
  document.title = `Sign in to ${params.get('provider') ?? 'provider'}`;
  render(<Consent state={consentState} provider={params.get('provider') ?? 'provider'} scopes={(params.get('scopes') ?? '').split('|').filter(Boolean)} />, root);
} else {
  installMockFetch();
  window.addEventListener('message', (event: MessageEvent) => {
    const message = event.data as FixtureConsentMessage | null;
    if (event.origin === location.origin && message?.type === 'fixture-consent') completeSignIn(message.state, message.allow);
  });
  const mobile = window.matchMedia('(max-width: 720px)');
  isMobile.value = mobile.matches;
  mobile.addEventListener('change', (event) => {
    isMobile.value = event.matches;
  });
  me.value = 'Alex Morgan';
  currentUserId.value = 'fixture-alex';
  groups.value = [{ id: FIXTURE_GROUP.id, name: FIXTURE_GROUP.name, isAdmin: true, hasContent: true }];
  groupId.value = FIXTURE_GROUP.id;
  credentialsUiEnabled.value = true;
  groupAdminTabRequest.value = params.get('tab') ?? 'credentials';
  groupAdminOpen.value = true;
  render(<Fixture />, root);
}
