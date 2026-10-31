import { useEffect, useRef, useState } from 'preact/hooks';
import { credentialRequest, credentialsPath, errorMessage, CredentialsError, type Connection } from './CredentialsApi';
import { ErrorNotice, useCredentialResource } from './CredentialsParts';
import { connectionName, serviceDestination } from './credential-presentation';
import { respondApproval } from '../actions';
import { approvalMessageDrafts, clearApprovalMessage } from '../approval-messages';
import { ApprovalMessageInput } from './ApprovalMessageInput';
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

const STATUS_LABELS: Record<string, string> = {
  applying: 'Applying access...',
  completed: 'Access granted.',
  rejected: 'Request declined.',
  cancelled: 'Request cancelled.',
  expired: 'Request expired.',
};

function accountNickname(preview: AccessPreview, server: string): string {
  const configured = preview.mcp?.configured?.[server];
  return configured?.connection_id === preview.connection.id ? configured.account_alias :
    connectionName(preview.connection).replace(/\p{Cc}/gu, ' ').trim().slice(0, 80);
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
  const chosen = connections.find(connection => connection.id === selected);
  const canApply = !busy && !signingIn && chosen?.status === 'ready' && preview?.matches && preview.connection.status === 'ready' &&
    preview.connection.id === selected && chosen?.revision === preview.connection.revision &&
    request.data?.status === 'pending' && preview.request.status === 'pending' &&
    preview.request.revision === request.data.revision &&
    (!configureMcp || (!!mcpServer && !!accountAlias.trim()));
  const failed = request.data?.status === 'failed';
  useEffect(() => {
    setPreview(null);
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
        setAccountAlias(accountNickname(value, name));
      })
      .catch(error => {
        if (controller.signal.aborted) return;
        if (!(error instanceof CredentialsError || error instanceof TypeError)) throw error;
        setError(errorMessage(error));
      });
    return () => controller.abort();
  }, [path, selected, connectionVersion, request.data?.revision, request.data?.status]);

  async function apply(): Promise<void> {
    if (!preview || !canApply) return;
    setBusy(true);
    setError('');
    try {
      const message = approvalMessageDrafts.value[id]?.trim();
      await credentialRequest(path + '/apply', 'POST', {
        connection_id: preview.connection.id, connection_revision: preview.connection.revision,
        request_revision: preview.request.revision,
        configure_mcp: configureMcp, config_revision: preview.mcp?.revision,
        ...(configureMcp ? { mcp_server: mcpServer, account_alias: accountAlias } : {}),
        ...(message ? { message } : {}),
      });
      clearApprovalMessage(id);
      setPreview(null);
      await request.refresh();
      onSaved();
    } catch (error) {
      if (!(error instanceof CredentialsError || error instanceof TypeError)) throw error;
      setError(errorMessage(error));
      setPreview(null);
      await request.refresh();
      onSaved();
    } finally { setBusy(false); }
  }

  async function reject(): Promise<void> {
    setBusy(true);
    setError('');
    try {
      await respondApproval(id, 'reject', approvalMessageDrafts.value[id]);
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
    setConfigureMcp(false);
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
    <h3>Allow agent access</h3>
    <ErrorNotice message={request.error || (failed ? "Couldn't finish setup. Some changes may have applied." : error)} />
    {request.loading ? <p role="status">Loading access request…</p> : null}
    {request.error ? <button type="button" onClick={() => void request.refresh()}>Retry</button> : null}
    {request.data ? <>
      <p><strong>{request.data.agent_group_name ?? request.data.agent_group_id}</strong> · <code>{new URL(request.data.resource_url).host}</code></p>
      {request.data.status !== 'pending' ? <div>
        {!failed ? <p role="status">{STATUS_LABELS[request.data.status] ?? request.data.status}</p> : null}
        {request.data.status === 'failed' ? <button type="button" disabled={busy || signingIn}
          onClick={() => void retry()}>Review and retry</button> : null}
      </div> : <>
        <label>Account
          <select aria-label="Account" value={selected} disabled={busy}
            onChange={event => setSelected(event.currentTarget.value)}>
            <option value="">Choose an account</option>
            {compatible.map(connection => <option value={connection.id} key={connection.id}>
              {connectionName(connection)}{connection.account ? ` (${connection.account})` : ''}{connection.status === 'ready' ? '' : ` (${connection.status})`}
            </option>)}
          </select>
        </label>
        {!compatible.length ? <p role="status">No matching accounts. Add one to continue.</p> : null}
        {createdMismatch && !selected ? <div role="alert">
          This account doesn't match the request. No access was granted.
          <button type="button" disabled={busy || signingIn} onClick={() => onManage(created)}>Review new credential</button>
        </div> : null}
        <ApprovalMessageInput approvalId={id} disabled={busy || signingIn === true} />
        <button type="button" class={!compatible.length ? 'primary' : undefined} disabled={busy || signingIn}
          onClick={() => { setSelected(''); setPreview(null); onCreate(request.data!); }}>Add account</button>
        <button type="button" disabled={busy} onClick={() => void reject()}>Decline</button>
        {preview ? <>
          {preview.mcp?.names.length ? <div><label>
            <input type="checkbox" checked={configureMcp} disabled={busy}
              onChange={event => setConfigureMcp(event.currentTarget.checked)} />
            Use for {mcpServer || 'an MCP server'}
          </label>
          {configureMcp ? <>
            {!preview.request.mcp_server ? <label>MCP server<select aria-label="MCP server for access request" value={mcpServer} disabled={busy}
              onChange={event => {
                const name = event.currentTarget.value;
                setMcpServer(name); setAccountAlias(accountNickname(preview, name));
              }}>
              <option value="">Choose one server</option>
              {preview.mcp.names.map(name => <option key={name} value={name}>{name}</option>)}
            </select></label> : null}
            <p class="muted">Restarts the requesting session.</p>
            <details><summary>Customize name</summary>
              <label>Nickname<input aria-label="Account nickname" value={accountAlias} maxLength={80} disabled={busy}
                onInput={event => setAccountAlias(event.currentTarget.value)} /></label>
            </details>
          </> : null}</div> : null}
          {!preview.matches ? <p role="status">This account doesn't match the request.</p> : null}
          {preview.connection.status !== 'ready' || !preview.matches ? <button type="button" disabled={busy || signingIn}
            onClick={() => onManage(preview.connection)}>Manage this connection</button> : null}
          <button type="button" class="primary" disabled={!canApply}
            onClick={() => void apply()}>{busy ? 'Applying…' : 'Allow access'}</button>
        </> : null}
      </>}
      <details><summary>Details</summary>
        <p>Agent's explanation: {request.data.reason}</p>
        <p><code>{request.data.resource_url}</code></p>
        {request.data.mcp_server ? <p>MCP server: {request.data.mcp_server}</p> : null}
        {request.data.authentication ? <p>Requested authentication: {ACCESS_AUTHENTICATION_LABELS[request.data.authentication.type]}
          {request.data.authentication.app_id ? ` · OAuth app: ${request.data.authentication.app_id}` : ''}
          {request.data.authentication.header ? ` · Header: ${request.data.authentication.header}` : ''}
          {request.data.authentication.parameter ? ` · Query parameter: ${request.data.authentication.parameter}` : ''}
          {request.data.authentication.prefix !== undefined ? ` · Public prefix: ${JSON.stringify(request.data.authentication.prefix)}` : ''}
          {request.data.authentication.headers?.length ? ` · Headers: ${request.data.authentication.headers.join(', ')}` : ''}
        </p> : null}
        {request.data.scopes?.length ? <p>Suggested scopes: {request.data.scopes.join(' ')}</p> : null}
        {preview ? <>
          <ul>{preview.connection.services.map(service => <li key={service.name}>
            {serviceDestination(service)} · {service.auth.type}
          </li>)}</ul>
          {preview.connection.kind !== 'static' ? <p>Provider-reported scopes: {preview.connection.granted_scopes?.join(' ') || 'Not reported; permissions are not verified.'}</p> : null}
          <p>{preview.verification}</p>
          {configureMcp ? <p>Only {mcpServer || 'the selected server'} changes. Manual Authorization is replaced by this account; other servers are unchanged.</p> : null}
        </> : null}
        {failed && error ? <p>{error}</p> : null}
        {request.data.result?.message && request.data.result.message !== error ? <p>{request.data.result.message}</p> : null}
      </details>
    </> : null}
  </section>;
}
