import { useEffect, useRef, useState } from 'preact/hooks';
import type { ComponentChildren } from 'preact';
import { credentialRequest, credentialsPath, errorMessage, CredentialsError, type AppInfo, type Connection } from './CredentialsApi';
import { ErrorNotice } from './CredentialsParts';
import { accountRequestStatusText, connectionName, serviceDestination } from './credential-presentation';
import { respondInteraction } from '../actions';
import { approvalMessageDrafts, clearApprovalMessage } from '../approval-messages';
import { ApprovalMessageInput } from './ApprovalMessageInput';
import { ApprovalCardFrame } from './ApprovalCard';
import { approvalThreadHref, isApprovalThread } from '../approval-origin';
import type { AccountInteraction } from '../../../../shared/approval';
import { ACCESS_AUTHENTICATION_LABELS, connectionMatchesAccess, type AccessRequirements } from '../../../../shared/access-authentication';
import { accessCreationDefaults } from './credential-routing';

interface AccessPreview {
  requestRevision: number;
  connection: Connection;
  matches: boolean;
  grantBreadth: string;
  verification: string;
  mcp?: { names: string[]; revision: string; configured?: Record<string, { connection_id: string; account_alias: string } | undefined> };
}

function accountNickname(preview: AccessPreview, server: string): string {
  const configured = preview.mcp?.configured?.[server];
  return configured?.connection_id === preview.connection.id ? configured.account_alias :
    connectionName(preview.connection).replace(/\p{Cc}/gu, ' ').trim().slice(0, 80);
}

export function AccessRequestReview({ request, connections, preferredConnectionId, signingIn, onCreate, onManage, onSaved,
  disabled, loadingAccounts, accountsError, onReloadAccounts, signInMessage, apps = [] }: {
  request: AccountInteraction;
  connections: Connection[];
  apps?: AppInfo[];
  preferredConnectionId?: string;
  signingIn?: boolean;
  onCreate: (request: AccessRequirements) => void | Promise<void>;
  onManage: (connection: Connection, request?: AccessRequirements) => void;
  onSaved: () => void;
  disabled?: boolean;
  loadingAccounts?: boolean;
  accountsError?: string;
  onReloadAccounts?: () => void;
  signInMessage?: ComponentChildren;
}) {
  const { id, requirements } = request;
  const path = credentialsPath(`/access-requests/${encodeURIComponent(id)}`);
  const [selected, setSelected] = useState('');
  const [preview, setPreview] = useState<AccessPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [submitted, setSubmitted] = useState<string>();
  const [error, setError] = useState('');
  const [configureMcp, setConfigureMcp] = useState(false);
  const [mcpServer, setMcpServer] = useState('');
  const [accountAlias, setAccountAlias] = useState('');
  const preferred = useRef<string | undefined>();
  const setupAttempt = useRef<number>();
  const defaults = accessCreationDefaults(requirements, apps);
  const effectiveRequest = {
    ...requirements, ...(defaults?.scopes.length ? { scopes: defaults.scopes } : {}),
  };
  const compatible = connections.filter(connection => connectionMatchesAccess(connection, effectiveRequest));
  const compatibleSet = new Set(compatible.map(connection => connection.id));
  const created = connections.find(connection => connection.id === preferredConnectionId);
  const createdMismatch = created?.status === 'ready' && !compatibleSet.has(created.id);
  const reconnect = connections.filter(connection =>
    connection.kind !== 'static' && !compatibleSet.has(connection.id) &&
    !(createdMismatch && connection.id === created.id) &&
    connectionMatchesAccess(connection, { ...effectiveRequest, scopes: undefined }));
  const compatibleIds = JSON.stringify([...compatibleSet]);
  useEffect(() => {
    if (preferredConnectionId && preferred.current !== preferredConnectionId &&
      compatibleSet.has(preferredConnectionId)) {
      preferred.current = preferredConnectionId;
      setSelected(preferredConnectionId);
    } else if (selected && !compatibleSet.has(selected)) {
      setSelected('');
    }
  }, [preferredConnectionId, compatibleIds, selected, request]);
  const connectionVersion = JSON.stringify(connections.map(connection => [connection.id, connection.revision, connection.status,
    connection.requested_scopes, connection.granted_scopes, connection.scope_source]));
  const chosen = compatible.find(connection => connection.id === selected);
  const here = isApprovalThread(request.origin);
  const awaiting = submitted === `${id}:${request.revision}`;
  const blocked = busy || awaiting || !!signingIn || !!disabled || !!loadingAccounts || !!accountsError;
  const setup = request.kind === 'account_setup' ||
    (!loadingAccounts && !accountsError && !compatible.some(connection => connection.status === 'ready'));
  const oauth = defaults?.kind !== undefined && defaults.kind !== 'static';
  const authorizationUrl = URL.parse(apps.find(app => app.id === defaults?.appId)?.authorization_endpoint ?? '');
  const signInDestination = authorizationUrl?.protocol === 'https:' && !authorizationUrl.username && !authorizationUrl.password
    ? authorizationUrl.origin + authorizationUrl.pathname : undefined;
  const canApply = here && !blocked &&
    chosen?.status === 'ready' && preview?.matches && preview.connection.status === 'ready' &&
    preview.connection.id === selected && chosen.revision === preview.connection.revision &&
    request.status === 'pending' &&
    preview.requestRevision === request.revision &&
    (setup ? request.kind === 'account_setup' : !configureMcp || (!!mcpServer && !!accountAlias.trim()));
  const failed = request.status === 'failed';
  useEffect(() => {
    setPreview(null);
    setConfigureMcp(false);
    if (request.status !== 'pending') return;
    setError('');
    if (!selected) return;
    const controller = new AbortController();
    void credentialRequest<AccessPreview>(path + '/preview', 'POST', { connection_id: selected }, controller.signal)
      .then(value => {
        if (controller.signal.aborted) return;
        setPreview(value);
        const name = requirements.mcp_server ?? (value.mcp?.names.length === 1 ? value.mcp.names[0] : '');
        setMcpServer(name);
        setAccountAlias(accountNickname(value, name));
      })
      .catch(error => {
        if (controller.signal.aborted) return;
        if (!(error instanceof CredentialsError || error instanceof TypeError)) throw error;
        setError(errorMessage(error));
      });
    return () => controller.abort();
  }, [path, selected, connectionVersion, request.revision, request.status]);

  async function runCredentialAction(
    action: () => void | Promise<void>,
    onFailure: (error: CredentialsError | TypeError) => void = error => setError(errorMessage(error)),
  ): Promise<boolean> {
    setBusy(true);
    setError('');
    try {
      await action();
      return true;
    } catch (error) {
      if (!(error instanceof CredentialsError || error instanceof TypeError)) throw error;
      onFailure(error);
      return false;
    } finally { setBusy(false); }
  }

  async function prepareSetup(): Promise<boolean> {
    if (blocked || !here || request.status !== 'pending') return false;
    if (request.kind === 'account_setup') return true;
    setPreview(null);
    setConfigureMcp(false);
    return runCredentialAction(async () => {
      await credentialRequest(path + '/setup', 'POST', { request_revision: request.revision });
      setSubmitted(`${id}:${request.revision}`);
      onSaved();
    }, error => setError(error instanceof CredentialsError && error.status === 404 && error.message === 'not_found'
      ? 'Account setup unavailable. Reload and retry.' : errorMessage(error)));
  }

  useEffect(() => {
    if (!setup || request.kind === 'account_setup' || request.status !== 'pending' ||
      blocked || !here || setupAttempt.current === request.revision) return;
    setupAttempt.current = request.revision;
    void prepareSetup();
  }, [setup, request.kind, request.revision, request.status, blocked, here]);

  async function addAccount(): Promise<void> {
    if (!(await prepareSetup())) return;
    await runCredentialAction(() => onCreate(effectiveRequest));
  }

  async function manageAccount(account: Connection): Promise<void> {
    if (await prepareSetup()) onManage(account, effectiveRequest);
  }

  async function apply(): Promise<void> {
    if (!preview || !canApply) return;
    await runCredentialAction(async () => {
      const message = approvalMessageDrafts.value[id]?.trim();
      await credentialRequest(path + (setup ? '/account' : '/apply'), 'POST', {
        connection_id: preview.connection.id, connection_revision: preview.connection.revision,
        request_revision: preview.requestRevision,
        ...(!setup ? {
          configure_mcp: configureMcp, config_revision: preview.mcp?.revision,
          ...(configureMcp ? { mcp_server: mcpServer, account_alias: accountAlias } : {}),
        } : {}),
        ...(message ? { message } : {}),
      });
      clearApprovalMessage(id);
      setSubmitted(`${id}:${request.revision}`);
      setPreview(null);
      onSaved();
    }, error => {
      setError(errorMessage(error));
      setPreview(null);
      onSaved();
    });
  }

  useEffect(() => {
    if (setup && created?.status === 'ready' && selected === created.id && canApply) void apply();
  }, [setup, created?.id, created?.status, selected, canApply]);

  async function reject(): Promise<void> {
    if (!isApprovalThread(request.origin)) return;
    setBusy(true);
    setError('');
    try {
      if (await respondInteraction(id, { value: 'reject', message: approvalMessageDrafts.value[id] }))
        setSubmitted(`${id}:${request.revision}`);
    } catch (error) {
      setError(errorMessage(error));
    } finally { setBusy(false); }
  }

  async function retry(): Promise<void> {
    if (blocked || !isApprovalThread(request.origin)) return;
    setPreview(null);
    setConfigureMcp(false);
    await runCredentialAction(async () => {
      await credentialRequest(path + '/retry', 'POST', { request_revision: request.revision });
      setSubmitted(`${id}:${request.revision}`);
      setSelected('');
      onSaved();
    });
  }

  const agentName = request.agentGroupName;
  const accountStatus: Record<Connection['status'], string> = {
    ready: 'Ready', draft: 'Needs sign-in', needs_reconnect: 'Sign in again', disabled: 'Turned off',
  };
  return <ApprovalCardFrame approvalId={id} title={setup ? 'Set up an account' : 'Allow account access?'}>
    <div class="approval-text access-request-review">
    <ErrorNotice message={failed ? "Couldn't finish setup. Some changes may have applied." : error} />
    {awaiting ? <p role="status">Waiting for confirmation…</p> : null}
      {requirements.mcp_server ? <p><strong>Tools:</strong> {requirements.mcp_server}</p> : null}
      {!setup ? <blockquote class="access-request-reason">{requirements.reason}</blockquote> : null}
      {request.status !== 'pending' ? <div>
        {!failed ? <p role="status">{accountRequestStatusText(request)}</p> : null}
        {request.retryable && here ? <button type="button" class="approval-btn" disabled={blocked}
          onClick={() => void retry()}>Review and retry</button> : null}
      </div> : !here ? <p>{request.origin
        ? <a href={approvalThreadHref(request.origin)}>Open requesting thread</a>
        : 'Requesting thread unavailable.'}</p> : <>
        {loadingAccounts ? <p role="status">Loading accounts…</p> : null}
        <ErrorNotice message={accountsError ?? ''} />
        {accountsError ? <button type="button" class="approval-btn" onClick={onReloadAccounts}>Try again</button> : null}
        {compatible.length && !signingIn ? <fieldset class="access-accounts" disabled={blocked}>
          {compatible.length > 1 ? <legend>Choose an account</legend> : null}
          {compatible.map(connection => <label class="access-account-option" key={connection.id}>
            <input type="radio" name={`account-${id}`} aria-label={`Account: ${connectionName(connection)}${connection.account ? ` (${connection.account})` : ''}`}
              value={connection.id} checked={selected === connection.id}
              onChange={() => setSelected(connection.id)} />
            <span><span class="access-account-name"><strong>Account:</strong> {connectionName(connection)}</span>
              {connection.account ? <span class="access-account-identity">{connection.account}</span> : null}
              <span class="muted">{accountStatus[connection.status]}</span>
              {connection.status !== 'ready' ? <button type="button" class="approval-btn" disabled={blocked}
                onClick={() => void manageAccount(connection)}>{connection.status === 'disabled' ? 'Enable' :
                  connection.kind === 'static' ? 'Update account' : 'Sign in'}</button> : null}
            </span>
          </label>)}
        </fieldset> : null}
        {!signingIn ? reconnect.map(connection => <div class="access-account-option" key={connection.id}>
          <span><span class="access-account-name"><strong>Account:</strong> {connectionName(connection)}</span>
            {connection.account ? <span class="access-account-identity">{connection.account}</span> : null}
          </span>
          <button type="button" class="approval-btn" disabled={blocked}
            onClick={() => void manageAccount(connection)}>{connection.status === 'disabled' ? 'Enable' : 'Sign in'}</button>
        </div>) : null}
        {createdMismatch && !selected ? <div role="alert">
          This account doesn't match the request. No access was granted.
          <button type="button" class="approval-btn" disabled={blocked}
            onClick={() => onManage(created, effectiveRequest)}>Review the new account</button>
        </div> : null}
        {(compatible.length || reconnect.length) && !signingIn ? <button type="button" class="approval-btn" disabled={blocked}
          onClick={() => { setSelected(''); setPreview(null); return addAccount(); }}>Add account</button>
          : null}
        {signInMessage}
        {preview ? <>
          {!setup && preview.mcp?.names.length ? <div class="access-tools-choice"><label>
            <input type="checkbox" checked={configureMcp} disabled={blocked}
              onChange={event => setConfigureMcp(event.currentTarget.checked)} />
            Use this account with {mcpServer ? `${mcpServer} tools` : 'these tools'}
          </label>
          {configureMcp ? <>
            {!requirements.mcp_server ? <label>Tools<select aria-label="Tools for this account" value={mcpServer} disabled={blocked}
              onChange={event => {
                const name = event.currentTarget.value;
                setMcpServer(name); setAccountAlias(accountNickname(preview, name));
              }}>
              <option value="">Choose tools</option>
              {preview.mcp.names.map(name => <option key={name} value={name}>{name}</option>)}
            </select></label> : null}
              <label>Name the agent sees<input type="text" class="question-card-input" aria-label="Account name shown to agent" value={accountAlias} maxLength={80} disabled={blocked}
                onInput={event => setAccountAlias(event.currentTarget.value)} /></label>
          </> : null}</div> : null}
          {!preview.matches ? <p role="status">This account doesn't match the request.</p> : null}
          {preview.connection.status !== 'ready' || !preview.matches ? <button type="button" class="approval-btn" disabled={blocked}
            onClick={() => void manageAccount(preview.connection)}>Manage this account</button> : null}
        </> : null}
      </>}
      {setup ? <>
        {!signingIn && signInDestination ? <p class="access-destination">{signInDestination}</p> : null}
      </> : <section class="access-more-information" aria-label="Access details">
        <p><strong>Website:</strong> <span class="access-destination">{requirements.resource_url}</span></p>
        {requirements.authentication ? <p><strong>Account type:</strong> {ACCESS_AUTHENTICATION_LABELS[requirements.authentication.type]}
          {requirements.authentication.app_id ? ` · App: ${requirements.authentication.app_id}` : ''}
        </p> : null}
        {requirements.authentication?.header ? <p>Sign-in field: {requirements.authentication.header}</p> : null}
        {requirements.authentication?.parameter ? <p>Sign-in field in the website address: {requirements.authentication.parameter}</p> : null}
        {requirements.authentication?.prefix !== undefined ? <p>The value starts with: {JSON.stringify(requirements.authentication.prefix)}</p> : null}
        {requirements.authentication?.headers?.length ? <p>Sign-in fields: {requirements.authentication.headers.join(', ')}</p> : null}
        {requirements.scopes?.length ? <><p>Needed permissions:</p><ul>{requirements.scopes.map(scope => <li key={scope}>{scope}</li>)}</ul></> : null}
        {preview ? <>
          <p>This account is set up for:</p>
          <ul>{preview.connection.services.map(service => <li key={service.name}>
            {serviceDestination(service)}
          </li>)}</ul>
          {preview.connection.kind !== 'static' ? <p>
            <strong>Enabled permissions:</strong>{' '}
            {preview.connection.scope_source === 'provider' ? preview.connection.granted_scopes?.join(', ') || 'Not reported.' : 'Not confirmed by the provider.'}
          </p> : null}
          <p>The agent receives all enabled permissions on this account to act on your behalf.</p>
        </> : null}
        {failed && error ? <p>{error}</p> : null}
        {request.outcomeMessage && request.outcomeMessage !== error ? <p>{request.outcomeMessage}</p> : null}
      </section>}
      {request.status === 'pending' && here ? <>
        {!setup && preview && selected ? <p class="access-decision-summary">
          {agentName} can use the <strong>{connectionName(preview.connection)} account</strong>.
          {configureMcp ? ` ${mcpServer || 'The selected'} tools will also use this account.` : ''}
        </p> : null}
        {!signingIn && (!setup || compatible.length) ? <ApprovalMessageInput approvalId={id} disabled={blocked} /> : null}
        <div class="question-card-actions approval-actions">
          <button type="button" class="approval-btn approval-reject" disabled={blocked} onClick={() => void reject()}>Decline</button>
          {!compatible.length && !reconnect.length && !signingIn ? <button type="button" class="approval-btn primary" disabled={blocked}
            onClick={() => addAccount()}>{busy ? 'Starting…' : oauth ? 'Sign in' : 'Add account'}</button> : null}
          {!setup || chosen?.status === 'ready' ? <button type="button" class="approval-btn approval-approve primary" disabled={!canApply}
            onClick={() => void apply()}>{busy ? 'Applying…' : setup ? 'Confirm account setup' : 'Allow access'}</button> : null}
        </div>
    </> : null}
    </div>
  </ApprovalCardFrame>;
}
