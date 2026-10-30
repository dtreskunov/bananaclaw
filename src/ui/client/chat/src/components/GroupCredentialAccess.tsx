import './Credentials.css';
import type { JSX } from 'preact';
import {
  accessPath, type AccessGrant,
} from './CredentialsApi';
import { ErrorNotice, useCredentialResource } from './CredentialsParts';
import { CredentialsContent } from './CredentialsPage';

export function GroupCredentials({ gid }: { gid: string }): JSX.Element {
  return <CredentialsContent agent={{ id: gid }} />;
}

import { serviceMatchesResource } from '../../../../shared/credential-matching';
export { serviceMatchesResource } from '../../../../shared/credential-matching';

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
    <span class="muted">Connect once as yourself, then grant services in Agent Settings → Credentials. No group-owned sign-in is created here.</span>
  </div>;
}
