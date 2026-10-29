import { useState } from 'preact/hooks';
import type { JSX } from 'preact';
import {
  appConfiguration, connectionPath, credentialRequest, credentialsPath, errorMessage, CredentialsError,
  parseAppConfiguration, parseServices, providedValues, serviceKeys, SERVICE_PRESETS,
  type AppInfo, type Connection, type CredentialGroup, type OAuthAppConfiguration,
  type OAuthAppScope, type Service, type SignInInput,
} from './CredentialsApi';
import {
  ConfirmCredentialAction, CredentialDialog, ErrorNotice, Impact, Review,
  SecretInput, useCredentialResource,
} from './CredentialsParts';
import { GroupAdminField as Field } from './GroupAdminField';
import { showToast } from './Toast';

export function ConnectionEditor({ id, groups, onClose, onSaved }: {
  id?: string; groups: CredentialGroup[]; onClose: () => void; onSaved: () => void;
}): JSX.Element {
  return id ? <ExistingConnectionEditor id={id} groups={groups} onClose={onClose} onSaved={onSaved} />
    : <ConnectionForm groups={groups} onClose={onClose} onSaved={onSaved} />;
}

function ExistingConnectionEditor({ id, groups, onClose, onSaved }: {
  id: string; groups: CredentialGroup[]; onClose: () => void; onSaved: () => void;
}): JSX.Element {
  const { data, error, loading, refresh } = useCredentialResource<Connection>(connectionPath(id));
  if (loading || error || !data) return <CredentialDialog title="Load connection" onClose={onClose}>
    {loading ? <p>Loading latest connection metadata…</p> : <><ErrorNotice message={error} />
      <button type="button" onClick={() => void refresh()}>Retry</button></>}
  </CredentialDialog>;
  return <ConnectionForm key={`${data.id}:${data.revision}`} connection={data} groups={groups} onClose={onClose} onSaved={onSaved} />;
}

function ConnectionForm({ connection, groups, onClose, onSaved }: {
  connection?: Connection; groups: CredentialGroup[]; onClose: () => void; onSaved: () => void;
}): JSX.Element {
  const [label, setLabel] = useState(connection?.label ?? '');
  const [text, setText] = useState(JSON.stringify(connection?.services ?? SERVICE_PRESETS[0].services, null, 2));
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [reviewed, setReviewed] = useState(false);
  const [stale, setStale] = useState(false);
  let services: Service[] = [];
  let jsonError = '';
  try { services = parseServices(text); }
  catch (error) {
    if (!(error instanceof SyntaxError || error instanceof CredentialsError)) throw error;
    jsonError = errorMessage(error);
  }
  const isStatic = !connection || connection.kind === 'static';
  const keys = isStatic ? [...new Set([...(connection?.credentials ?? []), ...serviceKeys(services)])] : [];
  const supplied = providedValues(values, keys);
  const canSave = !busy && !stale && !!label.trim() && !jsonError &&
    (connection ? reviewed : keys.length > 0 && keys.every((key) => !!supplied[key]));

  async function save(event: Event): Promise<void> {
    event.preventDefault();
    if (!canSave) return;
    setBusy(true);
    setError('');
    try {
      await credentialRequest<Connection>(connection ? connectionPath(connection.id) : credentialsPath('/connections'),
        connection ? 'PUT' : 'POST', {
          label: label.trim(), services,
          ...(isStatic && Object.keys(supplied).length ? { values: supplied } : {}),
          ...(connection ? { revision: connection.revision } : { kind: 'static' }),
        });
      setValues({});
      showToast(connection ? 'Connection updated. Review suspended grants before reapproving access.' : 'Personal connection created');
      onSaved();
      onClose();
    } catch (error) {
      if (!(error instanceof CredentialsError || error instanceof TypeError)) throw error;
      setError(errorMessage(error));
      if (error instanceof Error && 'status' in error && (error.status === 412 || error.status === 409)) setStale(true);
    } finally { setBusy(false); }
  }
  return <CredentialDialog title={connection ? `Manage ${connection.label}` : 'Create key connection'} onClose={onClose} busy={busy} footer={<>
    <button type="button" disabled={busy} onClick={onClose}>Cancel</button>
    <button type="submit" form="personal-connection" class="primary" disabled={!canSave}>{busy ? 'Saving…' : connection ? 'Save reviewed changes' : 'Create connection'}</button>
  </>}>
    <p class="group-admin-help">Owned by you, stored once. Add one or more services and complementary keys.
      Only key names and routing appear below; saved secret values are never returned.</p>
    <form id="personal-connection" onSubmit={save}>
      <Field label="Connection label"><input type="text" aria-label="Connection label" value={label} disabled={busy} onInput={(event) => setLabel(event.currentTarget.value)} /></Field>
      {!connection ? <Field label="Service preset"><select aria-label="Service preset" disabled={busy} onChange={(event) => {
        setText(JSON.stringify(SERVICE_PRESETS[Number(event.currentTarget.value)].services, null, 2));
        setValues({});
      }}>{SERVICE_PRESETS.map((preset, index) => <option value={index} key={preset.label}>{preset.label}</option>)}</select></Field> : null}
      <Field label="Service routing JSON">
        <textarea class="ga-cred-mono" aria-label="Service routing JSON" rows={12} value={text} disabled={busy}
          spellcheck={false} onInput={(event) => { setText(event.currentTarget.value); setReviewed(false); }} />
      </Field>
      <p class="group-admin-help">Use host[:port] and optional path patterns to restrict destinations. auth.token,
        username, password and key reference key NAMES. Custom auth.headers use templates such as
        {' '}<code>{'Bearer {{ API_TOKEN }}'}</code>. Substitutions reference a key name and placeholder.
        Never paste a secret into JSON. Basic pairs and multi-header values are saved together.</p>
      <ErrorNotice message={jsonError} />
      {keys.map((key) => <Field key={key} label={key} info={connection ? 'Blank preserves the current value; enter only a new value to rotate.' : 'Required to create this connection.'}>
        <SecretInput label={key} value={values[key] ?? ''} disabled={busy} placeholder={connection ? 'Keep current value' : 'New value'}
          onInput={(value) => { setValues((old) => ({ ...old, [key]: value })); setReviewed(false); }} />
      </Field>)}
      {connection ? <>
        <Impact connection={connection} groups={groups} />
        <p>Rotation affects every agent above. Routing, authority and authentication changes can suspend their
          grants until explicitly reapproved. Review new destinations and all selected services before saving.</p>
        <Review checked={reviewed} onChange={setReviewed}>I reviewed the routing, rotation and affected-agent impact.</Review>
      </> : null}
      <ErrorNotice message={error} />
      {stale ? <p role="alert">This connection changed or the operation conflicts. Close and reopen it to load the
        latest revision; your changes were not blindly overwritten.</p> : null}
    </form>
  </CredentialDialog>;
}

export function OAuthConnectionDialog({ connection, apps, groups, resourceUrl, onStart, onClose, onSaved }: {
  connection?: Connection; apps: AppInfo[]; groups: CredentialGroup[]; resourceUrl?: string;
  onStart: (id: string, input: SignInInput) => Promise<void>; onClose: () => void; onSaved: () => void;
}): JSX.Element {
  const [kind, setKind] = useState<'mcp_oauth' | 'oauth_app'>(connection?.kind === 'oauth_app' ? 'oauth_app' : 'mcp_oauth');
  const [label, setLabel] = useState(connection?.label ?? '');
  const [resource, setResource] = useState(connection?.resource_url ?? resourceUrl ?? '');
  const [app, setApp] = useState(connection?.app_id ?? '');
  const [scopes, setScopes] = useState((connection?.requested_scopes ?? []).join('\n'));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [reviewed, setReviewed] = useState(false);
  const [draft, setDraft] = useState<Connection | null>(null);
  const canStart = !busy && !!label.trim() && (kind === 'mcp_oauth' ? !!resource.trim() : !!app) && reviewed;
  async function start(event: Event): Promise<void> {
    event.preventDefault();
    if (!canStart) return;
    setBusy(true);
    setError('');
    try {
      const input: SignInInput = {
        ...(kind === 'mcp_oauth' ? { resource_url: resource.trim() } : {}),
        ...(app ? { app_id: app } : {}),
        scopes: scopes.split(/[\s,]+/).filter(Boolean),
      };
      let target = connection ?? draft;
      if (!target) {
        target = await credentialRequest<Connection>(credentialsPath('/connections'), 'POST', { label: label.trim(), kind, ...input });
        setDraft(target);
        onSaved();
      }
      await onStart(target.id, input);
      onSaved();
      onClose();
    } catch (error) {
      if (!(error instanceof CredentialsError || error instanceof TypeError)) throw error;
      setError(errorMessage(error));
    }
    finally { setBusy(false); }
  }
  return <CredentialDialog title={connection ? `Reconnect ${connection.label}` : 'Connect an account'} onClose={onClose} busy={busy} footer={<>
    <button type="button" disabled={busy} onClick={onClose}>Cancel</button>
    <button type="submit" form="personal-oauth" class="primary" disabled={!canStart}>{busy ? 'Starting…' : draft ? 'Retry sign-in' : 'Start sign-in'}</button>
  </>}>
    <form id="personal-oauth" onSubmit={start}>
      {!connection && !draft ? <>
        <Field label="Connection label"><input type="text" aria-label="Connection label" value={label} disabled={busy} onInput={(event) => setLabel(event.currentTarget.value)} /></Field>
        <Field label="Connection type"><select value={kind} aria-label="Connection type" disabled={busy} onChange={(event) => { setKind(event.currentTarget.value as typeof kind); setReviewed(false); }}>
          <option value="mcp_oauth">MCP server OAuth</option><option value="oauth_app">Configured OAuth app</option>
        </select></Field>
      </> : null}
      {kind === 'mcp_oauth' ? <Field label="MCP resource URL"><input type="url" aria-label="MCP resource URL" value={resource} disabled={busy}
        placeholder="https://mcp.example.com/mcp" onInput={(event) => { setResource(event.currentTarget.value); setReviewed(false); }} /></Field> : null}
      <Field label="OAuth app"><select aria-label="OAuth app" value={app} disabled={busy} onChange={(event) => {
        setApp(event.currentTarget.value);
        setScopes((apps.find((item) => item.id === event.currentTarget.value)?.default_scopes ?? []).join('\n'));
        setReviewed(false);
      }}>
        <option value="">{kind === 'mcp_oauth' ? 'Automatic discovery / dynamic registration' : 'Select a configured app'}</option>
        {apps.map((item) => <option key={`${item.source}:${item.id}`} value={item.id}>{item.label} · {item.source === 'user' ? 'Personal' : 'Install'}</option>)}
      </select></Field>
      {kind === 'oauth_app' && !apps.length ? <p>Configure a personal OAuth app below Connected accounts first.</p> : null}
      <Field label="Requested scopes"><textarea aria-label="Requested scopes" rows={4} value={scopes} disabled={busy}
        placeholder="One scope per line" onInput={(event) => { setScopes(event.currentTarget.value); setReviewed(false); }} /></Field>
      {connection ? <Impact connection={connection} groups={groups} /> : null}
      <p>All receiving agents share this upstream account and its actual permissions. Selecting services does
        not downscope a token or make it read-only. Requested scopes are not a guarantee of provider-granted
        scopes. A different account, issuer, resource or scope policy needs explicit review; scope expansion
        may suspend existing grants until reapproved. Use a separate connection for a different identity or scope profile.</p>
      <Review checked={reviewed} onChange={setReviewed}>I reviewed the upstream identity, resource, app,
        requested scopes and {connection ? 'affected agents' : 'shared-connection implications'}.</Review>
      {draft ? <p>A draft connection was saved. Retrying uses that same connection; it does not duplicate authorization.</p> : null}
      <ErrorNotice message={error} />
    </form>
  </CredentialDialog>;
}

export function ConnectionActionDialog({ connection, groups, action, onClose, onSaved }: {
  connection: Connection; groups: CredentialGroup[]; action: 'disable' | 'enable' | 'delete';
  onClose: () => void; onSaved: () => void;
}): JSX.Element {
  const latest = useCredentialResource<Connection>(connectionPath(connection.id));
  if (!latest.data || latest.loading || latest.error) return <CredentialDialog title="Review connection impact" onClose={onClose}>
    {latest.loading ? <p>Loading latest impact…</p> : <><ErrorNotice message={latest.error} />
      <button type="button" onClick={() => void latest.refresh()}>Retry</button></>}
  </CredentialDialog>;
  const current = latest.data;
  const deleting = action === 'delete';
  const title = deleting ? current.kind === 'static' ? 'Delete connection everywhere' : 'Disconnect everywhere' :
    action === 'disable' ? 'Disable connection everywhere' : 'Enable connection';
  return <ConfirmCredentialAction title={`${title} · ${current.label}`} label={title} onClose={onClose} onConfirm={async () => {
    await credentialRequest(connectionPath(current.id), deleting ? 'DELETE' : 'PUT',
      { revision: current.revision, ...(deleting ? {} : { enabled: action === 'enable' }) });
    onSaved();
    showToast(deleting ? 'Connection deleted everywhere' : `Connection ${action === 'enable' ? 'enabled' : 'disabled'}`);
  }}>
    <Impact connection={current} groups={groups} />
    <p>{deleting ? current.kind === 'static'
      ? 'Permanently remove this connection and its keys. Every receiving agent loses access.'
      : 'Delete this connection and disconnect the upstream authorization, affecting every receiving agent. Provider-side revocation may also affect other grants; failed remote cleanup is reported.'
      : action === 'disable' ? 'Stop every receiving agent from using this connection without deleting its saved state.'
        : 'Allow active, approved grants to use this connection again. Suspended grants still need review.'}</p>
  </ConfirmCredentialAction>;
}

export function ConnectionGrantsDialog({ connection, groups, onClose, onSaved, onlyGroup }: {
  connection: Connection; groups: CredentialGroup[]; onClose: () => void; onSaved: () => void; onlyGroup?: string;
}): JSX.Element {
  const latest = useCredentialResource<Connection>(connectionPath(connection.id));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [stale, setStale] = useState(false);
  const destinations = onlyGroup ? groups.filter((group) => group.id === onlyGroup) : [
    ...groups,
    ...(latest.data?.grants ?? []).filter((grant) => !groups.some((group) => group.id === grant.vault))
      .map((grant) => ({ id: grant.vault, name: grant.vault, canAdmin: false })),
  ];
  return <CredentialDialog title={`Agent access · ${connection.label}`} onClose={onClose} busy={busy} footer={<button type="button" disabled={busy} onClick={onClose}>Done</button>}>
    <p>You may attach your own connection only to an agent group you administer. Service selection shares
      the same upstream principal; it does not reduce token scopes or create read-only access.</p>
    {latest.loading ? <p>Loading latest grants…</p> : null}
    <ErrorNotice message={latest.error || error} />
    {stale ? <p role="alert">The connection changed. Close and reopen to review the current revision before reapproving.</p> : null}
    {latest.data && !latest.loading && !latest.error ? <>
      <Impact connection={latest.data} groups={groups} />
      {destinations.filter((group) => group.canAdmin || latest.data!.grants.some((grant) => grant.vault === group.id)).map((group) =>
        <ServiceGrantForm key={`${group.id}:${latest.data!.revision}:${JSON.stringify(latest.data!.grants)}`}
          connection={latest.data!} group={group} busy={busy || stale} onChange={async (services) => {
            setBusy(true);
            setError('');
            try {
              await credentialRequest(connectionPath(connection.id, `/grants/${encodeURIComponent(group.id)}`),
                services ? 'PUT' : 'DELETE', services ? { services, revision: latest.data!.revision } : undefined);
              onSaved();
              await latest.refresh();
              showToast(services ? 'Agent access approved' : 'Detached agent; upstream connection unchanged');
            } catch (error) {
              if (!(error instanceof CredentialsError || error instanceof TypeError)) throw error;
              setError(errorMessage(error));
              if (error instanceof Error && 'status' in error && (error.status === 412 || error.status === 409)) setStale(true);
            } finally { setBusy(false); }
          }} />)}
      {!destinations.some((group) => group.canAdmin) ? <p>No destination groups available for you to administer.</p> : null}
    </> : null}
  </CredentialDialog>;
}

function ServiceGrantForm({ connection, group, busy, onChange }: {
  connection: Connection; group: CredentialGroup; busy: boolean; onChange: (services: string[] | null) => Promise<void>;
}): JSX.Element {
  const grant = connection.grants.find((item) => item.vault === group.id);
  const [selected, setSelected] = useState((grant?.services ?? []).filter((name) =>
    connection.services.some((service) => service.name === name && service.enabled !== false)));
  const [reviewed, setReviewed] = useState(false);
  const [detaching, setDetaching] = useState(false);
  return <section class="ga-cred-grant">
    <strong>{group.name}</strong>{grant ? <span> · {grant.status}</span> : null}
    <fieldset disabled={busy} class="ga-cred-scope">
      <legend>Services available to this agent</legend>
      <div class="ga-cred-grant-services">{connection.services.map((service) => <label key={service.name}>
        <input type="checkbox" checked={selected.includes(service.name)} disabled={!group.canAdmin || service.enabled === false}
          onChange={(event) => {
            setSelected(event.currentTarget.checked ? [...selected, service.name] : selected.filter((name) => name !== service.name));
            setReviewed(false);
          }} /> {service.name} · {service.host}{service.path ?? ''}
      </label>)}</div>
      {group.canAdmin ? <>
        <Review checked={reviewed} onChange={setReviewed}>Approve these services and the current connection policy for {group.name} and its members.</Review>
        <button type="button" disabled={!reviewed || !selected.length || connection.status !== 'ready'} onClick={() => void onChange(selected)}>
          {grant ? 'Approve selected services' : 'Grant selected services'}
        </button>
        {connection.status !== 'ready' ? <p class="muted">The owner must finish connecting or enable this connection before granting access.</p> : null}
      </> : <p class="muted">You no longer administer this group. You can revoke its grant but cannot reapprove it.</p>}
      {grant ? <button type="button" class="danger" onClick={() => {
        if (!detaching) { setDetaching(true); return; }
        void onChange(null);
      }}>{detaching ? `Confirm detach ${group.name} only` : 'Detach agent access'}</button> : null}
      {detaching ? <p>Only {group.name} loses access. Other agents and upstream authorization remain unchanged.</p> : null}
    </fieldset>
  </section>;
}

const EMPTY_APP: OAuthAppConfiguration = {
  label: '', issuer: 'https://accounts.example.com', client_id: '',
  token_endpoint_auth_method: 'none', api_hosts: ['api.example.com'], default_scopes: [],
  identity: 'none', token_scope_separator: 'space',
};

export function OAuthAppDialog({ app, canEditInstall, connections, groups, onClose, onSaved }: {
  app?: AppInfo; canEditInstall: boolean; connections: Connection[]; groups: CredentialGroup[];
  onClose: () => void; onSaved: () => void;
}): JSX.Element {
  const [id, setId] = useState(app?.id ?? '');
  const [scope, setScope] = useState<OAuthAppScope>(app?.source ?? 'user');
  const [text, setText] = useState(JSON.stringify(app ? appConfiguration(app) : EMPTY_APP, null, 2));
  const [secret, setSecret] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [reviewed, setReviewed] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const affected = connections.filter((connection) => connection.app_id === (app?.id ?? id));
  const canSave = !busy && reviewed && !!id.trim() && (scope !== 'install' || canEditInstall);
  async function save(remove: boolean): Promise<void> {
    if (!canSave) return;
    setBusy(true);
    setError('');
    try {
      const body = remove ? undefined : { config: parseAppConfiguration(text), ...(secret ? { clientSecret: secret } : {}) };
      await credentialRequest(credentialsPath(`/oauth-apps/${encodeURIComponent(id.trim())}?scope=${scope}`), remove ? 'DELETE' : 'PUT', body);
      setSecret('');
      onSaved();
      onClose();
      showToast(remove ? 'OAuth app removed' : 'OAuth app saved');
    } catch (error) {
      if (!(error instanceof CredentialsError || error instanceof TypeError || error instanceof SyntaxError)) throw error;
      setError(errorMessage(error));
    }
    finally { setBusy(false); }
  }
  return <CredentialDialog title={app ? `Manage OAuth app · ${app.label}` : 'Configure OAuth app'} onClose={onClose} busy={busy} footer={<>
    <button type="button" disabled={busy} onClick={onClose}>Cancel</button>
    {app ? <button type="button" class="danger" disabled={!canSave} onClick={() => {
      if (!deleting) { setDeleting(true); return; }
      void save(true);
    }}>{deleting ? 'Confirm delete app' : 'Delete app'}</button> : null}
    <button type="button" class="primary" disabled={!canSave || deleting} onClick={() => void save(false)}>{busy ? 'Saving…' : 'Save app'}</button>
  </>}>
    <Field label="App ID"><input type="text" aria-label="App ID" disabled={busy || !!app} value={id} onInput={(event) => { setId(event.currentTarget.value); setReviewed(false); }} /></Field>
    <Field label="App ownership"><select aria-label="App ownership" value={scope} disabled={busy || !!app} onChange={(event) => { setScope(event.currentTarget.value as OAuthAppScope); setReviewed(false); }}>
      <option value="user">Personal app</option>{canEditInstall ? <option value="install">Install-wide app</option> : null}
    </select></Field>
    <Field label="Generic app config JSON"><textarea aria-label="Generic app config JSON" class="ga-cred-mono" rows={15} value={text} disabled={busy}
      spellcheck={false} onInput={(event) => { setText(event.currentTarget.value); setReviewed(false); }} /></Field>
    <p class="group-admin-help">Configure issuer or explicit authorization_endpoint / token_endpoint, approved api_hosts,
      default_scopes, authorization_params and identity discovery. Enter the NanoClaw callback URI
      {' '}<code>{`${location.origin}/oauth/callback`}</code> in your provider console. This is a generic app, not a provider permission catalog.</p>
    <Field label="Client secret" info={app?.client_secret_set ? 'A secret is configured. Blank preserves it.' : 'Required only for confidential clients; never returned after saving.'}>
      <SecretInput label="Client secret" value={secret} disabled={busy} placeholder={app?.client_secret_set ? 'Keep current secret' : 'New client secret'}
        onInput={(value) => { setSecret(value); setReviewed(false); }} />
    </Field>
    <div class="ga-cred-callout">
      <strong>Affected personal connections · {affected.length}</strong>
      {affected.map((connection) => <div key={connection.id}><p>{connection.label} · {connection.status}</p><Impact connection={connection} groups={groups} /></div>)}
      {scope === 'install' ? <p>Install-wide changes can also affect other users and agents not visible here.</p> : null}
      <p>Connections pin their issuing client. Saving a different client, issuer, host or scope policy does not
        automatically rebind existing connections. Secret rotation or deletion can prevent refresh and require reconnect.
        Review every affected connection before replacing or deleting an app.</p>
    </div>
    <Review checked={reviewed} onChange={setReviewed}>I reviewed the app policy, secret lifecycle and affected connections.</Review>
    {deleting ? <p role="alert">Delete this app configuration? Existing client bindings may stop refreshing; this does not detach one agent.</p> : null}
    <ErrorNotice message={error} />
  </CredentialDialog>;
}
