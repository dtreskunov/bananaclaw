import { useEffect, useRef, useState } from 'preact/hooks';
import type { ComponentChildren } from 'preact';
import { credentialRequest, credentialsPath, errorMessage, CredentialsError, type Connection } from './CredentialsApi';
import { ErrorNotice, useCredentialResource } from './CredentialsParts';
import { connectionName, serviceDestination } from './credential-presentation';
import { respondApproval } from '../actions';
import { approvalMessageDrafts, clearApprovalMessage } from '../approval-messages';
import { ApprovalMessageInput } from './ApprovalMessageInput';
import { ApprovalCardFrame } from './ApprovalCard';
import { approvalThreadHref, isApprovalThread } from '../approval-origin';
import type { ApprovalOrigin } from '../../../../shared/approval';
import { ACCESS_AUTHENTICATION_LABELS, connectionMatchesAccess, type AccessRequirements } from '../../../../shared/access-authentication';

interface AccessRequest extends AccessRequirements {
  origin?: ApprovalOrigin | null;
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

export function AccessRequestReview({ id, connections, preferredConnectionId, signingIn, onCreate, onManage, onSaved,
  disabled, loadingAccounts, accountsError, onReloadAccounts, signInMessage }: {
  id: string;
  connections: Connection[];
  preferredConnectionId?: string;
  signingIn?: boolean;
  onCreate: (request: AccessRequirements) => void;
  onManage: (connection: Connection) => void;
  onSaved: () => void;
  disabled?: boolean;
  loadingAccounts?: boolean;
  accountsError?: string;
  onReloadAccounts?: () => void;
  signInMessage?: ComponentChildren;
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
  const here = isApprovalThread(request.data?.origin);
  const blocked = busy || !!signingIn || !!disabled || !!loadingAccounts || !!accountsError;
  const canApply = here && !blocked && chosen?.status === 'ready' && preview?.matches && preview.connection.status === 'ready' &&
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
    if (!preview || !canApply || !isApprovalThread(request.data?.origin)) return;
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
    if (!isApprovalThread(request.data?.origin)) return;
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
    if (!request.data || busy || !isApprovalThread(request.data.origin)) return;
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

  const agentName = request.data?.agent_group_name ?? 'the agent';
  const accountStatus: Record<Connection['status'], string> = {
    ready: 'Ready', draft: 'Needs sign-in', needs_reconnect: 'Sign in again', disabled: 'Turned off',
  };
  return <ApprovalCardFrame approvalId={id} title={`Let ${agentName} use an account?`}>
    <div class="approval-text access-request-review">
    <ErrorNotice message={request.error || (failed ? "Couldn't finish setup. Some changes may have applied." : error)} />
    {request.loading ? <p role="status">Loading the request…</p> : null}
    {request.error ? <button type="button" class="approval-btn" onClick={() => void request.refresh()}>Try again</button> : null}
    {request.data ? <>
      {request.data.mcp_server ? <p><strong>Tools:</strong> {request.data.mcp_server}</p> : null}
      <blockquote class="access-request-reason">{request.data.reason}</blockquote>
      {request.data.status !== 'pending' ? <div>
        {!failed ? <p role="status">{STATUS_LABELS[request.data.status] ?? request.data.status}</p> : null}
        {request.data.status === 'failed' && here ? <button type="button" class="approval-btn" disabled={blocked}
          onClick={() => void retry()}>Review and retry</button> : null}
      </div> : !here ? <p>{request.data.origin
        ? <a href={approvalThreadHref(request.data.origin)}>Open requesting thread</a>
        : 'Requesting thread unavailable.'}</p> : <>
        <fieldset class="access-accounts" disabled={busy || signingIn || disabled || loadingAccounts}>
          <legend>Choose an account</legend>
          {loadingAccounts ? <p role="status">Loading your accounts…</p> : null}
          <ErrorNotice message={accountsError ?? ''} />
          {accountsError ? <button type="button" class="approval-btn" onClick={onReloadAccounts}>Try again</button> : null}
          {compatible.map(connection => <label class="access-account-option" key={connection.id}>
            <input type="radio" name={`account-${id}`} aria-label={`Account: ${connectionName(connection)}${connection.account ? ` (${connection.account})` : ''}`}
              value={connection.id} checked={selected === connection.id}
              onChange={() => setSelected(connection.id)} />
            <span><span class="access-account-name"><strong>Account:</strong> {connectionName(connection)}</span>
              {connection.account ? <span class="access-account-identity">{connection.account}</span> : null}
              <span class="muted">{accountStatus[connection.status]}</span>
            </span>
          </label>)}
          {!loadingAccounts && !accountsError && !compatible.length ? <p role="status">No matching accounts. Add one to continue.</p> : null}
        </fieldset>
        {createdMismatch && !selected ? <div role="alert">
          This account doesn't match the request. No access was granted.
          <button type="button" class="approval-btn" disabled={blocked} onClick={() => onManage(created)}>Review the new account</button>
        </div> : null}
        <button type="button" class="approval-btn" disabled={blocked}
          onClick={() => { setSelected(''); setPreview(null); onCreate(request.data!); }}>Add account</button>
        {signInMessage}
        {preview ? <>
          {preview.mcp?.names.length ? <div class="access-tools-choice"><label>
            <input type="checkbox" checked={configureMcp} disabled={blocked}
              onChange={event => setConfigureMcp(event.currentTarget.checked)} />
            Use this account with {mcpServer ? `${mcpServer} tools` : 'these tools'}
          </label>
          <p class="muted">Changes which account these tools use. Leave this off to keep their current account.</p>
          {configureMcp ? <>
            {!preview.request.mcp_server ? <label>Tools<select aria-label="Tools for this account" value={mcpServer} disabled={blocked}
              onChange={event => {
                const name = event.currentTarget.value;
                setMcpServer(name); setAccountAlias(accountNickname(preview, name));
              }}>
              <option value="">Choose tools</option>
              {preview.mcp.names.map(name => <option key={name} value={name}>{name}</option>)}
            </select></label> : null}
            <p class="muted">The agent will briefly reconnect to use this account.</p>
              <label>Name the agent sees<input type="text" class="question-card-input" aria-label="Account name shown to agent" value={accountAlias} maxLength={80} disabled={blocked}
                onInput={event => setAccountAlias(event.currentTarget.value)} /></label>
          </> : null}</div> : null}
          {!preview.matches ? <p role="status">This account doesn't match the request.</p> : null}
          {preview.connection.status !== 'ready' || !preview.matches ? <button type="button" class="approval-btn" disabled={blocked}
            onClick={() => onManage(preview.connection)}>Manage this account</button> : null}
        </> : null}
      </>}
      <section class="access-more-information" aria-label="More information">
        <p><strong>More information</strong></p>
        <p><strong>Website:</strong> <span class="access-destination">{request.data.resource_url}</span></p>
        {request.data.authentication ? <p><strong>Account type:</strong> {ACCESS_AUTHENTICATION_LABELS[request.data.authentication.type]}
          {request.data.authentication.app_id ? ` · App: ${request.data.authentication.app_id}` : ''}
        </p> : null}
        {request.data.authentication?.header ? <p>Sign-in field: {request.data.authentication.header}</p> : null}
        {request.data.authentication?.parameter ? <p>Sign-in field in the website address: {request.data.authentication.parameter}</p> : null}
        {request.data.authentication?.prefix !== undefined ? <p>The value starts with: {JSON.stringify(request.data.authentication.prefix)}</p> : null}
        {request.data.authentication?.headers?.length ? <p>Sign-in fields: {request.data.authentication.headers.join(', ')}</p> : null}
        {request.data.scopes?.length ? <><p>Requested permissions:</p><ul>{request.data.scopes.map(scope => <li key={scope}>{scope}</li>)}</ul></> : null}
        {preview ? <>
          <p>This account is set up for:</p>
          <ul>{preview.connection.services.map(service => <li key={service.name}>
            {serviceDestination(service)}
          </li>)}</ul>
          {preview.connection.kind !== 'static' ? <p>
            {preview.connection.scope_source === 'provider' ? 'Permissions reported by the service: ' : 'Saved permissions (not confirmed): '}
            {preview.connection.granted_scopes?.join(', ') || 'Not reported.'}
          </p> : null}
          <p>The agent will check that this account works after you allow access.</p>
          {configureMcp ? <p>Only {mcpServer || 'the selected tools'} will switch accounts. Your other tools stay the same.</p> : null}
        </> : null}
        {failed && error ? <p>{error}</p> : null}
        {request.data.result?.message && request.data.result.message !== error ? <p>{request.data.result.message}</p> : null}
      </section>
      {request.data.status === 'pending' && here ? <>
        {preview && selected ? <p class="access-decision-summary">
          {agentName} can use the <strong>{connectionName(preview.connection)} account</strong>.
          {configureMcp ? ` ${mcpServer || 'The selected'} tools will also use this account.` : ' Your tools will keep their current account.'}
        </p> : null}
        <ApprovalMessageInput approvalId={id} disabled={blocked} />
        <div class="question-card-actions approval-actions">
          <button type="button" class="approval-btn approval-reject" disabled={busy || disabled} onClick={() => void reject()}>Decline</button>
          <button type="button" class="approval-btn approval-approve primary" disabled={!canApply}
            onClick={() => void apply()}>{busy ? 'Applying…' : 'Allow access'}</button>
        </div>
      </> : null}
    </> : null}
    </div>
  </ApprovalCardFrame>;
}
