import { useEffect, useState } from 'preact/hooks';
import { credentialRequest, credentialsPath, errorMessage, CredentialsError, type Connection } from './CredentialsApi';
import { ErrorNotice, useCredentialResource } from './CredentialsParts';
import { connectionName, serviceDestination } from './credential-presentation';
import { respondApproval } from '../actions';

interface AccessRequest {
  request_id: string;
  status: string;
  resource_url: string;
  reason: string;
  scopes?: string[];
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
  mcp?: { names: string[]; revision: string };
}

export function AccessRequestReview({ id, connections, onCreate, onManage, onSaved }: {
  id: string;
  connections: Connection[];
  onCreate: (resourceUrl: string) => void;
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
  const connectionVersion = JSON.stringify(connections.map(connection => [connection.id, connection.revision, connection.status]));
  useEffect(() => {
    setPreview(null);
    setConfirmed(false);
    setConfigureMcp(false);
    setError('');
    if (!selected) return;
    const controller = new AbortController();
    void credentialRequest<AccessPreview>(path + '/preview', 'POST', { connection_id: selected }, controller.signal)
      .then(value => { if (!controller.signal.aborted) setPreview(value); })
      .catch(error => {
        if (controller.signal.aborted) return;
        if (!(error instanceof CredentialsError || error instanceof TypeError)) throw error;
        setError(errorMessage(error));
      });
    return () => controller.abort();
  }, [path, selected, connectionVersion]);

  async function apply(): Promise<void> {
    if (!preview || !confirmed || busy) return;
    setBusy(true);
    setError('');
    try {
      await credentialRequest(path + '/apply', 'POST', {
        connection_id: preview.connection.id, connection_revision: preview.connection.revision,
        request_revision: preview.request.revision,
        configure_mcp: configureMcp, config_revision: preview.mcp?.revision,
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

  return <section class="ga-cred access-request-review" aria-label="Review access request">
    <h3>Review agent access</h3>
    <ErrorNotice message={request.error || error} />
    {request.loading ? <p role="status">Loading access request…</p> : null}
    {request.error ? <button type="button" onClick={() => void request.refresh()}>Retry</button> : null}
    {request.data ? <>
      <p>{request.data.reason}</p>
      <p><code>{request.data.resource_url}</code></p>
      <p>Recipient agent: {request.data.agent_group_name ?? request.data.agent_group_id}</p>
      {request.data.scopes?.length ? <p>Suggested scopes (not automatically granted): {request.data.scopes.join(' ')}</p> : null}
      {request.data.status !== 'pending' ? <p role="status">{request.data.result?.message ?? request.data.status}</p> : <>
        <label>Personal connection
          <select aria-label="Connection for access request" value={selected} disabled={busy}
            onChange={event => setSelected(event.currentTarget.value)}>
            <option value="">Choose from your Credentials</option>
            {connections.map(connection => <option value={connection.id} key={connection.id}>
              {connectionName(connection)}{connection.status === 'ready' ? '' : ` (${connection.status})`}
            </option>)}
          </select>
        </label>
        <button type="button" disabled={busy} onClick={() => onCreate(request.data!.resource_url)}>Add credential</button>
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
          {preview.connection.kind !== 'static' && preview.mcp?.names.length ? <label>
            <input type="checkbox" checked={configureMcp} disabled={busy}
              onChange={event => setConfigureMcp(event.currentTarget.checked)} />
            Configure {preview.mcp.names.join(', ')} to select this account and restart the requesting session.
          </label> : null}
          {!preview.matches ? <p role="status">This connection does not cover the requested destination. Do not extend OAuth routing just to match a hostname.</p> : null}
          {preview.connection.status !== 'ready' || !preview.matches ? <button type="button" disabled={busy}
            onClick={() => onManage(preview.connection)}>Manage this connection</button> : null}
          <label><input type="checkbox" checked={confirmed} disabled={busy || !preview.matches || preview.connection.status !== 'ready'}
            onChange={event => setConfirmed(event.currentTarget.checked)} />
            Allow this agent to use this connection, including its full permissions and current and future URL patterns.
          </label>
          <button type="button" class="primary" disabled={busy || !confirmed || !preview.matches || preview.connection.status !== 'ready' || preview.request.status !== 'pending'}
            onClick={() => void apply()}>{busy ? 'Applying…' : 'Allow access and continue'}</button>
        </> : null}
      </>}
    </> : null}
  </section>;
}
