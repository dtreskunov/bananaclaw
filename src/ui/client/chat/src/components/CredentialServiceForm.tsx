import type { JSX, RefObject } from 'preact';
import { GroupAdminField as Field } from './GroupAdminField';
import { CredentialAction } from './CredentialsTable';
import { TrashIcon } from './ActionIcons';
import { credentialFields, authentication, unusedKey, type RouteDraft } from './credential-routing';
import type { Service } from './CredentialsApi';
import { showToast } from './Toast';

export function CredentialServiceForm({ route, index, busy, firstInput, onChange, onRemove }: {
  route: RouteDraft; index: number; busy: boolean;
  firstInput?: RefObject<HTMLInputElement>;
  onChange: (route: RouteDraft) => void; onRemove?: () => void;
}): JSX.Element {
  return <section class="credential-route">
    <div class="ga-cred-head"><strong>{index ? `Additional URL ${index + 1}` : 'Destination'}</strong>
      {onRemove ? <CredentialAction label={`Remove URL pattern ${index + 1}`} disabled={busy} onClick={onRemove}><TrashIcon /></CredentialAction> : null}
    </div>
    <Field label="URL pattern"><input ref={firstInput} type="text" aria-label={index ? `URL pattern ${index + 1}` : 'URL pattern'}
      value={route.pattern} placeholder="https://api.example.com/*" spellcheck={false} autoComplete="off" disabled={busy}
      onInput={event => onChange({ ...route, pattern: event.currentTarget.value })} /></Field>
  </section>;
}

export function CredentialAuthenticationForm({ auth, keys, busy, preferredKey, savedLabel, onChange }: {
  auth: Service['auth']; keys: string[]; busy: boolean; preferredKey?: string; savedLabel?: string;
  onChange: (auth: Service['auth']) => void;
}): JSX.Element {
  const update = (patch: Partial<Service['auth']>): void => onChange({ ...auth, ...patch });
  const query = auth.location === 'query';
  return <section class="credential-authentication">
    <Field label="Authentication"><select aria-label="Authentication" value={savedLabel ? 'saved' : auth.type} disabled={busy}
      onChange={event => onChange(authentication(event.currentTarget.value, auth, keys, preferredKey))}>
      {savedLabel ? <option value="saved" disabled>{savedLabel}</option> : null}
      <option value="bearer">Bearer token</option>
      <option value="api-key">API key</option>
      <option value="basic">Username and password</option>
      <option value="custom">Custom headers</option>
    </select></Field>
    {auth.type === 'api-key' ? <>
      <Field label="Send in"><select aria-label="API key placement" value={auth.location ?? 'header'} disabled={busy}
        onChange={event => {
          const location = event.currentTarget.value;
          if (location !== 'header' && location !== 'query') { showToast('Choose header or query placement.', 'err'); return; }
          onChange({ ...auth, location, header: location === 'header' ? 'X-Api-Key' : undefined,
            parameter: location === 'query' ? '' : undefined, prefix: undefined });
        }}>
        <option value="header">Header</option><option value="query">Query parameter</option>
      </select></Field>
      {query ? <Field label="Parameter"><input aria-label="Query parameter" type="text" value={auth.parameter ?? ''}
        placeholder="api_key" disabled={busy} onInput={event => update({ parameter: event.currentTarget.value })} /></Field> : <>
        <Field label="Header"><input aria-label="API-key header" type="text" value={auth.header ?? ''}
          placeholder="X-Api-Key" disabled={busy} onInput={event => update({ header: event.currentTarget.value })} /></Field>
        <Field label="Prefix"><input aria-label="Header prefix" type="text" value={auth.prefix ?? ''}
          placeholder="Optional, including any trailing space" disabled={busy} onInput={event => update({ prefix: event.currentTarget.value })} /></Field>
      </>}
    </> : null}
    {auth.type === 'custom' ? <HeaderFields auth={auth} keys={keys} busy={busy} onChange={headers => update({ headers })} /> : null}
    {savedLabel ? <p class="muted">Saved placement is preserved. Choose a new authentication method to edit destinations.</p> : null}
  </section>;
}

function HeaderFields({ auth, keys, busy, onChange }: {
  auth: Service['auth']; keys: string[]; busy: boolean; onChange: (headers: Record<string, string>) => void;
}): JSX.Element {
  const entries = Object.entries(auth.headers ?? {});
  const set = (position: number, header: string, template: string): boolean => {
    if (entries.some(([other], at) => at !== position && other.toLowerCase() === header.toLowerCase())) {
      showToast('This header already exists.', 'err');
      return false;
    }
    onChange(Object.fromEntries(entries.map((entry, at) => at === position ? [header, template] : entry)));
    return true;
  };
  return <div class="credential-headers">{entries.map(([header, template], position) => <fieldset disabled={busy} key={position}>
    <div class="credential-inline-field">
      <input type="text" aria-label={`Header ${position + 1}`} placeholder="Header" value={header}
        onInput={event => { if (!set(position, event.currentTarget.value, template)) event.currentTarget.value = header; }} />
      <CredentialAction label={`Remove header ${position + 1}`} disabled={entries.length === 1}
        onClick={() => onChange(Object.fromEntries(entries.filter((_, at) => at !== position)))}><TrashIcon /></CredentialAction>
    </div>
    <HeaderTemplate template={template} keys={keys} auth={auth} busy={busy}
      onChange={value => set(position, header, value)} />
  </fieldset>)}
    <button type="button" disabled={busy} onClick={() => {
      const key = unusedKey(keys, 'HEADER_VALUE');
      let header = 'X-Api-Key';
      let number = 2;
      while (entries.some(([name]) => name.toLowerCase() === header.toLowerCase())) header = `X-Api-Key-${number++}`;
      onChange({ ...auth.headers, [header]: `{{ ${key} }}` });
    }}>Add header</button>
  </div>;
}

function HeaderTemplate({ template, keys, auth, busy, onChange }: {
  template: string; keys: string[]; auth: Service['auth']; busy: boolean; onChange: (value: string) => void;
}): JSX.Element {
  const matches = [...template.matchAll(/\{\{\s*([\w.-]+)\s*\}\}/g)];
  const options = credentialFields([{ auth }]);
  const segments: { text: string; start: number; end: number }[] = [];
  let start = 0;
  for (const match of matches) {
    segments.push({ text: template.slice(start, match.index), start, end: match.index });
    start = match.index + match[0].length;
  }
  segments.push({ text: template.slice(start), start, end: template.length });
  return <div class="credential-header-template">
    {segments.map((segment, position) => <div class="credential-inline-field" key={position}>
      <input type="text" aria-label={`Header text ${position + 1}`} placeholder={position ? 'Text after value' : 'Optional prefix'}
        value={segment.text} disabled={busy} onInput={event =>
          onChange(template.slice(0, segment.start) + event.currentTarget.value + template.slice(segment.end))} />
      {matches[position] ? <select aria-label={`Header value ${position + 1}`} value={matches[position][1]} disabled={busy}
        onChange={event => {
          const match = matches[position];
          onChange(template.slice(0, match.index) + `{{ ${event.currentTarget.value} }}` + template.slice(match.index + match[0].length));
        }}>
        {keys.map((key, index) => <option value={key} key={key}>{options.find(item => item.key === key)?.label ?? `Value ${index + 1}`}</option>)}
      </select> : null}
    </div>)}
    <button type="button" class="ghost" disabled={busy} onClick={() =>
      onChange(template + `{{ ${unusedKey(keys, 'HEADER_VALUE')} }}`)}>Add value</button>
  </div>;
}
