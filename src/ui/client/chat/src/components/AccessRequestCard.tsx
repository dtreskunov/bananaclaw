import './Credentials.css';
import { useState } from 'preact/hooks';
import { AccessRequestReview } from './AccessRequestReview';
import { credentialsPath, type Connection, type CredentialsOverview } from './CredentialsApi';
import { useConnectionSignIn, useCredentialResource } from './CredentialsParts';
import { ConnectionActionDialog, ConnectionEditor, OAuthConnectionDialog } from './CredentialsDialogs';
import type { AccessRequirements } from '../../../../shared/access-authentication';
import type { AccountInteraction } from '../../../../shared/approval';
import { accountRequestStatusText } from './credential-presentation';
import { ApprovalCardFrame } from './ApprovalCard';
import { approvalThreadHref, isApprovalThread } from '../approval-origin';

type AccountDialog = { kind: 'add'; request: AccessRequirements } |
  { kind: 'manage'; connection: Connection; request?: AccessRequirements };

export function AccountRequestSummary({ request }: { request: AccountInteraction }) {
  return <ApprovalCardFrame approvalId={request.id} title={request.kind === 'account_setup' ? 'Set up an account' : 'Allow account access?'}>
    <div class="approval-text">
      <p>{request.requirements.reason}</p>
      <p class="access-destination">{request.requirements.resource_url}</p>
      {!isApprovalThread(request.origin) ? <p>{request.origin
        ? <a href={approvalThreadHref(request.origin)}>Open requesting thread</a>
        : 'Requesting thread unavailable.'}</p> : null}
      {request.status !== 'pending' ? <p role="status">{accountRequestStatusText(request)}</p> : null}
      {request.responseMessage ? <p class="approval-response-text">{request.responseMessage}</p> : null}
      {request.status === 'failed' && request.outcomeMessage ? <p role="alert">{request.outcomeMessage}</p> : null}
    </div>
  </ApprovalCardFrame>;
}

export function AccessRequestCard({ request, disabled }: { request: AccountInteraction; disabled?: boolean }) {
  const accounts = useCredentialResource<CredentialsOverview>(credentialsPath());
  const [dialog, setDialog] = useState<AccountDialog | null>(null);
  const [created, setCreated] = useState<string>();
  const signIn = useConnectionSignIn(() => void accounts.refresh());
  const close = (): void => setDialog(null);
  const saved = (): void => {
    void accounts.refresh();
  };
  const connection = dialog?.kind === 'manage' ? dialog.connection : undefined;
  return (
    <>
      <AccessRequestReview
        request={request}
        connections={accounts.data?.connections ?? []}
        apps={accounts.data?.apps ?? []}
        disabled={disabled}
        loadingAccounts={accounts.loading}
        accountsError={accounts.error}
        onReloadAccounts={saved}
        preferredConnectionId={created}
        signingIn={!!signIn.waiting}
        onCreate={(request) => setDialog({ kind: 'add', request })}
        onManage={(account, request) => setDialog({ kind: 'manage', connection: account, request })}
        onSaved={saved}
        signInMessage={
          signIn.waiting ? (
            <div class="access-sign-in" role="status">
              <div class="question-card-actions approval-actions">
                <a class="approval-btn" href={signIn.waiting.authorizeUrl} target="_blank" rel="noopener noreferrer"
                  onClick={event => { event.preventDefault(); signIn.reopen(); }}>Sign in</a>
                <button type="button" class="approval-btn" onClick={signIn.stop}>
                  Stop waiting
                </button>
              </div>
              <p class="access-destination">{new URL(signIn.waiting.authorizeUrl).origin}{new URL(signIn.waiting.authorizeUrl).pathname}</p>
            </div>
          ) : null
        }
      />
      {dialog?.kind === 'add' && accounts.data ? (
        <ConnectionEditor
          apps={accounts.data.apps}
          resourceUrl={dialog.request.resource_url}
          accessRequest={dialog.request}
          onCreated={(account) => setCreated(account.id)}
          onStart={signIn.start}
          onSaved={saved}
          onClose={close}
        />
      ) : null}
      {connection && accounts.data ? (
        connection.status === 'disabled' ? (
          <ConnectionActionDialog connection={connection} action="enable" onSaved={saved} onClose={close} />
        ) : connection.kind === 'static' ? (
          <ConnectionEditor
            id={connection.id}
            apps={accounts.data.apps}
            accessRequest={dialog?.kind === 'manage' ? dialog.request : undefined}
            onStart={signIn.start}
            onSaved={saved}
            onClose={close}
          />
        ) : (
          <OAuthConnectionDialog
            connection={connection}
            apps={accounts.data.apps}
            accessRequest={dialog?.kind === 'manage' ? dialog.request : undefined}
            onStart={signIn.start}
            onSaved={saved}
            onClose={close}
          />
        )
      ) : null}
    </>
  );
}
