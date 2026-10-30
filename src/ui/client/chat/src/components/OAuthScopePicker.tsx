import { useEffect, useRef, useState } from 'preact/hooks';
import type { JSX } from 'preact';
import { isOAuthScope } from '../../../../shared/oauth-app';
import { credentialRequest, credentialsPath, CredentialsError, errorMessage, type OAuthScopeOptions } from './CredentialsApi';
import { ErrorNotice } from './CredentialsParts';
import { scopeDiscoveryInput, scopeValues } from './oauth-scopes';

interface DiscoveryState {
  key: string;
  loading: boolean;
  data: OAuthScopeOptions | null;
  error: string;
}

export function OAuthScopePicker({ value, onChange, resource, appId, issuer, configured = [], disabled,
  unspecified, onUnspecified, label = 'Permissions' }: {
  value: string; onChange: (value: string) => void; resource?: string; appId?: string; issuer?: string;
  configured?: string[]; disabled: boolean; unspecified?: boolean; onUnspecified?: (value: boolean) => void; label?: string;
}): JSX.Element {
  const input = scopeDiscoveryInput({ resource, appId, issuer });
  const key = input ? JSON.stringify(input) : '';
  const [discovery, setDiscovery] = useState<DiscoveryState>({ key: '', loading: false, data: null, error: '' });
  const [retry, setRetry] = useState(0);
  const sequence = useRef(0);
  useEffect(() => {
    const request = ++sequence.current;
    const controller = new AbortController();
    if (!key) {
      setDiscovery({ key, loading: false, data: null, error: '' });
      return () => { sequence.current++; controller.abort(); };
    }
    setDiscovery({ key, loading: true, data: null, error: '' });
    const timer = setTimeout(() => {
      void credentialRequest<OAuthScopeOptions>(credentialsPath('/scopes'), 'POST', JSON.parse(key), controller.signal).then(data => {
        if (sequence.current === request) setDiscovery({ key, loading: false, data, error: '' });
      }).catch(error => {
        if (controller.signal.aborted) return;
        if (!(error instanceof CredentialsError || error instanceof TypeError)) throw error;
        if (sequence.current === request) setDiscovery({ key, loading: false, data: null, error: errorMessage(error) });
      });
    }, 500);
    return () => { sequence.current++; clearTimeout(timer); controller.abort(); };
  }, [key, retry]);
  const current = discovery.key === key ? discovery : null;
  const selected = scopeValues(value);
  const advertised = current?.data?.scopes ?? [];
  const choices = [...new Set([...advertised, ...configured, ...selected])].sort();
  const choose = (scope: string, checked: boolean): void =>
    onChange((checked ? [...selected, scope] : selected.filter(item => item !== scope)).sort().join('\n'));
  return <fieldset class="credential-scope-picker" disabled={disabled}>
    <legend>{label}</legend>
    {key && (!current || current.loading) ? <p class="muted" role="status">Discovering scope options…</p> : null}
    {!key ? <p class="muted">Enter a valid URL or select an OAuth app to discover scope options.</p> : null}
    {current?.error ? <>
      <ErrorNotice message={`Could not discover scope options: ${current.error}`} />
      <button type="button" class="ghost" onClick={() => setRetry(value => value + 1)}>Retry discovery</button>
    </> : null}
    {current?.data ? <p class="group-admin-help">
      {!current.data.oauth ? 'This resource did not advertise an OAuth challenge. Verify whether OAuth is required.' :
        current.data.source === 'not_advertised' ? 'No scopes were advertised. App defaults and custom scopes are still available.' :
          current.data.source === 'resource' ? 'Scopes advertised by this MCP resource.' : 'Scopes advertised by the authorization server; this list may be incomplete.'}
    </p> : null}
    {onUnspecified ? <label class="group-admin-check">
      <input type="checkbox" checked={unspecified} aria-label="Make no scope request"
        onChange={event => {
          onUnspecified(event.currentTarget.checked);
          if (event.currentTarget.checked) onChange('');
        }} />
      <span>Make no scope request (provider defaults)</span>
    </label> : null}
    {unspecified ? <p class="ga-cred-warn-text">The provider chooses the permissions. This does not mean no access.</p> : null}
    {choices.length ? <div class="credential-scope-options">{choices.map(scope => <label key={scope}>
      <input type="checkbox" aria-label={`Request scope ${scope}`} checked={selected.includes(scope)}
        disabled={unspecified} onChange={event => choose(scope, event.currentTarget.checked)} />
      <code>{scope}</code>
      <span class="muted">{advertised.includes(scope) ? 'Discovered' : configured.includes(scope) ? 'App default' : 'Custom'}</span>
    </label>)}</div> : null}
    {configured.length && onUnspecified ? <button type="button" class="ghost" onClick={() => {
      onUnspecified(false); onChange([...new Set(configured)].sort().join('\n'));
    }}>Use app defaults</button> : null}
    <details class="credential-custom-scopes"><summary>Custom scopes</summary>
      <textarea aria-label={label === 'Default scopes' ? 'Default scopes' : 'Custom scopes'} rows={3} value={value}
        disabled={unspecified} spellcheck={false} placeholder="One exact scope value per line"
        onInput={event => onChange(event.currentTarget.value)} />
    </details>
    {selected.some(scope => !isOAuthScope(scope)) ? <ErrorNotice message="Scope values must be printable ASCII without quotes or backslashes." /> : null}
    {onUnspecified && !unspecified && selected.length === 0 ? <p class="group-admin-help">Select scopes, enter custom values, or explicitly choose provider defaults.</p> : null}
  </fieldset>;
}
