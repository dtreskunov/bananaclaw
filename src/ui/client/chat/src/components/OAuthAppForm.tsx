import type { JSX } from 'preact';
import { GroupAdminField as Field } from './GroupAdminField';
import { CredentialAction } from './CredentialsTable';
import { CopyIcon, TrashIcon } from './ActionIcons';
import { showToast } from './Toast';
import type { OAuthAppDraft } from './oauth-app-form';
import { displayDestination } from './credential-presentation';
import { OAuthScopePicker } from './OAuthScopePicker';

export function OAuthAppForm({ draft, busy, onChange }: {
  draft: OAuthAppDraft; busy: boolean; onChange: (draft: OAuthAppDraft) => void;
}): JSX.Element {
  const update = (patch: Partial<OAuthAppDraft>): void => onChange({ ...draft, ...patch });
  return <>
    <input class="credential-name-input" type="text" aria-label="App name" placeholder="App name" value={draft.label}
      disabled={busy} onInput={(event) => update({ label: event.currentTarget.value })} />
    <Field label="Issuer URL" info="Provider URL used for discovery. Explicit endpoints can be configured below.">
      <input type="url" aria-label="Issuer URL" placeholder="https://accounts.example.com" value={displayDestination(draft.issuer)} disabled={busy}
        onInput={(event) => update({ issuer: event.currentTarget.value })} />
    </Field>
    <Field label="Client ID"><input type="text" aria-label="Client ID" value={draft.client_id} placeholder="Client ID from your provider"
      disabled={busy} onInput={(event) => update({ client_id: event.currentTarget.value })} /></Field>
    <Field label="Client authentication"><select aria-label="Client authentication" value={draft.token_endpoint_auth_method}
      disabled={busy} onChange={(event) => {
        const method = event.currentTarget.value;
        if (method === 'none' || method === 'client_secret_post' || method === 'client_secret_basic')
          update({ token_endpoint_auth_method: method });
        else showToast('Choose a supported client authentication method.', 'err');
      }}>
      <option value="none">Public client (no secret)</option>
      <option value="client_secret_post">Client secret in request body</option>
      <option value="client_secret_basic">Client secret with HTTP Basic</option>
    </select></Field>
    <Field label="API hosts" info="One exact hostname per line, optionally including a non-default port. HTTPS is required.">
      <textarea aria-label="API hosts" rows={3} value={draft.apiHosts} placeholder={'api.example.com\nfiles.example.com:8443'}
        disabled={busy} spellcheck={false} onInput={(event) => update({ apiHosts: event.currentTarget.value })} />
    </Field>
    <OAuthScopePicker label="Default scopes" issuer={draft.issuer} value={draft.scopes} disabled={busy}
      onChange={scopes => update({ scopes })} />
    <Field label="Callback URL" info="Register this redirect URL in your provider console.">
      <div class="credential-inline-field"><code class="credential-callback">{`${location.origin}/oauth/callback`}</code>
        <CredentialAction label="Copy callback URL" disabled={busy} onClick={() => {
          void navigator.clipboard.writeText(`${location.origin}/oauth/callback`).then(
            () => showToast('Callback URL copied'), () => showToast('Could not copy the callback URL', 'err'),
          );
        }}><CopyIcon /></CredentialAction>
      </div>
    </Field>
    <details class="credential-app-advanced">
      <summary>Advanced settings</summary>
      <Field label="Authorization endpoint"><input type="url" aria-label="Authorization endpoint" disabled={busy}
        placeholder="Discovered from issuer" value={displayDestination(draft.authorization_endpoint ?? '')}
        onInput={(event) => update({ authorization_endpoint: event.currentTarget.value })} /></Field>
      <Field label="Token endpoint"><input type="url" aria-label="Token endpoint" disabled={busy}
        placeholder="Discovered from issuer" value={displayDestination(draft.token_endpoint ?? '')}
        onInput={(event) => update({ token_endpoint: event.currentTarget.value })} /></Field>
      <Field label="Revocation endpoint"><input type="url" aria-label="Revocation endpoint" disabled={busy}
        placeholder="Optional" value={displayDestination(draft.revocation_endpoint ?? '')}
        onInput={(event) => update({ revocation_endpoint: event.currentTarget.value })} /></Field>
      <Field label="Account identity"><select aria-label="Account identity" value={draft.identity} disabled={busy}
        onChange={(event) => {
          const identity = event.currentTarget.value;
          if (identity === 'none' || identity === 'oidc' || identity === 'google' || identity === 'github') update({ identity });
          else showToast('Choose a supported account identity verifier.', 'err');
        }}>
        <option value="none">No identity verification</option><option value="oidc">OpenID Connect</option>
        <option value="google">Google</option><option value="github">GitHub</option>
      </select></Field>
      <Field label="Signing keys URL" info="Required for OpenID Connect identity verification.">
        <input type="url" aria-label="Signing keys URL" disabled={busy} placeholder="https://accounts.example.com/.well-known/jwks.json"
          value={displayDestination(draft.jwks_uri ?? '')} onInput={(event) => update({ jwks_uri: event.currentTarget.value })} />
      </Field>
      <Field label="Scope separator"><select aria-label="Scope separator" value={draft.token_scope_separator} disabled={busy}
        onChange={(event) => {
          const separator = event.currentTarget.value;
          if (separator === 'space' || separator === 'comma') update({ token_scope_separator: separator });
          else showToast('Choose a supported scope separator.', 'err');
        }}>
        <option value="space">Space</option><option value="comma">Comma</option>
      </select></Field>
      <fieldset class="credential-app-parameters" disabled={busy}>
        <legend>Authorization parameters</legend>
        {draft.parameters.map((parameter, index) => <div class="credential-inline-field" key={index}>
          <input type="text" aria-label={`Parameter ${index + 1} name`} placeholder="Parameter" value={parameter.name}
            onInput={(event) => update({ parameters: draft.parameters.map((item, at) => at === index ? { ...item, name: event.currentTarget.value } : item) })} />
          <input type="text" aria-label={`Parameter ${index + 1} value`} placeholder="Value" value={parameter.value}
            onInput={(event) => update({ parameters: draft.parameters.map((item, at) => at === index ? { ...item, value: event.currentTarget.value } : item) })} />
          <CredentialAction label={`Remove parameter ${index + 1}`} onClick={() =>
            update({ parameters: draft.parameters.filter((_, at) => at !== index) })}><TrashIcon /></CredentialAction>
        </div>)}
        <button type="button" class="ghost" onClick={() => update({ parameters: [...draft.parameters, { name: '', value: '' }] })}>Add parameter</button>
      </fieldset>
    </details>
  </>;
}
