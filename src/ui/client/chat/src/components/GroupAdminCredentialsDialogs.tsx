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
  presets,
  existingKeys,
  initialMatch,
  onExisting,
  onClose,
  onSaved,
}: {
  gid: string;
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
    const ok = await send(credPath(gid, '/keys'), 'POST', { key, label: label.trim(), value, destination: { ...destination, match: destination.match.trim() } }, `Saved ${label.trim()}`);
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
  item,
  onClose,
  onSaved,
}: {
  gid: string;
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
    const ok = await send(credPath(gid, `/keys/${encodeURIComponent(item.key)}`), 'PUT', { value }, `Updated ${item.label}`);
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
  item,
  onClose,
  onSaved,
}: {
  gid: string;
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
    const ok = await send(credPath(gid, `/keys/${encodeURIComponent(item.key)}`), 'PUT', {
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

const CLIENT_ID_RE = /^\S+$/;

export function OAuthAppDialog({
  gid,
  app,
  scope: fixedScope,
  canEditInstall,
  redirectUri,
  onClose,
  onSaved,
}: {
  gid: string;
  app: OAuthAppDto;
  /** Which app to edit; when omitted, an owner chooses (defaulting to install-wide). */
  scope?: OAuthAppScope;
  canEditInstall: boolean;
  redirectUri: string;
  onClose: () => void;
  onSaved: () => void;
}): JSX.Element {
  const [scope, setScope] = useState<OAuthAppScope>(fixedScope ?? (canEditInstall && !app.install ? 'install' : 'group'));
  const existing = scope === 'install' ? app.install : app.group;
  const [clientId, setClientId] = useState(existing?.clientId ?? '');
  const [secret, setSecret] = useState('');
  const [busy, setBusy] = useState(false);
  useEscapeClose(onClose, busy);
  useEffect(() => setClientId(existing?.clientId ?? ''), [scope]);
  const id = clientId.trim();
  const canSave = !busy && CLIENT_ID_RE.test(id) && (existing ? id !== existing.clientId || secret !== '' : secret !== '');
  const choosing = fixedScope === undefined && canEditInstall && !app.install && !app.group;

  async function save(event: Event): Promise<void> {
    event.preventDefault();
    if (!canSave) return;
    setBusy(true);
    const ok = await send(
      credPath(gid, `/oauth-apps/${encodeURIComponent(app.id)}`),
      'PUT',
      secret ? { scope, clientId: id, clientSecret: secret } : { scope, clientId: id },
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
            <li>
              Create an OAuth client of type <em>Web application</em> in the{' '}
              <a href={app.consoleUrl} target="_blank" rel="noopener noreferrer">{app.label} console</a>.
            </li>
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
        <Field label="Client ID">
          <input type="text" class="ga-cred-mono" value={clientId} spellcheck={false} autoFocus={!existing} onInput={(event) => setClientId(event.currentTarget.value)} />
        </Field>
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
          {existing && existing.clientId !== id && id ? ' Changing the client disconnects the accounts that use it.' : ''}
        </p>
      </form>
      <Footer>
        <button type="button" disabled={busy} onClick={onClose}>Cancel</button>
        <button type="submit" form="ga-cred-oauth-app" class="primary" disabled={!canSave}>{busy ? 'Saving…' : 'Save'}</button>
      </Footer>
    </MobileDialog>
  );
}

function appReady(app: OAuthAppDto): boolean {
  return Boolean(app.group ?? app.install);
}

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
  onSetUp: (app: OAuthAppDto) => void;
  onStart: (input: AccountStartInput) => Promise<boolean>;
  onClose: () => void;
}): JSX.Element {
  const initial = reconnect?.provider ?? provider;
  const [app, setApp] = useState<OAuthAppDto | null>(() => (initial ? apps.find((a) => a.id === initial) ?? null : null));
  const [scopes, setScopes] = useState<string[]>(() => reconnect?.scopes ?? []);
  const [busy, setBusy] = useState(false);
  useEscapeClose(onClose, busy);
  const mcpSignIns = mcp.filter((m) => m.auth === 'oauth');

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
          {apps.filter((a) => a.scopeSets.length > 0).map((a) => (
            <MobileDialogItem
              key={a.id}
              label={a.label}
              sublabel={appReady(a) ? `${a.scopeSets.length} kinds of access available` : 'Needs an OAuth app first'}
              chevron={appReady(a) || canEdit}
              onClick={appReady(a) ? () => setApp(a) : canEdit ? () => onSetUp(a) : undefined}
            />
          ))}
        </MobileDialogList>
        {mcpSignIns.length ? (
          <>
            <div class="settings-body ga-cred-dialog-body ga-cred-dialog-subhead"><h4>MCP servers</h4></div>
            <MobileDialogList className="ga-cred-preset-list">
              {mcpSignIns.map((m) => {
                const app = m.needsApp ? apps.find((a) => a.id === m.needsApp) : undefined;
                return (
                  <MobileDialogItem
                    key={m.server}
                    label={m.server}
                    sublabel={app
                      ? `Needs the ${app.label} OAuth app first`
                      : m.status === 'ok' ? `Signed in${m.account ? ` as ${m.account}` : ''} — sign in again` : m.url}
                    chevron={!app || canEdit}
                    onClick={busy ? undefined : app ? (canEdit ? () => onSetUp(app) : undefined) : () => void begin({ mcpServer: m.server })}
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
        <p class="group-admin-help">Choose what the agent may use. {app.label} will ask you to confirm.</p>
        <ul class="ga-cred-checklist">
          {app.scopeSets.map((s) => (
            <li key={s.id}>
              <label class="group-admin-check">
                <input
                  type="checkbox"
                  checked={scopes.includes(s.id)}
                  onChange={(event) => setScopes(event.currentTarget.checked ? [...scopes, s.id] : scopes.filter((x) => x !== s.id))}
                />
                <span>{s.label}</span>
              </label>
              <span class="ga-cred-checklist-note ga-cred-mono">{s.hosts.join(', ')}</span>
            </li>
          ))}
        </ul>
      </div>
      <Footer>
        <button type="button" disabled={busy} onClick={onClose}>Cancel</button>
        <button
          type="button"
          class="primary"
          disabled={busy || scopes.length === 0}
          onClick={() => void begin({ provider: app.id, scopeSets: scopes, replaceKey: reconnect?.key })}
        >
          {busy ? 'Opening…' : `Continue to ${app.label}`}
        </button>
      </Footer>
    </MobileDialog>
  );
}
