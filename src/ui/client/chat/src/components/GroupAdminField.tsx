import './GroupAdminField.css';
import type { ComponentChildren, JSX } from 'preact';

import { InfoIcon } from './Tooltip';

export function GroupAdminField({
  label,
  info,
  children,
}: {
  label: string;
  info?: string;
  children: ComponentChildren;
}): JSX.Element {
  return (
    <div class="settings-row group-admin-field">
      <label class="group-admin-label">
        {label}
        {info ? <InfoIcon text={info} /> : null}
      </label>
      <div class="group-admin-control">{children}</div>
    </div>
  );
}