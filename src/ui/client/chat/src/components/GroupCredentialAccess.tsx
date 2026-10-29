import './Credentials.css';
import { useState } from 'preact/hooks';
import type { JSX } from 'preact';
import { openCredentials } from '../credentials-navigation';
import {
  accessPath, credentialRequest, credentialsPath, type AccessGrant, type Connection,
  type CredentialsOverview, type Service,
} from './CredentialsApi';
import { ConfirmCredentialAction, CredentialDialog, ErrorNotice, useCredentialResource } from './CredentialsParts';
import { ConnectionGrantsDialog } from './CredentialsDialogs';
import { showToast } from './Toast';

export function GroupCredentialAccess({ gid }: { gid: string }): JSX.Element {
  const { data, loading, error, refresh } = useCredentialResource<{ grants: AccessGrant[] }>(accessPath(gid));
  const [attach, setAttach] = useState(false);
  const [detach, setDetach] = useState<AccessGrant | null>(null);
  return <section class="ga-cred">
    <div class="ga-cred-head"><h3>Access</h3><button type="button" disabled={loading} onClick={() => void refresh()}>Refresh access</button></div>
    <p class="group-admin-help">Services explicitly shared with this agent. Owners manage keys and authorization in
      their personal Credentials. Removing access detaches only this agent; it never disconnects the upstream account.</p>
    {loading ? <p role="status">Loading granted services…</p> : null}
    <ErrorNotice message={error} />
    {error ? <button type="button" onClick={() => void refresh()}>Try again</button> : null}
    {data && !error ? data.grants.length ? <ul class="ga-cred-list">
      {data.grants.map((grant) => <li class="ga-cred-item" key={grant.connection_id}>
        <div class="ga-cred-item-main"><strong>{grant.label}</strong>
          <div class="ga-cred-meta"><span>Owner: {grant.owner.label ?? grant.owner.id}</span><span>Status: {grant.status}</span></div>
          <div class="ga-cred-chips">{grant.services.map((service) => <span class="ga-cred-chip" key={service.name}>
            {service.name} · {service.host}{service.path ?? ''}
          </span>)}</div>
        </div>
        <button type="button" disabled={loading} onClick={() => setDetach(grant)}>Detach this agent</button>
      </li>)}
    </ul> : <p>No services have been granted to this agent.</p> : null}
    <div class="ga-cred-head-actions">
      <button type="button" onClick={() => setAttach(true)}>Use existing connection</button>
      <button type="button" onClick={() => openCredentials()}>Open personal Credentials</button>
    </div>
    {attach ? <AttachExistingConnection gid={gid} onClose={() => setAttach(false)} onSaved={() => void refresh()} /> : null}
    {detach ? <ConfirmCredentialAction title={`Detach ${detach.label} from this agent`} label="Detach this agent only" onClose={() => setDetach(null)}
      onConfirm={async () => {
        await credentialRequest(accessPath(gid, detach.connection_id), 'DELETE');
        showToast('Agent access detached. Other agents and upstream authorization are unchanged.');
        await refresh();
      }}>
      <p>This agent and its members will lose access to {detach.services.map((service) => service.name).join(', ')}.
        The connection remains owned by {detach.owner.label ?? detach.owner.id}. Other grants and the upstream account are unchanged.</p>
    </ConfirmCredentialAction> : null}
  </section>;
}

function AttachExistingConnection({ gid, onClose, onSaved }: { gid: string; onClose: () => void; onSaved: () => void }): JSX.Element {
  const overview = useCredentialResource<CredentialsOverview>(credentialsPath());
  const [connection, setConnection] = useState<Connection | null>(null);
  const group = overview.data?.groups.find((item) => item.id === gid);
  if (connection && overview.data) return <ConnectionGrantsDialog connection={connection} groups={overview.data.groups}
    onlyGroup={gid} onClose={onClose} onSaved={onSaved} />;
  return <CredentialDialog title="Use an existing personal connection" onClose={onClose}>
    <p>Only connections you own can be shared, and you must administer this destination agent. Receiving access to
      someone else's connection does not let you reshare it.</p>
    {overview.loading ? <p>Loading your connections…</p> : null}
    <ErrorNotice message={overview.error} />
    {overview.error ? <button type="button" onClick={() => void overview.refresh()}>Retry</button> : null}
    {overview.data && !overview.error ? group?.canAdmin ? <>
      {overview.data.connections.length ? <ul class="ga-cred-list">{overview.data.connections.map((item) => <li class="ga-cred-item" key={item.id}>
        <div class="ga-cred-item-main"><strong>{item.label}</strong><span>{item.status} · {item.services.map((service) => service.name).join(', ')}</span></div>
        <button type="button" onClick={() => setConnection(item)}>Select services</button>
      </li>)}</ul> : <p>You have no personal connections to share.</p>}
      <button type="button" onClick={() => openCredentials()}>Create a connection in personal Credentials</button>
    </> : <p role="alert">You do not administer this destination agent.</p> : null}
  </CredentialDialog>;
}

export function serviceMatchesResource(service: Service, resourceUrl: string): boolean {
  let url: URL;
  try { url = new URL(resourceUrl); }
  catch (error) { if (error instanceof TypeError) return false; throw error; }
  const glob = (pattern: string, value: string): boolean =>
    new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`, 'i').test(value);
  const slash = service.host.indexOf('/');
  const host = slash < 0 ? service.host : service.host.slice(0, slash);
  const path = service.path ?? (slash < 0 ? undefined : service.host.slice(slash));
  return glob(host, url.host) && (!path || glob(path, url.pathname)) && (!service.https_only || url.protocol === 'https:');
}

/** MCP only displays grant references. Authentication is created in the personal connection flow. */
export function McpConnectionAccess({ gid, resourceUrl, onOpenCredentials }: {
  gid: string; resourceUrl: string; onOpenCredentials: (create: boolean, connectionId?: string) => void;
}): JSX.Element {
  const { data, error, loading, refresh } = useCredentialResource<{ grants: AccessGrant[] }>(accessPath(gid));
  const matches = data?.grants.flatMap((grant) => grant.services.filter((service) => serviceMatchesResource(service, resourceUrl))
    .map((service) => ({ grant, service }))) ?? [];
  return <div class="ga-cred-mcp-auth">
    <span class="ga-mcp-row-label">Connection access</span>
    {loading ? <span class="muted">Loading granted bindings…</span> : null}
    <ErrorNotice message={error} />
    {error ? <button type="button" onClick={() => void refresh()}>Retry access</button> : null}
    {!loading && !error ? matches.length ? <ul>{matches.map(({ grant, service }) =>
      <li key={`${grant.connection_id}:${service.name}`}>{grant.label} / {service.name} · {grant.status}
        {' · Owner: '}{grant.owner.label ?? grant.owner.id}{service.enabled === false ? ' · service disabled' : ''}</li>)}</ul>
      : <span class="muted">No matching granted service. Public servers may not need authentication.</span> : null}
    <button type="button" disabled={loading || !!error} onClick={() => onOpenCredentials(!matches.length, matches.length === 1 ? matches[0].grant.connection_id : undefined)}>
      {matches.length ? 'Manage personal connections' : 'Connect in personal Credentials'}
    </button>
    <span class="muted">Connect once as yourself, then grant services in Agent Settings → Access. No group-owned sign-in is created here.</span>
  </div>;
}
