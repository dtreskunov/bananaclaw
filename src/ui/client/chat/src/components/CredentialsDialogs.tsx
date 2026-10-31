import { useEffect, useRef, useState } from 'preact/hooks';
import type { JSX, RefObject } from 'preact';
import {
  connectionPath, credentialRequest, credentialsPath, errorMessage, CredentialsError,
  providedValues, serviceKeys,
  type AppInfo, type Connection, type OAuthAppConfiguration,
  type OAuthAppScope, type Service, type SignInInput,
} from './CredentialsApi';
import {
  ConfirmCredentialAction, CredentialDialog, ErrorNotice,
  SecretInput, useCredentialResource,
} from './CredentialsParts';
import { GroupAdminField as Field } from './GroupAdminField';
import { showToast } from './Toast';
import { connectionName } from './credential-presentation';
import { accessCreationDefaults, compileRoutes, credentialFields, hostnameFromPattern, oauthResourceUrl, routingDrafts, sharedAuthentication, type RouteDraft } from './credential-routing';
import type { AccessRequirements } from '../../../../shared/access-authentication';
import { CredentialAuthenticationForm, CredentialServiceForm } from './CredentialServiceForm';
import { OAuthAppForm } from './OAuthAppForm';
import { compileOAuthApp, oauthAppDraft } from './oauth-app-form';
import { OAuthScopePicker, ScopeList } from './OAuthScopePicker';
import { scopeValues, validScopeSelection } from './oauth-scopes';

interface ConnectionEditorProps {
  id?: string; apps: AppInfo[]; initialKind?: Connection['kind']; resourceUrl?: string;
  accessRequest?: AccessRequirements;
  onCreated?: (connection: Connection) => void;
  onStart: (id: string, input: SignInInput) => Promise<void>; onClose: () => void; onSaved: () => void;
}

export function ConnectionEditor(props: ConnectionEditorProps): JSX.Element {
  return props.id ? <ExistingConnectionEditor {...props} id={props.id} /> : <ConnectionForm {...props} />;
}

function ExistingConnectionEditor({ id, ...props }: ConnectionEditorProps & { id: string }): JSX.Element {
  const { data, error, loading, refresh } = useCredentialResource<Connection>(connectionPath(id));
  if (loading || error || !data) return <CredentialDialog title="Load connection" onClose={props.onClose}>
    {loading ? <p>Loading latest connection metadata…</p> : <><ErrorNotice message={error} />
      <button type="button" onClick={() => void refresh()}>Retry</button></>}
  </CredentialDialog>;
  return <ConnectionForm {...props} key={`${data.id}:${data.revision}`} connection={data} />;
}

function ConnectionForm({ connection, apps, initialKind = 'static', resourceUrl, accessRequest, onCreated, onStart, onClose, onSaved }:
  ConnectionEditorProps & { connection?: Connection }): JSX.Element {
  const defaults = accessRequest ? accessCreationDefaults(accessRequest, apps) : undefined;
  const destination = resourceUrl ?? accessRequest?.resource_url;
  const [kind, setKind] = useState<Connection['kind']>(connection?.kind ?? defaults?.kind ?? initialKind);
  const [label, setLabel] = useState(connection ? connectionName(connection, apps) : hostnameFromPattern(destination ?? ''));
  const [automaticName, setAutomaticName] = useState(!connection);
  const [routes, setRoutes] = useState(() => {
    const result = !connection && defaults ? defaults.routes : routingDrafts(connection?.services);
    if (!connection && destination) result[0].pattern = destination;
    return result;
  });
  const [routingChanged, setRoutingChanged] = useState(false);
  const [auth, setAuth] = useState<Service['auth']>(() => {
    const value = structuredClone(connection?.services[0]?.auth ?? defaults?.routes[0].service.auth ?? routes[0].service.auth);
    if (value.type === 'api-key' && value.location !== 'query' && !value.header) value.header = 'Authorization';
    return value;
  });
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [stale, setStale] = useState(false);
  const [appId, setAppId] = useState(defaults?.appId ?? '');
  const [scopes, setScopes] = useState(defaults?.scopes.join('\n') ?? '');
  const [unspecifiedScopes, setUnspecifiedScopes] = useState(false);
  const [oauthDraft, setOauthDraft] = useState<Connection | null>(null);
  const firstUrl = useRef<HTMLInputElement>(null);
  useEffect(() => { if (!connection) firstUrl.current?.focus(); }, [kind]);
  const isStatic = kind === 'static';
  const creatingOAuth = !connection && !isStatic;
  const savedSubstitutions = connection?.services.flatMap(service => service.substitutions ?? []) ?? [];
  const savedKeys = [...new Set(savedSubstitutions.map(substitution => substitution.key))];
  const unsupported = !['bearer', 'api-key', 'basic', 'custom'].includes(auth.type);
  const preserving = !!connection && !routingChanged && (unsupported || savedSubstitutions.length > 0);
  const mixed = isStatic && !!connection && !sharedAuthentication(connection.services);
  let services: Service[] = [];
  let routingError = '';
  try { services = isStatic && !preserving ? compileRoutes(routes, auth) : connection?.services ?? []; }
  catch (error) {
    if (!(error instanceof CredentialsError)) throw error;
    routingError = errorMessage(error);
  }
  const drafts = routes.map((route) => route.service);
  const fields = isStatic ? credentialFields([{ auth, substitutions: preserving ? savedSubstitutions : undefined }]) : [];
  const keys = fields.map((field) => field.key);
  const knownKeys = [...new Set([...(connection?.credentials ?? []), ...serviceKeys(drafts), ...keys])];
  const supplied = providedValues(values, keys);
  const missingValues = keys.some((key) => !connection?.credentials.includes(key) && !supplied[key]);
  let resource = '';
  let oauthError = '';
  if (creatingOAuth && kind === 'mcp_oauth') {
    try { resource = oauthResourceUrl(routes[0].pattern); }
    catch (error) {
      if (!(error instanceof CredentialsError)) throw error;
      oauthError = errorMessage(error);
    }
  }
  const renamed = !connection || label.trim() !== connectionName(connection, apps);
  const canSave = !busy && !stale && !mixed && !!label.trim() && (creatingOAuth
    ? validScopeSelection(scopes, unspecifiedScopes) && (kind === 'mcp_oauth' ? !!resource : !!appId)
    : !routingError && !missingValues && (!connection || renamed || routingChanged || Object.keys(supplied).length > 0));
  const changeRoute = (index: number, route: RouteDraft): void => {
    setRoutes((old) => old.map((item, at) => at === index ? route : item));
    setRoutingChanged(true);
    if (index === 0 && automaticName) setLabel(hostnameFromPattern(route.pattern));
  };

  async function save(event: Event): Promise<void> {
    event.preventDefault();
    if (!canSave) return;
    setBusy(true);
    setError('');
    try {
      if (creatingOAuth) {
        const input: SignInInput = {
          ...(kind === 'mcp_oauth' ? { resource_url: resource } : {}),
          ...(appId ? { app_id: appId } : {}),
          scopes: scopeValues(scopes),
        };
        let target = oauthDraft;
        if (!target) {
          target = await credentialRequest<Connection>(credentialsPath('/connections'), 'POST', { label: label.trim(), kind, ...input });
          setOauthDraft(target);
          onCreated?.(target);
          onSaved();
        }
        await onStart(target.id, input);
        onSaved();
        onClose();
        return;
      }
      const saved = await credentialRequest<Connection>(connection ? connectionPath(connection.id) : credentialsPath('/connections'),
        connection ? 'PUT' : 'POST', {
          ...(renamed ? { label: label.trim() } : {}),
          ...(isStatic && (!connection || routingChanged) ? { services } : {}),
          ...(isStatic && Object.keys(supplied).length ? { values: supplied } : {}),
          ...(connection ? { revision: connection.revision } : { kind: 'static' }),
        });
      if (!connection) onCreated?.(saved);
      setValues({});
      showToast(connection ? 'Credential saved' : 'Credential created');
      onSaved();
      onClose();
    } catch (error) {
      if (!(error instanceof CredentialsError || error instanceof TypeError)) throw error;
      setError(errorMessage(error));
      if (error instanceof Error && 'status' in error && (error.status === 412 || error.status === 409)) setStale(true);
    } finally { setBusy(false); }
  }
  return <CredentialDialog title={connection ? `Edit ${connectionName(connection)}` : 'Add credential'} onClose={onClose} busy={busy} footer={<>
    <button type="button" disabled={busy} onClick={onClose}>Cancel</button>
    <button type="submit" form="personal-connection" class="primary" disabled={!canSave}>
      {busy ? creatingOAuth ? 'Starting…' : 'Saving…' : creatingOAuth ? oauthDraft ? 'Retry sign-in' : 'Start sign-in' : 'Save'}
    </button>
  </>}>
    <form id="personal-connection" onSubmit={save}>
      <input type="text" class="credential-name-input" aria-label="Credential name" placeholder="Credential name" value={label} disabled={busy || !!oauthDraft}
        onInput={(event) => { setLabel(event.currentTarget.value); setAutomaticName(false); }} />
      {!connection ? <Field label="Credential type"><select aria-label="Credential type" value={kind} disabled={busy || !!oauthDraft}
        onChange={(event) => {
          const next = event.currentTarget.value;
          if (next !== 'static' && next !== 'mcp_oauth' && next !== 'oauth_app') { showToast('Choose a credential type.', 'err'); return; }
          setKind(next);
          setScopes((next === 'static' ? [] : accessRequest?.scopes ?? (next === 'oauth_app' ? apps.find(app => app.id === appId)?.default_scopes ?? [] : [])).join('\n'));
          setUnspecifiedScopes(false);
          if (automaticName) setLabel(next === 'oauth_app' ? apps.find((app) => app.id === appId)?.label ?? '' : hostnameFromPattern(routes[0].pattern));
        }}>
        <option value="static">Key</option><option value="mcp_oauth">MCP server OAuth</option><option value="oauth_app">OAuth app</option>
      </select></Field> : null}
      {creatingOAuth ? <>
        <OAuthFields kind={kind === 'oauth_app' ? 'oauth_app' : 'mcp_oauth'} apps={apps} appId={appId}
          selectDiscovered={!oauthDraft}
          resource={routes[0].pattern} scopes={scopes} unspecifiedScopes={unspecifiedScopes} busy={busy} firstInput={firstUrl}
          onUnspecifiedScopes={setUnspecifiedScopes}
          onResource={(pattern) => changeRoute(0, { ...routes[0], pattern })}
          onApp={(id) => {
            setAppId(id);
            setUnspecifiedScopes(false);
            setScopes((accessRequest?.scopes ?? apps.find((app) => app.id === id)?.default_scopes ?? []).join('\n'));
            if (automaticName && kind === 'oauth_app') setLabel(apps.find((app) => app.id === id)?.label ?? '');
          }} onScopes={setScopes} />
        <ErrorNotice message={routes[0].pattern ? oauthError : ''} />
        {oauthDraft ? <p>A draft credential was saved. Retrying uses the same connection.</p> : null}
      </> : null}
      {isStatic ? <>
        <CredentialAuthenticationForm auth={auth} keys={knownKeys} busy={busy || mixed}
          preferredKey={savedKeys.length === 1 ? savedKeys[0] : undefined}
          savedLabel={preserving ? savedSubstitutions.length && savedSubstitutions.every(sub =>
            sub.in?.length === 1 && sub.in[0] === 'query') ? 'Saved query authentication' : 'Saved authentication' : undefined}
          onChange={value => { setAuth(value); setRoutingChanged(true); }} />
        {fields.map(({ key, label }) => <Field key={key} label={label}>
          <SecretInput label={label} value={values[key] ?? ''} disabled={busy} placeholder={connection?.credentials.includes(key) ? 'Keep current value' : 'New value'}
            onInput={value => setValues(old => ({ ...old, [key]: value }))} />
        </Field>)}
        {routes.map((route, index) => <CredentialServiceForm key={route.service.name} route={route} index={index}
          busy={busy || preserving || mixed} firstInput={index === 0 ? firstUrl : undefined} onChange={(value) => changeRoute(index, value)}
          onRemove={routes.length > 1 ? () => {
            setRoutes((old) => old.filter((_, at) => at !== index));
            setRoutingChanged(true);
            if (index === 0 && automaticName) setLabel(hostnameFromPattern(routes[1].pattern));
          } : undefined} />)}
        <button type="button" class="ghost" disabled={busy || preserving || mixed} onClick={() => {
          let number = routes.length + 1;
          while (routes.some((route) => route.service.name === `route-${number}`)) number++;
          const service = structuredClone(routes[0].service);
          service.name = `route-${number}`;
          setRoutes((old) => [...old, { service, pattern: '' }]);
          setRoutingChanged(true);
        }}>Add URL pattern</button>
        {mixed ? <ErrorNotice message="This saved credential uses different authentication per destination. Split it before editing." /> : null}
        <ErrorNotice message={routingError && routes.some((route) => route.pattern) ? routingError : ''} />
      </> : connection ? <>
        <p>{connection.resource_url ?? apps.find(app => app.id === connection.app_id)?.label ?? 'OAuth app unavailable'}</p>
        <fieldset class="credential-scope-picker"><legend>Scopes</legend>
          {connection.scope_source !== 'provider' || connection.granted_scopes == null ? <p class="muted">Not reported by the provider.</p> :
            connection.granted_scopes.length ? <ScopeList scopes={connection.granted_scopes} /> : <p class="muted">None.</p>}
        </fieldset>
      </> : null}
      <ErrorNotice message={error} />
      {stale ? <p role="alert">This connection changed or the operation conflicts. Close and reopen it to load the
        latest revision; your changes were not blindly overwritten.</p> : null}
    </form>
  </CredentialDialog>;
}

function OAuthFields({ kind, apps, resource, appId, scopes, unspecifiedScopes, busy, firstInput, onResource, onApp, onScopes, onUnspecifiedScopes, selectDiscovered = false }: {
  kind: 'mcp_oauth' | 'oauth_app'; apps: AppInfo[]; resource: string; appId: string; scopes: string; busy: boolean;
  firstInput?: RefObject<HTMLInputElement>; onResource: (value: string) => void; onApp: (value: string) => void; onScopes: (value: string) => void;
  unspecifiedScopes: boolean; onUnspecifiedScopes: (value: boolean) => void;
  selectDiscovered?: boolean;
}): JSX.Element {
  return <>
    {kind === 'mcp_oauth' ? <Field label="URL pattern"><input ref={firstInput} type="text" aria-label="URL pattern"
      value={resource} disabled={busy} placeholder="https://mcp.example.com/mcp" spellcheck={false}
      onInput={(event) => onResource(event.currentTarget.value)} /></Field> : null}
    <Field label="OAuth app"><select aria-label="OAuth app" value={appId} disabled={busy}
      onChange={(event) => onApp(event.currentTarget.value)}>
      <option value="">{kind === 'mcp_oauth' ? 'Automatic discovery / dynamic registration' : 'Select a configured app'}</option>
      {apps.map((app) => <option key={`${app.source}:${app.id}`} value={app.id}>{app.label} · {app.source === 'user' ? 'Personal' : 'Install'}</option>)}
    </select></Field>
    {kind === 'oauth_app' && !apps.length ? <p>Configure an app in the OAuth apps section first.</p> : null}
    <OAuthScopePicker resource={kind === 'mcp_oauth' ? resource : undefined} appId={appId}
      configured={apps.find(app => app.id === appId)?.default_scopes ?? []}
      value={scopes} onChange={onScopes} disabled={busy} unspecified={unspecifiedScopes} onUnspecified={onUnspecifiedScopes}
      selectDiscovered={selectDiscovered} />
  </>;
}

export function OAuthConnectionDialog({ connection, apps, onStart, onClose, onSaved }: {
  connection: Connection; apps: AppInfo[];
  onStart: (id: string, input: SignInInput) => Promise<void>; onClose: () => void; onSaved: () => void;
}): JSX.Element {
  const kind = connection.kind === 'oauth_app' ? 'oauth_app' : 'mcp_oauth';
  const [resource, setResource] = useState(connection.resource_url ?? '');
  const [app, setApp] = useState(connection.app_id ?? '');
  const [scopes, setScopes] = useState((connection.requested_scopes ?? []).join('\n'));
  const [unspecifiedScopes, setUnspecifiedScopes] = useState(!connection.requested_scopes?.length);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  let resourceUrl = '';
  let resourceError = '';
  if (kind === 'mcp_oauth') {
    try { resourceUrl = oauthResourceUrl(resource); }
    catch (error) {
      if (!(error instanceof CredentialsError)) throw error;
      resourceError = errorMessage(error);
    }
  }
  const canStart = !busy && validScopeSelection(scopes, unspecifiedScopes) && (kind === 'mcp_oauth' ? !!resourceUrl : !!app);
  async function start(event: Event): Promise<void> {
    event.preventDefault();
    if (!canStart) return;
    setBusy(true);
    setError('');
    try {
      const input: SignInInput = {
        ...(kind === 'mcp_oauth' ? { resource_url: resourceUrl } : {}),
        ...(app ? { app_id: app } : {}),
        scopes: scopeValues(scopes),
      };
      await onStart(connection.id, input);
      onSaved();
      onClose();
    } catch (error) {
      if (!(error instanceof CredentialsError || error instanceof TypeError)) throw error;
      setError(errorMessage(error));
    }
    finally { setBusy(false); }
  }
  return <CredentialDialog title={`Reconnect ${connectionName(connection, apps)}`} onClose={onClose} busy={busy} footer={<>
    <button type="button" disabled={busy} onClick={onClose}>Cancel</button>
    <button type="submit" form="personal-oauth" class="primary" disabled={!canStart}>{busy ? 'Starting…' : 'Start sign-in'}</button>
  </>}>
    <form id="personal-oauth" onSubmit={start}>
      <OAuthFields kind={kind} apps={apps} resource={resource} appId={app} scopes={scopes} busy={busy} unspecifiedScopes={unspecifiedScopes}
        onUnspecifiedScopes={setUnspecifiedScopes}
        onResource={setResource}
        onApp={(value) => {
          setApp(value);
          setUnspecifiedScopes(false);
          setScopes((apps.find((item) => item.id === value)?.default_scopes ?? []).join('\n'));
        }} onScopes={setScopes} />
      {resource && resourceError ? <ErrorNotice message={resourceError} /> : null}
      <ErrorNotice message={error} />
    </form>
  </CredentialDialog>;
}

export function ConnectionActionDialog({ connection, action, onClose, onSaved }: {
  connection: Connection; action: 'disable' | 'enable' | 'delete';
  onClose: () => void; onSaved: () => void;
}): JSX.Element {
  const latest = useCredentialResource<Connection>(connectionPath(connection.id));
  if (!latest.data || latest.loading || latest.error) return <CredentialDialog title="Load credential" onClose={onClose}>
    {latest.loading ? <p>Loading credential…</p> : <><ErrorNotice message={latest.error} />
      <button type="button" onClick={() => void latest.refresh()}>Retry</button></>}
  </CredentialDialog>;
  const current = latest.data;
  const deleting = action === 'delete';
  const title = deleting ? current.kind === 'static' ? 'Delete connection everywhere' : 'Disconnect everywhere' :
    action === 'disable' ? 'Disable connection everywhere' : 'Enable connection';
  return <ConfirmCredentialAction title={`${title} · ${connectionName(current)}`} label={title} onClose={onClose} onConfirm={async () => {
    await credentialRequest(connectionPath(current.id), deleting ? 'DELETE' : 'PUT',
      { revision: current.revision, ...(deleting ? {} : { enabled: action === 'enable' }) });
    onSaved();
    showToast(deleting ? 'Connection deleted everywhere' : `Connection ${action === 'enable' ? 'enabled' : 'disabled'}`);
  }}>
    <p>{deleting ? current.kind === 'static'
      ? 'Permanently remove this connection and its keys. Every receiving agent loses access.'
      : 'Delete this connection and disconnect the upstream authorization, affecting every receiving agent. Provider-side revocation may also affect other grants; failed remote cleanup is reported.'
      : action === 'disable' ? 'Stop every receiving agent from using this connection without deleting its saved state.'
        : 'Restore access for agents with this credential turned on. Paused grants stay off until explicitly restored.'}</p>
  </ConfirmCredentialAction>;
}

export function OAuthAppDialog({ app, canEditInstall, onClose, onSaved }: {
  app?: AppInfo; canEditInstall: boolean;
  onClose: () => void; onSaved: () => void;
}): JSX.Element {
  const [id] = useState(() => app?.id ?? `app-${crypto.randomUUID()}`);
  const [scope, setScope] = useState<OAuthAppScope>(app?.source ?? 'user');
  const [draft, setDraft] = useState(() => oauthAppDraft(app));
  const [secret, setSecret] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [deleting, setDeleting] = useState(false);
  let config: OAuthAppConfiguration | undefined;
  let validationError = '';
  try { config = compileOAuthApp(draft); }
  catch (error) {
    if (!(error instanceof CredentialsError)) throw error;
    validationError = errorMessage(error);
  }
  const canManage = !busy && !!id.trim() && (scope !== 'install' || canEditInstall);
  const canSave = canManage && !!config &&
    (draft.token_endpoint_auth_method === 'none' ? !secret : !!secret || !!app?.client_secret_set);
  const showValidation = !!app || [draft.label, draft.issuer, draft.client_id, secret].some(value => !!value.trim());
  async function save(remove: boolean): Promise<void> {
    if (remove ? !canManage : !canSave) return;
    setBusy(true);
    setError('');
    try {
      const body = remove ? undefined : { config, ...(secret ? { clientSecret: secret } : {}) };
      await credentialRequest(credentialsPath(`/oauth-apps/${encodeURIComponent(id.trim())}?scope=${scope}`), remove ? 'DELETE' : 'PUT', body);
      setSecret('');
      onSaved();
      onClose();
      showToast(remove ? 'OAuth app removed' : 'OAuth app saved');
    } catch (error) {
      if (!(error instanceof CredentialsError || error instanceof TypeError)) throw error;
      setError(errorMessage(error));
    }
    finally { setBusy(false); }
  }
  return <CredentialDialog title={app ? `Manage OAuth app · ${app.label}` : 'Configure OAuth app'} onClose={onClose} busy={busy} footer={<>
    <button type="button" disabled={busy} onClick={onClose}>Cancel</button>
    {app ? <button type="button" class="danger" disabled={!canManage} onClick={() => {
      if (!deleting) { setDeleting(true); return; }
      void save(true);
    }}>{deleting ? 'Confirm delete app' : 'Delete app'}</button> : null}
    <button type="button" class="primary" disabled={!canSave || deleting} onClick={() => void save(false)}>{busy ? 'Saving…' : 'Save app'}</button>
  </>}>
    <Field label="App ownership"><select aria-label="App ownership" value={scope} disabled={busy || !!app} onChange={(event) => setScope(event.currentTarget.value as OAuthAppScope)}>
      <option value="user">Personal app</option>{canEditInstall ? <option value="install">Install-wide app</option> : null}
    </select></Field>
    <OAuthAppForm draft={draft} busy={busy} onChange={setDraft} selectDiscovered={!app} />
    <Field label="Client secret" info={app?.client_secret_set ? 'A secret is configured. Blank preserves it.' : 'Required only for confidential clients; never returned after saving.'}>
      <SecretInput label="Client secret" value={secret} disabled={busy} placeholder={app?.client_secret_set ? 'Keep current secret' : 'New client secret'}
        onInput={setSecret} />
    </Field>
    <ErrorNotice message={showValidation ? validationError ||
      (draft.token_endpoint_auth_method === 'none' && secret ? 'Public clients must not have a client secret.' :
        draft.token_endpoint_auth_method !== 'none' && !secret && !app?.client_secret_set ? 'Enter a client secret.' : '') : ''} />
    {deleting ? <p role="alert">Delete this app configuration? Existing client bindings may stop refreshing; this does not detach one agent.</p> : null}
    <ErrorNotice message={error} />
  </CredentialDialog>;
}
