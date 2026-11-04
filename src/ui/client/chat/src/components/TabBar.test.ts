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
  it('keeps tab and dropdown actions separate from their count buttons', () => {
    const select = vi.fn();
    const badge = vi.fn();
    const root = TabBar({
      ariaLabel: 'Agents', activeId: 'g', onSelect: select,
      items: [{ id: 'g', label: 'Group', badge: '2', onBadgeClick: badge }],
    });
    const [nav, dropdown] = root.props.children;
    const group = nav.props.children[0][0];
    expect(group.props.children[0].props.role).toBe('tab');
    expect(group.props.children[0].props.children[0].props.children).toBeTruthy();
    const action = group.props.children[1];
    expect(action.type).toBe('button');
    expect(action.props.class).toContain('msg-action-btn');
    expect(dropdown.type).toBe('div');
    expect(dropdown.props.children[0].type).toBe('button');
    expect(dropdown.props.children[1].type).toBe('button');
    action.props.onClick();
    expect(badge).toHaveBeenCalledOnce();
    expect(select).not.toHaveBeenCalled();
  });
  it('closes the mobile sheet when its separate count button is activated', () => {
    hooks.sheetOpen = true;
    const badge = vi.fn();
    const root = TabBar({
      ariaLabel: 'Agents', activeId: 'g', onSelect: vi.fn(),
      items: [{ id: 'g', label: 'Group', badge: '2', onBadgeClick: badge }],
    });
    const sheet = root.props.children[2];
    const dialog = sheet.type(sheet.props);
    const item = dialog.props.children.props.children[0][0];
    item.props.onBadgeClick();
    expect(hooks.setSheetOpen).toHaveBeenCalledWith(false);
    expect(badge).toHaveBeenCalledOnce();
  });
  it('renders mobile row badges beside rather than inside the row button', () => {
    const click = vi.fn();
    const item = MobileDialogItem({ label: 'Group', badge: '2', onBadgeClick: click, badgeDisabled: true });
    expect(item.type).toBe('div');
    const buttons = toChildArray(item.props.children);
    expect(buttons).toMatchObject([{ type: 'button' }, { type: 'button', props: { disabled: true } }]);
  });
});
