import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GroupAdmin } from './GroupAdmin';
import { call } from './GroupAdminApi';
import { showToast } from './Toast';
import { groupAdminOpen, groupId, isMobile } from '../state';
import type { JSX } from 'preact';

const hooks = vi.hoisted(() => {
  vi.stubGlobal('window', { matchMedia: () => ({ matches: false }) });
  return {
    slots: [] as unknown[],
    cursor: 0,
    deps: [] as (readonly unknown[] | undefined)[],
    effects: [] as (() => void)[],
  };
});
vi.mock('preact/hooks', () => ({
  useState: (initial: unknown) => {
    const index = hooks.cursor++;
    if (!(index in hooks.slots)) hooks.slots[index] = typeof initial === 'function' ? initial() : initial;
    return [
      hooks.slots[index],
      (value: unknown) => {
        hooks.slots[index] = typeof value === 'function' ? value(hooks.slots[index]) : value;
      },
    ];
  },
  useRef: (initial: unknown) => {
    const index = hooks.cursor++;
    if (!(index in hooks.slots)) hooks.slots[index] = { current: initial };
    return hooks.slots[index];
  },
  useEffect: (effect: () => void, deps?: readonly unknown[]) => {
    const index = hooks.cursor++;
    const previous = hooks.deps[index];
    if (!deps || !previous || deps.some((value, i) => value !== previous[i])) hooks.effects.push(effect);
    hooks.deps[index] = deps;
  },
}));
vi.mock('../modalBackButton', () => ({ useBackButtonCloses: vi.fn() }));
vi.mock('./Toast', () => ({ showToast: vi.fn() }));
vi.mock('./GroupAdminApi', async (original) => ({
  ...(await original<typeof import('./GroupAdminApi')>()),
  call: vi.fn(),
}));

interface HeaderActions {
  apply: () => void;
  busy: boolean;
  canSave: boolean;
}
interface SettingsProps {
  gid: string;
  section: 'settings' | 'models' | 'packages';
  onClose: () => void;
  onActions: (actions: HeaderActions | null) => void;
}
interface TestNode {
  type: unknown;
  props: {
    children?: unknown;
    label?: string;
    title?: string;
    class?: string;
    disabled?: boolean;
    onClick: () => void;
    onChange: (value: unknown) => void;
    oninput: (event: { currentTarget: { value: string } }) => void;
  };
}
function descendants(value: unknown): TestNode[] {
  if (Array.isArray(value)) return value.flatMap(descendants);
  if (!value || typeof value !== 'object' || !('type' in value) || !('props' in value)) return [];
  const node = value as TestNode;
  return [node, ...descendants(node.props.children)];
}
function text(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(text).join('');
  if (!value || typeof value !== 'object' || !('props' in value)) return '';
  return text((value as TestNode).props.children);
}
function find(value: unknown, predicate: (node: TestNode) => boolean): TestNode {
  const node = descendants(value).find(predicate);
  if (!node) throw new Error('Missing settings control');
  return node;
}
function field(value: unknown, label: string): TestNode {
  return find(value, (node) => node.props.label === label);
}
function input(value: unknown, label: string): TestNode {
  return find(field(value, label), (node) => node.type === 'input');
}
function resetHooks(): void {
  hooks.slots = [];
  hooks.deps = [];
  hooks.effects = [];
  hooks.cursor = 0;
}
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function settings() {
  return {
    id: 'g',
    name: 'Agent',
    folder: 'agent',
    createdAt: 1,
    updatedAt: null,
    config: {
      provider: 'native',
      upstream_provider: null,
      model: 'minimax/MiniMax-M3.1-Flash',
      small_model: null,
      effort: 'low',
      image_tag: 'agent:current',
      assistant_name: 'Agent',
      max_messages_per_prompt: null,
      soft_turn_token_budget: null,
      cli_scope: 'group',
      voice_input_backend: null,
      voice_input_enabled: false,
    },
    defaults: {
      provider: 'native',
      models: {},
      effort: null,
      image_tag: 'agent:default',
      voice_input_backend: 'disabled',
    },
    voiceInput: { backend: 'disabled', ready: false },
    modelParams: {},
    packages: { apt: [], npm: [], pip: [] },
    mcpServers: {},
    skills: [],
    disabledSkills: [],
    availableSkills: [],
    validProviders: ['native', 'claude'],
    validCliScopes: ['disabled', 'group', 'global'],
    runningSessionCount: 1,
    selectedModelDetail: null,
    selectedImageDetail: null,
    actorIsElevated: true,
    providesAgentSurfaces: false,
    site: { available: false, enabled: false, slug: null },
    email: { available: false, enabled: false, slug: null },
  };
}

async function harness() {
  isMobile.value = false;
  groupAdminOpen.value = true;
  groupId.value = 'g';
  const parent = GroupAdmin();
  const settingsNode = find(parent, (node) => typeof node.type === 'function' && node.type.name === 'SettingsTab');
  const render = settingsNode.type as (props: SettingsProps) => JSX.Element;
  resetHooks();
  const saved = settings();
  vi.mocked(call).mockImplementation(async (url, method = 'GET', body) => {
    if (url.endsWith('/images')) {
      return {
        ok: true,
        status: 200,
        data: {
          images: [
            {
              value: 'agent:current',
              label: 'agent:current',
              createdAt: null,
              size: null,
              isDefault: false,
            },
          ],
        },
      };
    }
    if (method === 'PATCH' && url.endsWith('/settings')) Object.assign(saved.config, body);
    return {
      ok: true,
      status: 200,
      data: url.endsWith('/restart') ? { restarted: 1, rebuilt: true } : structuredClone(saved),
    };
  });
  const onClose = vi.fn();
  let actions: HeaderActions | null = null;
  const draw = (section: SettingsProps['section'] = 'settings') => {
    hooks.cursor = 0;
    const tree = render({
      gid: 'g',
      section,
      onClose,
      onActions: (next) => {
        actions = next;
      },
    });
    hooks.effects.splice(0).forEach((effect) => effect());
    return tree;
  };
  draw();
  await settle();
  return {
    draw,
    onClose,
    apply: () => {
      if (!actions) throw new Error('Missing save action');
      actions.apply();
    },
    canSave: () => actions?.canSave,
    rebuild: () => find(draw(), (node) => node.type === 'button' && text(node) === 'Rebuild image'),
  };
}

beforeEach(() => {
  resetHooks();
  vi.clearAllMocks();
  isMobile.value = false;
});

describe('Agent Settings save and rebuild', () => {
  it('saves the latest edits directly, including edits made while Save remains enabled', async () => {
    const h = await harness();
    input(h.draw(), 'Assistant name').props.oninput({ currentTarget: { value: 'First edit' } });
    input(h.draw(), 'Assistant name').props.oninput({ currentTarget: { value: 'Latest edit' } });
    const tree = h.draw();
    expect(descendants(tree).some((node) => node.props.title === 'Apply changes')).toBe(false);
    h.apply();
    await settle();
    expect(call).toHaveBeenCalledWith(expect.stringContaining('/settings'), 'PATCH', { assistant_name: 'Latest edit' });
    expect(call).toHaveBeenCalledWith(expect.stringContaining('/restart'), 'POST', { rebuild: false });
    expect(h.onClose).toHaveBeenCalledOnce();
  });

  it('rebuilds without requiring any settings edits', async () => {
    const h = await harness();
    expect(h.canSave()).toBeFalsy();
    const imageActions = find(field(h.draw(), 'Image tag'), (node) => node.props.class === 'group-admin-image-actions');
    expect(text(imageActions)).toContain('Rebuild image');
    expect(h.rebuild().props.disabled).toBe(false);
    h.rebuild().props.onClick();
    await settle();
    expect(call).not.toHaveBeenCalledWith(expect.anything(), 'PATCH', expect.anything());
    expect(call).toHaveBeenCalledWith(expect.stringContaining('/restart'), 'POST', { rebuild: true });
    expect(h.onClose).toHaveBeenCalledOnce();
  });

  it('saves edits before rebuilding and disables the button while busy', async () => {
    const h = await harness();
    input(h.draw(), 'Assistant name').props.oninput({ currentTarget: { value: 'Updated' } });
    h.rebuild().props.onClick();
    expect(find(h.draw(), (node) => node.type === 'button' && text(node) === 'Rebuilding…').props.disabled).toBe(true);
    await settle();
    const mutations = vi.mocked(call).mock.calls.filter(([, method]) => method === 'PATCH' || method === 'POST');
    expect(mutations).toEqual([
      [expect.stringContaining('/settings'), 'PATCH', { assistant_name: 'Updated' }],
      [expect.stringContaining('/restart'), 'POST', { rebuild: true }],
    ]);
  });

  it('keeps host-only saves free of unnecessary restarts', async () => {
    const h = await harness();
    find(
      field(h.draw(), 'CLI scope'),
      (node) => typeof node.type === 'function' && node.type.name === 'Combobox',
    ).props.onChange('disabled');
    h.draw();
    h.apply();
    await settle();
    expect(call).toHaveBeenCalledWith(expect.stringContaining('/settings'), 'PATCH', { cli_scope: 'disabled' });
    expect(call).not.toHaveBeenCalledWith(expect.stringContaining('/restart'), expect.anything(), expect.anything());
  });

  it('automatically rebuilds on Save when packages changed', async () => {
    const h = await harness();
    find(
      h.draw('packages'),
      (node) => typeof node.type === 'function' && node.type.name === 'PackagesSection',
    ).props.onChange({ apt: ['jq'], npm: [], pip: [] });
    expect(text(h.draw('packages'))).toContain('Saving will rebuild the image');
    h.apply();
    await settle();
    expect(call).toHaveBeenCalledWith(expect.stringContaining('/packages'), 'PATCH', { apt: ['jq'] });
    expect(call).toHaveBeenCalledWith(expect.stringContaining('/restart'), 'POST', { rebuild: true });
  });

  it.each(['save', 'rebuild'])('does not rebuild or close after a failed settings write via %s', async (action) => {
    const h = await harness();
    input(h.draw(), 'Assistant name').props.oninput({ currentTarget: { value: 'Updated' } });
    h.draw();
    vi.mocked(call).mockResolvedValueOnce({ ok: false, status: 400, data: { error: 'Invalid settings' } });
    if (action === 'save') h.apply();
    else h.rebuild().props.onClick();
    await settle();
    expect(call).not.toHaveBeenCalledWith(expect.stringContaining('/restart'), expect.anything(), expect.anything());
    expect(showToast).toHaveBeenCalledWith('Invalid settings', 'err');
    expect(h.onClose).not.toHaveBeenCalled();
    expect(h.rebuild().props.disabled).toBe(false);
  });

  it('reports a rebuild failure and leaves the form available for retry', async () => {
    const h = await harness();
    vi.mocked(call).mockResolvedValueOnce({ ok: false, status: 500, data: { error: 'Build failed' } });
    h.rebuild().props.onClick();
    await settle();
    expect(showToast).toHaveBeenCalledWith('Build failed', 'err');
    expect(h.onClose).not.toHaveBeenCalled();
    expect(h.rebuild().props.disabled).toBe(false);
  });

  it('blocks both Save and rebuild for an invalid thinking edit', async () => {
    const h = await harness();
    find(
      h.draw('models'),
      (node) => typeof node.type === 'function' && node.type.name === 'ThinkingLevelField',
    ).props.onChange('none');
    h.draw();
    expect(h.canSave()).toBe(false);
    expect(h.rebuild().props.disabled).toBe(true);
    h.apply();
    h.rebuild().props.onClick();
    await settle();
    expect(call).not.toHaveBeenCalledWith(expect.anything(), 'PATCH', expect.anything());
    expect(call).not.toHaveBeenCalledWith(expect.anything(), 'POST', expect.anything());
  });
});
