import { afterEach, describe, expect, it, vi } from 'vitest';
import { toChildArray } from 'preact';
const hooks = vi.hoisted(() => ({ sheetOpen: false, setSheetOpen: vi.fn() }));
vi.mock('preact/hooks', () => ({
  useRef: () => ({ current: null }),
  useEffect: vi.fn(),
  useState: () => [hooks.sheetOpen, hooks.setSheetOpen],
}));
import { MobileDialogItem } from './MobileDialog';
import { TabBar } from './TabBar';

afterEach(() => {
  hooks.sheetOpen = false;
  vi.clearAllMocks();
});

describe('status-line tab indicators', () => {
  it('places waiting before metadata without nesting action buttons or changing selection', () => {
    const select = vi.fn();
    const badge = vi.fn();
    const root = TabBar({
      ariaLabel: 'Agents',
      activeId: 'g',
      onSelect: select,
      items: [
        {
          id: 'g',
          label: 'Group',
          sublabel: 'just now',
          badge: '?',
          badgeLabel: 'Open oldest request in Group',
          onBadgeClick: badge,
        },
      ],
    });
    const [nav, dropdown] = root.props.children;
    const group = nav.props.children[0][0];
    const [heading, status] = group.props.children;
    const tab = heading.props.children;
    const [action, metadata] = status.props.children;
    expect(action.type).toBe('button');
    expect(tab.props.role).toBe('tab');
    expect(tab.props.children.props.children).toBe('Group');
    expect(metadata.props.children).toBe('just now');
    expect(dropdown.props.children[0].props['aria-label']).toBe('Open oldest request in Group');
    expect(dropdown.props.children[1].props['aria-haspopup']).toBe('dialog');
    const [dropdownLabel, dropdownStatus] = dropdown.props.children[1].props.children[0].props.children;
    expect(dropdownLabel.props.children.props.children).toBe('Group');
    expect(dropdownStatus.props.class).toBe('tab-bar-dropdown-status has-badge');
    expect(dropdownStatus.props.children.props.children).toBe('just now');
    const event = { stopPropagation: vi.fn() };
    action.props.onClick(event);
    expect(badge).toHaveBeenCalledOnce();
    expect(event.stopPropagation).toHaveBeenCalledOnce();
    expect(select).not.toHaveBeenCalled();
    group.props.onClick();
    expect(select).toHaveBeenCalledExactlyOnceWith('g');
  });

  it('closes the mobile sheet when its separate waiting icon is activated', () => {
    hooks.sheetOpen = true;
    const badge = vi.fn();
    const root = TabBar({
      ariaLabel: 'Agents',
      activeId: 'g',
      onSelect: vi.fn(),
      items: [{ id: 'g', label: 'Group', badge: '?', onBadgeClick: badge }],
    });
    const sheet = root.props.children[2];
    const dialog = sheet.type(sheet.props);
    const item = dialog.props.children.props.children[0][0];
    item.props.onBadgeClick();
    expect(hooks.setSheetOpen).toHaveBeenCalledWith(false);
    expect(badge).toHaveBeenCalledOnce();
  });

  it('keeps mobile waiting icons independent and reserves their status row without metadata', () => {
    const item = MobileDialogItem({
      label: 'Group',
      badge: '?',
      badgeLabel: 'Last known waiting',
      onBadgeClick: vi.fn(),
      badgeDisabled: true,
    });
    expect(item.type).toBe('div');
    expect(toChildArray(item.props.children)).toMatchObject([
      { type: 'button', props: { disabled: true, 'aria-label': 'Last known waiting' } },
      { type: 'button', props: { class: 'mobile-dialog-item' } },
    ]);
    const selection = toChildArray(item.props.children)[1] as ReturnType<typeof MobileDialogItem>;
    expect(selection.props.children[1].props.class).toBe('mobile-dialog-item-sublabel');
  });

  it('keeps idle/running passive in desktop, dropdown and mobile sheet status rows', () => {
    hooks.sheetOpen = true;
    const root = TabBar({
      ariaLabel: 'Agents',
      activeId: 'g',
      onSelect: vi.fn(),
      items: [{ id: 'g', label: 'Group', badge: 'icon' }],
    });
    const [nav, dropdown, sheet] = root.props.children;
    const [heading, status] = nav.props.children[0][0].props.children;
    expect(heading.props.children.type).toBe('button');
    expect(status.props.children[0].type).toBe('span');
    expect(status.props.children[0].props.children).toBe('icon');
    expect(dropdown.props.children[0].type).toBe('span');
    const dialog = sheet.type(sheet.props);
    const item = dialog.props.children.props.children[0][0];
    const row = MobileDialogItem(item.props);
    expect(toChildArray(row.props.children)[0]).toMatchObject({ type: 'span', props: { children: 'icon' } });
  });

  it('shows selected admin-only activity in the mobile dropdown status without a desktop tab', () => {
    const root = TabBar({
      ariaLabel: 'Agents',
      activeId: 'admin',
      onSelect: vi.fn(),
      items: [],
      mobileFallbackItem: { id: 'admin', label: 'Admin agent', badge: '?', onBadgeClick: vi.fn() },
    });
    const [nav, dropdown] = root.props.children;
    expect(nav.props.children[0]).toHaveLength(0);
    expect(dropdown.props.children[0].props.children).toBe('?');
    expect(dropdown.props.children[1].type).toBe('button');
    expect(dropdown.props.children[1].props.children[0].props.children[1].props.class).toBe(
      'tab-bar-dropdown-status has-badge',
    );
  });
});
