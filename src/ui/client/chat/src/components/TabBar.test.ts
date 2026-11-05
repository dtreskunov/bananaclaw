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

describe('tab badge actions', () => {
  it('places waiting alongside status text, outside the native tab selection button', () => {
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
          badge: 'waiting',
          badgeLabel: 'Open oldest request in Group',
          onBadgeClick: badge,
        },
      ],
    });
    const [nav, dropdown] = root.props.children;
    const group = nav.props.children[0][0];
    expect(group.props.children[0].props.role).toBe('tab');
    expect(group.props.children[0].props.children.props.children.props.children).toBe('Group');
    const status = group.props.children[1];
    expect(status.props.class).toBe('tab-item-status');
    expect(status.props.children[0].props.children).toBe('just now');
    expect(status.props.children[1].props).toMatchObject({
      class: 'attention-separator',
      children: ' \u00b7 ',
      'aria-hidden': 'true',
    });
    const action = status.props.children[2];
    expect(action.type).toBe('button');
    expect(action.props.class).toContain('msg-action-btn');
    expect(action.props['aria-label']).toBe('Open oldest request in Group');
    expect(dropdown.type).toBe('div');
    expect(dropdown.props.children[0].type).toBe('button');
    expect(dropdown.props.children[1].type).toBe('button');
    const event = { stopPropagation: vi.fn() };
    action.props.onClick(event);
    expect(badge).toHaveBeenCalledOnce();
    expect(event.stopPropagation).toHaveBeenCalledOnce();
    expect(select).not.toHaveBeenCalled();
    group.props.onClick();
    expect(select).toHaveBeenCalledExactlyOnceWith('g');
  });
  it('closes the mobile sheet when its separate waiting button is activated', () => {
    hooks.sheetOpen = true;
    const badge = vi.fn();
    const root = TabBar({
      ariaLabel: 'Agents',
      activeId: 'g',
      onSelect: vi.fn(),
      items: [
        { id: 'g', label: 'Group', badge: 'waiting', badgeLabel: 'Open oldest request in Group', onBadgeClick: badge },
      ],
    });
    const sheet = root.props.children[2];
    const dialog = sheet.type(sheet.props);
    const item = dialog.props.children.props.children[0][0];
    expect(item.props.badgeLabel).toBe('Open oldest request in Group');
    item.props.onBadgeClick();
    expect(hooks.setSheetOpen).toHaveBeenCalledWith(false);
    expect(badge).toHaveBeenCalledOnce();
  });
  it('renders mobile row badges beside rather than inside the row button', () => {
    const click = vi.fn();
    const item = MobileDialogItem({
      label: 'Group',
      badge: 'waiting',
      badgeLabel: 'Last known waiting',
      onBadgeClick: click,
      badgeDisabled: true,
    });
    expect(item.type).toBe('div');
    const buttons = toChildArray(item.props.children);
    expect(buttons).toMatchObject([{ type: 'button' }, { type: 'button', props: { disabled: true } }]);
    expect(buttons[1]).toMatchObject({ props: { 'aria-label': 'Last known waiting', title: 'Last known waiting' } });
  });
  it('keeps running passive in desktop, mobile selected-dropdown, and mobile sheet', () => {
    hooks.sheetOpen = true;
    const root = TabBar({
      ariaLabel: 'Agents',
      activeId: 'g',
      onSelect: vi.fn(),
      items: [{ id: 'g', label: 'Group', badge: 'running' }],
    });
    const [nav, dropdown, sheet] = root.props.children;
    expect(nav.props.children[0][0].props.children[1].props.children[2].type).toBe('span');
    expect(dropdown.props.children[1].type).toBe('span');
    const dialog = sheet.type(sheet.props);
    const item = dialog.props.children.props.children[0][0];
    const row = MobileDialogItem(item.props);
    expect(toChildArray(row.props.children)[1]).toMatchObject({ type: 'span', props: { children: 'running' } });
  });
  it('shows selected admin-only status in the mobile dropdown without introducing a desktop tab', () => {
    const root = TabBar({
      ariaLabel: 'Agents',
      activeId: 'admin',
      onSelect: vi.fn(),
      items: [],
      mobileFallbackItem: { id: 'admin', label: 'Admin agent', badge: 'waiting', onBadgeClick: vi.fn() },
    });
    const [nav, dropdown] = root.props.children;
    expect(nav.props.children[0]).toHaveLength(0);
    expect(dropdown.props.children[1].type).toBe('button');
    expect(dropdown.props.children[1].props.children).toBe('waiting');
  });
  it.each([
    { sublabel: '2h', badge: undefined },
    { sublabel: undefined, badge: 'waiting' },
  ])('does not render a dangling separator for %j', ({ sublabel, badge }) => {
    const root = TabBar({
      ariaLabel: 'Agents',
      activeId: 'g',
      onSelect: vi.fn(),
      items: [{ id: 'g', label: 'Group', sublabel, badge, reserveSublabel: true }],
    });
    const group = root.props.children[0].props.children[0][0];
    expect(group.props.children[1].props.children[1]).toBeNull();
  });
});
