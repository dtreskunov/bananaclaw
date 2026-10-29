import './Credentials.css';
import { useEffect, useState } from 'preact/hooks';
import type { JSX } from 'preact';
import { credentialsIntent } from '../credentials-navigation';
import {
  connectionPath, credentialsPath, type AppInfo, type Connection, type CredentialsOverview,
} from './CredentialsApi';
import { ErrorNotice, Impact, useConnectionSignIn, useCredentialResource } from './CredentialsParts';
import {
  ConnectionActionDialog, ConnectionEditor, ConnectionGrantsDialog, OAuthAppDialog, OAuthConnectionDialog,
} from './CredentialsDialogs';
import { showToast } from './Toast';

type Dialog =
  | { kind: 'edit'; id?: string }
  | { kind: 'connect'; connection?: Connection; resourceUrl?: string }
  | { kind: 'grants'; connection: Connection }
  | { kind: 'action'; connection: Connection; action: 'disable' | 'enable' | 'delete' }
  | { kind: 'app'; app?: AppInfo };

export function CredentialsPage(): JSX.Element {
  const { data, error, loading, refresh } = useCredentialResource<CredentialsOverview>(credentialsPath());
  const [view, setView] = useState<'keys' | 'accounts'>('keys');
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const signIn = useConnectionSignIn(() => void refresh());
  const intent = credentialsIntent.value;
  useEffect(() => {
    if (!intent || !data) return;
    setView('accounts');
    if (intent.create) setDialog({ kind: 'connect', resourceUrl: intent.resourceUrl });
    else if (intent.connectionId) {
      const connection = data.connections.find((item) => item.id === intent.connectionId);
      if (connection) {
        setView(connection.kind === 'static' ? 'keys' : 'accounts');
        setDialog({ kind: 'edit', id: connection.id });
      } else {
        showToast('This connection belongs to another owner. Ask its owner to manage it; this agent can only detach its access.');
      }
    }
    credentialsIntent.value = null;
  }, [intent, data]);
  const connections = data?.connections.filter((connection) => view === 'keys' ? connection.kind === 'static' : connection.kind !== 'static') ?? [];
  const close = (): void => setDialog(null);
  const saved = (): void => { void refresh(); };
  return <main class="credentials-page settings-body" id="credentials-page" aria-label="Personal credentials">
    <section class="ga-cred">
      <div class="ga-cred-head"><h1>Credentials</h1>
        <button type="button" disabled={loading} onClick={() => void refresh()}>Refresh connections</button></div>
      <p class="group-admin-help">Your personal keys and connected accounts, stored once and shared by reference.
        Agent Settings → Access controls which agents may use selected services. Secret values are write-only.</p>
      <nav class="ga-cred-segments" aria-label="Credentials sections">
        <button type="button" class={view === 'keys' ? 'active' : ''} aria-current={view === 'keys' ? 'page' : undefined}
          onClick={() => setView('keys')}>Keys</button>
        <button type="button" class={view === 'accounts' ? 'active' : ''} aria-current={view === 'accounts' ? 'page' : undefined}
          onClick={() => setView('accounts')}>Connected accounts</button>
      </nav>
      {signIn.waiting ? <div class="ga-cred-banner" role="status" aria-live="polite">
        <span class="ga-cred-spinner" aria-hidden="true" />
        <span class="ga-cred-banner-text">Finish signing in to {signIn.waiting.label} in the provider window.</span>
        <div class="ga-cred-banner-actions">
          <button type="button" onClick={signIn.reopen}>Open sign-in window</button>
          <button type="button" onClick={signIn.stop}>Stop waiting</button>
        </div>
      </div> : null}
      {loading ? <p role="status">Loading personal connections…</p> : null}
      <ErrorNotice message={error ? `Couldn't load credentials: ${error}` : ''} />
      {error ? <button type="button" onClick={() => void refresh()}>Try again</button> : null}
      {data && !error ? <>
        <div class="ga-cred-head">
          <p class="group-admin-help">{view === 'keys'
            ? 'A connection can hold a Basic pair, multiple headers and more than one approved service. Rotate once for every authorized agent.'
            : 'Authorize a provider or MCP server once. Agents share the upstream identity and its real permissions; services do not downscope OAuth tokens.'}</p>
          <button type="button" class="primary" disabled={loading || !!signIn.waiting}
            onClick={() => setDialog(view === 'keys' ? { kind: 'edit' } : { kind: 'connect' })}>
            {view === 'keys' ? 'Create key connection' : 'Connect an account'}
          </button>
        </div>
        {connections.length ? <ul class="ga-cred-list">
          {connections.map((connection) => <li class={`ga-cred-item${connection.status === 'needs_reconnect' ? ' attention' : ''}`} key={connection.id}>
            <div class="ga-cred-item-main">
              <div class="ga-cred-item-title"><strong class="ga-cred-name">{connection.label}</strong>
                <span class={`ga-cred-pill ${connection.status === 'ready' ? 'ok' : connection.status === 'disabled' ? 'muted' : 'warn'}`}>{connection.status.replaceAll('_', ' ')}</span>
              </div>
              <div class="ga-cred-meta"><span>Owner: {connection.owner.label ?? 'You'}</span><span>{connection.kind.replaceAll('_', ' ')}</span>
                {connection.account ? <span>{connection.account}</span> : null}</div>
              <div class="ga-cred-chips">{connection.services.map((service) => <span class="ga-cred-chip" key={service.name}>
                {service.name} · {service.host}{service.path ?? ''}{service.enabled === false ? ' · disabled' : ''}
              </span>)}</div>
              <details><summary>Available to · {connection.grants.length} agents</summary><Impact connection={connection} groups={data.groups} /></details>
              {connection.kind !== 'static' ? <details>
                <summary>OAuth permission details</summary>
                <p>Resource: {connection.resource_url ?? 'Configured app'} · App: {connection.app_id ?? 'Discovered client'}</p>
                <p>Requested scopes: {connection.requested_scopes?.join(', ') || 'Not specified'}</p>
                <p>Provider-granted scopes: {connection.granted_scopes?.join(', ') || 'Not reported'}</p>
                <p>Scope provenance: {connection.scope_source ?? 'Unknown'}. Service grants do not reduce these permissions.</p>
              </details> : <span class="muted">{connection.credentials.length} write-only keys</span>}
            </div>
            <div class="ga-cred-item-actions">
              <button type="button" disabled={loading} onClick={() => setDialog({ kind: 'edit', id: connection.id })}>{connection.kind === 'static' ? 'Manage / rotate' : 'Manage services'}</button>
              {connection.kind !== 'static' ? <button type="button" disabled={loading || !!signIn.waiting || connection.status === 'disabled'}
                onClick={() => setDialog({ kind: 'connect', connection })}>{connection.status === 'draft' ? 'Finish sign-in' : 'Reconnect'}</button> : null}
              <button type="button" disabled={loading} onClick={() => setDialog({ kind: 'grants', connection })}>Agent access</button>
              <button type="button" disabled={loading} onClick={() => setDialog({ kind: 'action', connection, action: connection.status === 'disabled' ? 'enable' : 'disable' })}>
                {connection.status === 'disabled' ? 'Enable' : 'Disable'}
              </button>
              <button type="button" class="danger" disabled={loading} onClick={() => setDialog({ kind: 'action', connection, action: 'delete' })}>
                {connection.kind === 'static' ? 'Delete' : 'Disconnect everywhere'}
              </button>
            </div>
          </li>)}
        </ul> : !loading ? <div class="ga-cred-empty"><p>No {view === 'keys' ? 'key connections' : 'connected accounts'} yet.</p><span>Create your personal connection, then grant access to agents.</span></div> : null}
        {view === 'accounts' ? <section class="ga-cred-view">
          <div class="ga-cred-head"><h2>OAuth apps</h2><button type="button" disabled={loading} onClick={() => setDialog({ kind: 'app' })}>Configure OAuth app</button></div>
          <p class="group-admin-help">Generic OAuth clients for providers without dynamic registration.
            Personal apps belong to you; only authorized install administrators can manage install-wide apps.</p>
          {data.apps.length ? <ul class="ga-cred-list">{data.apps.map((app) => <li class="ga-cred-item" key={`${app.source}:${app.id}`}>
            <div class="ga-cred-item-main"><strong>{app.label}</strong><span>{app.source === 'user' ? 'Personal' : 'Install-wide'} · {app.id}</span>
              <span class="muted">{app.issuer} · {app.client_secret_set ? 'Client secret configured' : 'No client secret'}</span></div>
            {app.source === 'user' || data.canEditInstall ? <button type="button" disabled={loading} onClick={() => setDialog({ kind: 'app', app })}>Manage app</button> : <span class="muted">Install administrator manages this app</span>}
          </li>)}</ul> : <p class="muted">No configured OAuth apps.</p>}
        </section> : null}
      </> : null}
      {dialog?.kind === 'edit' && data ? <ConnectionEditor id={dialog.id} groups={data.groups} onClose={close} onSaved={saved} /> : null}
      {dialog?.kind === 'connect' && data ? dialog.connection
        ? <ReconnectLatest id={dialog.connection.id} apps={data.apps} groups={data.groups} onStart={signIn.start} onClose={close} onSaved={saved} />
        : <OAuthConnectionDialog apps={data.apps} groups={data.groups} resourceUrl={dialog.resourceUrl} onStart={signIn.start} onClose={close} onSaved={saved} />
        : null}
      {dialog?.kind === 'action' && data ? <ConnectionActionDialog connection={dialog.connection} groups={data.groups} action={dialog.action} onClose={close} onSaved={saved} /> : null}
      {dialog?.kind === 'grants' && data ? <ConnectionGrantsDialog connection={dialog.connection} groups={data.groups} onClose={close} onSaved={saved} /> : null}
      {dialog?.kind === 'app' && data ? <OAuthAppDialog app={dialog.app} canEditInstall={data.canEditInstall} connections={data.connections} groups={data.groups} onClose={close} onSaved={saved} /> : null}
    </section>
  </main>;
}

function ReconnectLatest(props: Omit<Parameters<typeof OAuthConnectionDialog>[0], 'connection'> & { id: string }): JSX.Element {
  const { data, error, loading, refresh } = useCredentialResource<Connection>(connectionPath(props.id));
  if (!data || loading || error) return <div class="ga-cred-callout" role="status">
    {loading ? <p>Loading latest reconnect impact…</p> : <><ErrorNotice message={error} /><button type="button" onClick={() => void refresh()}>Retry</button></>}
    <button type="button" onClick={props.onClose}>Cancel reconnect</button>
  </div>;
  return <OAuthConnectionDialog {...props} connection={data} />;
}
