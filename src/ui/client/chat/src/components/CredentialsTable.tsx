import { useRef, useState } from 'preact/hooks';
import type { ComponentChildren, JSX } from 'preact';
import {
  connectionPath, credentialRequest, errorMessage, CredentialsError,
  type AppInfo, type Connection, type CredentialGroup, type Service,
} from './CredentialsApi';
import { accessGroups, connectionName, serviceDestination } from './credential-presentation';
import { ErrorNotice } from './CredentialsParts';
import { CheckIcon, CloseIcon, EditIcon, PlayIcon, RefreshIcon, StopIcon, TrashIcon } from './ActionIcons';
import { showToast } from './Toast';

export function CredentialAction({ label, children, onClick, disabled, danger }: {
  label: string; children: ComponentChildren; onClick: () => void; disabled?: boolean; danger?: boolean;
}): JSX.Element {
  return <button type="button" class={`msg-action-btn${danger ? ' danger' : ''}`}
    title={label} aria-label={label} disabled={disabled} onClick={onClick}>{children}</button>;
}

export function CredentialsTable({ connections, groups, apps, busy, onEdit, onConnect, onAction, onSaved, onlyGroup }: {
  connections: Connection[]; groups: CredentialGroup[]; apps: AppInfo[]; busy: boolean;
  onEdit: (connection: Connection) => void; onConnect: (connection: Connection) => void;
  onAction: (connection: Connection, action: 'enable' | 'disable' | 'delete') => void;
  onSaved: () => Promise<void>;
  onlyGroup?: string;
}): JSX.Element {
  const destinations = accessGroups(connections, groups).filter((group) => !onlyGroup || group.id === onlyGroup);
  return <div class="credentials-matrix-scroll" tabIndex={0} role="region" aria-label="Agent authorization">
    <table class="credentials-matrix">
      {!onlyGroup ? <thead><tr><th scope="col">Credential</th>
        {destinations.map((group) => <th scope="col" class="credentials-agent-heading" key={group.id}><span>{group.name}</span></th>)}
      </tr></thead> : null}
      <tbody>{connections.map((connection) => <CredentialRow
        key={`${connection.id}:${connection.revision}:${JSON.stringify(connection.grants)}`}
        connection={connection} groups={destinations} apps={apps} busy={busy}
        onEdit={onEdit} onConnect={onConnect} onAction={onAction} onSaved={onSaved}
      />)}
      </tbody>
    </table>
  </div>;
}

export function CredentialRow({ connection, groups, apps, busy, onEdit, onConnect, onAction, onSaved }: {
  connection: Connection; groups: CredentialGroup[]; apps: AppInfo[]; busy: boolean;
  onEdit: (connection: Connection) => void; onConnect: (connection: Connection) => void;
  onAction: (connection: Connection, action: 'enable' | 'disable' | 'delete') => void;
  onSaved: () => Promise<void>;
}): JSX.Element {
  const [changes, setChanges] = useState<Record<string, string[] | null>>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [stale, setStale] = useState(false);
  const name = connectionName(connection, apps);
  const services = connection.services.filter((service) => service.enabled !== false).map((service) => service.name);
  const pending = Object.keys(changes).length > 0;
  const blocked = busy || saving || stale;
  async function save(): Promise<void> {
    setSaving(true);
    setError('');
    try {
      let latest = await credentialRequest<Connection>(connectionPath(connection.id));
      if (latest.revision !== connection.revision)
        throw new CredentialsError('This credential changed. Refresh and review agent access again.', 412);
      for (const [group, selected] of Object.entries(changes)) {
        await credentialRequest(connectionPath(connection.id, `/grants/${encodeURIComponent(group)}`),
          selected ? 'PUT' : 'DELETE', selected ? { services: selected, revision: latest.revision } : undefined);
        latest = await credentialRequest<Connection>(connectionPath(connection.id));
      }
      setChanges({});
      await onSaved();
      showToast('Agent access saved');
    } catch (error) {
      if (!(error instanceof CredentialsError || error instanceof TypeError)) throw error;
      setError(errorMessage(error));
      showToast(errorMessage(error), 'err');
      // Some earlier cells may have committed; refresh before retrying instead of replaying them.
      setStale(true);
      await onSaved();
    } finally { setSaving(false); }
  }
  const actions = <div class="credentials-row-actions">
    {pending ? <>
      <CredentialAction label={`Save agent access for ${name}`} disabled={blocked}
        onClick={() => save()}><CheckIcon /></CredentialAction>
      <CredentialAction label={`Cancel access changes for ${name}`} disabled={saving}
        onClick={() => { setChanges({}); setError(''); }}><CloseIcon /></CredentialAction>
    </> : null}
    <CredentialAction label={`Edit ${name}`} disabled={blocked} onClick={() => onEdit(connection)}><EditIcon /></CredentialAction>
    {connection.kind !== 'static' ? <CredentialAction label={`${connection.status === 'draft' ? 'Connect' : 'Reconnect'} ${name}`}
      disabled={blocked || connection.status === 'disabled'} onClick={() => onConnect(connection)}>
      <RefreshIcon />
    </CredentialAction> : null}
    <CredentialAction label={`${connection.status === 'disabled' ? 'Enable' : 'Disable'} ${name}`} disabled={blocked}
      onClick={() => onAction(connection, connection.status === 'disabled' ? 'enable' : 'disable')}>
      {connection.status === 'disabled' ? <PlayIcon /> : <StopIcon />}
    </CredentialAction>
    <CredentialAction label={`${connection.kind === 'static' ? 'Delete' : 'Disconnect everywhere:'} ${name}`}
      disabled={blocked} danger onClick={() => onAction(connection, 'delete')}><TrashIcon /></CredentialAction>
  </div>;
  return <>
    <tr>
      <CredentialCell services={connection.services} account={connection.account} status={connection.status} actions={actions}>
        <CredentialName connection={connection} name={name} busy={blocked || pending} onSaved={onSaved} onBusyChange={setSaving} />
      </CredentialCell>
      {groups.map((group) => {
        const grant = connection.grants.find((item) => item.vault === group.id);
        const changed = Object.hasOwn(changes, group.id);
        const selected = changed ? changes[group.id] ?? [] : grant?.services ?? [];
        const active = changed || grant?.status === 'active';
        const checked = active && services.length > 0 && services.every((service) => selected.includes(service));
        const partial = selected.length > 0 && (!checked || !active);
        const canGrant = group.canAdmin && connection.status === 'ready' && services.length > 0;
        const canRevoke = !!grant && selected.length > 0;
        const label = `${name} — ${group.name}`;
        return <td key={group.id}>
          <input type="checkbox" aria-label={label} checked={checked} aria-checked={partial ? 'mixed' : checked}
            ref={(node) => { if (node) node.indeterminate = partial; }}
            disabled={blocked || (!canGrant && !canRevoke)}
            title={grant?.status === 'suspended' && !changed ? 'Access needs review' :
              partial ? 'Some services selected' : !canGrant && !grant ? 'Agent administrator required' : label}
            onChange={(event) => {
              const next = canGrant && event.currentTarget.checked ? [...services] : null;
              const unchanged = grant
                ? grant.status === 'active' && next !== null &&
                  next.length === grant.services.length && next.every((service) => grant.services.includes(service))
                : next === null;
              setChanges((old) => {
                const updated = { ...old };
                if (unchanged) delete updated[group.id];
                else updated[group.id] = next;
                return updated;
              });
              setError('');
            }}
          />
        </td>;
      })}
    </tr>
    {error ? <tr><td colSpan={groups.length + 1}><ErrorNotice message={error} /></td></tr> : null}
  </>;
}

function CredentialCell({ children, services, account, status, actions }: {
  children: ComponentChildren; services: Service[]; account?: string | null; status: string; actions: ComponentChildren;
}): JSX.Element {
  const destinations = [...new Set(services.map(serviceDestination))];
  const notice = status === 'ready' || status === 'active' ? '' : status === 'disabled' ? 'Disabled' :
    status === 'draft' ? 'Not connected' : status === 'suspended' ? 'Access needs review' : 'Sign in required';
  return <th scope="row" class="credentials-matrix-name">
    {children}
    {account ? <span class="muted">{account}</span> : null}
    {destinations.map((destination) => <span class="muted credential-destination" key={destination}>{destination}</span>)}
    {notice ? <span class="ga-cred-warn-text">{notice}</span> : null}
    {actions}
  </th>;
}

export function CredentialName({ connection, name, busy, onSaved, onBusyChange }: {
  connection: Connection; name: string; busy: boolean; onSaved: () => Promise<void>;
  onBusyChange?: (busy: boolean) => void;
}): JSX.Element {
  const [value, setValue] = useState(name);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const pending = useRef(false);
  async function save(next: string): Promise<void> {
    const label = next.trim();
    if (pending.current || label === name) return;
    if (!label) {
      setValue(name);
      setError('Enter a credential name.');
      return;
    }
    pending.current = true;
    setSaving(true);
    onBusyChange?.(true);
    setError('');
    try {
      const latest = await credentialRequest<Connection>(connectionPath(connection.id));
      if (latest.revision !== connection.revision)
        throw new CredentialsError('This credential changed. Refresh before renaming.', 412);
      await credentialRequest(connectionPath(connection.id), 'PUT', { label, revision: latest.revision });
      setValue(label);
      await onSaved();
    } catch (error) {
      if (!(error instanceof CredentialsError || error instanceof TypeError)) throw error;
      setError(errorMessage(error));
      showToast(errorMessage(error), 'err');
    } finally { pending.current = false; setSaving(false); onBusyChange?.(false); }
  }
  return <div>
    <span class="credential-name-editor"><span aria-hidden="true">{value || ' '}</span>
    <input class="credential-name-input" type="text" aria-label={`Credential name for ${name}`} value={value}
      disabled={busy || saving} onInput={(event) => setValue(event.currentTarget.value)}
      onBlur={(event) => void save(event.currentTarget.value)}
      onKeyDown={(event) => {
        if (event.key === 'Enter') { event.preventDefault(); event.currentTarget.blur(); }
        if (event.key === 'Escape') {
          event.preventDefault(); event.stopPropagation();
          setValue(name); event.currentTarget.value = name; event.currentTarget.blur();
        }
      }} /></span>
    <ErrorNotice message={error} />
  </div>;
}
