import './Credentials.css';
import { useState } from 'preact/hooks';
import { AccessRequestReview } from './AccessRequestReview';
import { credentialsPath, type Connection, type CredentialsOverview } from './CredentialsApi';
import { useConnectionSignIn, useCredentialResource } from './CredentialsParts';
import { ConnectionActionDialog, ConnectionEditor, OAuthConnectionDialog } from './CredentialsDialogs';
import type { AccessRequirements } from '../../../../shared/access-authentication';

type AccountDialog = { kind: 'add'; request: AccessRequirements } | { kind: 'manage'; connection: Connection };

export function AccessRequestCard({ id, disabled }: { id: string; disabled?: boolean }) {
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
        id={id}
        connections={accounts.data?.connections ?? []}
        disabled={disabled}
        loadingAccounts={accounts.loading}
        accountsError={accounts.error}
        onReloadAccounts={saved}
        preferredConnectionId={created}
        signingIn={!!signIn.waiting}
        onCreate={(request) => setDialog({ kind: 'add', request })}
        onManage={(account) => setDialog({ kind: 'manage', connection: account })}
        onSaved={saved}
        signInMessage={
          signIn.waiting ? (
            <div class="access-sign-in" role="status">
              <p>Finish signing in to your {signIn.waiting.label} account.</p>
              <div class="question-card-actions approval-actions">
                <button type="button" class="approval-btn" onClick={signIn.reopen}>
                  Open sign-in window
                </button>
                <button type="button" class="approval-btn" onClick={signIn.stop}>
                  Stop waiting
                </button>
              </div>
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
            onStart={signIn.start}
            onSaved={saved}
            onClose={close}
          />
        ) : (
          <OAuthConnectionDialog
            connection={connection}
            apps={accounts.data.apps}
            onStart={signIn.start}
            onSaved={saved}
            onClose={close}
          />
        )
      ) : null}
    </>
  );
}
