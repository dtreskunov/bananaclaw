import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import type { Connection, CredentialGroup } from './CredentialsApi';
import { CredentialAction, CredentialName, CredentialRow, CredentialsTable } from './CredentialsTable';

vi.hoisted(() => {
  vi.stubGlobal('window', { matchMedia: () => ({ matches: false }) });
});
const hooks = vi.hoisted(() => ({ slots: [] as unknown[], cursor: 0 }));
vi.mock('preact/hooks', () => ({
  useState: (initial: unknown) => {
    const index = hooks.cursor++;
    if (!(index in hooks.slots)) hooks.slots[index] = initial;
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
}));
vi.mock('./Toast', () => ({ showToast: vi.fn() }));

const original: Connection = {
  id: 'shared',
  label: 'Search',
  kind: 'static',
  status: 'ready',
  revision: '"reviewed"',
  owner: { id: 'owner', label: 'Not shown' },
  credentials: ['KEY'],
  services: [
    { name: 'search', host: 'api.example.com/search', auth: { type: 'bearer', token: 'KEY' } },
    { name: 'lookup', host: 'api.example.com/lookup', auth: { type: 'bearer', token: 'KEY' } },
  ],
  grants: [
    { vault: 'one', services: ['search'], status: 'active' },
    { vault: 'two', services: ['search', 'lookup'], status: 'active' },
  ],
};
const groups: CredentialGroup[] = [
  { id: 'one', name: 'Lab', canAdmin: true },
  { id: 'two', name: 'My Agent', canAdmin: true },
  { id: 'three', name: 'New Agent', canAdmin: true },
];
let latest: Connection;
let writes: { url: string; method: string; body?: Record<string, unknown> }[];

beforeEach(() => {
  hooks.slots = [];
  hooks.cursor = 0;
  writes = [];
  latest = structuredClone(original);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      if (!init?.method || init.method === 'GET') return new Response(JSON.stringify(latest));
      const body = init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
      writes.push({ url, method: init.method, body });
      latest.revision = '"updated"';
      return new Response(JSON.stringify({ ok: true }));
    }),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
});

interface Node {
  type: unknown;
  ref?: (node: { indeterminate: boolean }) => void;
  props: {
    children?: unknown;
    actions?: unknown;
    groups?: CredentialGroup[];
    checked?: boolean;
    disabled?: boolean;
    label?: string;
    'aria-label'?: string;
    'aria-checked'?: string | boolean;
    onChange?: (event: { currentTarget: { checked: boolean } }) => void;
    onClick?: () => Promise<void> | void;
    busy?: boolean;
    onBlur?: (event: { currentTarget: { value: string } }) => void;
  };
}
function descendants(value: unknown): Node[] {
  if (Array.isArray(value)) return value.flatMap(descendants);
  if (!value || typeof value !== 'object' || !('type' in value) || !('props' in value)) return [];
  const node = value as Node;
  return [node, ...descendants(node.props.children), ...descendants(node.props.actions)];
}
function draw(connection = original, destinations = groups, onSaved = vi.fn().mockResolvedValue(undefined)) {
  hooks.cursor = 0;
  return CredentialRow({
    connection,
    groups: destinations,
    apps: [],
    busy: false,
    onEdit: vi.fn(),
    onConnect: vi.fn(),
    onAction: vi.fn(),
    onSaved,
  });
}
function checkbox(node: unknown, group: string) {
  return descendants(node).find((item) => item.type === 'input' && item.props['aria-label'] === `Search — ${group}`)!;
}
function save(node: unknown) {
  return descendants(node).find(
    (item) => item.type === CredentialAction && item.props.label === 'Save agent access for Search',
  )!;
}

describe('editable credential authorization matrix', () => {
  it('filters only the requested agent column and removes the header', () => {
    const node = CredentialsTable({
      connections: [original],
      groups,
      apps: [],
      busy: false,
      onlyGroup: 'one',
      onEdit: vi.fn(),
      onConnect: vi.fn(),
      onAction: vi.fn(),
      onSaved: vi.fn(),
    });
    expect(descendants(node).some((item) => item.type === 'thead')).toBe(false);
    expect(descendants(node).find((item) => item.type === CredentialRow)!.props.groups).toEqual([groups[0]]);
  });
  it('renames directly using a label-only update without disturbing grants', async () => {
    const saved = vi.fn().mockResolvedValue(undefined);
    const busy = vi.fn();
    const node = CredentialName({
      connection: original,
      name: 'Search',
      busy: false,
      onSaved: saved,
      onBusyChange: busy,
    });
    descendants(node).find((item) => item.type === 'input')!.props.onBlur!({ currentTarget: { value: 'My search' } });
    await vi.waitFor(() => expect(saved).toHaveBeenCalledOnce());
    expect(writes).toEqual([
      {
        url: '/ui/chat/api/credentials/connections/shared',
        method: 'PUT',
        body: { label: 'My search', revision: '"reviewed"' },
      },
    ]);
    expect(busy.mock.calls).toEqual([[true], [false]]);
  });
  it('does not rename a stale revision', async () => {
    latest.revision = '"changed elsewhere"';
    const node = CredentialName({ connection: original, name: 'Search', busy: false, onSaved: vi.fn() });
    descendants(node).find((item) => item.type === 'input')!.props.onBlur!({ currentTarget: { value: 'My search' } });
    await vi.waitFor(() => expect(vi.mocked(fetch)).toHaveBeenCalledOnce());
    expect(writes).toEqual([]);
  });
  it('locks inline naming while agent access edits are pending', () => {
    checkbox(draw(), 'New Agent').props.onChange!({ currentTarget: { checked: true } });
    expect(descendants(draw()).find((item) => item.type === CredentialName)!.props.busy).toBe(true);
  });
  it('preserves partial access until an explicit edit is saved', () => {
    const node = draw(),
      field = checkbox(node, 'Lab');
    expect(field.props['aria-checked']).toBe('mixed');
    const input = { indeterminate: false };
    field.ref!(input);
    expect(input.indeterminate).toBe(true);
    expect(checkbox(node, 'My Agent').props.checked).toBe(true);
    expect(writes).toEqual([]);
    expect(save(node)).toBeUndefined();
  });
  it('saves only edited agent cells with selected services and exact current revision', async () => {
    checkbox(draw(), 'New Agent').props.onChange!({ currentTarget: { checked: true } });
    expect(writes).toEqual([]);
    await save(draw()).props.onClick!();
    expect(writes).toEqual([
      {
        url: '/ui/chat/api/credentials/connections/shared/grants/three',
        method: 'PUT',
        body: { services: ['search', 'lookup'], revision: '"reviewed"' },
      },
    ]);
  });
  it('removes only the selected group grant, never the upstream credential', async () => {
    checkbox(draw(), 'My Agent').props.onChange!({ currentTarget: { checked: false } });
    await save(draw()).props.onClick!();
    expect(writes).toEqual([
      {
        url: '/ui/chat/api/credentials/connections/shared/grants/two',
        method: 'DELETE',
        body: undefined,
      },
    ]);
  });
  it('does not save a new grant that was checked and then unchecked', () => {
    checkbox(draw(), 'New Agent').props.onChange!({ currentTarget: { checked: true } });
    expect(save(draw())).toBeDefined();
    checkbox(draw(), 'New Agent').props.onChange!({ currentTarget: { checked: false } });
    expect(save(draw())).toBeUndefined();
    expect(writes).toEqual([]);
  });
  it('uses the refreshed revision between two explicitly edited cells', async () => {
    checkbox(draw(), 'New Agent').props.onChange!({ currentTarget: { checked: true } });
    checkbox(draw(), 'Lab').props.onChange!({ currentTarget: { checked: true } });
    await save(draw()).props.onClick!();
    expect(writes.map((write) => write.body?.revision)).toEqual(['"reviewed"', '"updated"']);
    expect(writes.map((write) => write.url.split('/').at(-1))).toEqual(['three', 'one']);
  });
  it('lets an owner revoke partial grants without granting new authority after losing admin access', async () => {
    const destinations = groups.map((group) => ({ ...group, canAdmin: false }));
    const field = checkbox(draw(original, destinations), 'Lab');
    expect(field.props.disabled).toBe(false);
    field.props.onChange!({ currentTarget: { checked: true } });
    await save(draw(original, destinations)).props.onClick!();
    expect(writes[0].method).toBe('DELETE');
    expect(checkbox(draw(original, destinations), 'New Agent').props.disabled).toBe(true);
  });
  it('requires explicit reapproval for suspended grants', async () => {
    const suspended = { ...original, grants: [{ ...original.grants[0], status: 'suspended' as const }] };
    checkbox(draw(suspended), 'Lab').props.onChange!({ currentTarget: { checked: true } });
    await save(draw(suspended)).props.onClick!();
    expect(writes[0]).toMatchObject({
      method: 'PUT',
      body: { services: ['search', 'lookup'], revision: '"reviewed"' },
    });
  });
  it('does not send a stale authorization update or retry after a conflict', async () => {
    checkbox(draw(), 'New Agent').props.onChange!({ currentTarget: { checked: true } });
    latest.revision = '"changed elsewhere"';
    const refreshed = vi.fn().mockResolvedValue(undefined);
    await save(draw(original, groups, refreshed)).props.onClick!();
    expect(writes).toEqual([]);
    expect(refreshed).toHaveBeenCalledOnce();
    expect(save(draw()).props.disabled).toBe(true);
  });
  it('shows compact icon controls and hides owner/key-count/type metadata', () => {
    const node = draw();
    const actions = descendants(node).filter((item) => item.type === CredentialAction);
    expect(actions.map((item) => item.props.label)).toEqual(['Edit Search', 'Disable Search', 'Delete Search']);
    const text = descendants(node)
      .map((item) => (typeof item.props.children === 'string' ? item.props.children : ''))
      .join(' ');
    expect(text).not.toContain('Owner');
    expect(text).not.toContain('write-only');
    expect(text).not.toContain('static');
    expect(text).not.toContain('Not shown');
  });
});
