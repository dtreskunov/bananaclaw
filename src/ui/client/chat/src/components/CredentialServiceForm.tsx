import type { JSX, RefObject } from 'preact';
import { GroupAdminField as Field } from './GroupAdminField';
import { CredentialAction } from './CredentialsTable';
import { CopyIcon, TrashIcon } from './ActionIcons';
import { credentialFields, authentication, unusedKey, type RouteDraft } from './credential-routing';
import type { Service } from './CredentialsApi';
import { showToast } from './Toast';

const LOCATIONS = [
  ['query', 'Query'], ['path', 'Path'], ['header', 'Headers'], ['body', 'Body'], ['websocket', 'WebSocket'],
];

export function CredentialServiceForm({ route, index, keys, busy, firstInput, onChange, onRemove }: {
  route: RouteDraft; index: number; keys: string[]; busy: boolean;
  firstInput?: RefObject<HTMLInputElement>;
  onChange: (route: RouteDraft) => void; onRemove?: () => void;
}): JSX.Element {
  const service = route.service;
  const update = (patch: Partial<Service>): void => onChange({ ...route, service: { ...service, ...patch } });
  const updateAuth = (patch: Partial<Service['auth']>): void => update({ auth: { ...service.auth, ...patch } });
  const substitutions = service.substitutions ?? [];
  return <section class="credential-route">
    <div class="ga-cred-head"><strong>{index ? `Additional URL ${index + 1}` : 'Destination'}</strong>
      {onRemove ? <CredentialAction label={`Remove URL pattern ${index + 1}`} disabled={busy} onClick={onRemove}><TrashIcon /></CredentialAction> : null}
    </div>
    <Field label="URL pattern"><input ref={firstInput} type="text" aria-label={index ? `URL pattern ${index + 1}` : 'URL pattern'}
      value={route.pattern} placeholder="https://api.example.com/*" spellcheck={false} autoComplete="off" disabled={busy}
      onInput={(event) => onChange({ ...route, pattern: event.currentTarget.value })} /></Field>
    <Field label="Authentication"><select aria-label={`Authentication ${index + 1}`} value={service.auth.type} disabled={busy}
      onChange={(event) => {
        const type = event.currentTarget.value;
        const patch: Partial<Service> = { auth: authentication(type, service.auth, keys) };
        if (type === 'passthrough' && !substitutions.length) {
          const key = unusedKey(keys, 'PLACEHOLDER_VALUE');
          patch.substitutions = [{ key, placeholder: `__${key}__`, in: ['query'] }];
        }
        update(patch);
      }}>
      <option value="bearer">Bearer token</option>
      <option value="api-key">API-key header</option>
      <option value="basic">Username and password</option>
      <option value="custom">Custom headers</option>
      <option value="passthrough">Request placeholder</option>
    </select></Field>
    {service.auth.type === 'api-key' ? <>
      <Field label="Header"><input aria-label={`API-key header ${index + 1}`} type="text" value={service.auth.header ?? ''}
        placeholder="X-Api-Key" disabled={busy} onInput={(event) => updateAuth({ header: event.currentTarget.value })} /></Field>
      <Field label="Prefix"><input aria-label={`Header prefix ${index + 1}`} type="text" value={service.auth.prefix ?? ''}
        placeholder="Optional, including any trailing space" disabled={busy} onInput={(event) => updateAuth({ prefix: event.currentTarget.value })} /></Field>
    </> : null}
    {service.auth.type === 'custom' ? <HeaderFields service={service} keys={keys} busy={busy} onChange={(headers) => updateAuth({ headers })} /> : null}
    {substitutions.length ? <div class="credential-placeholders">{substitutions.map((substitution, position) => {
      const replace = (patch: Partial<typeof substitution>): void => update({
        substitutions: substitutions.map((item, at) => at === position ? { ...item, ...patch } : item),
      });
      return <fieldset key={`${substitution.key}:${position}`} disabled={busy} class="credential-placeholder">
        <legend>Request placeholder {substitutions.length > 1 ? position + 1 : ''}</legend>
        <Field label="Value"><select aria-label={`Value for placeholder ${index + 1}.${position + 1}`} value={substitution.key}
          onChange={(event) => replace({ key: event.currentTarget.value })}>
          {keys.map((key, at) => <option value={key} key={key}>
            {credentialFields([service]).find((field) => field.key === key)?.label ?? `Saved value ${at + 1}`}
          </option>)}
        </select></Field>
        <div class="credential-inline-field">
          <input type="text" aria-label={`Placeholder ${index + 1}.${position + 1}`} value={substitution.placeholder} spellcheck={false}
            onInput={(event) => replace({ placeholder: event.currentTarget.value })} />
          <CredentialAction label="Copy placeholder" onClick={() => {
            void navigator.clipboard.writeText(substitution.placeholder).then(
              () => showToast('Placeholder copied'),
              () => showToast('Could not copy the placeholder', 'err'),
            );
          }}><CopyIcon /></CredentialAction>
          <CredentialAction label="Remove placeholder" onClick={() => update({
            substitutions: substitutions.filter((_, at) => at !== position),
          })}><TrashIcon /></CredentialAction>
        </div>
        <div class="credential-placeholder-locations">{LOCATIONS.map(([value, label]) => <label key={value}>
          <input type="checkbox" checked={(substitution.in ?? ['path', 'query']).includes(value)}
            onChange={(event) => {
              const selected = substitution.in ?? ['path', 'query'];
              replace({ in: event.currentTarget.checked ? [...selected, value] : selected.filter((item) => item !== value) });
            }} />{label}
        </label>)}</div>
      </fieldset>;
    })}</div> : null}
    <button type="button" class="ghost" disabled={busy} onClick={() => {
      const key = unusedKey(keys, 'PLACEHOLDER_VALUE');
      update({ substitutions: [...substitutions, { key, placeholder: `__${key}__`, in: ['query'] }] });
    }}>Add request placeholder</button>
  </section>;
}

function HeaderFields({ service, keys, busy, onChange }: {
  service: Service; keys: string[]; busy: boolean; onChange: (headers: Record<string, string>) => void;
}): JSX.Element {
  const entries = Object.entries(service.auth.headers ?? {});
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
        onInput={(event) => { if (!set(position, event.currentTarget.value, template)) event.currentTarget.value = header; }} />
      <CredentialAction label={`Remove header ${position + 1}`} disabled={entries.length === 1}
        onClick={() => onChange(Object.fromEntries(entries.filter((_, at) => at !== position)))}><TrashIcon /></CredentialAction>
    </div>
    <HeaderTemplate template={template} keys={keys} service={service} busy={busy}
      onChange={(value) => set(position, header, value)} />
  </fieldset>)}
    <button type="button" disabled={busy} onClick={() => {
      const key = unusedKey(keys, 'HEADER_VALUE');
      let header = 'X-Api-Key';
      let number = 2;
      while (entries.some(([name]) => name.toLowerCase() === header.toLowerCase())) header = `X-Api-Key-${number++}`;
      onChange({ ...service.auth.headers, [header]: `{{ ${key} }}` });
    }}>Add header</button>
  </div>;
}

function HeaderTemplate({ template, keys, service, busy, onChange }: {
  template: string; keys: string[]; service: Service; busy: boolean; onChange: (value: string) => void;
}): JSX.Element {
  const matches = [...template.matchAll(/\{\{\s*([\w.-]+)\s*\}\}/g)];
  const options = credentialFields([service]);
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
        value={segment.text} disabled={busy} onInput={(event) =>
          onChange(template.slice(0, segment.start) + event.currentTarget.value + template.slice(segment.end))} />
      {matches[position] ? <select aria-label={`Header value ${position + 1}`} value={matches[position][1]} disabled={busy}
        onChange={(event) => {
          const match = matches[position];
          onChange(template.slice(0, match.index) + `{{ ${event.currentTarget.value} }}` + template.slice(match.index + match[0].length));
        }}>
        {keys.map((key, index) => <option value={key} key={key}>{options.find((item) => item.key === key)?.label ?? `Value ${index + 1}`}</option>)}
      </select> : null}
    </div>)}
    <button type="button" class="ghost" disabled={busy} onClick={() =>
      onChange(template + `{{ ${unusedKey(keys, 'HEADER_VALUE')} }}`)}>Add value placeholder</button>
  </div>;
}
