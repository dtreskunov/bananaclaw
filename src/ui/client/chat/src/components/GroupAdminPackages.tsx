import './GroupAdminPackages.css';
import { useState } from 'preact/hooks';
import type { JSX } from 'preact';

import { GroupAdminField as Field } from './GroupAdminField';

export interface GroupAdminPackagesValue {
  apt: string[];
  npm: string[];
  pip: string[];
}

const PACKAGE_TOKEN_RE = /^[A-Za-z0-9@._/+=<>~^!*-]+$/;

export function PackagesSection({
  value,
  busy,
  onChange,
}: {
  value: GroupAdminPackagesValue;
  busy: boolean;
  onChange: (next: GroupAdminPackagesValue) => void;
}): JSX.Element {
  return (
    <>
      <div class="group-admin-toolbar">
        <p class="group-admin-help">
          Packages baked into the container image. Changes require an image rebuild — the Apply
          dialog suggests rebuild when any list here changes. Mirrors{' '}
          <code>ncl groups config add-package / remove-package</code>.
        </p>
      </div>
      <PackageListField
        label="apt packages"
        info="Debian packages installed via apt-get in the agent image. Example: ripgrep, jq, postgresql-client."
        placeholder="apt package (e.g. ripgrep, jq, postgresql-client)"
        items={value.apt}
        disabled={busy}
        onChange={(apt) => onChange({ ...value, apt })}
      />
      <PackageListField
        label="npm packages"
        info="Node packages installed globally via pnpm/npm in the agent image. Example: typescript@5, prettier."
        placeholder="npm package (e.g. typescript@5, prettier)"
        items={value.npm}
        disabled={busy}
        onChange={(npm) => onChange({ ...value, npm })}
      />
      <PackageListField
        label="pip packages"
        info="Python packages installed via pip in the agent image. Example: requests, pandas==2.0.0."
        placeholder="pip package (e.g. requests, pandas==2.0.0)"
        items={value.pip}
        disabled={busy}
        onChange={(pip) => onChange({ ...value, pip })}
      />
    </>
  );
}

function PackageListField({
  label,
  info,
  placeholder,
  items,
  disabled,
  onChange,
}: {
  label: string;
  info: string;
  placeholder: string;
  items: string[];
  disabled: boolean;
  onChange: (next: string[]) => void;
}): JSX.Element {
  const [draft, setDraft] = useState('');
  const trimmed = draft.trim();
  const isDup = trimmed !== '' && items.includes(trimmed);
  const isInvalid = trimmed !== '' && !PACKAGE_TOKEN_RE.test(trimmed);
  const canAdd = trimmed !== '' && !isDup && !isInvalid;

  function add(): void {
    if (!canAdd) return;
    onChange([...items, trimmed]);
    setDraft('');
  }

  function remove(idx: number): void {
    onChange(items.filter((_, i) => i !== idx));
  }

  return (
    <Field label={label} info={info}>
      <div class="group-admin-stack ga-package-list">
        {items.length === 0 ? (
          <p class="group-admin-help">No packages.</p>
        ) : (
          <ul class="ga-package-chips">
            {items.map((packageName, index) => (
              <li key={`${packageName}-${index}`} class="ga-package-chip">
                <span class="ga-package-chip-label">{packageName}</span>
                <button
                  type="button"
                  class="ga-package-chip-remove"
                  aria-label={`Remove ${packageName}`}
                  disabled={disabled}
                  onClick={() => remove(index)}
                >
                  {'\u2715'}
                </button>
              </li>
            ))}
          </ul>
        )}
        <div class="ga-package-actions">
          <input
            type="text"
            class="ga-package-input"
            placeholder={placeholder}
            value={draft}
            disabled={disabled}
            onInput={(event: JSX.TargetedEvent<HTMLInputElement>) => setDraft(event.currentTarget.value)}
            onKeyDown={(event: JSX.TargetedKeyboardEvent<HTMLInputElement>) => {
              if (event.key === 'Enter') { event.preventDefault(); add(); }
            }}
          />
          <button type="button" disabled={disabled || !canAdd} onClick={add}>
            + Add
          </button>
        </div>
        {isInvalid ? (
          <p class="ga-confirm-warn">"{trimmed}" has invalid characters.</p>
        ) : isDup ? (
          <p class="ga-confirm-warn">"{trimmed}" is already in the list.</p>
        ) : null}
      </div>
    </Field>
  );
}