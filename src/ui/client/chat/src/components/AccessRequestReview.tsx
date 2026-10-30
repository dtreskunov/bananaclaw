import { useEffect, useRef, useState } from 'preact/hooks';
import { credentialRequest, credentialsPath, errorMessage, CredentialsError, type Connection } from './CredentialsApi';
import { ErrorNotice, useCredentialResource } from './CredentialsParts';
import { connectionName, serviceDestination } from './credential-presentation';
import { respondApproval } from '../actions';
import { ACCESS_AUTHENTICATION_LABELS, connectionMatchesAccess, type AccessRequirements } from '../../../../shared/access-authentication';

interface AccessRequest extends AccessRequirements {
  request_id: string;
  status: string;
  resource_url: string;
  reason: string;
  scopes?: string[];
  mcp_server?: string;
  revision: number;
  agent_group_id: string;
  agent_group_name?: string;
  result: { message: string } | null;
}
interface AccessPreview {
  request: AccessRequest;
  connection: Connection;
  matches: boolean;
  grantBreadth: string;
  verification: string;
  mcp?: { names: string[]; revision: string; configured?: Record<string, { connection_id: string; account_alias: string } | undefined> };
}

export function AccessRequestReview({ id, connections, preferredConnectionId, signingIn, onCreate, onManage, onSaved }: {
  id: string;
  connections: Connection[];
  preferredConnectionId?: string;
  signingIn?: boolean;
  onCreate: (request: AccessRequirements) => void;
  onManage: (connection: Connection) => void;
  onSaved: () => void;
}) {
  const path = credentialsPath(`/access-requests/${encodeURIComponent(id)}`);
  const request = useCredentialResource<AccessRequest>(path);
  const [selected, setSelected] = useState('');
  const [preview, setPreview] = useState<AccessPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [configureMcp, setConfigureMcp] = useState(false);
  const [mcpServer, setMcpServer] = useState('');
  const [accountAlias, setAccountAlias] = useState('');
  const preferred = useRef<string | undefined>();
  const compatible = request.data ? connections.filter(connection => connectionMatchesAccess(connection, request.data!)) : [];
  const created = connections.find(connection => connection.id === preferredConnectionId);
  const createdMismatch = created?.status === 'ready' && !compatible.some(connection => connection.id === created.id);
  const compatibleIds = JSON.stringify(compatible.map(connection => connection.id));
  useEffect(() => {
    if (!request.data) return;
    if (preferredConnectionId && preferred.current !== preferredConnectionId &&
      compatible.some(connection => connection.id === preferredConnectionId)) {
      preferred.current = preferredConnectionId;
      setSelected(preferredConnectionId);
    } else if (selected && !compatible.some(connection => connection.id === selected)) {
      setSelected('');
    }
  }, [preferredConnectionId, compatibleIds, selected, request.data]);
  const connectionVersion = JSON.stringify(connections.map(connection => [connection.id, connection.revision, connection.status,
    connection.requested_scopes, connection.granted_scopes, connection.scope_source]));
  useEffect(() => {
    setPreview(null);
    setConfirmed(false);
    setConfigureMcp(false);
    if (request.data?.status !== 'pending') return;
    setError('');
    if (!selected) return;
    const controller = new AbortController();
    void credentialRequest<AccessPreview>(path + '/preview', 'POST', { connection_id: selected }, controller.signal)
      .then(value => {
        if (controller.signal.aborted) return;
        setPreview(value);
        const name = value.request.mcp_server ?? (value.mcp?.names.length === 1 ? value.mcp.names[0] : '');
        setMcpServer(name);
        setAccountAlias(value.mcp?.configured?.[name]?.account_alias || name);
      })
      .catch(error => {
        if (controller.signal.aborted) return;
        if (!(error instanceof CredentialsError || error instanceof TypeError)) throw error;
        setError(errorMessage(error));
      });
    return () => controller.abort();
  }, [path, selected, connectionVersion, request.data?.revision, request.data?.status]);

  async function apply(): Promise<void> {
    if (!preview || !confirmed || busy) return;
    setBusy(true);
    setError('');
    try {
      await credentialRequest(path + '/apply', 'POST', {
        connection_id: preview.connection.id, connection_revision: preview.connection.revision,
        request_revision: preview.request.revision,
        configure_mcp: configureMcp, config_revision: preview.mcp?.revision,
        ...(configureMcp ? { mcp_server: mcpServer, account_alias: accountAlias } : {}),
      });
      setPreview(null);
      setConfirmed(false);
      await request.refresh();
      onSaved();
    } catch (error) {
      if (!(error instanceof CredentialsError || error instanceof TypeError)) throw error;
      setError(errorMessage(error));
      setPreview(null);
      setConfirmed(false);
      await request.refresh();
      onSaved();
    } finally { setBusy(false); }
  }

  async function reject(): Promise<void> {
    setBusy(true);
    setError('');
    try {
      await respondApproval(id, 'reject');
      await request.refresh();
    } catch (error) {
      setError(errorMessage(error));
    } finally { setBusy(false); }
  }

  async function retry(): Promise<void> {
    if (!request.data || busy) return;
    setBusy(true);
    setError('');
    setPreview(null);
    setConfirmed(false);
    try {
      await credentialRequest(path + '/retry', 'POST', { request_revision: request.data.revision });
      setSelected('');
      onSaved();
      await request.refresh();
    } catch (error) {
      if (!(error instanceof CredentialsError || error instanceof TypeError)) throw error;
      setError(errorMessage(error));
      await request.refresh();
    } finally { setBusy(false); }
  }

  return <section class="ga-cred access-request-review" aria-label="Review access request">
    <h3>Review agent access</h3>
    <ErrorNotice message={request.error || error} />
    {request.loading ? <p role="status">Loading access request…</p> : null}
    {request.error ? <button type="button" onClick={() => void request.refresh()}>Retry</button> : null}
    {request.data ? <>
      <p>{request.data.reason}</p>
      <p><code>{request.data.resource_url}</code></p>
      {request.data.mcp_server ? <p>MCP server: {request.data.mcp_server}</p> : null}
      <p>Recipient agent: {request.data.agent_group_name ?? request.data.agent_group_id}</p>
      {request.data.authentication ? <p>Requested authentication: {ACCESS_AUTHENTICATION_LABELS[request.data.authentication.type]}
        {request.data.authentication.app_id ? ` · OAuth app: ${request.data.authentication.app_id}` : ''}
        {request.data.authentication.header ? ` · Header: ${request.data.authentication.header}` : ''}
        {request.data.authentication.prefix !== undefined ? ` · Public prefix: ${JSON.stringify(request.data.authentication.prefix)}` : ''}
        {request.data.authentication.headers?.length ? ` · Headers: ${request.data.authentication.headers.join(', ')}` : ''}
        . Review these agent suggestions before using them.</p> : null}
      {request.data.scopes?.length ? <p>Suggested scopes (not automatically granted): {request.data.scopes.join(' ')}</p> : null}
      {request.data.status !== 'pending' ? <div>
        <p role="status">{request.data.result?.message ?? request.data.status}</p>
        {request.data.status === 'failed' ? <button type="button" disabled={busy || signingIn}
          onClick={() => void retry()}>Review and retry</button> : null}
      </div> : <>
        <label>Personal connection
          <select aria-label="Connection for access request" value={selected} disabled={busy}
            onChange={event => setSelected(event.currentTarget.value)}>
            <option value="">Choose from your Credentials</option>
            {compatible.map(connection => <option value={connection.id} key={connection.id}>
              {connectionName(connection)}{connection.status === 'ready' ? '' : ` (${connection.status})`}
            </option>)}
          </select>
        </label>
        <p class="muted">Only credentials matching this URL and the requested authentication and scopes are listed. Unknown scope grants are not assumed to match.</p>
        {!compatible.length ? <p role="status">No credentials match this destination, authentication mechanism and requested scopes. Create one to continue.</p> : null}
        {createdMismatch && !selected ? <div role="alert">
          The new credential was saved, but its destination, authentication or provider-reported scopes do not meet this request. No access was granted.
          <button type="button" disabled={busy || signingIn} onClick={() => onManage(created)}>Review new credential</button>
        </div> : null}
        <button type="button" class={!compatible.length ? 'primary' : undefined} disabled={busy || signingIn}
          onClick={() => { setSelected(''); setPreview(null); setConfirmed(false); onCreate(request.data!); }}>Create new credential</button>
        <button type="button" disabled={busy} onClick={() => void reject()}>Reject request</button>
        {preview ? <>
          <h4>{connectionName(preview.connection)}</h4>
          {preview.connection.account ? <p>{preview.connection.account}</p> : null}
          <ul>{preview.connection.services.map(service => <li key={service.name}>
            {serviceDestination(service)} · {service.auth.type}
          </li>)}</ul>
          {preview.connection.kind !== 'static' ? <p>Provider-reported scopes: {preview.connection.granted_scopes?.join(' ') || 'Not reported; permissions are not verified.'}</p> : null}
          <p>{preview.grantBreadth}</p>
          <p>{preview.verification}</p>
          {preview.mcp?.names.length ? <div><label>
            <input type="checkbox" checked={configureMcp} disabled={busy}
              onChange={event => setConfigureMcp(event.currentTarget.checked)} />
            Pin this connection to one named MCP server and restart the requesting session.
          </label>
          {configureMcp ? <>
            <label>MCP server<select aria-label="MCP server for access request" value={mcpServer} disabled={busy || !!preview.request.mcp_server}
              onChange={event => {
                const name = event.currentTarget.value;
                setMcpServer(name); setAccountAlias(preview.mcp?.configured?.[name]?.account_alias || name);
              }}>
              <option value="">Choose one server</option>
              {preview.mcp.names.map(name => <option key={name} value={name}>{name}</option>)}
            </select></label>
            <label>Account alias<input aria-label="MCP account alias" value={accountAlias} maxLength={80} disabled={busy}
              onInput={event => setAccountAlias(event.currentTarget.value)} /></label>
            <p>Only {mcpServer || 'the selected server'} will change. Other servers using the same URL keep their own accounts. Manual Authorization is replaced by the host-managed connection.</p>
          </> : null}</div> : null}
          {!preview.matches ? <p role="status">This connection does not cover the requested destination. Do not extend OAuth routing just to match a hostname.</p> : null}
          {preview.connection.status !== 'ready' || !preview.matches ? <button type="button" disabled={busy || signingIn}
            onClick={() => onManage(preview.connection)}>Manage this connection</button> : null}
          <label><input type="checkbox" checked={confirmed} disabled={busy || !preview.matches || preview.connection.status !== 'ready'}
            onChange={event => setConfirmed(event.currentTarget.checked)} />
            Allow this agent to use this connection, including its full permissions and current and future URL patterns.
          </label>
          <button type="button" class="primary" disabled={busy || !confirmed || !preview.matches || preview.connection.status !== 'ready' || preview.request.status !== 'pending' || (configureMcp && (!mcpServer || !accountAlias.trim()))}
            onClick={() => void apply()}>{busy ? 'Applying…' : 'Allow access and continue'}</button>
        </> : null}
      </>}
    </> : null}
  </section>;
}
