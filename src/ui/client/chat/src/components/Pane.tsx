// Reusable collapsible/drawer pane.
import './Pane.css';
import type { ComponentChildren, JSX } from 'preact';
import { paneOpen, drawerOpen, isMobile } from '../state';

interface Props {
  paneKey: 'threads' | 'files';
  name: string;
  label: string;
  extraClass?: string;
  headActions?: ComponentChildren;
  collapsedActions?: ComponentChildren;
  children?: ComponentChildren;
}

export function Pane({ paneKey, name, label, extraClass, headActions, collapsedActions, children }: Props) {
  const mobile = isMobile.value;
  const open = mobile ? drawerOpen[paneKey] : paneOpen[paneKey];
  const collapsed = !mobile && !open.value;
  const drawer = mobile && open.value;
  const cls = 'nc-pane ' + name
    + (collapsed ? ' collapsed' : '')
    + (drawer ? ' open' : '')
    + (extraClass ? ' ' + extraClass : '');

  const toggle = (): void => { open.value = !open.value; };

  const onPaneClick = (ev: JSX.TargetedMouseEvent<HTMLElement>): void => {
    if (!collapsed) return;
    if ((ev.target as HTMLElement).closest('button, a')) return;
    paneOpen[paneKey].value = true;
  };

  const onHeadClick = (ev: JSX.TargetedMouseEvent<HTMLElement>): void => {
    if ((ev.target as HTMLElement).closest('button, a')) return;
    ev.stopPropagation();
    toggle();
  };

  return (
    <aside class={cls} id={name} onClick={onPaneClick}>
      <div class="head" onClick={onHeadClick}>
        <button
          type="button"
          class="icon-btn desktop-only"
          id={'btn-' + paneKey + '-toggle'}
          aria-label={collapsed ? 'Expand ' + label : 'Collapse ' + label}
          onClick={(e: JSX.TargetedMouseEvent<HTMLButtonElement>) => { e.stopPropagation(); toggle(); }}
        ></button>
        <span class="title">{label}</span>
        {collapsedActions ? <div class="collapsed-actions">{collapsedActions}</div> : null}
      </div>
      {headActions || null}
      {children}
    </aside>
  );
}
