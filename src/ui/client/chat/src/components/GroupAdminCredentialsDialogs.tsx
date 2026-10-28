// Dialogs for group settings → Credentials (R1).
import { useEffect, useState } from 'preact/hooks';
import type { JSX } from 'preact';

import { call, errMsg } from './GroupAdminApi';
import {
  credPath,
  type AccountStartInput,
  type DestinationDto,
  type InjectionDto,
  type InjectionType,
  type KeyDto,
  type KeyPresetDto,
  type McpAuthDto,
  type OAuthAppDto,
  type OAuthAppScope,
} from './GroupAdminCredentialsApi';
import { KEY_NAME_RE, SecretInput, ago, useEscapeClose } from './GroupAdminCredentialsParts';
import { GroupAdminField as Field } from './GroupAdminField';
import { MobileDialog, MobileDialogFooter, MobileDialogItem, MobileDialogList } from './MobileDialog';
import { showToast } from './Toast';

const INJECTION_LABELS: Record<InjectionType, string> = {
  bearer: 'Bearer token (Authorization header)',
  basic: 'Basic auth, key as username (Authorization header)',
  'api-key': 'Named header',
  query: 'Replace a placeholder in the URL query',
  custom: 'Header template',
};

function toKeyName(label: string): string {
  const base = label.trim().toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  if (!base) return '';
  const name = /^[A-Z]/.test(base) ? base : `KEY_${base}`;
  return name.endsWith('_KEY') || name.endsWith('_TOKEN') ? name : `${name}_KEY`;
}

async function send(url: string, method: string, body: unknown, success: string): Promise<boolean> {
  const r = await call(url, method, body);
  if (!r.ok) {
    showToast(errMsg(r.data, `HTTP ${r.status}`), 'err');
    return false;
  }
  showToast(success);
  return true;
}

function Footer({ children }: { children: JSX.Element | (JSX.Element | null)[] }): JSX.Element {
  return <MobileDialogFooter className="ga-confirm-foot ga-cred-foot">{children}</MobileDialogFooter>;
}

export function KeySetDialog({ gid, targetOnly = false, name, onClose, onSaved }: {
  gid: string;
  targetOnly?: boolean;
  name?: string;
  onClose: () => void;
  onSaved: () => void;
}): JSX.Element {
  const [info, setInfo] = useState<{ keys: string[]; revision: string; service: unknown } | null>(null);
  const [loadError, setLoadError] = useState('');
  const [stale, setStale] = useState(false);
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [names, setNames] = useState('KEY_ONE, KEY_TWO');
  const [values, setValues] = useState<Record<string, string>>({});
  const [text, setText] = useState(JSON.stringify({
    name: 'new-service', host: 'api.example.com',
    auth: { type: 'custom', headers: { Authorization: 'Bearer {{ KEY_ONE }}', 'x-api-key': '{{ KEY_TWO }}' } },
  }, null, 2));
  useEscapeClose(onClose, busy);
  useEffect(() => {
    if (!name) return;
    let active = true;
    void (async () => {
      const r = await call<{ keys: string[]; revision: string; service: unknown }>(credPath(gid, `/key-sets/${encodeURIComponent(name)}`, targetOnly));
      if (!active) return;
      if (!r.ok) setLoadError(errMsg(r.data, `HTTP ${r.status}`));
      else { setInfo(r.data); setText(JSON.stringify(r.data.service, null, 2)); }
    })();
    return () => { active = false; };
  }, [gid, name, targetOnly]);
  const keys = info?.keys ?? [...new Set(names.split(/[\s,]+/).filter(Boolean))];
  const ready = !busy && !loadError && !stale && (!name || !!info);
  const canSave = ready && keys.length > 0 && keys.length <= 64 && (!!name || keys.every((key) => !!values[key]));
  const path = credPath(gid, name ? `/key-sets/${encodeURIComponent(name)}` : '/key-sets', targetOnly);

  async function change(method: 'POST' | 'PUT' | 'DELETE', body: unknown): Promise<void> {
    setBusy(true);
    const r = await call(path, method, body);
    setBusy(false);
    if (!r.ok) {
      if (r.status === 412) setStale(true);
      showToast(errMsg(r.data, `HTTP ${r.status}`), 'err');
      return;
    }
    showToast(method === 'DELETE' ? 'Deleted the entire key set' : 'Saved key set atomically');
    onSaved();
    onClose();
  }
  async function save(event: Event): Promise<void> {
    event.preventDefault();
    if (!canSave) return;
    let service: unknown;
    try { service = JSON.parse(text); }
    catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      showToast('Provide valid service JSON. Put values only in the separate password fields.', 'err');
      return;
    }
    await change(name ? 'PUT' : 'POST', {
      service, revision: info?.revision,
      values: Object.fromEntries(keys.filter((key) => !!values[key]).map((key) => [key, values[key]])),
    });
  }
  return (
    <MobileDialog title={name ? `Manage ${name}` : 'Create atomic key set'} onClose={onClose} maxWidth="680px" className="ga-cred-dialog" closeDisabled={busy}>
      <form id="ga-cred-set" class="settings-body ga-cred-dialog-body" onSubmit={save}>
        <p class="group-admin-help">One service and its exclusive keys are saved or deleted together. Values remain write-only. Existing keys or services are never overwritten by creation.</p>
        {loadError ? <p role="alert">{loadError}</p> : null}
        {stale ? <p role="alert">This set changed elsewhere. Close and reopen it to review the current routing before trying again.</p> : null}
        {name && !info && !loadError ? <p>Loading metadata...</p> : null}
        {!name ? <Field label="Referenced key names" info="Comma-separated names. They must match the service's credential references.">
          <input value={names} disabled={busy} onInput={(e) => setNames(e.currentTarget.value)} />
        </Field> : null}
        <Field label="Service routing JSON" info="Safe configuration only, never credential values. Set membership and name cannot be changed by an edit.">
          <textarea class="ga-cred-mono" rows={12} value={text} disabled={!ready} spellcheck={false} onInput={(e) => setText(e.currentTarget.value)} />
        </Field>
        {keys.map((key) => <Field key={key} label={key} info={name ? 'Leave blank to preserve its current value.' : 'Required for creation.'}>
          <SecretInput value={values[key] ?? ''} disabled={!ready} placeholder={name ? 'Keep current value' : 'New value'} onInput={(value) => setValues((old) => ({ ...old, [key]: value }))} />
        </Field>)}
        {confirmDelete ? <p role="alert">Delete this service and all {keys.length} keys? This cannot be undone.</p> : null}
      </form>
      <Footer>
        <button type="button" disabled={busy} onClick={onClose}>Cancel</button>
        {name ? <button type="button" class="danger" disabled={!ready} onClick={async () => {
          if (!confirmDelete) { setConfirmDelete(true); return; }
          await change('DELETE', { revision: info!.revision });
        }}>{confirmDelete ? 'Confirm delete entire set' : 'Delete entire set'}</button> : null}
        <button type="submit" form="ga-cred-set" class="primary" disabled={!canSave}>{busy ? 'Saving...' : name ? 'Save atomically' : 'Create only'}</button>
      </Footer>
    </MobileDialog>
  );
}

export function ConfirmDialog({
  title,
  children,
  confirmLabel,
  danger,
  onConfirm,
  onClose,
}: {
  title: string;
  children: JSX.Element | JSX.Element[] | string;
  confirmLabel: string;
  danger?: boolean;
  onConfirm: () => Promise<boolean>;
  onClose: () => void;
}): JSX.Element {
  const [busy, setBusy] = useState(false);
  useEscapeClose(onClose, busy);
  return (
    <MobileDialog title={title} onClose={onClose} maxWidth="440px" className="ga-confirm-modal" closeDisabled={busy}>
      <div class="settings-body ga-cred-dialog-body">{children}</div>
      <Footer>
        <button type="button" disabled={busy} onClick={onClose}>Cancel</button>
        <button
          type="button"
          class={danger ? 'danger' : 'primary'}
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            const ok = await onConfirm();
            setBusy(false);
            if (ok) onClose();
          }}
        >
          {confirmLabel}
        </button>
      </Footer>
    </MobileDialog>
  );
}

/** Where a key is sent and how; shared by the add and edit dialogs. */
function DestinationFields({
  keyName,
  value,
  onChange,
}: {
  keyName: string;
  value: DestinationDto;
  onChange: (next: DestinationDto) => void;
}): JSX.Element {
  const injection = value.injection;
  const setInjection = (next: InjectionDto): void => onChange({ ...value, injection: next });
  return (
    <>
      <Field label="Send it to" info="Host, optionally with a port and a path pattern, e.g. api.example.com/v1/*. The key is only ever sent to matching requests.">
        <input type="text" class="ga-cred-mono" value={value.match} spellcheck={false} placeholder="api.example.com" onInput={(event) => onChange({ ...value, match: event.currentTarget.value })} />
      </Field>
      <Field label="How it's sent" info="How the gateway attaches the key to matching requests. Whatever the agent puts in this slot is replaced.">
        <select
          value={injection.type}
          onChange={(event) => {
            const next = event.currentTarget.value as InjectionType;
            setInjection({
              type: next,
              name: next === 'api-key' ? injection.name || 'X-API-Key' : next === 'query' ? injection.name || `__${keyName || 'KEY'}__` : undefined,
              template: next === 'custom' ? injection.template || `Basic {{ ${keyName || 'KEY'} }}` : undefined,
            });
          }}
        >
          {(Object.keys(INJECTION_LABELS) as InjectionType[]).map((t) => (
            <option key={t} value={t}>{INJECTION_LABELS[t]}</option>
          ))}
        </select>
      </Field>
      {injection.type === 'api-key' || injection.type === 'query' ? (
        <Field
          label={injection.type === 'query' ? 'Placeholder' : 'Header'}
          info={injection.type === 'query' ? 'The agent or MCP server URL uses this text where the key goes, e.g. ?apiKey=__MY_KEY__; the gateway swaps in the real key.' : undefined}
        >
          <input type="text" value={injection.name ?? ''} spellcheck={false} onInput={(event) => setInjection({ ...injection, name: event.currentTarget.value })} />
        </Field>
      ) : null}
      {injection.type === 'api-key' ? (
        <Field label="Prefix" info="Text placed before the key, e.g. “Token ”.">
          <input type="text" value={injection.prefix ?? ''} spellcheck={false} placeholder="none" onInput={(event) => setInjection({ ...injection, prefix: event.currentTarget.value })} />
        </Field>
      ) : null}
      {injection.type === 'custom' ? (
        <Field label="Header" info="Write the full Authorization header; {{ KEY_NAME }} is replaced by the key.">
          <input type="text" value={injection.template ?? ''} spellcheck={false} onInput={(event) => setInjection({ ...injection, template: event.currentTarget.value })} />
        </Field>
      ) : null}
    </>
  );
}

function destinationValid(value: DestinationDto): boolean {
  const i = value.injection;
  if (!value.match.trim()) return false;
  if ((i.type === 'api-key' || i.type === 'query') && !i.name?.trim()) return false;
  return i.type !== 'custom' || !!i.template?.includes('{{');
}

export function AddKeyDialog({
  gid,
  targetOnly = false,
  presets,
  existingKeys,
  initialMatch,
  onExisting,
  onClose,
  onSaved,
}: {
  gid: string;
  targetOnly?: boolean;
  presets: KeyPresetDto[];
  existingKeys: string[];
  /** Host pattern to start from, e.g. when adding a key for an MCP server. */
  initialMatch?: string;
  /** Called instead of adding when the chosen preset's key already exists. */
  onExisting: (key: string) => void;
  onClose: () => void;
  onSaved: () => void;
}): JSX.Element {
  const [preset, setPreset] = useState<KeyPresetDto | 'custom' | null>(null);
  const [label, setLabel] = useState('');
  const [key, setKey] = useState('');
  const [keyTouched, setKeyTouched] = useState(false);
  const [value, setValue] = useState('');
  const [destination, setDestination] = useState<DestinationDto>({ match: '', injection: { type: 'bearer' } });
  const [busy, setBusy] = useState(false);
  useEscapeClose(onClose, busy);

  function pick(next: KeyPresetDto | 'custom'): void {
    setPreset(next);
    setLabel(next === 'custom' ? '' : next.label);
    setKey(next === 'custom' ? '' : next.key);
    setDestination(next === 'custom' ? { match: '', injection: { type: 'bearer' } } : next.destination);
    setKeyTouched(false);
  }

  useEffect(() => {
    if (!initialMatch) return;
    const host = initialMatch.split('/')[0];
    const match = presets.find((p) => p.destination.match.split('/')[0] === host && !existingKeys.includes(p.key));
    pick(match ?? 'custom');
    if (!match) setDestination({ match: initialMatch, injection: { type: 'bearer' } });
  }, []);

  if (!preset) {
    return (
      <MobileDialog title="Add a key" onClose={onClose} maxWidth="520px" className="ga-cred-dialog">
        <div class="settings-body ga-cred-dialog-body">
          <p class="group-admin-help">Pick the service the key is for. The agent will be able to use it but never read it.</p>
        </div>
        <MobileDialogList className="ga-cred-preset-list">
          {presets.map((p) => (
            existingKeys.includes(p.key) ? (
              <MobileDialogItem key={p.id} label={p.label} sublabel={`Already added (${p.key}) · replace its value`} chevron onClick={() => onExisting(p.key)} />
            ) : (
              <MobileDialogItem key={p.id} label={p.label} sublabel={p.destination.match} chevron onClick={() => pick(p)} />
            )
          ))}
          <MobileDialogItem label="Another service" sublabel="Any host; choose how the key is sent" chevron onClick={() => pick('custom')} />
        </MobileDialogList>
      </MobileDialog>
    );
  }

  const keyInvalid = key !== '' && !KEY_NAME_RE.test(key);
  const keyDuplicate = existingKeys.includes(key);
  const canSave = !busy && label.trim() !== '' && key !== '' && !keyInvalid && !keyDuplicate && value !== '' && destinationValid(destination);

  async function save(event: Event): Promise<void> {
    event.preventDefault();
    if (!canSave) return;
    setBusy(true);
    const ok = await send(credPath(gid, '/keys', targetOnly), 'POST', { key, label: label.trim(), value, destination: { ...destination, match: destination.match.trim() } }, `Saved ${label.trim()}`);
    setBusy(false);
    if (ok) {
      onSaved();
      onClose();
    }
  }

  const obtain = preset !== 'custom' ? preset : null;
  return (
    <MobileDialog
      title={preset === 'custom' ? 'Add a key' : `Add ${preset.label} key`}
      onClose={onClose}
      onBack={() => setPreset(null)}
      backLabel="Back to services"
      maxWidth="560px"
      className="ga-cred-dialog"
      closeDisabled={busy}
    >
      <form id="ga-cred-add-key" class="settings-body ga-cred-dialog-body" onSubmit={save}>
        {obtain?.obtainUrl || obtain?.hint ? (
          <p class="group-admin-help">
            {obtain.hint ? `${obtain.hint} ` : null}
            {obtain.obtainUrl ? <a href={obtain.obtainUrl} target="_blank" rel="noopener noreferrer">Get a key ↗</a> : null}
          </p>
        ) : null}
        <Field label="Name">
          <input type="text" value={label} placeholder="e.g. Weather API" onInput={(event) => {
            const next = event.currentTarget.value;
            setLabel(next);
            if (!keyTouched && preset === 'custom') setKey(toKeyName(next));
          }} />
        </Field>
        <Field label="Key name" info="How this key is referred to, e.g. in header templates. Upper case, digits and underscores.">
          <input type="text" class="ga-cred-mono" value={key} spellcheck={false} onInput={(event) => {
            setKeyTouched(true);
            setKey(event.currentTarget.value.toUpperCase());
          }} />
        </Field>
        {keyInvalid ? <p class="ga-cred-error">Use upper case letters, digits and underscores, starting with a letter.</p> : null}
        {keyDuplicate ? <p class="ga-cred-error">This group already has {key}. Use Replace on that key instead.</p> : null}
        <Field label="Value">
          <SecretInput value={value} onInput={setValue} autoFocus={preset !== 'custom'} />
        </Field>
        <p class="group-admin-help ga-cred-field-help">Stored encrypted by the credential gateway. Nobody can view it after saving; you can only replace it.</p>
        <DestinationFields keyName={key} value={destination} onChange={setDestination} />
      </form>
      <Footer>
        <button type="button" disabled={busy} onClick={onClose}>Cancel</button>
        <button type="submit" form="ga-cred-add-key" class="primary" disabled={!canSave}>{busy ? 'Saving…' : 'Save key'}</button>
      </Footer>
    </MobileDialog>
  );
}

export function ReplaceKeyDialog({
  gid,
  targetOnly = false,
  item,
  onClose,
  onSaved,
}: {
  gid: string;
  targetOnly?: boolean;
  item: KeyDto;
  onClose: () => void;
  onSaved: () => void;
}): JSX.Element {
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  useEscapeClose(onClose, busy);
  const verb = item.status === 'needs_value' ? 'Set' : 'Replace';

  async function save(event: Event): Promise<void> {
    event.preventDefault();
    if (!value) return;
    setBusy(true);
    const ok = await send(credPath(gid, `/keys/${encodeURIComponent(item.key)}`, targetOnly), 'PUT', { value }, `Updated ${item.label}`);
    setBusy(false);
    if (ok) {
      onSaved();
      onClose();
    }
  }

  return (
    <MobileDialog title={`${verb} ${item.label}`} onClose={onClose} maxWidth="480px" className="ga-cred-dialog" closeDisabled={busy}>
      <form id="ga-cred-replace" class="settings-body ga-cred-dialog-body" onSubmit={save}>
        <p class="group-admin-help"><code>{item.key}</code>{item.status === 'set' && item.updatedAt ? ` · current value set ${ago(item.updatedAt)}` : ''}</p>
        <Field label="New value">
          <SecretInput value={value} onInput={setValue} autoFocus />
        </Field>
      </form>
      <Footer>
        <button type="button" disabled={busy} onClick={onClose}>Cancel</button>
        <button type="submit" form="ga-cred-replace" class="primary" disabled={busy || !value}>{busy ? 'Saving…' : verb}</button>
      </Footer>
    </MobileDialog>
  );
}

export function EditKeyDialog({
  gid,
  targetOnly = false,
  item,
  onClose,
  onSaved,
}: {
  gid: string;
  targetOnly?: boolean;
  item: KeyDto;
  onClose: () => void;
  onSaved: () => void;
}): JSX.Element {
  const [label, setLabel] = useState(item.label);
  const [destination, setDestination] = useState<DestinationDto>(item.destination);
  const [busy, setBusy] = useState(false);
  useEscapeClose(onClose, busy);
  const dirty = label.trim() !== item.label || JSON.stringify(destination) !== JSON.stringify(item.destination);
  const canSave = !busy && dirty && label.trim() !== '' && destinationValid(destination);

  async function save(event: Event): Promise<void> {
    event.preventDefault();
    if (!canSave) return;
    setBusy(true);
    const ok = await send(credPath(gid, `/keys/${encodeURIComponent(item.key)}`, targetOnly), 'PUT', {
      label: label.trim(),
      destination: { ...destination, match: destination.match.trim() },
    }, `Updated ${label.trim()}`);
    setBusy(false);
    if (ok) {
      onSaved();
      onClose();
    }
  }

  return (
    <MobileDialog title={`Edit ${item.label}`} onClose={onClose} maxWidth="560px" className="ga-cred-dialog" closeDisabled={busy}>
      <form id="ga-cred-edit" class="settings-body ga-cred-dialog-body" onSubmit={save}>
        <p class="group-admin-help"><code>{item.key}</code> · the value stays as it is.</p>
        <Field label="Name">
          <input type="text" value={label} onInput={(event) => setLabel(event.currentTarget.value)} />
        </Field>
        <DestinationFields keyName={item.key} value={destination} onChange={setDestination} />
      </form>
      <Footer>
        <button type="button" disabled={busy} onClick={onClose}>Cancel</button>
        <button type="submit" form="ga-cred-edit" class="primary" disabled={!canSave}>{busy ? 'Saving…' : 'Save'}</button>
      </Footer>
    </MobileDialog>
  );
}

export function OAuthAppDialog({
  gid,
  targetOnly = false,
  app,
  scope: fixedScope,
  canEditInstall,
  redirectUri,
  issuer,
  onClose,
  onSaved,
}: {
  gid: string;
  targetOnly?: boolean;
  app: OAuthAppDto;
  /** Which app to edit; when omitted, an owner chooses (defaulting to install-wide). */
  scope?: OAuthAppScope;
  canEditInstall: boolean;
  redirectUri: string;
  issuer?: string;
  onClose: () => void;
  onSaved: () => void;
}): JSX.Element {
  const [scope, setScope] = useState<OAuthAppScope>(fixedScope ?? (canEditInstall && !app.install ? 'install' : 'group'));
  const existing = scope === 'install' ? app.install : app.group;
  const [appId, setAppId] = useState(app.id);
  const initialConfig = () => JSON.stringify(existing?.config ?? (app.install ?? app.group)?.config ?? {
    label: app.label === 'New app' ? '' : app.label,
    issuer: issuer ?? (app.install ?? app.group)?.config.issuer ?? '',
    client_id: '',
    token_endpoint_auth_method: 'client_secret_post',
    authorization_endpoint: '',
    token_endpoint: '',
    api_hosts: [],
    default_scopes: [],
    authorization_params: {},
    identity: 'none',
    token_scope_separator: 'space',
  }, null, 2);
  const [configText, setConfigText] = useState(initialConfig);
  const [secret, setSecret] = useState('');
  const [busy, setBusy] = useState(false);
  useEscapeClose(onClose, busy);
  useEffect(() => { setConfigText(initialConfig()); setSecret(''); }, [scope]);
  let config: unknown;
  let configError = '';
  try {
    config = JSON.parse(configText);
    if (!config || typeof config !== 'object' || Array.isArray(config)) configError = 'Configuration must be a JSON object.';
    else if ('client_secret' in config) configError = 'Use the separate client-secret field, not the configuration JSON.';
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    configError = 'Configuration must be valid JSON.';
  }
  const id = appId.trim();
  const canSave = !busy && !configError && /^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/.test(id);
  const choosing = fixedScope === undefined && canEditInstall && !app.install && !app.group;

  async function save(event: Event): Promise<void> {
    event.preventDefault();
    if (!canSave) return;
    setBusy(true);
    const ok = await send(
      credPath(gid, `/oauth-apps/${encodeURIComponent(id)}`, targetOnly),
      'PUT',
      secret ? { scope, config, clientSecret: secret } : { scope, config },
      `Saved the ${app.label} app`,
    );
    setBusy(false);
    if (ok) onSaved();
  }

  function copy(): void {
    navigator.clipboard.writeText(redirectUri).then(
      () => showToast('Copied the redirect URI'),
      () => showToast('Couldn’t copy; select the URI and copy it', 'err'),
    );
  }

  const title = existing
    ? `${app.label} app · ${scope === 'install' ? 'all groups' : 'this group'}`
    : scope === 'group' && app.install
      ? `Use a different ${app.label} app here`
      : `Set up ${app.label}`;

  return (
    <MobileDialog title={title} onClose={onClose} maxWidth="560px" className="ga-cred-dialog" closeDisabled={busy}>
      <form id="ga-cred-oauth-app" class="settings-body ga-cred-dialog-body" onSubmit={save}>
        {existing ? null : (
          <ol class="ga-cred-steps group-admin-help">
            <li>Create an OAuth client with your authorization server.</li>
            <li>Add the redirect URI below as an authorized redirect URI.</li>
            <li>Paste the client ID and secret here.</li>
          </ol>
        )}
        {choosing ? (
          <fieldset class="ga-cred-scope">
            <legend>Use it in</legend>
            <label class="group-admin-check">
              <input type="radio" name="ga-cred-app-scope" checked={scope === 'install'} onChange={() => setScope('install')} />
              <span>All groups <span class="ga-cred-choice-note">Recommended. Each group connects its own accounts; tokens stay in each group.</span></span>
            </label>
            <label class="group-admin-check">
              <input type="radio" name="ga-cred-app-scope" checked={scope === 'group'} onChange={() => setScope('group')} />
              <span>Only this group</span>
            </label>
          </fieldset>
        ) : null}
        <Field label="Redirect URI">
          <div class="ga-cred-copy">
            <code>{redirectUri}</code>
            <button type="button" onClick={copy}>Copy</button>
          </div>
        </Field>
        <Field label="App ID">
          <input type="text" aria-label="App ID" class="ga-cred-mono" value={appId} disabled={Boolean(app.id)} spellcheck={false} autoFocus={!app.id} onInput={(event) => setAppId(event.currentTarget.value)} />
        </Field>
        <Field label="OAuth configuration (JSON)">
          <textarea aria-label="OAuth configuration (JSON)" class="ga-cred-mono" rows={16} value={configText} spellcheck={false} onInput={(event) => setConfigText(event.currentTarget.value)} />
        </Field>
        {configError ? <p role="alert" class="ga-cred-error">{configError}</p> : null}
        <p class="group-admin-help">
          Configure issuer, client_id, authorization_endpoint, token_endpoint, exact api_hosts and default_scopes.
          MCP-only apps can omit OAuth endpoints and API hosts. Optional fields include authorization_params,
          revocation_endpoint, identity (none, oidc, google or github), jwks_uri and token_scope_separator (space or comma).
          Public clients use token_endpoint_auth_method: "none"; confidential clients use client_secret_post or client_secret_basic.
        </p>
        <Field label="Client secret">
          <SecretInput value={secret} onInput={setSecret} placeholder={existing ? 'Leave empty to keep the current secret' : 'Paste the secret'} />
        </Field>
        <p class="group-admin-help ga-cred-field-help">
          {scope === 'install'
            ? 'Every group without its own app uses this client. '
            : app.install
              ? 'Only this group uses this client, instead of the install-wide app. '
              : 'Only this group uses this client. '}
          The secret is stored in the gateway and can't be viewed again.
          {existing ? ` Current client set ${ago(existing.updatedAt)}.` : ''}
          {existing ? ' Changing the issuer, client ID, OAuth endpoints or token-auth method disconnects accounts issued by this app source and requires a supplied confidential-client secret. Other configuration changes apply to new sign-ins.' : ''}
        </p>
      </form>
      <Footer>
        <button type="button" disabled={busy} onClick={onClose}>Cancel</button>
        <button type="submit" form="ga-cred-oauth-app" class="primary" disabled={!canSave}>{busy ? 'Saving…' : 'Save'}</button>
      </Footer>
    </MobileDialog>
  );
}

function appReady(app: OAuthAppDto): boolean { return Boolean(app.group ?? app.install); }

export function ConnectAccountDialog({
  apps,
  mcp,
  canEdit,
  provider,
  reconnect,
  onSetUp,
  onStart,
  onClose,
}: {
  apps: OAuthAppDto[];
  mcp: McpAuthDto[];
  canEdit: boolean;
  /** Opens straight to this provider's access choices. */
  provider?: string;
  reconnect?: { provider: string; key: string; scopes: string[] };
  onSetUp: (app: OAuthAppDto, issuer?: string) => void;
  onStart: (input: AccountStartInput) => Promise<boolean>;
  onClose: () => void;
}): JSX.Element {
  const initial = reconnect?.provider ?? provider;
  const [app, setApp] = useState<OAuthAppDto | null>(() => (initial ? apps.find((a) => a.id === initial) ?? null : null));
  const [scopes, setScopes] = useState<string>(() => (reconnect?.scopes ?? (app?.group ?? app?.install)?.config.default_scopes ?? []).join('\n'));
  const [mcpChoice, setMcpChoice] = useState<McpAuthDto | null>(null);
  const [busy, setBusy] = useState(false);
  useEscapeClose(onClose, busy);
  const mcpSignIns = mcp.filter((m) => m.auth === 'oauth');

  if (mcpChoice) {
    const candidates = apps.filter((a) => !mcpChoice.issuer || (a.group ?? a.install)?.config.issuer === mcpChoice.issuer);
    return (
      <MobileDialog title={`Choose an app for ${mcpChoice.server}`} onClose={onClose} onBack={() => setMcpChoice(null)}>
        <MobileDialogList>
          {candidates.map((a) => <MobileDialogItem key={a.id} label={a.label} sublabel={a.id} onClick={() => void begin({ mcpServer: mcpChoice.server, appId: a.id })} />)}
        </MobileDialogList>
      </MobileDialog>
    );
  }

  async function begin(input: AccountStartInput): Promise<void> {
    setBusy(true);
    const ok = await onStart(input);
    setBusy(false);
    if (ok) onClose();
  }

  if (!app) {
    return (
      <MobileDialog title="Connect an account" onClose={onClose} maxWidth="520px" className="ga-cred-dialog">
        <div class="settings-body ga-cred-dialog-body">
          <p class="group-admin-help">You'll sign in with the provider in a new window. The agent can then use the account through the gateway, without seeing its tokens.</p>
        </div>
        <MobileDialogList className="ga-cred-preset-list">
          {apps.filter((a) => {
            const c = (a.group ?? a.install)?.config;
            return c?.authorization_endpoint && c.token_endpoint && c.api_hosts.length;
          }).map((a) => (
            <MobileDialogItem
              key={a.id}
              label={a.label}
              sublabel={(a.group ?? a.install)?.config.issuer}
              chevron={appReady(a) || canEdit}
              onClick={() => { setApp(a); setScopes((a.group ?? a.install)!.config.default_scopes.join('\n')); }}
            />
          ))}
        </MobileDialogList>
        {mcpSignIns.length ? (
          <>
            <div class="settings-body ga-cred-dialog-body ga-cred-dialog-subhead"><h4>MCP servers</h4></div>
            <MobileDialogList className="ga-cred-preset-list">
              {mcpSignIns.map((m) => {
                return (
                  <MobileDialogItem
                    key={m.server}
                    label={m.server}
                    sublabel={m.needsApp
                      ? `Needs an OAuth app for ${m.issuer ?? 'the discovered issuer'}`
                      : m.ambiguousApp ? 'Choose a configured OAuth app'
                      : m.status === 'ok' ? `Signed in${m.account ? ` as ${m.account}` : ''} — sign in again` : m.url}
                    chevron
                    onClick={busy ? undefined : m.needsApp
                      ? () => onSetUp({ id: '', label: 'New app', install: null, group: null, overridesInstall: false }, m.issuer)
                      : m.ambiguousApp ? () => setMcpChoice(m) : () => void begin({ mcpServer: m.server })}
                  />
                );
              })}
            </MobileDialogList>
          </>
        ) : null}
      </MobileDialog>
    );
  }

  return (
    <MobileDialog
      title={reconnect ? `Reconnect ${app.label}` : `Connect ${app.label}`}
      onClose={onClose}
      onBack={reconnect || provider ? undefined : () => setApp(null)}
      backLabel="Back to providers"
      maxWidth="520px"
      className="ga-cred-dialog"
      closeDisabled={busy}
    >
      <div class="settings-body ga-cred-dialog-body">
        <p class="group-admin-help">Request OAuth scopes, one per line or separated by spaces. An empty field explicitly requests no scopes.</p>
        <Field label="Requested OAuth scopes">
          <textarea aria-label="Requested OAuth scopes" class="ga-cred-mono" rows={6} value={scopes} onInput={(event) => setScopes(event.currentTarget.value)} />
        </Field>
        <p class="group-admin-help">
          The provider decides the effective grant and may retain earlier permissions. Requesting fewer scopes does not revoke them.
          The agent can use all provider-permitted operations on {(app.group ?? app.install)?.config.api_hosts.join(', ')}.
        </p>
      </div>
      <Footer>
        <button type="button" disabled={busy} onClick={onClose}>Cancel</button>
        <button
          type="button"
          class="primary"
          disabled={busy}
          onClick={() => void begin({ appId: app.id, scopes: scopes.trim() ? scopes.trim().split(/\s+/) : [], replaceKey: reconnect?.key })}
        >
          {busy ? 'Opening…' : `Continue to ${app.label}`}
        </button>
      </Footer>
    </MobileDialog>
  );
}
