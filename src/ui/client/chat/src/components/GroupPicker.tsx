// Group picker — header tab bar (TabBar component handles desktop strip
// vs mobile dropdown) plus the "More agents" non-member browser modal.
import { useEffect } from 'preact/hooks';
import type { JSX } from 'preact';

import './GroupPicker.css';
import {
  groups,
  groupId,
  isElevatedUser,
  nowTick,
  groupPickerOpen,
  groupPickerMode,
} from '../state';
import { selectGroup } from '../actions';
import { fmtRelative, fmtAbsolute } from '../utils';
import type { Group } from '../types';
import { createGroupOpen } from './CreateGroupModal';
import { TabBar, type TabItem, type TabExtra } from './TabBar';

function isElevatedOnly(g: Group): boolean {
  return g.elevatedOnly === true;
}

interface ChipParts {
  parts: string[];
  isAdminOnly: boolean;
}

function chipParts(g: Group, elevated: boolean): ChipParts {
  const isAdminOnly = elevated && isElevatedOnly(g);
  const parts: string[] = [];
  if (!g.isAdmin) parts.push('\uD83D\uDD12');
  if (isAdminOnly) parts.push('\uD83D\uDC41');
  if (g.lastActivityAt) parts.push(fmtRelative(g.lastActivityAt));
  return { parts, isAdminOnly };
}

function tipFor(g: Group, isAdminOnly: boolean): string {
  const parts: string[] = [g.name];
  if (isAdminOnly) parts.push('Visible to you as admin');
  if (g.lastActivityAt) parts.push(fmtAbsolute(g.lastActivityAt));
  return parts.join(' \u00B7 ');
}

function openModal(mode: 'all' | 'non-members'): void {
  groupPickerMode.value = mode;
  groupPickerOpen.value = true;
}

export function GroupStrip(): JSX.Element | null {
  const elevated = isElevatedUser.value;
  // Subscribe so relative times refresh.
  // eslint-disable-next-line @typescript-eslint/no-unused-expressions
  nowTick.value;
  const all = groups.value;
  // Groups requiring system-wide privileges belong exclusively in the eye browser.
  const memberGroups = all.filter((g) => !isElevatedOnly(g));
  const active = all.find((g) => g.id === groupId.value);

  const items: TabItem[] = memberGroups.map((g) => {
    const { parts, isAdminOnly } = chipParts(g, elevated);
    const sublabel = parts.join(' \u00B7 ');
    return {
      id: g.id,
      label: g.name,
      sublabel: sublabel || undefined,
      reserveSublabel: true,
      title: tipFor(g, isAdminOnly),
      className: isAdminOnly ? 'is-admin-visible' : undefined,
    };
  });

  const extras: TabExtra[] = [];
  if (elevated) {
    const elevatedOnlyCount = all.filter(isElevatedOnly).length;
    if (elevatedOnlyCount > 0) {
      extras.push({
        key: 'more',
        label: `More agents (${elevatedOnlyCount})`,
        title: `Groups available through system admin access (${elevatedOnlyCount})`,
        ariaHaspopup: 'dialog',
        onClick: () => openModal('non-members'),
        className: 'group-extra-more',
      });
    }
    extras.push({
      key: 'new',
      label: 'New Agent\u2026',
      reserveSublabel: true,
      title: 'Create a new agent group',
      ariaHaspopup: 'dialog',
      onClick: () => { createGroupOpen.value = true; },
      className: 'group-extra-new',
    });
  }

  const pick = (gid: string): void => {
    if (gid !== groupId.value) selectGroup(gid).catch(console.error);
  };

  return (
    <TabBar
      ariaLabel="Agent groups"
      mobileSheetTitle="Agent groups"
      mobileFallbackLabel={active?.name}
      activeId={active?.id ?? null}
      items={items}
      onSelect={pick}
      extras={extras.length ? extras : undefined}
      className="group-strip"
    />
  );
}

// Compact desktop entry point for groups available through system-wide access.
export function MoreAgentsButton(): JSX.Element | null {
  const elevated = isElevatedUser.value;
  const all = groups.value;
  if (!elevated) return null;
  const elevatedOnlyCount = all.filter(isElevatedOnly).length;
  if (elevatedOnlyCount === 0) return null;
  const tip = `Groups available through system admin access (${elevatedOnlyCount})`;
  return (
    <button
      type="button"
      class="icon-btn more-agents-btn"
      aria-label={tip}
      title={tip}
      aria-haspopup="dialog"
      onClick={() => openModal('non-members')}
    >{'\uD83D\uDC41\uFE0F'}</button>
  );
}

export function GroupPickerModal() {
  const open = groupPickerOpen.value;
  const mode = groupPickerMode.value;
  // eslint-disable-next-line @typescript-eslint/no-unused-expressions
  nowTick.value;

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') groupPickerOpen.value = false;
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  if (!open) return null;

  const elevated = isElevatedUser.value;
  const all = groups.value;
  const visible = (() => {
    if (mode === 'non-members') return all.filter(isElevatedOnly);
    return elevated ? all : all.filter((g) => !isElevatedOnly(g));
  })();
  const title = mode === 'non-members' ? 'More agents' : 'Agent groups';

  const close = (): void => { groupPickerOpen.value = false; };
  const onBackdrop = (e: JSX.TargetedMouseEvent<HTMLDivElement>): void => {
    if ((e.target as HTMLElement).classList.contains('settings-backdrop')) close();
  };
  const pick = (gid: string): void => {
    close();
    if (gid !== groupId.value) selectGroup(gid).catch(console.error);
  };

  return (
    <div class="settings-backdrop" onClick={onBackdrop}>
      <div
        class="settings-modal group-picker-modal"
        role="dialog"
        aria-label={title}
        style="max-width:480px"
      >
        <header class="settings-head">
          <span class="title">{title}</span>
          <button type="button" class="icon-btn" aria-label="Close" onClick={close}>{'\u2715'}</button>
        </header>
        <div class="settings-body group-picker-list">
          {visible.map((g) => {
            const isActive = g.id === groupId.value;
            const { parts, isAdminOnly } = chipParts(g, elevated);
            const subtitle = parts.join(' \u00B7 ');
            return (
              <button
                type="button"
                key={g.id}
                class={`group-row${isActive ? ' active' : ''}${isAdminOnly ? ' is-admin-visible' : ''}`}
                aria-current={isActive ? 'true' : undefined}
                title={tipFor(g, isAdminOnly)}
                onClick={() => pick(g.id)}
              >
                <span class="row-name">{g.name}</span>
                {subtitle ? <span class="row-sub">{subtitle}</span> : null}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
