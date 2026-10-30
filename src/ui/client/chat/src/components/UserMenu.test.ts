import { afterEach, describe, expect, it, vi } from 'vitest';
import { isMobile, userMenuOpen } from '../state';
import { openCredentials } from '../credentials-navigation';
import { MobileDialogItem } from './MobileDialog';
import { UserMenu } from './UserMenu';

vi.hoisted(() => {
  vi.stubGlobal('window', { matchMedia: () => ({ matches: false }) });
});
vi.mock('preact/hooks', () => ({
  useEffect: vi.fn(),
  useRef: () => ({ current: null }),
}));
vi.mock('../credentials-navigation', () => ({ openCredentials: vi.fn() }));

interface MenuNode {
  type: unknown;
  props: {
    role?: string;
    label?: string;
    children?: unknown;
    onClick?: () => void;
  };
}

function descendants(value: unknown): MenuNode[] {
  if (Array.isArray(value)) return value.flatMap(descendants);
  if (!value || typeof value !== 'object' || !('type' in value) || !('props' in value)) return [];
  const node = value as MenuNode;
  return [node, ...descendants(node.props.children)];
}

afterEach(() => {
  isMobile.value = false;
  userMenuOpen.value = false;
  vi.clearAllMocks();
});

describe.each([false, true])('Credentials in the account menu (mobile=%s)', (mobile) => {
  it('appears immediately after My Profile for users without an agent selected', () => {
    isMobile.value = mobile;
    userMenuOpen.value = true;
    const nodes = descendants(UserMenu());
    const labels = mobile
      ? nodes.filter((node) => node.type === MobileDialogItem).map((node) => node.props.label)
      : nodes.filter((node) => node.props.role === 'menuitem').map((node) => node.props.children);
    const profile = labels.indexOf('My Profile');
    expect(profile).toBeGreaterThanOrEqual(0);
    expect(labels[profile + 1]).toBe('Credentials');
    expect(labels.filter((label) => label === 'Credentials')).toHaveLength(1);
  });

  it('closes the menu before opening the existing personal Credentials page', () => {
    isMobile.value = mobile;
    userMenuOpen.value = true;
    vi.mocked(openCredentials).mockImplementation(() => {
      expect(userMenuOpen.value).toBe(false);
    });
    const item = descendants(UserMenu()).find((node) =>
      mobile
        ? node.type === MobileDialogItem && node.props.label === 'Credentials'
        : node.props.role === 'menuitem' && node.props.children === 'Credentials',
    );
    expect(item).toBeDefined();
    item!.props.onClick!();
    expect(userMenuOpen.value).toBe(false);
    expect(openCredentials).toHaveBeenCalledOnce();
    expect(openCredentials).toHaveBeenCalledWith();
  });
});
