import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Connection, CredentialGroup } from './CredentialsApi';
import { ConnectionActionDialog, ConnectionEditor, ConnectionGrantsDialog } from './CredentialsDialogs';
import { ConfirmCredentialAction, Impact, Review, SecretInput, useConnectionSignIn } from './CredentialsParts';
import { GroupCredentialAccess, McpConnectionAccess, serviceMatchesResource } from './GroupCredentialAccess';
import { showToast } from './Toast';

const hooks = vi.hoisted(() => {
  vi.stubGlobal('window', { matchMedia: () => ({ matches: false }) });
  return {
    slots: [] as unknown[],
    cursor: 0,
    effects: [] as (() => void | (() => void))[],
    resource: { data: null as unknown, error: '', loading: false, refresh: vi.fn().mockResolvedValue(undefined) },
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
  useEffect: (effect: () => void | (() => void)) => {
    hooks.effects.push(effect);
  },
}));
vi.mock('./CredentialsParts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./CredentialsParts')>()),
  useCredentialResource: () => hooks.resource,
}));
vi.mock('./Toast', () => ({ showToast: vi.fn() }));

const original: Connection = {
  id: 'pair',
  label: 'Shared Basic pair',
  kind: 'static',
  status: 'ready',
  revision: '"reviewed"',
  owner: { id: 'native-user', label: 'Owner' },
  credentials: ['USERNAME', 'PASSWORD'],
  services: [
    {
      name: 'basic',
      host: 'api.example.com',
      https_only: true,
      auth: { type: 'basic', username: 'USERNAME', password: 'PASSWORD' },
    },
  ],
  grants: [
    { vault: 'one', services: ['basic'], status: 'active' },
    { vault: 'two', services: ['basic'], status: 'active' },
  ],
};
const groups = [
  { id: 'one', name: 'One', canAdmin: true },
  { id: 'two', name: 'Two', canAdmin: true },
];

beforeEach(() => {
  hooks.slots = [];
  hooks.cursor = 0;
  hooks.effects = [];
  hooks.resource = {
    data: structuredClone(original),
    error: '',
    loading: false,
    refresh: vi.fn().mockResolvedValue(undefined),
  };
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(original))));
  vi.stubGlobal('location', { origin: 'https://nanoclaw.example' });
  vi.stubGlobal('window', {
    matchMedia: () => ({ matches: false }),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    open: vi.fn(),
  });
  vi.mocked(showToast).mockClear();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

interface TestProps {
  footer: unknown;
  value: unknown;
  type: string;
  disabled: boolean;
  checked: boolean;
  connection: Connection;
  group: CredentialGroup;
  onChange(value: boolean): void;
  onInput(value: unknown): void;
  oninput(value: unknown): void;
  onClick(): void;
  onConfirm(): Promise<void>;
  onSubmit(event: { preventDefault(): void }): Promise<void>;
}
interface TestNode {
  type: unknown;
  props: TestProps & { children?: unknown };
}

function render(node: { type: unknown; props: unknown }): TestNode {
  hooks.cursor = 0;
  hooks.effects = [];
  return (node.type as (props: unknown) => TestNode)(node.props);
}
function descendants(value: unknown): TestNode[] {
  if (Array.isArray(value)) return value.flatMap(descendants);
  if (!value || typeof value !== 'object' || !('type' in value) || !('props' in value)) return [];
  const node = value as TestNode;
  return [node, ...descendants(node.props.children), ...descendants(node.props.footer)];
}
function find(node: unknown, type: unknown): TestNode {
  return descendants(node).find((child) => child.type === type)!;
}
function formRenderer(): () => TestNode {
  const editor = ConnectionEditor({ id: original.id, groups, onClose: vi.fn(), onSaved: vi.fn() });
  const form = render(editor);
  return () => render(form);
}
function requestBody(): Record<string, unknown> {
  return JSON.parse(vi.mocked(fetch).mock.calls.at(-1)![1]!.body as string) as Record<string, unknown>;
}

describe('connection UI safety and ownership', () => {
  it('never prefills secrets and omits the values field entirely on blank edits', async () => {
    const draw = formRenderer();
    let node = draw();
    expect(
      descendants(node)
        .filter((child) => child.type === SecretInput)
        .map((child) => child.props.value),
    ).toEqual(['', '']);
    expect(find(node, Impact).props.connection.grants).toHaveLength(2);
    expect(descendants(node).find((child) => child.props.type === 'submit')!.props.disabled).toBe(true);
    find(node, Review).props.onChange(true);
    node = draw();
    await find(node, 'form').props.onSubmit({ preventDefault: vi.fn() });
    expect(requestBody()).toEqual({ label: original.label, services: original.services, revision: original.revision });
    expect(requestBody()).not.toHaveProperty('values');
  });

  it('rotates a provided component once, preserving the blank username and reviewed revision', async () => {
    const draw = formRenderer();
    let node = draw();
    descendants(node)
      .filter((child) => child.type === SecretInput)[1]
      .props.onInput('replacement');
    node = draw();
    find(node, Review).props.onChange(true);
    node = draw();
    await find(node, 'form').props.onSubmit({ preventDefault: vi.fn() });
    expect(fetch).toHaveBeenCalledOnce();
    expect(vi.mocked(fetch).mock.calls[0][0]).toBe('/ui/chat/api/credentials/connections/pair');
    expect(requestBody()).toMatchObject({ revision: '"reviewed"', values: { PASSWORD: 'replacement' } });
  });

  it('requires renewed review after retargeting a shared service', () => {
    const draw = formRenderer();
    let node = draw();
    find(node, Review).props.onChange(true);
    node = draw();
    expect(descendants(node).find((child) => child.props.type === 'submit')!.props.disabled).toBe(false);
    find(node, 'textarea').props.oninput({
      currentTarget: { value: JSON.stringify([{ ...original.services[0], host: 'different.example.com' }]) },
    });
    node = draw();
    expect(descendants(node).find((child) => child.props.type === 'submit')!.props.disabled).toBe(true);
    expect(find(node, Review).props.checked).toBe(false);
  });

  it('deletes/disconnects the connection with its exact latest revision, never blind DELETE', async () => {
    const node = ConnectionActionDialog({
      connection: original,
      groups,
      action: 'delete',
      onClose: vi.fn(),
      onSaved: vi.fn(),
    });
    expect(node.type).toBe(ConfirmCredentialAction);
    expect(find(node, Impact).props.connection.revision).toBe('"reviewed"');
    await node.props.onConfirm();
    expect(vi.mocked(fetch).mock.calls[0][1]!.method).toBe('DELETE');
    expect(requestBody()).toEqual({ revision: '"reviewed"' });
  });

  it('lets owners revoke references even after losing destination-group access', () => {
    const node = ConnectionGrantsDialog({ connection: original, groups: [], onClose: vi.fn(), onSaved: vi.fn() });
    const destinations = descendants(node).filter((child) => typeof child.type === 'function' && child.props.group);
    expect(destinations.map((child) => child.props.group)).toEqual([
      { id: 'one', name: 'one', canAdmin: false },
      { id: 'two', name: 'two', canAdmin: false },
    ]);
  });

  it('keeps agent Access reference-only and detaches without an upstream connection mutation', async () => {
    hooks.resource.data = {
      grants: [
        {
          connection_id: original.id,
          label: original.label,
          owner: { id: 'someone-else', label: 'Other owner' },
          services: original.services,
          status: 'active',
        },
      ],
    };
    let node = GroupCredentialAccess({ gid: 'one' });
    expect(descendants(node).some((child) => child.type === SecretInput || child.type === ConnectionEditor)).toBe(
      false,
    );
    descendants(node)
      .find((child) => child.type === 'button' && child.props.children === 'Detach this agent')!
      .props.onClick();
    hooks.cursor = 0;
    node = GroupCredentialAccess({ gid: 'one' });
    await find(node, ConfirmCredentialAction).props.onConfirm();
    expect(vi.mocked(fetch).mock.calls[0][0]).toBe('/ui/chat/api/groups/one/admin/access/pair');
    expect(vi.mocked(fetch).mock.calls[0][1]!.method).toBe('DELETE');
    expect(vi.mocked(fetch).mock.calls[0][1]!.body).toBeUndefined();
  });

  it('routes MCP Manage to the existing personal binding instead of a new sign-in', () => {
    hooks.resource.data = {
      grants: [
        { connection_id: 'pair', label: 'Pair', owner: original.owner, services: original.services, status: 'active' },
      ],
    };
    const open = vi.fn();
    const node = McpConnectionAccess({
      gid: 'one',
      resourceUrl: 'https://api.example.com/mcp',
      onOpenCredentials: open,
    });
    descendants(node)
      .find((child) => child.type === 'button' && child.props.children === 'Manage personal connections')!
      .props.onClick();
    expect(open).toHaveBeenCalledWith(false, 'pair');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('matches MCP bindings using explicit host/port, path and HTTPS policy', () => {
    const service = { ...original.services[0], host: '*.example.com:8443', path: '/mcp/*' };
    expect(serviceMatchesResource(service, 'https://api.example.com:8443/mcp/tools')).toBe(true);
    expect(serviceMatchesResource(service, 'https://api.example.com/mcp/tools')).toBe(false);
    expect(serviceMatchesResource(service, 'https://api.example.com:8443/admin')).toBe(false);
    expect(serviceMatchesResource(service, 'http://api.example.com:8443/mcp/tools')).toBe(false);
  });
});

describe('OAuth browser lifecycle', () => {
  it('uses personal start/progress, authenticates callback origin/state and closes the popup after authoritative completion', async () => {
    vi.useFakeTimers();
    const popup = { location: { href: '' }, closed: false, close: vi.fn() };
    vi.mocked(window.open).mockReturnValue(popup as unknown as Window);
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ state: 'flow', label: 'MCP', authorizeUrl: 'https://issuer.example/authorize' })),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: 'pending' })))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ status: 'connected', connection_id: 'account', account: 'user@example.com' })),
      );
    vi.stubGlobal('fetch', fetch);
    const finished = vi.fn();
    let signIn = useConnectionSignIn(finished);
    await signIn.start('account', { resource_url: 'https://mcp.example.com', scopes: ['read'] });
    expect(window.open).toHaveBeenCalledWith('about:blank', 'nanoclaw-oauth', expect.any(String));
    expect(popup.location.href).toBe('https://issuer.example/authorize');
    hooks.cursor = 0;
    hooks.effects = [];
    signIn = useConnectionSignIn(finished);
    expect(signIn.waiting?.state).toBe('flow');
    const cleanup = hooks.effects[0]();
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    const message = vi.mocked(window.addEventListener).mock.calls.find(([type]) => type === 'message')![1] as (
      event: unknown,
    ) => void;
    message({
      origin: 'https://attacker.example',
      source: popup,
      data: { type: 'nanoclaw-oauth-complete', state: 'flow' },
    });
    message({ origin: location.origin, source: popup, data: { type: 'nanoclaw-oauth-complete', state: 'wrong-flow' } });
    expect(fetch).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    message({ origin: location.origin, source: popup, data: { type: 'nanoclaw-oauth-complete', state: 'flow' } });
    await vi.waitFor(() => expect(finished).toHaveBeenCalledOnce());
    expect(fetch.mock.calls.map(([url]) => url)).toEqual([
      '/ui/chat/api/credentials/connections/account/start',
      '/ui/chat/api/credentials/sign-ins/flow',
      '/ui/chat/api/credentials/sign-ins/flow',
    ]);
    expect(popup.close).toHaveBeenCalledOnce();
    if (typeof cleanup === 'function') cleanup();
  });

  it('retains the flow when popups are blocked so the user can explicitly reopen it', async () => {
    vi.mocked(window.open).mockReturnValue(null);
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            state: 'blocked',
            label: 'Account',
            authorizeUrl: 'https://issuer.example/authorize',
          }),
        ),
      ),
    );
    let signIn = useConnectionSignIn(vi.fn());
    await signIn.start('account', {});
    hooks.cursor = 0;
    signIn = useConnectionSignIn(vi.fn());
    expect(signIn.waiting?.state).toBe('blocked');
    signIn.reopen();
    expect(window.open).toHaveBeenLastCalledWith(
      'https://issuer.example/authorize',
      'nanoclaw-oauth',
      expect.any(String),
    );
    expect(showToast).toHaveBeenCalledWith(expect.stringContaining('blocked'), 'err');
  });
});
