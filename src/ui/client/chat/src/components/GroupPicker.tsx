// Group picker — header tab bar (TabBar component handles desktop strip
// vs mobile dropdown) plus the "More agents" non-member browser modal.
import { useEffect } from 'preact/hooks';
import type { JSX } from 'preact';

import {
  groups,
  groupId,
  isElevatedUser,
  nowTick,
  groupPickerOpen,
  groupPickerMode,
  credentialsOpen,
  agentActivity,
} from '../state';
import { openChat } from '../credentials-navigation';
import { navigateActivity, selectGroup } from '../actions';
import { fmtRelative, fmtAbsolute } from '../utils';
import type { Group } from '../types';
import { createGroupOpen } from './CreateGroupModal';
import { TabBar, type TabItem, type TabExtra } from './TabBar';
import { MobileDialog, MobileDialogItem, MobileDialogList } from './MobileDialog';
import { ActivityIndicator, activityNavigationDetails } from './ActivityIndicator';
import { groupAttentionCount } from '../attention-state';
import { withPendingActivity } from '../conversation-state';
import { isActivityNavigating } from '../activity-navigation';

function activityBadge(group: Group) {
  const saved = agentActivity.value.find((activity) => activity.id === group.id);
  if (!saved) return {};
  const status = withPendingActivity(saved, group.id);
  const count = groupAttentionCount(group.id);
  const unread = !!saved.unreadThreadCount;
  const navigating = isActivityNavigating(group.id);
  const details = activityNavigationDetails(status, unread, count, group.name);
  const actionable = details.actionable && !navigating;
  const description = navigating ? `Opening message in ${group.name}\u2026` : details.description;
  return {
    badge: <ActivityIndicator status={status} description={description} unread={unread} navigating={navigating} />,
    badgeLabel: description,
    badgeDisabled: !actionable,
    badgeBusy: navigating,
    onBadgeClick: () => actionable ? navigateActivity(group.id, status, unread) : undefined,
  };
}

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
  if (g.lastActivityAt != null) parts.push(fmtRelative(g.lastActivityAt));
  const threadCount = agentActivity.value.find((activity) => activity.id === g.id)?.threadCount;
  if (threadCount) parts.push(`${threadCount} thr`);
  return { parts, isAdminOnly };
}

function tipFor(g: Group, isAdminOnly: boolean): string {
  const parts: string[] = [g.name];
  const unread = agentActivity.value.find(activity => activity.id === g.id)?.unreadThreadCount;
  if (unread) parts.push(`${unread} unread ${unread === 1 ? 'conversation' : 'conversations'}`);
  if (isAdminOnly) parts.push('Visible to you as admin');
  if (g.lastActivityAt != null) parts.push(fmtAbsolute(g.lastActivityAt));
  return parts.join(' \u00B7 ');
}

function groupItem(g: Group, elevated: boolean): TabItem {
  const { parts, isAdminOnly } = chipParts(g, elevated);
  const unread = agentActivity.value.find(activity => activity.id === g.id)?.unreadThreadCount;
  return {
    id: g.id, label: g.name, ...activityBadge(g),
    sublabel: parts.join(' \u00B7 ') || undefined, reserveSublabel: true,
    title: tipFor(g, isAdminOnly),
    className: [isAdminOnly ? 'is-admin-visible' : '', unread ? 'is-unread' : ''].filter(Boolean).join(' ') || undefined,
  };
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

  const items = memberGroups.map(g => groupItem(g, elevated));

  const extras: TabExtra[] = [];
  if (elevated) {
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
    if (credentialsOpen.value) openChat();
    if (gid !== groupId.value) selectGroup(gid).catch(console.error);
  };

  return (
    <TabBar
      ariaLabel="Agent groups"
      mobileSheetTitle="Agent groups"
      mobileFallbackLabel={active?.name}
      mobileFallbackItem={active ? groupItem(active, elevated) : undefined}
      activeId={active?.id ?? null}
      items={items}
      onSelect={pick}
      extras={extras.length ? extras : undefined}
      className="group-strip tab-bar-header"
    />
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
  const pick = (gid: string): void => {
    close();
    if (gid !== groupId.value) selectGroup(gid).catch(console.error);
  };

  return (
    <MobileDialog title={title} onClose={close} maxWidth="480px">
      <MobileDialogList>
        {visible.map((g) => {
          const isActive = g.id === groupId.value;
          const item = groupItem(g, elevated);
          return (
            <MobileDialogItem
              key={g.id}
              {...item}
              onBadgeClick={item.onBadgeClick ? async () => {
                if (await item.onBadgeClick?.() !== false) close();
              } : undefined}
              active={isActive}
              onClick={() => pick(g.id)}
            />
          );
        })}
      </MobileDialogList>
    </MobileDialog>
  );
}
