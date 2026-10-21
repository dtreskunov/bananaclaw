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
} from './GroupAdminCredentialsApi';
import { SignInBanner, ago, describeInjection, useSignIn } from './GroupAdminCredentialsParts';
import {
  AddKeyDialog,
  ConfirmDialog,
  ConnectAccountDialog,
  EditKeyDialog,
  OAuthAppDialog,
  ReplaceKeyDialog,
} from './GroupAdminCredentialsDialogs';
import { showToast } from './Toast';

type View = 'keys' | 'accounts';

/** Where the Credentials tab should open next, e.g. when linked from the MCP editor. */
export const credentialsFocus = signal<{ view: View; key?: string; action?: 'set' | 'add'; match?: string } | null>(null);

type Dialog =
  | { kind: 'add-key'; match?: string }
  | { kind: 'replace'; item: KeyDto }
  | { kind: 'edit'; item: KeyDto }
  | { kind: 'delete-key'; item: KeyDto }
  | { kind: 'connect'; provider?: string; reconnect?: { provider: string; key: string; scopes: string[] } }
  | { kind: 'disconnect'; account: AccountDto }
  | { kind: 'oauth-app'; app: OAuthAppDto; thenConnect?: boolean }
  | { kind: 'remove-app'; app: OAuthAppDto };

type Load =
  | { state: 'loading' }
  | { state: 'down' }
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

function useOverview(gid: string): { load: Load; refresh: () => Promise<void> } {
  const [load, setLoad] = useState<Load>({ state: 'loading' });
  async function refresh(): Promise<void> {
    const r = await call<CredentialsOverviewDto>(credPath(gid));
    if (r.ok) setLoad({ state: 'ready', data: r.data });
    else if (r.status === 503 && errMsg(r.data, '') === ERROR_GATEWAY_UNREACHABLE) setLoad({ state: 'down' });
    else setLoad({ state: 'error', message: errMsg(r.data, `HTTP ${r.status}`) });
  }
  useEffect(() => {
    setLoad({ state: 'loading' });
    void refresh();
  }, [gid]);
  return { load, refresh };
}

export function CredentialsTab({ gid }: { gid: string }): JSX.Element {
  const { load, refresh } = useOverview(gid);
  const [view, setView] = useState<View>('keys');
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const signIn = useSignIn(gid, () => void refresh());

  useEffect(() => setView('keys'), [gid]);
  useEffect(() => {
    if (load.state !== 'ready') return;
    const focus = credentialsFocus.peek();
    if (!focus) return;
    credentialsFocus.value = null;
    setView(focus.view);
    const item = focus.key ? load.data.keys.find((k) => k.key === focus.key) : undefined;
    if (focus.action === 'set' && item && load.data.canEdit) setDialog({ kind: 'replace', item });
    if (focus.action === 'add' && load.data.canEdit) setDialog({ kind: 'add-key', match: focus.match });
  }, [load.state]);

  if (load.state === 'loading') return <p class="muted">Loading…</p>;
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
          presets={data.presets}
          existingKeys={keyNames}
          initialMatch={dialog.match}
          onExisting={(key) => {
            const item = data.keys.find((k) => k.key === key);
            setDialog(item ? { kind: 'replace', item } : null);
          }}
          onClose={close}
          onSaved={done}
        />
      ) : null}
      {dialog?.kind === 'replace' ? <ReplaceKeyDialog gid={gid} item={dialog.item} onClose={close} onSaved={done} /> : null}
      {dialog?.kind === 'edit' ? <EditKeyDialog gid={gid} item={dialog.item} onClose={close} onSaved={done} /> : null}
      {dialog?.kind === 'connect' ? (
        <ConnectAccountDialog
          apps={data.oauthApps}
          mcp={data.mcp}
          canEdit={data.canEdit}
          provider={dialog.provider}
          reconnect={dialog.reconnect}
          onSetUp={(app) => setDialog({ kind: 'oauth-app', app, thenConnect: true })}
          onStart={signIn.start}
          onClose={close}
        />
      ) : null}
      {dialog?.kind === 'oauth-app' ? (
        <OAuthAppDialog
          gid={gid}
          app={dialog.app}
          redirectUri={data.oauthRedirectUri}
          onClose={close}
          onSaved={() => {
            done();
            setDialog(dialog.thenConnect ? { kind: 'connect', provider: dialog.app.id } : null);
          }}
        />
      ) : null}
      {dialog?.kind === 'remove-app' ? (
        <ConfirmDialog
          title={`Remove the ${dialog.app.label} OAuth app?`}
          confirmLabel="Remove"
          danger
          onClose={close}
          onConfirm={async () => {
            const ok = await mutate(credPath(gid, `/oauth-apps/${encodeURIComponent(dialog.app.id)}`), 'DELETE', undefined, `Removed the ${dialog.app.label} OAuth app`);
            if (ok) done();
            return ok;
          }}
        >
          <p class="group-admin-help">
            {appAccounts(data, dialog.app.id) > 0
              ? `This group's ${dialog.app.label} accounts (${appAccounts(data, dialog.app.id)}) are disconnected too, and their tokens are revoked.`
              : `New ${dialog.app.label} accounts can't be connected in this group until an OAuth app is set up again.`}
          </p>
        </ConfirmDialog>
      ) : null}
      {dialog?.kind === 'delete-key' ? (
        <ConfirmDialog
          title={`Delete ${dialog.item.label}?`}
          confirmLabel="Delete key"
          danger
          onClose={close}
          onConfirm={async () => {
            const ok = await mutate(credPath(gid, `/keys/${encodeURIComponent(dialog.item.key)}`), 'DELETE', undefined, `Deleted ${dialog.item.label}`);
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
            const ok = await mutate(credPath(gid, `/accounts/${encodeURIComponent(dialog.account.key)}`), 'DELETE', undefined, 'Account disconnected');
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
  const edit = data.canEdit;
  return (
    <div class="ga-cred-view">
      <SectionHead help="API keys and tokens the agent can use, and where each one is sent.">
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
                  <button type="button" class={k.status === 'needs_value' ? 'primary' : ''} onClick={() => onDialog({ kind: 'replace', item: k })}>
                    {k.status === 'needs_value' ? 'Set value' : 'Replace'}
                  </button>
                  <button type="button" onClick={() => onDialog({ kind: 'edit', item: k })}>Edit</button>
                  <button type="button" class="ga-cred-icon danger" aria-label={`Delete ${k.label}`} title="Delete" onClick={() => onDialog({ kind: 'delete-key', item: k })}>{'\u2715'}</button>
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
              </div>
              {edit ? (
                <div class="ga-cred-item-actions">
                  <button type="button" class="primary" onClick={() => void onSignIn({ mcpServer: m.server })}>Sign in</button>
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
                  {a.status === 'needs_reconnect' ? <StatusPill tone="warn">Needs reconnecting</StatusPill> : null}
                </div>
                {a.scopes.length ? (
                  <div class="ga-cred-chips">{a.scopes.map((s) => <span key={s.id} class="ga-cred-chip">{s.label}</span>)}</div>
                ) : null}
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
                      : onDialog({ kind: 'connect', reconnect: { provider: a.provider, key: a.key, scopes: a.scopes.map((s) => s.id) } }))}
                  >
                    {a.status === 'needs_reconnect' ? 'Reconnect' : 'Change access'}
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

function appAccounts(data: CredentialsOverviewDto, provider: string): number {
  return data.accounts.filter((a) => a.kind === 'oauth_app' && a.provider === provider).length;
}

function OAuthAppsSection({ data, onDialog }: { data: CredentialsOverviewDto; onDialog: (d: Dialog) => void }): JSX.Element {
  const edit = data.canEdit;
  return (
    <>
      <h4 class="ga-cred-subhead">OAuth apps</h4>
      <p class="group-admin-help">
        Providers like Google need an OAuth client that you create in their console before accounts can be connected.
        This group's client is used only by this group. MCP servers don't need one; the gateway registers its own client
        with each server for this group.
      </p>
      <ul class="ga-cred-list">
        {data.oauthApps.map((app) => {
          const accounts = appAccounts(data, app.id);
          return (
            <li key={app.id} class="ga-cred-item">
              <div class="ga-cred-item-main">
                <div class="ga-cred-item-title">
                  <span class="ga-cred-name">{app.label}</span>
                  {app.configured ? null : <StatusPill tone="muted">Not set up</StatusPill>}
                </div>
                {app.configured ? (
                  <div class="ga-cred-meta">
                    <span>Client <span class="ga-cred-mono">{app.clientId}</span></span>
                    {app.updatedAt ? <span>Set {ago(app.updatedAt)}</span> : null}
                    <span>{accounts === 1 ? '1 account' : `${accounts} accounts`}</span>
                  </div>
                ) : null}
              </div>
              {edit ? (
                <div class="ga-cred-item-actions">
                  <button type="button" onClick={() => onDialog({ kind: 'oauth-app', app })}>{app.configured ? 'Edit' : 'Set up'}</button>
                  {app.configured ? (
                    <button type="button" class="ga-cred-icon danger" aria-label={`Remove the ${app.label} OAuth app`} title="Remove" onClick={() => onDialog({ kind: 'remove-app', app })}>{'\u2715'}</button>
                  ) : null}
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
  else if (!entry) body = <span class="muted">Save the server to check whether it needs a key or sign-in.</span>;
  else if (entry.auth === 'oauth') {
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
        <button type="button" class="ga-cred-link" onClick={() => open({ view: 'keys', action: 'add', match: mcpMatch(entry.url) })}>Add a key</button>
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
