// Group settings → Credentials: keys, accounts, rules and activity for this
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
  type ActivityDecision,
  type ActivityDto,
  type ActivityPageDto,
  type CredentialsOverviewDto,
  type KeyDto,
  type McpAuthDto,
  type RequestDto,
  type RuleDto,
} from './GroupAdminCredentialsApi';
import {
  APPROVAL_LABELS,
  SecretInput,
  SignInBanner,
  ago,
  describeInjection,
  until,
  useSignIn,
} from './GroupAdminCredentialsParts';
import {
  AddKeyDialog,
  ConfirmDialog,
  ConnectAccountDialog,
  CopyFromDialog,
  ReplaceKeyDialog,
  RuleDialog,
  ShareKeyDialog,
} from './GroupAdminCredentialsDialogs';
import { showToast } from './Toast';

type View = 'requests' | 'keys' | 'accounts' | 'rules' | 'activity' | 'network';

/** Where the Credentials tab should open next, e.g. when linked from the MCP editor. */
export const credentialsFocus = signal<{ view: View; key?: string; action?: 'set' | 'add'; match?: string } | null>(null);

type Dialog =
  | { kind: 'add-key'; match?: string }
  | { kind: 'replace'; item: KeyDto }
  | { kind: 'share'; item: KeyDto }
  | { kind: 'copy-from' }
  | { kind: 'delete-key'; item: KeyDto }
  | { kind: 'rule'; rule: RuleDto | null; initialKey?: string }
  | { kind: 'delete-rule'; rule: RuleDto }
  | { kind: 'connect'; reconnect?: { provider: string; key: string; scopes: string[] } }
  | { kind: 'disconnect'; account: AccountDto }
  | { kind: 'reject'; request: RequestDto };

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

function rulesForKey(rules: RuleDto[], key: string): RuleDto[] {
  return rules.filter((r) => r.injection.key === key || (r.injection.template ?? '').includes(`{{ ${key} }}`));
}

function hostOf(match: string): string {
  return match.split('/')[0] ?? match;
}

export function CredentialsTab({ gid }: { gid: string }): JSX.Element {
  const { load, refresh } = useOverview(gid);
  const [view, setView] = useState<View | null>(null);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const signIn = useSignIn(gid, () => void refresh());

  useEffect(() => setView(null), [gid]);
  useEffect(() => {
    if (load.state !== 'ready') return;
    const focus = credentialsFocus.peek();
    if (focus) {
      credentialsFocus.value = null;
      setView(focus.view);
      const item = focus.key ? load.data.keys.find((k) => k.key === focus.key) : undefined;
      if (focus.action === 'set' && item && load.data.canEdit) setDialog({ kind: 'replace', item });
      if (focus.action === 'add' && load.data.canEdit) setDialog({ kind: 'add-key', match: focus.match });
      return;
    }
    if (view === null) setView(load.data.requests.length ? 'requests' : 'keys');
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
  const current: View = view ?? 'keys';
  const close = (): void => setDialog(null);
  const done = (): void => void refresh();
  const keyNames = data.keys.map((k) => k.key);

  const segments: { id: View; label: string; count?: number; alert?: boolean }[] = [
    ...(data.requests.length || current === 'requests'
      ? [{ id: 'requests' as const, label: 'Requests', count: data.requests.length, alert: data.requests.length > 0 }]
      : []),
    { id: 'keys', label: 'Keys', count: data.keys.length, alert: data.keys.some((k) => k.status === 'needs_value') },
    {
      id: 'accounts',
      label: 'Accounts',
      count: data.accounts.length + data.mcp.filter((m) => m.auth === 'oauth' && m.status === 'needs_sign_in').length,
      alert: data.accounts.some((a) => a.status === 'needs_reconnect') || data.mcp.some((m) => m.status === 'needs_sign_in'),
    },
    { id: 'rules', label: 'Rules', count: data.rules.length },
    { id: 'activity', label: 'Activity' },
    { id: 'network', label: 'Network' },
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
            class={current === s.id ? 'active' : ''}
            aria-current={current === s.id ? 'page' : undefined}
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

      {current === 'requests' ? (
        <RequestsView gid={gid} data={data} onReject={(request) => setDialog({ kind: 'reject', request })}
          onSignIn={signIn.start} onDone={done} />
      ) : null}
      {current === 'keys' ? <KeysView data={data} onDialog={setDialog} /> : null}
      {current === 'accounts' ? <AccountsView data={data} onDialog={setDialog} onSignIn={signIn.start} /> : null}
      {current === 'rules' ? <RulesView gid={gid} data={data} onDialog={setDialog} onDone={done} onNetwork={() => setView('network')} /> : null}
      {current === 'activity' ? <ActivityView gid={gid} /> : null}
      {current === 'network' ? <NetworkView gid={gid} data={data} onDone={done} /> : null}

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
      {dialog?.kind === 'share' ? <ShareKeyDialog gid={gid} item={dialog.item} onClose={close} onSaved={done} /> : null}
      {dialog?.kind === 'copy-from' ? <CopyFromDialog gid={gid} existingKeys={keyNames} onClose={close} onSaved={done} /> : null}
      {dialog?.kind === 'rule' ? (
        <RuleDialog gid={gid} rule={dialog.rule} keys={keyNames} initialKey={dialog.initialKey} onClose={close} onSaved={done} />
      ) : null}
      {dialog?.kind === 'connect' ? (
        <ConnectAccountDialog apps={data.oauthApps} mcp={data.mcp} reconnect={dialog.reconnect} onStart={signIn.start} onClose={close} />
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
          <DeleteKeyText item={dialog.item} rules={rulesForKey(data.rules, dialog.item.key)} />
        </ConfirmDialog>
      ) : null}
      {dialog?.kind === 'delete-rule' ? (
        <ConfirmDialog
          title="Delete this rule?"
          confirmLabel="Delete rule"
          danger
          onClose={close}
          onConfirm={async () => {
            const ok = await mutate(credPath(gid, `/rules/${encodeURIComponent(dialog.rule.name)}`), 'DELETE', undefined, 'Rule deleted');
            if (ok) done();
            return ok;
          }}
        >
          <p class="group-admin-help">
            Requests to <code>{dialog.rule.match}</code> will no longer get{' '}
            {dialog.rule.injection.key ? <code>{dialog.rule.injection.key}</code> : 'special handling'}. The key itself is kept.
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
      {dialog?.kind === 'reject' ? (
        <ConfirmDialog
          title="Decline this request?"
          confirmLabel="Decline"
          danger
          onClose={close}
          onConfirm={async () => {
            const ok = await mutate(credPath(gid, `/requests/${encodeURIComponent(dialog.request.id)}/reject`), 'POST', {}, 'Request declined');
            if (ok) done();
            return ok;
          }}
        >
          <p class="group-admin-help">The agent is told the request was declined. Nothing is added.</p>
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

function DeleteKeyText({ item, rules }: { item: KeyDto; rules: RuleDto[] }): JSX.Element {
  return (
    <>
      <p class="group-admin-help">The value is erased from this group's vault. This can't be undone.</p>
      {rules.length ? (
        <p class="group-admin-help">
          {rules.length === 1 ? 'This rule uses it and will be deleted too:' : `These ${rules.length} rules use it and will be deleted too:`}
          {' '}{rules.map((r, i) => <span key={r.name}>{i ? ', ' : ''}<code>{r.match}</code></span>)}
        </p>
      ) : null}
      {item.alsoIn.length ? (
        <p class="group-admin-help">{item.alsoIn.map((g) => g.groupName).join(', ')} keep their own copies.</p>
      ) : null}
    </>
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
      <SectionHead help="API keys and tokens the agent can use. Each group has its own copy of a key.">
        {edit ? <button type="button" onClick={() => onDialog({ kind: 'copy-from' })}>Copy from group…</button> : null}
        {edit ? <button type="button" class="primary" onClick={() => onDialog({ kind: 'add-key' })}>Add key</button> : null}
      </SectionHead>
      {data.keys.length === 0 ? (
        <div class="ga-cred-empty">
          <p>No keys yet.</p>
          <p class="group-admin-help">Add a key for a service, or copy keys you already set up in another group.</p>
        </div>
      ) : (
        <ul class="ga-cred-list">
          {data.keys.map((k) => {
            const rules = rulesForKey(data.rules, k.key);
            const hosts = [...new Set(rules.map((r) => hostOf(r.match)))];
            const staleCopy = k.copiedFrom?.stale;
            return (
              <li key={k.key} class={`ga-cred-item${k.status === 'needs_value' ? ' attention' : ''}`}>
                <div class="ga-cred-item-main">
                  <div class="ga-cred-item-title">
                    <span class="ga-cred-name">{k.label}</span>
                    <code class="ga-cred-code-muted">{k.key}</code>
                    {k.status === 'needs_value' ? <StatusPill tone="warn">Needs a value</StatusPill> : null}
                    {staleCopy ? <StatusPill tone="warn">Out of date</StatusPill> : null}
                  </div>
                  <div class="ga-cred-meta">
                    {hosts.length ? <span>Sent to <span class="ga-cred-mono">{hosts.join(', ')}</span></span>
                      : <span class="ga-cred-warn-text">Not used by any rule</span>}
                    {k.status === 'set' ? <span>Last used {ago(k.lastUsedAt)}</span> : null}
                    {k.status === 'set' && k.updatedAt ? <span>Set {ago(k.updatedAt)}</span> : null}
                  </div>
                  {k.copiedFrom ? (
                    <div class="ga-cred-meta">
                      <span>
                        Copied from {k.copiedFrom.groupName} {ago(k.copiedFrom.at)}
                        {staleCopy ? `; ${k.copiedFrom.groupName} has replaced its value since` : ''}
                      </span>
                    </div>
                  ) : null}
                  {k.alsoIn.length ? (
                    <div class="ga-cred-meta"><span>Also in {k.alsoIn.map((g) => g.groupName).join(', ')}</span></div>
                  ) : null}
                </div>
                {edit ? (
                  <div class="ga-cred-item-actions">
                    <button type="button" class={k.status === 'needs_value' || staleCopy ? 'primary' : ''} onClick={() => onDialog({ kind: 'replace', item: k })}>
                      {k.status === 'needs_value' ? 'Set value' : 'Replace'}
                    </button>
                    {k.status === 'set' ? <button type="button" onClick={() => onDialog({ kind: 'share', item: k })}>Copy to…</button> : null}
                    {!hosts.length ? <button type="button" onClick={() => onDialog({ kind: 'rule', rule: null, initialKey: k.key })}>Add rule</button> : null}
                    <button type="button" class="ga-cred-icon danger" aria-label={`Delete ${k.label}`} title="Delete" onClick={() => onDialog({ kind: 'delete-key', item: k })}>{'\u2715'}</button>
                  </div>
                ) : null}
              </li>
            );
          })}
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
    </div>
  );
}

function RulesView({
  gid,
  data,
  onDialog,
  onDone,
  onNetwork,
}: {
  gid: string;
  data: CredentialsOverviewDto;
  onDialog: (d: Dialog) => void;
  onDone: () => void;
  onNetwork: () => void;
}): JSX.Element {
  const edit = data.canEdit;
  const [busy, setBusy] = useState<string | null>(null);
  async function toggle(rule: RuleDto): Promise<void> {
    setBusy(rule.name);
    const { name: _name, ...body } = rule;
    if (await mutate(credPath(gid, `/rules/${encodeURIComponent(rule.name)}`), 'PUT', { ...body, enabled: !rule.enabled }, rule.enabled ? 'Rule paused' : 'Rule resumed')) onDone();
    setBusy(null);
  }
  const availability = new Map<string, 'ok' | 'missing' | 'reconnect'>();
  for (const k of data.keys) availability.set(k.key, k.status === 'set' ? 'ok' : 'missing');
  for (const a of data.accounts) availability.set(a.key, a.status === 'connected' ? 'ok' : 'reconnect');
  return (
    <div class="ga-cred-view">
      <SectionHead help="Which requests get which key, and which calls wait for approval. The most specific match wins.">
        {edit ? <button type="button" class="primary" onClick={() => onDialog({ kind: 'rule', rule: null })}>Add rule</button> : null}
      </SectionHead>
      {data.rules.length === 0 ? (
        <div class="ga-cred-empty"><p>No rules yet.</p><p class="group-admin-help">Adding a key creates its rule; add more to reuse a key for other hosts.</p></div>
      ) : (
        <ul class="ga-cred-list">
          {data.rules.map((r) => {
            const keyState = r.injection.key ? availability.get(r.injection.key) ?? 'gone' : 'ok';
            return (
              <li key={r.name} class={`ga-cred-item${r.enabled ? '' : ' paused'}`}>
                <div class="ga-cred-item-main">
                  <div class="ga-cred-item-title">
                    <span class="ga-cred-name ga-cred-mono">{r.match}</span>
                    {r.mcpServer ? <span class="ga-cred-tag">MCP · {r.mcpServer}</span> : null}
                    {!r.enabled ? <StatusPill tone="muted">Paused</StatusPill> : null}
                    {keyState === 'missing' ? <StatusPill tone="warn">Key has no value</StatusPill> : null}
                    {keyState === 'reconnect' ? <StatusPill tone="warn">Account needs reconnecting</StatusPill> : null}
                    {keyState === 'gone' ? <StatusPill tone="err">Key deleted</StatusPill> : null}
                  </div>
                  <div class="ga-cred-meta">
                    <span class="ga-cred-mono">{describeInjection(r.injection)}</span>
                    <span>{APPROVAL_LABELS[r.approval]}</span>
                  </div>
                  {r.approval === 'custom' && r.askRules.length ? (
                    <div class="ga-cred-chips">
                      {r.askRules.map((a, i) => <span key={i} class="ga-cred-chip ga-cred-mono">Ask: {a.method} {a.path}</span>)}
                    </div>
                  ) : null}
                </div>
                {edit ? (
                  <div class="ga-cred-item-actions">
                    <button type="button" disabled={busy === r.name} onClick={() => void toggle(r)}>{r.enabled ? 'Pause' : 'Resume'}</button>
                    <button type="button" onClick={() => onDialog({ kind: 'rule', rule: r })}>Edit</button>
                    <button type="button" class="ga-cred-icon danger" aria-label={`Delete rule ${r.match}`} title="Delete" onClick={() => onDialog({ kind: 'delete-rule', rule: r })}>{'\u2715'}</button>
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
      <p class="group-admin-help ga-cred-foot-note">
        Requests that match no rule {data.network.unmatched === 'tunnel' ? 'go out without a key' : 'are blocked'}.{' '}
        <button type="button" class="ga-cred-link" onClick={onNetwork}>Change</button>
      </p>
    </div>
  );
}

const DECISION_LABELS: Record<ActivityDecision, { label: string; tone: 'ok' | 'warn' | 'muted' | 'err' }> = {
  injected: { label: 'Key added', tone: 'ok' },
  approved: { label: 'Approved', tone: 'ok' },
  denied: { label: 'Denied', tone: 'err' },
  expired: { label: 'Not approved in time', tone: 'warn' },
  tunnel: { label: 'No key', tone: 'muted' },
  blocked: { label: 'Blocked', tone: 'err' },
};

function ActivityView({ gid }: { gid: string }): JSX.Element {
  const [filter, setFilter] = useState<'all' | 'keys' | 'problems'>('all');
  const [items, setItems] = useState<ActivityDto[] | null>(null);
  const [next, setNext] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function fetchPage(before: string | null, replace: boolean): Promise<void> {
    setBusy(true);
    const query = new URLSearchParams({ filter });
    if (before) query.set('before', before);
    const r = await call<ActivityPageDto>(`${credPath(gid, '/activity')}?${query}`);
    setBusy(false);
    if (!r.ok) {
      showToast(errMsg(r.data, `HTTP ${r.status}`), 'err');
      if (replace) setItems([]);
      return;
    }
    setItems(replace ? r.data.items : [...(items ?? []), ...r.data.items]);
    setNext(r.data.nextBefore);
  }
  useEffect(() => {
    setItems(null);
    void fetchPage(null, true);
  }, [gid, filter]);

  return (
    <div class="ga-cred-view">
      <SectionHead help="Recent requests from this group's agents. Bodies and key values are never recorded.">
        <div class="ga-cred-filter" role="group" aria-label="Filter">
          {(['all', 'keys', 'problems'] as const).map((f) => (
            <button type="button" key={f} class={filter === f ? 'active' : ''} aria-pressed={filter === f} onClick={() => setFilter(f)}>
              {f === 'all' ? 'All' : f === 'keys' ? 'Used a key' : 'Denied or blocked'}
            </button>
          ))}
        </div>
        <button type="button" disabled={busy} onClick={() => void fetchPage(null, true)}>Refresh</button>
      </SectionHead>
      {items === null ? <p class="muted">Loading…</p> : items.length === 0 ? (
        <div class="ga-cred-empty"><p>Nothing here yet.</p></div>
      ) : (
        <>
          <ul class="ga-cred-activity">
            {items.map((a) => {
              const d = DECISION_LABELS[a.decision];
              return (
                <li key={a.id}>
                  <span class="ga-cred-activity-time" title={new Date(a.at).toLocaleString()}>{ago(a.at)}</span>
                  <span class="ga-cred-activity-req ga-cred-mono">
                    <strong>{a.method}</strong> {a.host}<span class="ga-cred-activity-path">{a.path}</span>
                  </span>
                  <span class="ga-cred-activity-outcome">
                    <StatusPill tone={d.tone}>{d.label}</StatusPill>
                    {a.status !== null ? <span class="ga-cred-activity-status">{a.status}</span> : null}
                  </span>
                  <span class="ga-cred-activity-detail">
                    {a.key ? <code class="ga-cred-code-muted">{a.key}</code> : null}
                    {a.thread ? <span>{a.thread}</span> : null}
                  </span>
                </li>
              );
            })}
          </ul>
          {next ? <button type="button" class="ga-cred-more" disabled={busy} onClick={() => void fetchPage(next, false)}>{busy ? 'Loading…' : 'Show older'}</button> : null}
        </>
      )}
    </div>
  );
}

function NetworkView({ gid, data, onDone }: { gid: string; data: CredentialsOverviewDto; onDone: () => void }): JSX.Element {
  const edit = data.canEdit;
  const [unmatched, setUnmatched] = useState(data.network.unmatched);
  const [allow, setAllow] = useState(data.network.allowPrivate);
  const [entry, setEntry] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setUnmatched(data.network.unmatched);
    setAllow(data.network.allowPrivate);
  }, [JSON.stringify(data.network)]);
  const dirty = unmatched !== data.network.unmatched || JSON.stringify(allow) !== JSON.stringify(data.network.allowPrivate);
  const entryValid = /^[A-Za-z0-9.:\-[\]]+(\/\d{1,3})?(:\d+)?$/.test(entry.trim());

  function add(): void {
    const value = entry.trim();
    if (!entryValid || allow.includes(value)) return;
    setAllow([...allow, value]);
    setEntry('');
  }

  return (
    <div class="ga-cred-view">
      <SectionHead help="What the agent can reach besides services with a rule." />
      <fieldset class="ga-cred-choice" disabled={!edit}>
        <legend>Requests that match no rule</legend>
        <label class="group-admin-check">
          <input type="radio" name="ga-cred-unmatched" checked={unmatched === 'tunnel'} onChange={() => setUnmatched('tunnel')} />
          <span>Allow, without a key <span class="ga-cred-choice-note">Recommended. Public sites and downloads work; the gateway doesn't inspect them.</span></span>
        </label>
        <label class="group-admin-check">
          <input type="radio" name="ga-cred-unmatched" checked={unmatched === 'deny'} onChange={() => setUnmatched('deny')} />
          <span>Block <span class="ga-cred-choice-note">Only hosts with a rule are reachable. Add “No key — just allow the host” rules for anything else.</span></span>
        </label>
      </fieldset>
      <h4>Private network addresses</h4>
      <p class="group-admin-help">
        Addresses on your local network are blocked unless listed here, e.g. <code>192.168.1.20</code> or <code>homeassistant.local:8123</code>.
      </p>
      <div class="ga-cred-chips ga-cred-chips-edit">
        {allow.map((a) => (
          <span key={a} class="ga-cred-chip ga-cred-mono">
            {a}
            {edit ? <button type="button" aria-label={`Remove ${a}`} onClick={() => setAllow(allow.filter((x) => x !== a))}>{'\u2715'}</button> : null}
          </span>
        ))}
        {data.network.operatorAllowPrivate.map((a) => (
          <span key={`op-${a}`} class="ga-cred-chip ga-cred-mono locked" title="Allowed for every group in the gateway's .env">{a} · all groups</span>
        ))}
        {allow.length === 0 && data.network.operatorAllowPrivate.length === 0 ? <span class="muted">None</span> : null}
      </div>
      {edit ? (
        <form class="ga-cred-inline-add" onSubmit={(event) => { event.preventDefault(); add(); }}>
          <input type="text" class="ga-cred-mono" value={entry} spellcheck={false} placeholder="Address, network or host:port" onInput={(event) => setEntry(event.currentTarget.value)} />
          <button type="submit" disabled={!entryValid}>Add</button>
        </form>
      ) : null}
      <p class="group-admin-help ga-cred-field-help">Cloud metadata addresses are always blocked.</p>
      {edit ? (
        <div class="ga-cred-save-row">
          <button type="button" disabled={!dirty || busy} onClick={() => { setUnmatched(data.network.unmatched); setAllow(data.network.allowPrivate); }}>Discard</button>
          <button type="button" class="primary" disabled={!dirty || busy} onClick={async () => {
            setBusy(true);
            if (await mutate(credPath(gid, '/network'), 'PUT', { unmatched, allowPrivate: allow }, 'Network settings saved')) onDone();
            setBusy(false);
          }}>
            {busy ? 'Saving…' : 'Save'}
          </button>
        </div>
      ) : null}
    </div>
  );
}

function RequestsView({
  gid,
  data,
  onReject,
  onSignIn,
  onDone,
}: {
  gid: string;
  data: CredentialsOverviewDto;
  onReject: (request: RequestDto) => void;
  onSignIn: (input: { provider: string; scopeSets: string[]; requestId: string }) => Promise<boolean>;
  onDone: () => void;
}): JSX.Element {
  if (data.requests.length === 0) {
    return <div class="ga-cred-view"><div class="ga-cred-empty"><p>No pending requests.</p></div></div>;
  }
  return (
    <div class="ga-cred-view">
      <SectionHead help="The agent asked for access it doesn't have yet. Nothing changes until you approve." />
      {data.requests.map((r) => <RequestCard key={r.id} gid={gid} request={r} canEdit={data.canEdit} onReject={onReject} onSignIn={onSignIn} onDone={onDone} />)}
    </div>
  );
}

function RequestCard({
  gid,
  request,
  canEdit,
  onReject,
  onSignIn,
  onDone,
}: {
  gid: string;
  request: RequestDto;
  canEdit: boolean;
  onReject: (request: RequestDto) => void;
  onSignIn: (input: { provider: string; scopeSets: string[]; requestId: string }) => Promise<boolean>;
  onDone: () => void;
}): JSX.Element {
  const [values, setValues] = useState<Record<string, string>>({});
  const [copyFrom, setCopyFrom] = useState<Record<string, string>>({});
  const [source, setSource] = useState<Record<string, 'enter' | 'copy'>>({});
  const [busy, setBusy] = useState(false);
  const slotReady = (key: string, agentProvided?: boolean): boolean => {
    if (agentProvided) return true;
    return (source[key] ?? 'enter') === 'copy' ? !!copyFrom[key] : !!values[key];
  };
  const ready = request.slots.every((s) => slotReady(s.key, s.agentProvided));

  async function approve(): Promise<void> {
    setBusy(true);
    const body = {
      values: Object.fromEntries(request.slots.filter((s) => !s.agentProvided && (source[s.key] ?? 'enter') === 'enter').map((s) => [s.key, values[s.key] ?? ''])),
      copyFrom: Object.fromEntries(request.slots.filter((s) => (source[s.key] ?? 'enter') === 'copy').map((s) => [s.key, copyFrom[s.key]])),
    };
    if (await mutate(credPath(gid, `/requests/${encodeURIComponent(request.id)}/approve`), 'POST', body, 'Request approved')) onDone();
    setBusy(false);
  }

  return (
    <article class="ga-cred-request">
      <header>
        <div>
          <strong>{request.account ? `Connect ${request.account.providerLabel}` : request.slots.length ? `Add ${request.slots.map((s) => s.label).join(', ')}` : 'Change rules'}</strong>
          <span class="ga-cred-meta">
            <span>Asked {ago(request.createdAt)}{request.thread ? ` in “${request.thread}”` : ''}</span>
            <span>{until(request.expiresAt)}</span>
          </span>
        </div>
      </header>
      <blockquote class="ga-cred-request-message">{request.message}</blockquote>

      {request.slots.map((s) => {
        const mode = source[s.key] ?? 'enter';
        return (
          <div class="ga-cred-slot" key={s.key}>
            <div class="ga-cred-item-title">
              <span class="ga-cred-name">{s.label}</span>
              <code class="ga-cred-code-muted">{s.key}</code>
            </div>
            <p class="group-admin-help">{s.description}</p>
            {s.agentProvided ? (
              <p class="ga-cred-note">The agent created this value itself (for example, a token from a sign-up). Approving stores it; you won't see it.</p>
            ) : (
              <>
                {s.copyableFrom.length ? (
                  <div class="ga-cred-filter" role="group" aria-label={`Value for ${s.key}`}>
                    <button type="button" class={mode === 'enter' ? 'active' : ''} aria-pressed={mode === 'enter'} onClick={() => setSource({ ...source, [s.key]: 'enter' })}>Enter a value</button>
                    <button type="button" class={mode === 'copy' ? 'active' : ''} aria-pressed={mode === 'copy'} onClick={() => {
                      setSource({ ...source, [s.key]: 'copy' });
                      if (!copyFrom[s.key]) setCopyFrom({ ...copyFrom, [s.key]: s.copyableFrom[0]!.groupId });
                    }}>Copy from {s.copyableFrom.length === 1 ? s.copyableFrom[0]!.groupName : 'another group'}</button>
                  </div>
                ) : null}
                {mode === 'enter' ? (
                  <>
                    <SecretInput value={values[s.key] ?? ''} onInput={(v) => setValues({ ...values, [s.key]: v })} disabled={!canEdit} />
                    {s.obtainUrl || s.obtainInstructions ? (
                      <p class="group-admin-help ga-cred-field-help">
                        {s.obtainInstructions ? `${s.obtainInstructions} ` : null}
                        {s.obtainUrl ? <a href={s.obtainUrl} target="_blank" rel="noopener noreferrer">Get one ↗</a> : null}
                      </p>
                    ) : null}
                  </>
                ) : s.copyableFrom.length > 1 ? (
                  <select value={copyFrom[s.key] ?? ''} onChange={(event) => setCopyFrom({ ...copyFrom, [s.key]: event.currentTarget.value })}>
                    {s.copyableFrom.map((g) => <option key={g.groupId} value={g.groupId}>{g.groupName}</option>)}
                  </select>
                ) : (
                  <p class="group-admin-help">The value is copied inside the gateway; nobody sees it.</p>
                )}
              </>
            )}
          </div>
        );
      })}

      {request.rules.length ? (
        <div class="ga-cred-request-rules">
          <span class="ga-cred-row-label">Rules it adds</span>
          <ul>
            {request.rules.map((r, i) => (
              <li key={i}>
                <span class="ga-cred-mono">{r.match}</span> · <span class="ga-cred-mono">{describeInjection(r.injection)}</span> · {APPROVAL_LABELS[r.approval]}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {request.account ? (
        <div class="ga-cred-chips">{request.account.scopes.map((s) => <span key={s.id} class="ga-cred-chip">{s.label}</span>)}</div>
      ) : null}

      {canEdit ? (
        <footer>
          <button type="button" class="danger" disabled={busy} onClick={() => onReject(request)}>Decline</button>
          {request.account ? (
            <button type="button" class="primary" disabled={busy} onClick={() => void onSignIn({
              provider: request.account!.provider,
              scopeSets: request.account!.scopes.map((s) => s.id),
              requestId: request.id,
            })}>
              Sign in to {request.account.providerLabel}
            </button>
          ) : (
            <button type="button" class="primary" disabled={busy || !ready} onClick={() => void approve()}>{busy ? 'Approving…' : 'Approve'}</button>
          )}
        </footer>
      ) : null}
    </article>
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
