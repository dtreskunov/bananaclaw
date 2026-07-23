import './UserMenu.css';
import type { JSX } from 'preact';
import { useEffect, useRef } from 'preact/hooks';
import {
  groupAdminOpen,
  groupPickerMode,
  groupPickerOpen,
  isAdmin,
  isElevatedUser,
  isMobile,
  me,
  settingsOpen,
  userMenuOpen,
} from '../state';
import { MobileDialog, MobileDialogDivider, MobileDialogItem, MobileDialogList } from './MobileDialog';

interface MenuItem {
  label: string;
  action: () => void;
}

function initialsFor(displayName: string): string {
  const parts = displayName.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  const first = Array.from(parts[0]!)[0] || '?';
  if (parts.length === 1) return first.toUpperCase();
  const last = Array.from(parts[parts.length - 1]!)[0] || '';
  return (first + last).toUpperCase();
}

export function UserMenu(): JSX.Element {
  const open = userMenuOpen.value;
  const setOpen = (value: boolean | ((current: boolean) => boolean)): void => {
    userMenuOpen.value = typeof value === 'function' ? value(userMenuOpen.value) : value;
  };
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const admin = isAdmin.value;
  const showAllAgents = isElevatedUser.value;
  const mobile = isMobile.value;
  const displayName = me.value || 'User';

  useEffect(() => {
    if (!open) return undefined;
    const onDocumentMouseDown = (event: MouseEvent): void => {
      if (wrapRef.current && !wrapRef.current.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDocumentMouseDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onDocumentMouseDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  const choose = (action: () => void): void => {
    setOpen(false);
    action();
  };
  const items: MenuItem[] = [
    { label: 'My Profile', action: () => { settingsOpen.value = true; } },
  ];
  if (admin) items.push({ label: 'Agent Settings', action: () => { groupAdminOpen.value = true; } });
  if (showAllAgents) {
    items.push({
      label: 'Show All Agents',
      action: () => {
        groupPickerMode.value = 'all';
        groupPickerOpen.value = true;
      },
    });
  }

  return (
    <div class={'user-menu' + (open ? ' open' : '')} ref={wrapRef}>
      <button
        type="button"
        class="avatar-btn"
        aria-label={`${displayName} menu`}
        aria-haspopup={mobile ? 'dialog' : 'menu'}
        aria-expanded={open}
        title={displayName}
        onClick={(event: JSX.TargetedMouseEvent<HTMLButtonElement>) => {
          event.stopPropagation();
          setOpen((value) => !value);
        }}
      >{initialsFor(displayName)}</button>
      {open && !mobile ? (
        <div class="user-menu-panel" role="menu" aria-label="Account and agent actions">
          <div class="user-menu-identity" aria-hidden="true">{displayName}</div>
          <form method="POST" action="/ui/auth/logout" class="user-menu-logout-form">
            <button type="submit" role="menuitem">Log out</button>
          </form>
          <div class="user-menu-divider" aria-hidden="true" />
          {items.map((item) => (
            <button type="button" role="menuitem" key={item.label} onClick={() => choose(item.action)}>
              {item.label}
            </button>
          ))}
        </div>
      ) : null}
      {open && mobile ? (
        <MobileDialog title={displayName} ariaLabel="Account and agent actions" onClose={() => setOpen(false)}>
          <MobileDialogList>
            {items.map((item) => (
              <MobileDialogItem label={item.label} chevron key={item.label} onClick={() => choose(item.action)} />
            ))}
            <MobileDialogDivider />
            <form method="POST" action="/ui/auth/logout" class="user-menu-logout-form">
              <MobileDialogItem type="submit" label="Log out" />
            </form>
          </MobileDialogList>
        </MobileDialog>
      ) : null}
    </div>
  );
}
