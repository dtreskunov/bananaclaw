// Dialogs for group settings → Credentials.
import { useEffect, useState } from 'preact/hooks';
import type { JSX } from 'preact';

import { call, errMsg } from './GroupAdminApi';
import {
  credPath,
  type AccountStartInput,
  type ApprovalMode,
  type AskRuleDto,
  type InjectionType,
  type KeyDto,
  type KeyPresetDto,
  type McpAuthDto,
  type OAuthAppDto,
  type PeerGroupDto,
  type RuleDto,
  type RuleInput,
} from './GroupAdminCredentialsApi';
import { APPROVAL_HELP, APPROVAL_LABELS, KEY_NAME_RE, SecretInput, ago, useEscapeClose } from './GroupAdminCredentialsParts';
import { GroupAdminField as Field } from './GroupAdminField';
import { MobileDialog, MobileDialogFooter, MobileDialogItem, MobileDialogList } from './MobileDialog';
import { showToast } from './Toast';

const INJECTION_LABELS: Record<InjectionType, string> = {
  bearer: 'Bearer token (Authorization header)',
  basic: 'Basic auth (Authorization header)',
  'api-key': 'Named header',
  query: 'Query parameter',
  custom: 'Header template',
  passthrough: 'No key — just allow the host',
};
const METHODS = ['ANY', 'GET', 'POST', 'PUT', 'PATCH', 'DELETE'];

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

export function usePeers(gid: string): PeerGroupDto[] | null {
  const [peers, setPeers] = useState<PeerGroupDto[] | null>(null);
  useEffect(() => {
    let live = true;
    void call<{ groups: PeerGroupDto[] }>(credPath(gid, '/peers')).then((r) => {
      if (!live) return;
      if (r.ok) setPeers(r.data.groups);
      else {
        setPeers([]);
        showToast(errMsg(r.data, `HTTP ${r.status}`), 'err');
      }
    });
    return () => {
      live = false;
    };
  }, [gid]);
  return peers;
}

function Footer({ children }: { children: JSX.Element | (JSX.Element | null)[] }): JSX.Element {
  return <MobileDialogFooter className="ga-confirm-foot ga-cred-foot">{children}</MobileDialogFooter>;
}

function GroupChecklist({
  groups,
  selected,
  onChange,
  note,
}: {
  groups: { groupId: string; groupName: string; detail?: string; disabled?: boolean }[];
  selected: string[];
  onChange: (next: string[]) => void;
  note?: (groupId: string) => string | null;
}): JSX.Element {
  if (groups.length === 0) return <p class="group-admin-help">No other groups you can change.</p>;
  return (
    <ul class="ga-cred-checklist">
      {groups.map((g) => (
        <li key={g.groupId}>
          <label class="group-admin-check">
            <input
              type="checkbox"
              disabled={g.disabled}
              checked={selected.includes(g.groupId)}
              onChange={(event) => onChange(event.currentTarget.checked
                ? [...selected, g.groupId]
                : selected.filter((id) => id !== g.groupId))}
            />
            <span>{g.groupName}</span>
          </label>
          {g.detail || note?.(g.groupId) ? <span class="ga-cred-checklist-note">{g.detail ?? note?.(g.groupId)}</span> : null}
        </li>
      ))}
    </ul>
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

function InjectionFields({
  value,
  keys,
  onChange,
  keyFixed,
}: {
  value: RuleDto['injection'];
  keys: string[];
  onChange: (next: RuleDto['injection']) => void;
  keyFixed?: boolean;
}): JSX.Element {
  const type = value.type;
  return (
    <>
      <Field label="How it's sent" info="How the gateway attaches the key to matching requests. Whatever the agent puts in this slot is replaced.">
        <select
          value={type}
          onChange={(event) => {
            const next = event.currentTarget.value as InjectionType;
            onChange({
              type: next,
              key: next === 'passthrough' ? undefined : value.key ?? keys[0],
              name: next === 'api-key' ? value.name || 'X-API-Key' : next === 'query' ? value.name || 'api_key' : undefined,
              template: next === 'custom' ? value.template || `Basic {{ ${value.key ?? 'KEY'} }}` : undefined,
            });
          }}
        >
          {(Object.keys(INJECTION_LABELS) as InjectionType[]).map((t) => (
            <option key={t} value={t}>{INJECTION_LABELS[t]}</option>
          ))}
        </select>
      </Field>
      {type !== 'passthrough' && !keyFixed ? (
        <Field label="Key">
          <select value={value.key ?? ''} onChange={(event) => onChange({ ...value, key: event.currentTarget.value })}>
            {keys.length === 0 ? <option value="">No keys yet</option> : null}
            {keys.map((k) => <option key={k} value={k}>{k}</option>)}
          </select>
        </Field>
      ) : null}
      {type === 'api-key' || type === 'query' ? (
        <Field label={type === 'query' ? 'Parameter' : 'Header'}>
          <input type="text" value={value.name ?? ''} spellcheck={false} onInput={(event) => onChange({ ...value, name: event.currentTarget.value })} />
        </Field>
      ) : null}
      {type === 'api-key' ? (
        <Field label="Prefix" info="Text placed before the key, e.g. “Token ”.">
          <input type="text" value={value.prefix ?? ''} spellcheck={false} placeholder="none" onInput={(event) => onChange({ ...value, prefix: event.currentTarget.value })} />
        </Field>
      ) : null}
      {type === 'custom' ? (
        <Field label="Header" info="Write the full Authorization header; {{ KEY_NAME }} is replaced by the key.">
          <input type="text" value={value.template ?? ''} spellcheck={false} onInput={(event) => onChange({ ...value, template: event.currentTarget.value })} />
        </Field>
      ) : null}
    </>
  );
}

function ApprovalFields({
  mode,
  askRules,
  onChange,
}: {
  mode: ApprovalMode;
  askRules: AskRuleDto[];
  onChange: (mode: ApprovalMode, askRules: AskRuleDto[]) => void;
}): JSX.Element {
  return (
    <>
      <Field label="Approval">
        <select value={mode} onChange={(event) => {
          const next = event.currentTarget.value as ApprovalMode;
          onChange(next, next === 'custom' && askRules.length === 0 ? [{ method: 'POST', path: '/*' }] : askRules);
        }}>
          {(Object.keys(APPROVAL_LABELS) as ApprovalMode[]).map((m) => <option key={m} value={m}>{APPROVAL_LABELS[m]}</option>)}
        </select>
      </Field>
      <p class="group-admin-help ga-cred-field-help">{APPROVAL_HELP[mode]}</p>
      {mode === 'custom' ? (
        <div class="ga-cred-ask-rules">
          {askRules.map((rule, index) => (
            <div class="ga-cred-ask-rule" key={index}>
              <select aria-label="Method" value={rule.method} onChange={(event) => onChange(mode, askRules.map((r, i) => (i === index ? { ...r, method: event.currentTarget.value } : r)))}>
                {METHODS.map((m) => <option key={m} value={m}>{m}</option>)}
              </select>
              <input type="text" aria-label="Path" value={rule.path} spellcheck={false} placeholder="/v1/messages/*" onInput={(event) => onChange(mode, askRules.map((r, i) => (i === index ? { ...r, path: event.currentTarget.value } : r)))} />
              <button type="button" class="icon-btn" aria-label="Remove" onClick={() => onChange(mode, askRules.filter((_, i) => i !== index))}>{'\u2715'}</button>
            </div>
          ))}
          <button type="button" onClick={() => onChange(mode, [...askRules, { method: 'POST', path: '/*' }])}>Add call</button>
        </div>
      ) : null}
    </>
  );
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
  const peers = usePeers(gid);
  const [preset, setPreset] = useState<KeyPresetDto | 'custom' | null>(null);
  const [label, setLabel] = useState('');
  const [key, setKey] = useState('');
  const [keyTouched, setKeyTouched] = useState(false);
  const [value, setValue] = useState('');
  const [match, setMatch] = useState('');
  const [injection, setInjection] = useState<RuleDto['injection']>({ type: 'bearer' });
  const [approval, setApproval] = useState<ApprovalMode>('allow');
  const [askRules, setAskRules] = useState<AskRuleDto[]>([]);
  const [alsoGroups, setAlsoGroups] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  useEscapeClose(onClose, busy);

  useEffect(() => {
    if (!initialMatch) return;
    const host = initialMatch.split('/')[0];
    const match = presets.find((p) => p.match.split('/')[0] === host);
    pick(match ?? 'custom');
    if (!match) setMatch(initialMatch);
  }, []);

  function pick(next: KeyPresetDto | 'custom'): void {
    setPreset(next);
    if (next === 'custom') {
      setLabel('');
      setKey('');
      setMatch('');
      setInjection({ type: 'bearer' });
    } else {
      setLabel(next.label);
      setKey(next.key);
      setMatch(next.match);
      setInjection({ ...next.injection, key: next.key });
    }
    setKeyTouched(false);
  }

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
              <MobileDialogItem key={p.id} label={p.label} sublabel={p.match} chevron onClick={() => pick(p)} />
            )
          ))}
          <MobileDialogItem label="Another service" sublabel="Any host; choose how the key is sent" chevron onClick={() => pick('custom')} />
        </MobileDialogList>
      </MobileDialog>
    );
  }

  const keyInvalid = key !== '' && !KEY_NAME_RE.test(key);
  const keyDuplicate = existingKeys.includes(key);
  const canSave = !busy && label.trim() !== '' && key !== '' && !keyInvalid && !keyDuplicate && value !== '' && match.trim() !== '';
  const editablePeers = (peers ?? []).filter((p) => p.canEdit);

  async function save(event: Event): Promise<void> {
    event.preventDefault();
    if (!canSave) return;
    setBusy(true);
    const rule: RuleInput = {
      match: match.trim(),
      injection: { ...injection, key },
      approval,
      askRules: approval === 'custom' ? askRules : [],
      enabled: true,
    };
    const ok = await send(credPath(gid, '/keys'), 'POST', { key, label: label.trim(), value, rule, alsoGroups }, `Saved ${label.trim()}`);
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
        <Field label="Key name" info="How rules and agent requests refer to this key. Upper case, digits and underscores.">
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
        <Field label="Send it to" info="Host, optionally with a port and a path pattern, e.g. api.example.com/v1/*. The key is only ever sent to matching requests.">
          <input type="text" class="ga-cred-mono" value={match} spellcheck={false} placeholder="api.example.com" onInput={(event) => setMatch(event.currentTarget.value)} />
        </Field>
        <InjectionFields value={{ ...injection, key }} keys={[key]} keyFixed onChange={setInjection} />
        <ApprovalFields mode={approval} askRules={askRules} onChange={(m, rules) => { setApproval(m); setAskRules(rules); }} />
        <h4>Also add to</h4>
        {peers === null ? <p class="muted">Loading groups…</p> : (
          <GroupChecklist
            groups={editablePeers.map((p) => ({
              groupId: p.groupId,
              groupName: p.groupName,
              detail: p.keys.some((k) => k.key === key) ? `Replaces its ${key}` : undefined,
            }))}
            selected={alsoGroups}
            onChange={setAlsoGroups}
          />
        )}
        <p class="group-admin-help ga-cred-field-help">Each group gets its own copy; changing one later doesn't change the others.</p>
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
  const [alsoGroups, setAlsoGroups] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  useEscapeClose(onClose, busy);
  const editable = item.alsoIn.filter((g) => g.canEdit);
  const locked = item.alsoIn.filter((g) => !g.canEdit);
  const verb = item.status === 'needs_value' ? 'Set' : 'Replace';

  async function save(event: Event): Promise<void> {
    event.preventDefault();
    if (!value) return;
    setBusy(true);
    const ok = await send(credPath(gid, `/keys/${encodeURIComponent(item.key)}`), 'PUT', { value, alsoGroups },
      alsoGroups.length ? `Updated ${item.label} in ${alsoGroups.length + 1} groups` : `Updated ${item.label}`);
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
        {editable.length ? (
          <>
            <h4>Also replace it in</h4>
            <GroupChecklist
              groups={editable.map((g) => ({ groupId: g.groupId, groupName: g.groupName, detail: g.stale ? 'Its copy is out of date' : undefined }))}
              selected={alsoGroups}
              onChange={setAlsoGroups}
            />
          </>
        ) : null}
        {locked.length ? (
          <p class="group-admin-help ga-cred-field-help">
            {locked.map((g) => g.groupName).join(', ')} also {locked.length === 1 ? 'has' : 'have'} a {item.key}; ask an admin of {locked.length === 1 ? 'that group' : 'those groups'} to update it.
          </p>
        ) : null}
      </form>
      <Footer>
        <button type="button" disabled={busy} onClick={onClose}>Cancel</button>
        <button type="submit" form="ga-cred-replace" class="primary" disabled={busy || !value}>{busy ? 'Saving…' : verb}</button>
      </Footer>
    </MobileDialog>
  );
}

export function ShareKeyDialog({
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
  const peers = usePeers(gid);
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  useEscapeClose(onClose, busy);
  const editable = (peers ?? []).filter((p) => p.canEdit);
  return (
    <MobileDialog title={`Copy ${item.label} to other groups`} onClose={onClose} maxWidth="480px" className="ga-cred-dialog" closeDisabled={busy}>
      <div class="settings-body ga-cred-dialog-body">
        <p class="group-admin-help">The value is copied inside the credential gateway; it isn't shown to anyone. Each group can then use and replace its own copy.</p>
        {peers === null ? <p class="muted">Loading groups…</p> : (
          <GroupChecklist
            groups={editable.map((p) => ({
              groupId: p.groupId,
              groupName: p.groupName,
              detail: p.keys.some((k) => k.key === item.key) ? `Replaces its ${item.key}` : undefined,
            }))}
            selected={selected}
            onChange={setSelected}
          />
        )}
      </div>
      <Footer>
        <button type="button" disabled={busy} onClick={onClose}>Cancel</button>
        <button type="button" class="primary" disabled={busy || selected.length === 0} onClick={async () => {
          setBusy(true);
          const ok = await send(credPath(gid, `/keys/${encodeURIComponent(item.key)}/share`), 'POST', { toGroups: selected },
            `Copied ${item.label} to ${selected.length} group${selected.length === 1 ? '' : 's'}`);
          setBusy(false);
          if (ok) {
            onSaved();
            onClose();
          }
        }}>
          {busy ? 'Copying…' : 'Copy'}
        </button>
      </Footer>
    </MobileDialog>
  );
}

export function CopyFromDialog({
  gid,
  existingKeys,
  onClose,
  onSaved,
}: {
  gid: string;
  existingKeys: string[];
  onClose: () => void;
  onSaved: () => void;
}): JSX.Element {
  const peers = usePeers(gid);
  const sources = (peers ?? []).filter((p) => p.canEdit && p.keys.length > 0);
  const [from, setFrom] = useState<string | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  useEscapeClose(onClose, busy);
  const source = sources.find((p) => p.groupId === from) ?? null;

  useEffect(() => {
    if (!from && sources.length) setFrom(sources[0]!.groupId);
  }, [sources.length]);
  useEffect(() => setSelected([]), [from]);

  return (
    <MobileDialog title="Copy keys from another group" onClose={onClose} maxWidth="520px" className="ga-cred-dialog" closeDisabled={busy}>
      <div class="settings-body ga-cred-dialog-body">
        {peers === null ? <p class="muted">Loading groups…</p> : sources.length === 0 ? (
          <p class="group-admin-help">None of the other groups you manage has keys yet.</p>
        ) : (
          <>
            <Field label="From">
              <select value={from ?? ''} onChange={(event) => setFrom(event.currentTarget.value)}>
                {sources.map((p) => <option key={p.groupId} value={p.groupId}>{p.groupName}</option>)}
              </select>
            </Field>
            <ul class="ga-cred-checklist">
              {source?.keys.map((k) => {
                const missing = k.status !== 'set';
                return (
                  <li key={k.key}>
                    <label class="group-admin-check">
                      <input
                        type="checkbox"
                        disabled={missing}
                        checked={selected.includes(k.key)}
                        onChange={(event) => setSelected(event.currentTarget.checked ? [...selected, k.key] : selected.filter((x) => x !== k.key))}
                      />
                      <span>{k.label} <code class="ga-cred-code-muted">{k.key}</code></span>
                    </label>
                    {missing ? <span class="ga-cred-checklist-note">Has no value to copy</span>
                      : existingKeys.includes(k.key) ? <span class="ga-cred-checklist-note">Replaces this group's value</span> : null}
                  </li>
                );
              })}
            </ul>
            <p class="group-admin-help ga-cred-field-help">Values are copied inside the credential gateway and never shown. Rules for these keys are copied too.</p>
          </>
        )}
      </div>
      <Footer>
        <button type="button" disabled={busy} onClick={onClose}>Cancel</button>
        <button type="button" class="primary" disabled={busy || !source || selected.length === 0} onClick={async () => {
          if (!source) return;
          setBusy(true);
          const ok = await send(credPath(gid, '/keys/copy'), 'POST', { fromGroup: source.groupId, keys: selected },
            `Copied ${selected.length} key${selected.length === 1 ? '' : 's'} from ${source.groupName}`);
          setBusy(false);
          if (ok) {
            onSaved();
            onClose();
          }
        }}>
          {busy ? 'Copying…' : selected.length > 1 ? `Copy ${selected.length} keys` : 'Copy'}
        </button>
      </Footer>
    </MobileDialog>
  );
}

export function RuleDialog({
  gid,
  rule,
  keys,
  initialKey,
  onClose,
  onSaved,
}: {
  gid: string;
  rule: RuleDto | null;
  keys: string[];
  initialKey?: string;
  onClose: () => void;
  onSaved: () => void;
}): JSX.Element {
  const [match, setMatch] = useState(rule?.match ?? '');
  const [injection, setInjection] = useState<RuleDto['injection']>(rule?.injection ?? { type: 'bearer', key: initialKey ?? keys[0] });
  const [approval, setApproval] = useState<ApprovalMode>(rule?.approval ?? 'allow');
  const [askRules, setAskRules] = useState<AskRuleDto[]>(rule?.askRules ?? []);
  const [busy, setBusy] = useState(false);
  useEscapeClose(onClose, busy);
  const needsKey = injection.type !== 'passthrough';
  const canSave = !busy && match.trim() !== '' && (!needsKey || !!injection.key);

  async function save(event: Event): Promise<void> {
    event.preventDefault();
    if (!canSave) return;
    setBusy(true);
    const body: RuleInput = {
      match: match.trim(),
      injection: needsKey ? injection : { type: 'passthrough' },
      approval,
      askRules: approval === 'custom' ? askRules : [],
      enabled: rule?.enabled ?? true,
      mcpServer: rule?.mcpServer,
    };
    const ok = rule
      ? await send(credPath(gid, `/rules/${encodeURIComponent(rule.name)}`), 'PUT', body, 'Rule updated')
      : await send(credPath(gid, '/rules'), 'POST', body, 'Rule added');
    setBusy(false);
    if (ok) {
      onSaved();
      onClose();
    }
  }

  return (
    <MobileDialog title={rule ? 'Edit rule' : 'Add a rule'} onClose={onClose} maxWidth="560px" className="ga-cred-dialog" closeDisabled={busy}>
      <form id="ga-cred-rule" class="settings-body ga-cred-dialog-body" onSubmit={save}>
        <p class="group-admin-help">A rule says which requests get a key, and whether calls need approval.</p>
        <Field label="Requests to" info="Host, optionally with a port and a path pattern, e.g. api.example.com/v1/*.">
          <input type="text" class="ga-cred-mono" value={match} spellcheck={false} placeholder="api.example.com" onInput={(event) => setMatch(event.currentTarget.value)} />
        </Field>
        <InjectionFields value={injection} keys={keys} onChange={setInjection} />
        <ApprovalFields mode={approval} askRules={askRules} onChange={(m, rules) => { setApproval(m); setAskRules(rules); }} />
      </form>
      <Footer>
        <button type="button" disabled={busy} onClick={onClose}>Cancel</button>
        <button type="submit" form="ga-cred-rule" class="primary" disabled={!canSave}>{busy ? 'Saving…' : rule ? 'Save rule' : 'Add rule'}</button>
      </Footer>
    </MobileDialog>
  );
}

export function ConnectAccountDialog({
  apps,
  mcp,
  reconnect,
  onStart,
  onClose,
}: {
  apps: OAuthAppDto[];
  mcp: McpAuthDto[];
  reconnect?: { provider: string; key: string; scopes: string[] };
  onStart: (input: AccountStartInput) => Promise<boolean>;
  onClose: () => void;
}): JSX.Element {
  const [app, setApp] = useState<OAuthAppDto | null>(() => (reconnect ? apps.find((a) => a.id === reconnect.provider) ?? null : null));
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
          {apps.map((a) => (
            <MobileDialogItem
              key={a.id}
              label={a.label}
              sublabel={a.configured ? `${a.scopeSets.length} kinds of access available` : 'Not set up by the operator'}
              chevron={a.configured}
              title={a.configured ? undefined : a.envHint}
              className={a.configured ? undefined : 'ga-cred-item-disabled'}
              onClick={a.configured ? () => setApp(a) : undefined}
            />
          ))}
        </MobileDialogList>
        {mcpSignIns.length ? (
          <>
            <div class="settings-body ga-cred-dialog-body ga-cred-dialog-subhead"><h4>MCP servers</h4></div>
            <MobileDialogList className="ga-cred-preset-list">
              {mcpSignIns.map((m) => (
                <MobileDialogItem
                  key={m.server}
                  label={m.server}
                  sublabel={m.status === 'ok' ? `Signed in${m.account ? ` as ${m.account}` : ''} — sign in again` : m.url}
                  chevron
                  onClick={busy ? undefined : () => void begin({ mcpServer: m.server })}
                />
              ))}
            </MobileDialogList>
          </>
        ) : null}
        {apps.some((a) => !a.configured) ? (
          <div class="settings-body ga-cred-dialog-body">
            <p class="group-admin-help">Providers that aren't set up need an OAuth client in the gateway's <code>.env</code>; see the operator guide.</p>
          </div>
        ) : null}
      </MobileDialog>
    );
  }

  return (
    <MobileDialog
      title={reconnect ? `Reconnect ${app.label}` : `Connect ${app.label}`}
      onClose={onClose}
      onBack={reconnect ? undefined : () => setApp(null)}
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
