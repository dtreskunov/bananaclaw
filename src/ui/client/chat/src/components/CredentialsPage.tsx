import './Credentials.css';
import { useEffect, useState } from 'preact/hooks';
import type { JSX } from 'preact';
import { credentialsIntent, openChat, openCredentials } from '../credentials-navigation';
import { credentialsOpen, isMobile } from '../state';
import { returnToUserMenu } from '../actions';
import { MobileDialog } from './MobileDialog';
import { CloseIcon, EditIcon, ExternalLinkIcon } from './ActionIcons';
import { connectionPath, credentialsPath, type AppInfo, type Connection, type CredentialsOverview } from './CredentialsApi';
import { ErrorNotice, useConnectionSignIn, useCredentialResource } from './CredentialsParts';
import { ConnectionActionDialog, ConnectionEditor, OAuthAppDialog, OAuthConnectionDialog } from './CredentialsDialogs';
import { CredentialAction, CredentialsTable } from './CredentialsTable';
import { showToast } from './Toast';
import { displayDestination } from './credential-presentation';

type Dialog =
  | { kind: 'edit'; id?: string }
  | { kind: 'connect'; connection?: Connection; resourceUrl?: string }
  | { kind: 'action'; connection: Connection; action: 'disable' | 'enable' | 'delete' }
  | { kind: 'app'; app?: AppInfo };

export function CredentialsPage(): JSX.Element | null {
  return credentialsOpen.value ? <CredentialsContent /> : null;
}

export function CredentialsContent({ agent }: {
  agent?: { id: string };
} = {}): JSX.Element {
  const { data, error, loading, refresh } = useCredentialResource<CredentialsOverview>(credentialsPath());
  const [view, setView] = useState<'credentials' | 'apps'>('credentials');
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [tableVersion, setTableVersion] = useState(0);
  const signIn = useConnectionSignIn(() => void refresh());
  const intent = agent ? null : credentialsIntent.value;
  useEffect(() => {
    if (agent) return;
    if (!intent || !data) return;
    setView('credentials');
    if (intent.create) setDialog({ kind: 'connect', resourceUrl: intent.resourceUrl });
    else if (intent.connectionId) {
      const connection = data.connections.find((item) => item.id === intent.connectionId);
      if (connection) {
        setDialog({ kind: 'edit', id: connection.id });
      } else {
        showToast('Ask the credential owner to manage this connection.');
      }
    }
    credentialsIntent.value = null;
  }, [intent, data]);
  useEffect(() => {
    if (agent) return;
    const key = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !dialog) openChat();
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [dialog, agent]);
  const connections = data?.connections ?? [];
  const close = (): void => setDialog(null);
  const reload = (): void => { setTableVersion((value) => value + 1); void refresh(); };
  const tableGroups = agent ? [data?.groups.find((group) => group.id === agent.id) ??
    { id: agent.id, name: 'This agent', canAdmin: false }] : data?.groups ?? [];
  const content = <>
    <div class={agent ? 'ga-cred' : 'credentials-page settings-body'} id={agent ? 'agent-credentials' : 'credentials-page'}
      role="region" aria-label={agent ? 'Agent credentials' : 'Personal credentials'}>
      <section class="ga-cred">
        {!agent ? <div class="credentials-toolbar">
          <nav class="ga-cred-segments" aria-label="Credentials sections">
            <button type="button" class={view === 'credentials' ? 'active' : ''} aria-current={view === 'credentials' ? 'page' : undefined}
              onClick={() => setView('credentials')}>Credentials</button>
            <button type="button" class={view === 'apps' ? 'active' : ''} aria-current={view === 'apps' ? 'page' : undefined}
              onClick={() => setView('apps')}>OAuth apps</button>
          </nav>
          <div class="credentials-row-actions">
            {view === 'credentials' ? <>
              <CredentialAction label="Add credential" disabled={loading || !!signIn.waiting} onClick={() => setDialog({ kind: 'edit' })}>
                <span class="plus-glyph" aria-hidden="true">+</span>
              </CredentialAction>
            </> : <CredentialAction label="Add OAuth app" disabled={loading} onClick={() => setDialog({ kind: 'app' })}>
              <span class="plus-glyph" aria-hidden="true">+</span>
            </CredentialAction>}
          </div>
        </div> : null}
        {signIn.waiting ? <div class="ga-cred-banner" role="status" aria-live="polite">
          <span class="ga-cred-spinner" aria-hidden="true" />
          <span class="ga-cred-banner-text">Finish signing in to {signIn.waiting.label}.</span>
          <CredentialAction label="Open sign-in window" onClick={signIn.reopen}><ExternalLinkIcon /></CredentialAction>
          <CredentialAction label="Stop waiting" onClick={signIn.stop}><CloseIcon /></CredentialAction>
        </div> : null}
        {loading ? <p role="status">Loading credentials…</p> : null}
        <ErrorNotice message={error ? `Couldn't load credentials: ${error}` : ''} />
        {error ? <button type="button" onClick={reload}>Try again</button> : null}
        {data && !error ? <>
          {view === 'credentials' ? connections.length ? <CredentialsTable key={tableVersion}
            connections={connections} groups={tableGroups} apps={data.apps} onlyGroup={agent?.id}
            busy={loading || !!signIn.waiting} onEdit={(connection) => setDialog({ kind: 'edit', id: connection.id })}
            onConnect={(connection) => setDialog({ kind: 'connect', connection })}
            onAction={(connection, action) => setDialog({ kind: 'action', connection, action })}
            onSaved={refresh} />
            : !loading ? agent ? <div>
              <p>No personal credentials yet. Add a connection, then explicitly grant this agent access.</p>
              <button type="button" onClick={() => openCredentials()}>Open personal Credentials</button>
            </div> : <p>No credentials yet.</p> : null : null}
          {!agent && view === 'apps' ? <section class="credentials-apps" aria-label="OAuth apps">
            {data.apps.length ? <ul class="ga-cred-list">{data.apps.map((app) => <li class="ga-cred-item" key={`${app.source}:${app.id}`}>
              <div class="ga-cred-item-main"><strong>{app.label}</strong><span class="muted">{displayDestination(app.issuer)}</span></div>
              {app.source === 'user' || data.canEditInstall ? <CredentialAction label={`Edit ${app.label} OAuth app`}
                disabled={loading} onClick={() => setDialog({ kind: 'app', app })}><EditIcon /></CredentialAction> : null}
            </li>)}</ul> : <p>No OAuth apps configured.</p>}
          </section> : null}
        </> : null}
      </section>
    </div>
    {dialog?.kind === 'edit' && data ? <ConnectionEditor id={dialog.id} apps={data.apps} groups={data.groups}
      onStart={signIn.start} onClose={close} onSaved={() => void refresh()} /> : null}
    {dialog?.kind === 'connect' && data ? dialog.connection
      ? <ReconnectLatest id={dialog.connection.id} apps={data.apps} groups={data.groups} onStart={signIn.start} onClose={close} onSaved={() => void refresh()} />
      : <ConnectionEditor initialKind="mcp_oauth" apps={data.apps} groups={data.groups} resourceUrl={dialog.resourceUrl}
        onStart={signIn.start} onClose={close} onSaved={() => void refresh()} />
      : null}
    {dialog?.kind === 'action' && data ? <ConnectionActionDialog connection={dialog.connection} groups={data.groups}
      action={dialog.action} onClose={close} onSaved={() => void refresh()} /> : null}
    {dialog?.kind === 'app' && data ? <OAuthAppDialog app={dialog.app} canEditInstall={data.canEditInstall}
      connections={data.connections} groups={data.groups} onClose={close} onSaved={() => void refresh()} /> : null}
  </>;
  return agent ? content : <MobileDialog title="Credentials" ariaLabel="Credentials" onClose={openChat}
    onBack={isMobile.value ? () => { openChat(); returnToUserMenu(credentialsOpen); } : undefined}
    backLabel="Back to account menu" maxWidth="1100px" className="credentials-dialog">{content}</MobileDialog>;
}

function ReconnectLatest(props: Omit<Parameters<typeof OAuthConnectionDialog>[0], 'connection'> & { id: string }): JSX.Element {
  const { data, error, loading, refresh } = useCredentialResource<Connection>(connectionPath(props.id));
  if (!data || loading || error) return <div class="ga-cred-callout" role="status">
    {loading ? <p>Loading reconnect details…</p> : <><ErrorNotice message={error} /><button type="button" onClick={() => void refresh()}>Retry</button></>}
    <button type="button" onClick={props.onClose}>Cancel</button>
  </div>;
  return <OAuthConnectionDialog {...props} connection={data} />;
}
