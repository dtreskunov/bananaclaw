import './UserMenu.css';
import type { JSX } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import {
  groupAdminOpen,
  groupPickerMode,
  groupPickerOpen,
  isAdmin,
  isElevatedUser,
  isMobile,
  me,
  settingsOpen,
} from '../state';

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
  const [open, setOpen] = useState(false);
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

  const onBackdrop = (event: JSX.TargetedMouseEvent<HTMLDivElement>): void => {
    if ((event.target as HTMLElement).classList.contains('settings-backdrop')) setOpen(false);
  };

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
        <div class="settings-backdrop tab-bar-sheet-backdrop" onClick={onBackdrop}>
          <div
            class="settings-modal tab-bar-sheet"
            role="dialog"
            aria-label="Account and agent actions"
            style="max-width:480px"
          >
            <header class="settings-head">
              <span class="title">{displayName}</span>
              <button type="button" class="icon-btn" aria-label="Close" onClick={() => setOpen(false)}>{'\u2715'}</button>
            </header>
            <div class="settings-body tab-bar-sheet-list">
              <form method="POST" action="/ui/auth/logout" class="user-menu-logout-form">
                <button type="submit" class="tab-bar-sheet-row">
                  <span class="tab-bar-sheet-row-name">Log out</span>
                </button>
              </form>
              <div class="tab-bar-sheet-divider" aria-hidden="true" />
              {items.map((item) => (
                <button
                  type="button"
                  class="tab-bar-sheet-row"
                  key={item.label}
                  onClick={() => choose(item.action)}
                >
                  <span class="tab-bar-sheet-row-name">{item.label}</span>
                </button>
              ))}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
