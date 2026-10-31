import './GroupAdminPackages.css';
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

export function ScopeList({ scopes, disabled, onRemove }: {
  scopes: string[]; disabled?: boolean; onRemove?: (scope: string) => void;
}): JSX.Element {
  return <ul class="ga-package-chips credential-scope-chips">{scopes.map(scope => <li class="ga-package-chip" key={scope}>
    <span class="ga-package-chip-label">{scope}</span>
    {onRemove ? <button type="button" class="ga-package-chip-remove" aria-label={`Remove scope ${scope}`}
      disabled={disabled} onClick={() => onRemove(scope)}>{'\u2715'}</button> : null}
  </li>)}</ul>;
}

export function OAuthScopePicker({ value, onChange, resource, appId, issuer, configured = [], disabled,
  unspecified, onUnspecified, label = 'Scopes', selectDiscovered = false }: {
  value: string; onChange: (value: string) => void; resource?: string; appId?: string; issuer?: string;
  configured?: string[]; disabled: boolean; unspecified?: boolean; onUnspecified?: (value: boolean) => void;
  label?: string; selectDiscovered?: boolean;
}): JSX.Element {
  const input = scopeDiscoveryInput({ resource, appId, issuer });
  const key = input ? JSON.stringify(input) : '';
  const [discovery, setDiscovery] = useState<DiscoveryState>({ key: '', loading: false, data: null, error: '' });
  const [retry, setRetry] = useState(0);
  const [draft, setDraft] = useState('');
  const sequence = useRef(0);
  const initialized = useRef(new Set<string>());
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
  const choices = [...new Set([...advertised, ...configured])].sort();
  const custom = selected.filter(scope => !choices.includes(scope));
  useEffect(() => {
    if (!selectDiscovered || disabled || unspecified || !key || !advertised.length ||
      initialized.current.has(key)) return;
    initialized.current.add(key);
    const next = [...new Set([...selected, ...advertised])].sort().join('\n');
    if (next !== value) onChange(next);
  }, [selectDiscovered, disabled, unspecified, key, current?.data]);
  const choose = (scope: string, checked: boolean): void => {
    initialized.current.add(key);
    onChange((checked ? [...new Set([...selected, scope])] : selected.filter(item => item !== scope)).sort().join('\n'));
  };
  const trimmed = draft.trim();
  const duplicate = selected.includes(trimmed);
  const invalid = !!trimmed && !isOAuthScope(trimmed);
  const canAdd = !!trimmed && !duplicate && !invalid && !disabled && !unspecified;
  const add = (): void => {
    if (!canAdd) return;
    choose(trimmed, true);
    setDraft('');
  };
  return <fieldset class="credential-scope-picker" disabled={disabled}>
    <legend>{label}</legend>
    {key && (!current || current.loading) ? <p class="muted" role="status">Discovering scopes…</p> : null}
    {!key ? <p class="muted">Enter a URL or select an OAuth app to discover scopes.</p> : null}
    {current?.error ? <>
      <ErrorNotice message={`Could not discover scopes: ${current.error}`} />
      <button type="button" class="ghost" onClick={() => setRetry(value => value + 1)}>Retry discovery</button>
    </> : null}
    {current?.data && !choices.length ? <p class="muted">No scopes advertised.</p> : null}
    {onUnspecified ? <label class="group-admin-check">
      <input type="checkbox" checked={unspecified} aria-label="Make no scope request"
        onChange={event => {
          initialized.current.add(key);
          onUnspecified(event.currentTarget.checked);
          if (event.currentTarget.checked) onChange('');
        }} />
      <span>Use provider defaults</span>
    </label> : null}
    {choices.length ? <div class="credential-scope-options">{choices.map(scope => <label key={scope}>
      <input type="checkbox" aria-label={`Request scope ${scope}`} checked={selected.includes(scope)}
        disabled={unspecified} onChange={event => choose(scope, event.currentTarget.checked)} />
      <code>{scope}</code>
    </label>)}</div> : null}
    {configured.length && onUnspecified ? <button type="button" class="ghost" onClick={() => {
      initialized.current.add(key);
      onUnspecified(false); onChange([...new Set(configured)].sort().join('\n'));
    }}>Use app defaults</button> : null}
    <div class="group-admin-stack ga-package-list">
      {custom.length ? <ScopeList scopes={custom} disabled={disabled || unspecified} onRemove={scope => choose(scope, false)} /> : null}
      <div class="ga-package-actions">
        <input type="text" class="ga-package-input" aria-label="Add scope" placeholder="Scope"
          value={draft} disabled={unspecified} spellcheck={false}
          onInput={event => setDraft(event.currentTarget.value)}
          onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); add(); } }} />
        <button type="button" aria-label="Add scope" disabled={!canAdd} onClick={add}>+ Add</button>
      </div>
      <ErrorNotice message={invalid ? 'Enter one scope without spaces, quotes or backslashes.' :
        duplicate && trimmed ? 'This scope is already selected.' : ''} />
    </div>
    {selected.some(scope => !isOAuthScope(scope)) ? <ErrorNotice message="Scope values must be printable ASCII without quotes or backslashes." /> : null}
  </fieldset>;
}
