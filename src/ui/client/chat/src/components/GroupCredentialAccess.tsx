import './Credentials.css';
import type { JSX } from 'preact';
import {
  accessPath, type AccessGrant,
} from './CredentialsApi';
import { ErrorNotice, useCredentialResource } from './CredentialsParts';
import { CredentialsContent } from './CredentialsPage';
import type { McpAuthentication } from '../../../../shared/mcp-authentication';

export function GroupCredentials({ gid }: { gid: string }): JSX.Element {
  return <CredentialsContent agent={{ id: gid }} />;
}

import { serviceMatchesResource } from '../../../../shared/credential-matching';
export { serviceMatchesResource } from '../../../../shared/credential-matching';

/** MCP only displays grant references. Authentication is created in the personal connection flow. */
export function McpConnectionAccess({ gid, resourceUrl, onOpenCredentials, authentication, onAuthenticationChange, serverName, disabled }: {
  gid: string; resourceUrl: string; onOpenCredentials: (create: boolean, connectionId?: string) => void;
  authentication?: McpAuthentication;
  onAuthenticationChange?: (authentication: McpAuthentication | undefined) => void;
  serverName?: string;
  disabled?: boolean;
}): JSX.Element {
  const { data, error, loading, refresh } = useCredentialResource<{ grants: AccessGrant[] }>(accessPath(gid));
  const matches = data?.grants.flatMap((grant) => grant.services.filter((service) => serviceMatchesResource(service, resourceUrl))
    .map((service) => ({ grant, service }))) ?? [];
  const choices = [...new Map(matches.map(item => [item.grant.connection_id, item.grant])).values()];
  return <div class="ga-cred-mcp-auth">
    <span class="ga-mcp-row-label">Connection access</span>
    {loading ? <span class="muted">Loading granted bindings…</span> : null}
    <ErrorNotice message={error} />
    {onAuthenticationChange && !loading && !error ? <>
      <label>Credential connection
        <select class="ga-mcp-input" disabled={disabled} aria-label={`Credential connection for ${serverName ?? 'MCP server'}`} value={authentication?.connection_id ?? ''}
          onChange={event => {
            const selected = choices.find(choice => choice.connection_id === event.currentTarget.value);
            onAuthenticationChange(selected ? { connection_id: selected.connection_id,
              account_alias: authentication?.account_alias || serverName || 'Account' } : undefined);
          }}>
          <option value="">Automatic destination matching (no pinned account)</option>
          {authentication && !choices.some(choice => choice.connection_id === authentication.connection_id)
            ? <option value={authentication.connection_id}>Configured connection — unavailable in your personal grants</option> : null}
          {choices.map(choice => <option key={choice.connection_id} value={choice.connection_id} disabled={choice.status !== 'active'}>
            {choice.label}{choice.status === 'active' ? '' : ` (${choice.status})`}
          </option>)}
        </select>
      </label>
      {authentication ? <label>Account alias
        <input class="ga-mcp-input" disabled={disabled} aria-label={`Account alias for ${serverName ?? 'MCP server'}`} value={authentication.account_alias} maxLength={80}
          onInput={event => onAuthenticationChange({ ...authentication, account_alias: event.currentTarget.value })} />
        <span class="muted">Shown to the agent to distinguish accounts. The host manages the binding header; this reference does not grant access.</span>
      </label> : null}
    </> : null}
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
