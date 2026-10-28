// Group settings → Credentials (R1): keys, accounts and OAuth apps in this
// group's vault in the credential gateway. Values are write-only throughout.
import './GroupAdminCredentials.css';
import { signal } from '@preact/signals';
import { useEffect, useState } from 'preact/hooks';
import type { JSX } from 'preact';

import { call, errMsg } from './GroupAdminApi';
import {
  ERROR_GATEWAY_UNREACHABLE,
  credPath,
  type AccountDto,
  type CredentialsOverviewDto,
  type KeyDto,
  type McpAuthDto,
  type OAuthAppDto,
  type OAuthAppScope,
} from './GroupAdminCredentialsApi';
import { SignInBanner, ago, describeInjection, useSignIn } from './GroupAdminCredentialsParts';
import {
  AddKeyDialog,
  ConfirmDialog,
  ConnectAccountDialog,
  EditKeyDialog,
  OAuthAppDialog,
  ReplaceKeyDialog,
  KeySetDialog,
} from './GroupAdminCredentialsDialogs';
import { showToast } from './Toast';

type View = 'keys' | 'accounts';

/** Where the Credentials tab should open next, e.g. when linked from the MCP editor. */
export const credentialsFocus = signal<{ view: View; key?: string; action?: 'set' | 'add'; match?: string; setupApp?: string; setupIssuer?: string } | null>(null);

type Dialog =
  | { kind: 'add-key'; match?: string }
  | { kind: 'replace'; item: KeyDto }
  | { kind: 'edit'; item: KeyDto }
  | { kind: 'delete-key'; item: KeyDto }
  | { kind: 'key-set'; name?: string }
  | { kind: 'connect'; provider?: string; reconnect?: { provider: string; key: string; scopes: string[] } }
  | { kind: 'disconnect'; account: AccountDto }
  | { kind: 'oauth-app'; app: OAuthAppDto; scope?: OAuthAppScope; thenConnect?: boolean; issuer?: string }
  | { kind: 'remove-app'; app: OAuthAppDto; scope: OAuthAppScope };

type Load =
  | { state: 'loading' }
  | { state: 'down' }
  | { state: 'inactive-target' }
  | { state: 'error'; message: string }
  | { state: 'ready'; data: CredentialsOverviewDto };

async function mutate(url: string, method: string, body: unknown, success: string): Promise<boolean> {
  const r = await call(url, method, body);
  if (!r.ok) {
    showToast(errMsg(r.data, `HTTP ${r.status}`), 'err');
    return false;
  }
  showToast(success);
  return true;
}

function useOverview(gid: string, targetOnly = false): { load: Load; refresh: () => Promise<void> } {
  const [load, setLoad] = useState<Load>({ state: 'loading' });
  async function refresh(): Promise<void> {
    const r = await call<CredentialsOverviewDto>(credPath(gid, '', targetOnly));
    if (r.ok) setLoad({ state: 'ready', data: r.data });
    else if (r.status === 503 && errMsg(r.data, '') === ERROR_GATEWAY_UNREACHABLE) setLoad({ state: 'down' });
    else if (r.status === 409 && errMsg(r.data, '') === 'inactive_gateway_target') setLoad({ state: 'inactive-target' });
    else setLoad({ state: 'error', message: errMsg(r.data, `HTTP ${r.status}`) });
  }
  useEffect(() => {
    setLoad({ state: 'loading' });
    void refresh();
  }, [gid, targetOnly]);
  return { load, refresh };
}

export function CredentialsTab({ gid }: { gid: string }): JSX.Element {
  const [targetGroup, setTargetGroup] = useState<string | null>(null);
  const targetOnly = targetGroup === gid;
  const [preparing, setPreparing] = useState(false);
  const { load, refresh } = useOverview(gid, targetOnly);
  const [view, setView] = useState<View>('keys');
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const signIn = useSignIn(gid, () => void refresh(), targetOnly);

  useEffect(() => { setView('keys'); setTargetGroup(null); setDialog(null); }, [gid]);
  useEffect(() => {
    if (load.state !== 'ready') return;
    const focus = credentialsFocus.peek();
    if (!focus) return;
    credentialsFocus.value = null;
    setView(focus.view);
    const item = focus.key ? load.data.keys.find((k) => k.key === focus.key) : undefined;
    const keysEditable = load.data.canEdit && load.data.keysEditable !== false;
    if (focus.action === 'set' && item && keysEditable) setDialog(item.sharedService ? { kind: 'key-set', name: item.sharedService } : { kind: 'replace', item });
    if (focus.action === 'add' && keysEditable) setDialog({ kind: 'add-key', match: focus.match });
    const app = focus.setupApp ? load.data.oauthApps.find((a) => a.id === focus.setupApp) : undefined;
    if (app && load.data.canEdit) setDialog({ kind: 'oauth-app', app });
    if (focus.setupIssuer && load.data.canEdit) setDialog({
      kind: 'oauth-app', app: { id: '', label: 'New app', install: null, group: null, overridesInstall: false }, issuer: focus.setupIssuer,
    });
  }, [load.state]);

  if (load.state === 'loading') return <p class="muted">Loading…</p>;
  if (load.state === 'inactive-target') return (
    <section class="ga-cred">
      <p>This group still uses OneCLI. Prepare or open its inactive Agent Vault target to stage credentials and consent. This does not switch the backend or change OneCLI grants.</p>
      <button type="button" disabled={preparing} onClick={async () => {
        setPreparing(true);
        const ok = await mutate(credPath(gid, '/target'), 'POST', {}, 'Agent Vault target prepared; OneCLI remains active');
        setPreparing(false);
        if (ok) setTargetGroup(gid);
      }}>{preparing ? 'Preparing…' : 'Prepare / open Agent Vault target'}</button>
    </section>
  );
  if (load.state === 'down') return <GatewayDown onRetry={() => void refresh()} />;
  if (load.state === 'error') {
    return (
      <section class="ga-cred">
        <p class="ga-cred-error">Couldn't load credentials: {load.message}</p>
        <button type="button" onClick={() => void refresh()}>Try again</button>
      </section>
    );
  }

  const data = load.data;
  const close = (): void => setDialog(null);
  const done = (): void => void refresh();
  const keyNames = data.keys.map((k) => k.key);
  const pendingMcp = data.mcp.filter((m) => m.auth === 'oauth' && m.status === 'needs_sign_in').length;

  const segments: { id: View; label: string; count?: number; alert?: boolean }[] = [
    { id: 'keys', label: 'Keys', count: data.keys.length, alert: data.keys.some((k) => k.status === 'needs_value') },
    {
      id: 'accounts',
      label: 'Accounts',
      count: data.accounts.length + pendingMcp,
      alert: data.accounts.some((a) => a.status === 'needs_reconnect') || pendingMcp > 0,
    },
  ];

  return (
    <section class="ga-cred">
      <p class="group-admin-help ga-cred-intro">
        The agent uses these keys and accounts through the credential gateway, which adds them to matching requests.
        The agent never sees them, and nobody can view a key after it's saved.
      </p>
      {data.targetOnly ? <div class="ga-cred-callout warn" role="status"><strong>Inactive Agent Vault target</strong><p>OneCLI remains active. These credentials are staged only; saving keys or signing in does not cut this group over.</p></div> : null}
      {signIn.waiting ? <SignInBanner waiting={signIn.waiting} onReopen={signIn.reopen} onCancel={signIn.cancel} /> : null}
      <nav class="ga-cred-segments" aria-label="Credentials sections">
        {segments.map((s) => (
          <button
            type="button"
            key={s.id}
            class={view === s.id ? 'active' : ''}
            aria-current={view === s.id ? 'page' : undefined}
            onClick={() => setView(s.id)}
          >
            {s.label}
            {s.count !== undefined ? <span class={`ga-cred-count${s.alert ? ' alert' : ''}`}>{s.count}</span> : null}
          </button>
        ))}
      </nav>
      {!data.canEdit ? (
        <p class="ga-cred-note">You can see this group's credentials but not change them.</p>
      ) : null}

      {view === 'keys' ? <KeysView data={data} onDialog={setDialog} /> : null}
      {view === 'accounts' ? <AccountsView data={data} onDialog={setDialog} onSignIn={signIn.start} /> : null}

      {dialog?.kind === 'add-key' ? (
        <AddKeyDialog
          gid={gid}
          targetOnly={targetOnly}
          presets={data.presets}
          existingKeys={keyNames}
          initialMatch={dialog.match}
          onExisting={(key) => {
            const item = data.keys.find((k) => k.key === key);
            setDialog(item ? item.sharedService ? { kind: 'key-set', name: item.sharedService } : { kind: 'replace', item } : null);
          }}
          onClose={close}
          onSaved={done}
        />
      ) : null}
      {dialog?.kind === 'replace' ? <ReplaceKeyDialog gid={gid} targetOnly={targetOnly} item={dialog.item} onClose={close} onSaved={done} /> : null}
      {dialog?.kind === 'edit' ? <EditKeyDialog gid={gid} targetOnly={targetOnly} item={dialog.item} onClose={close} onSaved={done} /> : null}
      {dialog?.kind === 'key-set' ? <KeySetDialog gid={gid} targetOnly={targetOnly} name={dialog.name} onClose={close} onSaved={done} /> : null}
      {dialog?.kind === 'connect' ? (
        <ConnectAccountDialog
          apps={data.oauthApps}
          mcp={data.mcp}
          canEdit={data.canEdit}
          provider={dialog.provider}
          reconnect={dialog.reconnect}
          onSetUp={(app, issuer) => setDialog({ kind: 'oauth-app', app, issuer, thenConnect: true })}
          onStart={signIn.start}
          onClose={close}
        />
      ) : null}
      {dialog?.kind === 'oauth-app' ? (
        <OAuthAppDialog
          gid={gid}
          targetOnly={targetOnly}
          app={dialog.app}
          scope={dialog.scope}
          canEditInstall={data.canEditInstall}
          redirectUri={data.oauthRedirectUri}
          issuer={dialog.issuer}
          onClose={close}
          onSaved={() => {
            done();
            setDialog(dialog.thenConnect ? { kind: 'connect', provider: dialog.app.id } : null);
          }}
        />
      ) : null}
      {dialog?.kind === 'remove-app' ? (
        <ConfirmDialog
          title={dialog.scope === 'install' ? `Remove the install-wide ${dialog.app.label} app?` : `Remove this group's ${dialog.app.label} app?`}
          confirmLabel="Remove"
          danger
          onClose={close}
          onConfirm={async () => {
            const url = credPath(gid, `/oauth-apps/${encodeURIComponent(dialog.app.id)}?scope=${dialog.scope}`, targetOnly);
            const ok = await mutate(url, 'DELETE', undefined, `Removed the ${dialog.app.label} app`);
            if (ok) done();
            return ok;
          }}
        >
          <p class="group-admin-help">{removeAppText(dialog.app, dialog.scope)}</p>
        </ConfirmDialog>
      ) : null}
      {dialog?.kind === 'delete-key' ? (
        <ConfirmDialog
          title={`Delete ${dialog.item.label}?`}
          confirmLabel="Delete key"
          danger
          onClose={close}
          onConfirm={async () => {
            const ok = await mutate(credPath(gid, `/keys/${encodeURIComponent(dialog.item.key)}`, targetOnly), 'DELETE', undefined, `Deleted ${dialog.item.label}`);
            if (ok) done();
            return ok;
          }}
        >
          <p class="group-admin-help">
            The value is erased from this group's vault, and requests to <code>{dialog.item.destination.match}</code> stop
            getting it. This can't be undone.
          </p>
        </ConfirmDialog>
      ) : null}
      {dialog?.kind === 'disconnect' ? (
        <ConfirmDialog
          title={`Disconnect ${dialog.account.account ?? dialog.account.providerLabel}?`}
          confirmLabel="Disconnect"
          danger
          onClose={close}
          onConfirm={async () => {
            const ok = await mutate(credPath(gid, `/accounts/${encodeURIComponent(dialog.account.key)}`, targetOnly), 'DELETE', undefined, 'Account disconnected');
            if (ok) done();
            return ok;
          }}
        >
          <p class="group-admin-help">
            The agent loses access to {dialog.account.providerLabel} in this group, and the gateway revokes its tokens.
            Other groups connected to the same account keep their own access.
          </p>
        </ConfirmDialog>
      ) : null}
    </section>
  );
}

function GatewayDown({ onRetry }: { onRetry: () => void }): JSX.Element {
  return (
    <section class="ga-cred">
      <div class="ga-cred-callout warn" role="alert">
        <strong>The credential gateway isn't responding.</strong>
        <p>
          Keys and accounts can't be viewed or changed right now, and agents can't start new sessions until it's back.
          Running agents keep working only for services that don't need a key.
        </p>
        <p class="group-admin-help">
          Operator: check <code>systemctl --user status nanoclaw-gateway</code> and its log.
        </p>
        <button type="button" onClick={onRetry}>Try again</button>
      </div>
    </section>
  );
}

function StatusPill({ tone, children }: { tone: 'ok' | 'warn' | 'muted' | 'err'; children: string }): JSX.Element {
  return <span class={`ga-cred-pill ${tone}`}>{children}</span>;
}

function SectionHead({ help, children }: { help: string; children?: JSX.Element | (JSX.Element | null)[] | null }): JSX.Element {
  return (
    <div class="ga-cred-head">
      <p class="group-admin-help">{help}</p>
      {children ? <div class="ga-cred-head-actions">{children}</div> : null}
    </div>
  );
}

function KeysView({ data, onDialog }: { data: CredentialsOverviewDto; onDialog: (d: Dialog) => void }): JSX.Element {
  const edit = data.canEdit && data.keysEditable !== false;
  return (
    <div class="ga-cred-view">
      {data.canEdit && data.keysEditable === false ? (
        <p class="ga-cred-note">Keys can be viewed here; adding and changing them arrives in a later update.</p>
      ) : null}
      <SectionHead help="API keys and tokens the agent can use, and where each one is sent.">
        {edit ? <button type="button" onClick={() => onDialog({ kind: 'key-set' })}>Create atomic key set</button> : null}
        {edit ? <button type="button" class="primary" onClick={() => onDialog({ kind: 'add-key' })}>Add key</button> : null}
      </SectionHead>
      {data.keys.length === 0 ? (
        <div class="ga-cred-empty">
          <p>No keys yet.</p>
          <p class="group-admin-help">Add a key for a service; it's only ever sent to the host you choose.</p>
        </div>
      ) : (
        <ul class="ga-cred-list">
          {data.keys.map((k) => (
            <li key={k.key} class={`ga-cred-item${k.status === 'needs_value' ? ' attention' : ''}`}>
              <div class="ga-cred-item-main">
                <div class="ga-cred-item-title">
                  <span class="ga-cred-name">{k.label}</span>
                  <code class="ga-cred-code-muted">{k.key}</code>
                  {k.mcpServer ? <span class="ga-cred-tag">MCP · {k.mcpServer}</span> : null}
                  {k.status === 'needs_value' ? <StatusPill tone="warn">Needs a value</StatusPill> : null}
                </div>
                <div class="ga-cred-meta">
                  <span>Sent to <span class="ga-cred-mono">{k.destination.match}</span></span>
                  <span class="ga-cred-mono">{describeInjection(k.destination.injection, k.key)}</span>
                </div>
                {k.status === 'set' ? (
                  <div class="ga-cred-meta">
                    <span>Last used {ago(k.lastUsedAt)}</span>
                    {k.updatedAt ? <span>Set {ago(k.updatedAt)}</span> : null}
                  </div>
                ) : null}
              </div>
              {edit ? (
                <div class="ga-cred-item-actions">
                  {k.sharedService ? <button type="button" onClick={() => onDialog({ kind: 'key-set', name: k.sharedService })}>Manage key set</button> : <>
                  <button type="button" class={k.status === 'needs_value' ? 'primary' : ''} onClick={() => onDialog({ kind: 'replace', item: k })}>
                    {k.status === 'needs_value' ? 'Set value' : 'Replace'}
                  </button>
                  <button type="button" onClick={() => onDialog({ kind: 'edit', item: k })}>Edit</button>
                  <button type="button" class="ga-cred-icon danger" aria-label={`Delete ${k.label}`} title="Delete" onClick={() => onDialog({ kind: 'delete-key', item: k })}>{'\u2715'}</button>
                  </>}
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function AccountsView({
  data,
  onDialog,
  onSignIn,
}: {
  data: CredentialsOverviewDto;
  onDialog: (d: Dialog) => void;
  onSignIn: (input: { mcpServer: string }) => Promise<boolean>;
}): JSX.Element {
  const edit = data.canEdit;
  const pendingMcp = data.mcp.filter((m) => m.auth === 'oauth' && m.status === 'needs_sign_in');
  return (
    <div class="ga-cred-view">
      <SectionHead help="Accounts you signed in to for this group. The gateway keeps their tokens fresh.">
        {edit ? <button type="button" class="primary" onClick={() => onDialog({ kind: 'connect' })}>Connect account</button> : null}
      </SectionHead>
      {pendingMcp.length ? (
        <ul class="ga-cred-list">
          {pendingMcp.map((m) => (
            <li key={m.server} class="ga-cred-item attention">
              <div class="ga-cred-item-main">
                <div class="ga-cred-item-title">
                  <span class="ga-cred-name">{m.server}</span>
                  <span class="ga-cred-tag">MCP server</span>
                  <StatusPill tone="warn">Needs sign-in</StatusPill>
                </div>
                <div class="ga-cred-meta"><span class="ga-cred-mono">{m.url}</span></div>
                {m.needsApp || m.ambiguousApp ? (
                  <div class="ga-cred-meta">
                    <span class="ga-cred-warn-text">{m.ambiguousApp ? 'Multiple OAuth apps match; choose one.' : `Configure an OAuth app for ${m.issuer ?? 'the discovered issuer'}.`}</span>
                  </div>
                ) : null}
              </div>
              {edit ? (
                <div class="ga-cred-item-actions">
                  {m.needsApp ? (
                    <button type="button" class="primary" onClick={() => onDialog({ kind: 'oauth-app', app: { id: '', label: 'New app', install: null, group: null, overridesInstall: false }, issuer: m.issuer })}>Set up app</button>
                  ) : m.ambiguousApp ? (
                    <button type="button" class="primary" onClick={() => onDialog({ kind: 'connect' })}>Choose app</button>
                  ) : (
                    <button type="button" class="primary" onClick={() => void onSignIn({ mcpServer: m.server })}>Sign in</button>
                  )}
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      {data.accounts.length === 0 && pendingMcp.length === 0 ? (
        <div class="ga-cred-empty">
          <p>No accounts connected.</p>
          <p class="group-admin-help">Connect Google and similar services by signing in. MCP servers that need sign-in also appear here.</p>
        </div>
      ) : (
        <ul class="ga-cred-list">
          {data.accounts.map((a) => (
            <li key={a.key} class={`ga-cred-item${a.status === 'needs_reconnect' ? ' attention' : ''}`}>
              <div class="ga-cred-item-main">
                <div class="ga-cred-item-title">
                  <span class="ga-cred-name">{a.account ?? a.providerLabel}</span>
                  <span class="ga-cred-tag">{a.kind === 'mcp_oauth' ? `MCP · ${a.mcpServer}` : a.providerLabel}</span>
                  {a.client === 'registered' ? <span class="ga-cred-tag" title="The gateway registered its own OAuth client with this server for this group only">Own client</span> : null}
                  {a.client === 'app' ? <span class="ga-cred-tag" title="Signed in through an OAuth app set up under OAuth apps">OAuth app</span> : null}
                  {a.status === 'needs_reconnect' ? <StatusPill tone="warn">Needs reconnecting</StatusPill> : null}
                </div>
                {a.scopes.length ? (
                  <div class="ga-cred-chips">{a.scopes.map((s) => <span key={s.id} class="ga-cred-chip">{s.label}</span>)}</div>
                ) : null}
                {a.kind === 'oauth_app' ? <div class="ga-cred-meta">
                  <span>Scope metadata: {a.scopeSource ?? 'unknown'}{a.grantedScopes === null ? ' (provider grant not reported)' : ''}</span>
                  <span>API hosts: {a.apiHosts?.join(', ') || 'none'}</span>
                  <span>App source: {a.appSource ?? 'unknown'}</span>
                </div> : null}
                <div class="ga-cred-meta">
                  {a.status === 'needs_reconnect'
                    ? <span class="ga-cred-warn-text">{a.providerLabel} stopped accepting the saved sign-in. Reconnect to restore access.</span>
                    : <span>Last used {ago(a.lastUsedAt)}</span>}
                  {a.connectedAt ? <span>Connected {ago(a.connectedAt)}</span> : null}
                </div>
              </div>
              {edit ? (
                <div class="ga-cred-item-actions">
                  <button
                    type="button"
                    class={a.status === 'needs_reconnect' ? 'primary' : ''}
                    onClick={() => (a.kind === 'mcp_oauth' && a.mcpServer
                      ? void onSignIn({ mcpServer: a.mcpServer })
                      : onDialog({ kind: 'connect', reconnect: { provider: a.provider, key: a.key, scopes: a.scopeSource !== 'legacy' && a.requestedScopes !== null && a.requestedScopes !== undefined ? a.requestedScopes : a.scopes.map((s) => s.id) } }))}
                  >
                    {a.status === 'needs_reconnect' ? 'Reconnect' : 'Reauthorize'}
                  </button>
                  <button type="button" class="ga-cred-icon danger" aria-label={`Disconnect ${a.account ?? a.providerLabel}`} title="Disconnect" onClick={() => onDialog({ kind: 'disconnect', account: a })}>{'\u2715'}</button>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      <OAuthAppsSection data={data} onDialog={onDialog} />
    </div>
  );
}

function countAccounts(n: number): string {
  return n === 1 ? '1 account' : `${n} accounts`;
}

function removeAppText(app: OAuthAppDto, scope: OAuthAppScope): string {
  if (scope === 'install') {
    const all = app.install?.accountsAllGroups ?? app.install?.accounts ?? 0;
    const others = app.group ? ' This group keeps its own app.' : '';
    return all > 0
      ? `Groups without their own ${app.label} app can no longer connect accounts. ${countAccounts(all)} across all groups (${app.install?.accounts ?? 0} here) are disconnected, and their tokens are revoked.${others}`
      : `Groups without their own ${app.label} app can no longer connect accounts.${others}`;
  }
  const n = app.group?.accounts ?? 0;
  const fallback = app.install || app.overridesInstall ? `This group goes back to the install-wide app.` : `New ${app.label} accounts can't be connected here until an app is set up again.`;
  return n > 0 ? `${fallback} This group's ${countAccounts(n)} connected through its own app are disconnected, and their tokens are revoked.` : fallback;
}

function OAuthAppsSection({ data, onDialog }: { data: CredentialsOverviewDto; onDialog: (d: Dialog) => void }): JSX.Element {
  const edit = data.canEdit;
  const inst = data.canEditInstall;
  return (
    <>
      <h4 class="ga-cred-subhead">OAuth apps</h4>
      {edit ? <button type="button" onClick={() => onDialog({ kind: 'oauth-app', app: { id: '', label: 'New app', install: null, group: null, overridesInstall: false } })}>Add OAuth app</button> : null}
      <p class="group-admin-help">
        Providers that don't register clients themselves, like Google and GitHub, need an OAuth client created in their
        console. An install-wide app is shared by every group; a group can use its own instead. Tokens always stay in
        each group.
      </p>
      <ul class="ga-cred-list">
        {data.oauthApps.map((app) => {
          const client = app.group ?? app.install;
          return (
            <li key={app.id} class="ga-cred-item">
              <div class="ga-cred-item-main">
                <div class="ga-cred-item-title">
                  <span class="ga-cred-name">{app.label}</span>
                  {app.group ? <span class="ga-cred-tag">This group</span> : app.install ? <span class="ga-cred-tag">All groups</span> : <StatusPill tone="muted">Not set up</StatusPill>}
                </div>
                {client ? (
                  <div class="ga-cred-meta">
                    <span>Client <span class="ga-cred-mono">{client.clientId}</span></span>
                    <span>Set {ago(client.updatedAt)}</span>
                    <span>{countAccounts(client.accounts)} here{!app.group && app.install?.accountsAllGroups !== undefined ? `, ${app.install.accountsAllGroups} in all groups` : ''}</span>
                  </div>
                ) : null}
                {app.group && app.overridesInstall ? (
                  <div class="ga-cred-meta"><span>Used instead of the install-wide app{app.install ? ` (${app.install.clientId})` : ''}</span></div>
                ) : null}
                <div class="ga-cred-meta"><span>{client?.config.issuer}</span><span>{client?.config.api_hosts.join(', ') || 'MCP-only app'}</span></div>
              </div>
              {edit ? (
                <div class="ga-cred-item-actions">
                  {app.group ? (
                    <>
                      <button type="button" onClick={() => onDialog({ kind: 'oauth-app', app, scope: 'group' })}>Edit</button>
                      <button type="button" class="ga-cred-icon danger" aria-label={`Remove this group's ${app.label} app`} title="Remove this group's app" onClick={() => onDialog({ kind: 'remove-app', app, scope: 'group' })}>{'\u2715'}</button>
                      {inst && app.install ? <>
                        <button type="button" onClick={() => onDialog({ kind: 'oauth-app', app, scope: 'install' })}>Edit install-wide</button>
                        <button type="button" class="ga-cred-icon danger" aria-label={`Remove the install-wide ${app.label} app`} onClick={() => onDialog({ kind: 'remove-app', app, scope: 'install' })}>{'\u2715'}</button>
                      </> : null}
                    </>
                  ) : app.install ? (
                    <>
                      {inst ? <button type="button" onClick={() => onDialog({ kind: 'oauth-app', app, scope: 'install' })}>Edit</button> : null}
                      <button type="button" title="Use a different OAuth app in this group only" onClick={() => onDialog({ kind: 'oauth-app', app, scope: 'group' })}>Use own app</button>
                      {inst ? <button type="button" class="ga-cred-icon danger" aria-label={`Remove the install-wide ${app.label} app`} title="Remove the install-wide app" onClick={() => onDialog({ kind: 'remove-app', app, scope: 'install' })}>{'\u2715'}</button> : null}
                    </>
                  ) : (
                    <button type="button" onClick={() => onDialog({ kind: 'oauth-app', app })}>Set up</button>
                  )}
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
    </>
  );
}

function mcpMatch(url: string): string {
  if (!URL.canParse(url)) return '';
  const u = new URL(url);
  const dir = u.pathname.replace(/[^/]*$/, '');
  return `${u.host}${dir.length > 1 ? `${dir}*` : ''}`;
}

/** Sign-in status for one MCP server, shown in the MCP server editor. */
export function McpServerAuth({
  gid,
  server,
  onOpenCredentials,
}: {
  gid: string;
  server: string;
  onOpenCredentials: () => void;
}): JSX.Element {
  const { load, refresh } = useOverview(gid);
  const signIn = useSignIn(gid, () => void refresh());
  const entry: McpAuthDto | undefined = load.state === 'ready' ? load.data.mcp.find((m) => m.server === server) : undefined;
  const open = (focus: NonNullable<typeof credentialsFocus.value>): void => {
    credentialsFocus.value = focus;
    onOpenCredentials();
  };

  let body: JSX.Element;
  if (load.state === 'loading') body = <span class="muted">Checking…</span>;
  else if (load.state === 'down') body = <span class="ga-cred-warn-text">The credential gateway isn't responding.</span>;
  else if (load.state === 'error') body = <span class="ga-cred-warn-text">Couldn't check sign-in: {load.message}</span>;
  else if (load.state === 'inactive-target') body = <>
    <span class="muted">OneCLI remains active. Agent Vault credentials can be staged separately.</span>
    <button type="button" onClick={() => open({ view: 'accounts' })}>Open target setup</button>
  </>;
  else if (!entry) body = <span class="muted">Save the server to check whether it needs a key or sign-in.</span>;
  else if (entry.auth === 'oauth' && (entry.needsApp || entry.ambiguousApp)) {
    body = (
      <>
        <span class="ga-cred-warn-text">{entry.ambiguousApp ? 'Choose a configured OAuth app for this server.' : `Configure an OAuth app for ${entry.issuer ?? 'the discovered issuer'}.`}</span>
        <button type="button" class="primary" onClick={() => open({ view: 'accounts', setupIssuer: entry.needsApp ? entry.issuer : undefined })}>Manage in Credentials</button>
      </>
    );
  } else if (entry.auth === 'oauth') {
    body = entry.status === 'ok' ? (
      <>
        <span>Signed in{entry.account ? ` as ${entry.account}` : ''}.</span>
        <button type="button" onClick={() => void signIn.start({ mcpServer: server })}>Sign in again</button>
      </>
    ) : (
      <>
        <span class="ga-cred-warn-text">{entry.status === 'needs_reconnect' ? 'The sign-in expired.' : 'This server asks you to sign in before the agent can use it.'}</span>
        <button type="button" class="primary" onClick={() => void signIn.start({ mcpServer: server })}>Sign in</button>
      </>
    );
  } else if (entry.auth === 'key') {
    body = entry.status === 'needs_value' ? (
      <>
        <span class="ga-cred-warn-text">Uses <code>{entry.key}</code>, which has no value yet.</span>
        <button type="button" class="primary" onClick={() => open({ view: 'keys', key: entry.key, action: 'set' })}>Set it in Credentials</button>
      </>
    ) : (
      <>
        <span>Uses <code>{entry.key}</code> from Credentials.</span>
        <button type="button" class="ga-cred-link" onClick={() => open({ view: 'keys', key: entry.key })}>Manage</button>
      </>
    );
  } else {
    body = (
      <>
        <span class="muted">No key or sign-in.</span>
        {load.data.keysEditable !== false ? (
          <button type="button" class="ga-cred-link" onClick={() => open({ view: 'keys', action: 'add', match: mcpMatch(entry.url) })}>Add a key</button>
        ) : null}
      </>
    );
  }

  return (
    <div class="ga-cred-mcp-auth">
      <span class="ga-mcp-row-label">Sign-in</span>
      <div class="ga-cred-mcp-auth-body">{body}</div>
      {signIn.waiting ? <SignInBanner waiting={signIn.waiting} onReopen={signIn.reopen} onCancel={signIn.cancel} /> : null}
    </div>
  );
}
