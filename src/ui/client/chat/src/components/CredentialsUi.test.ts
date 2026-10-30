import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppInfo, Connection, CredentialGroup } from './CredentialsApi';
import { ConnectionActionDialog, ConnectionEditor, OAuthAppDialog, OAuthConnectionDialog } from './CredentialsDialogs';
import { ConfirmCredentialAction, ErrorNotice, Impact, SecretInput, useConnectionSignIn } from './CredentialsParts';
import { GroupCredentials, McpConnectionAccess, serviceMatchesResource } from './GroupCredentialAccess';
import { showToast } from './Toast';
import { CredentialsContent, CredentialsPage } from './CredentialsPage';
import { CredentialsTable } from './CredentialsTable';
import { MobileDialog } from './MobileDialog';
import { credentialsOpen, isMobile } from '../state';
import { CredentialServiceForm } from './CredentialServiceForm';
import type { RouteDraft } from './credential-routing';
import { OAuthAppForm } from './OAuthAppForm';
import type { OAuthAppDraft } from './oauth-app-form';
import { OAuthScopePicker } from './OAuthScopePicker';
import { ApprovalCard } from './ApprovalCard';
import { AccessRequestReview } from './AccessRequestReview';
import { accessApprovalId } from '../credentials-navigation';

const hooks = vi.hoisted(() => {
  vi.stubGlobal('window', { matchMedia: () => ({ matches: false }) });
  return {
    slots: [] as unknown[],
    cursor: 0,
    effects: [] as (() => void | (() => void))[],
    urls: [] as string[],
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
  useCredentialResource: (url: string) => {
    hooks.urls.push(url);
    return hooks.resource;
  },
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
  accessApprovalId.value = null;
  hooks.slots = [];
  hooks.cursor = 0;
  hooks.effects = [];
  hooks.urls = [];
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
  accessApprovalId.value = null;
  credentialsOpen.value = false;
  isMobile.value = false;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

interface TestProps {
  message?: string;
  'aria-label'?: string;
  open?: boolean;
  class?: string;
  scopes?: string;
  appId?: string;
  resource?: string;
  footer: unknown;
  value: unknown;
  type: string;
  disabled: boolean;
  checked: boolean;
  connection: Connection;
  connections: Connection[];
  draft: OAuthAppDraft;
  route: RouteDraft;
  group: CredentialGroup;
  onlyGroup?: string;
  onChange(value: unknown): void;
  onInput(value: unknown): void;
  oninput(value: unknown): void;
  onClick(): void;
  onClose(): void;
  onBack?: () => void;
  title?: string;
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

describe('assisted credential approval UI', () => {
  it('surfaces a newly created credential that did not receive requested scopes without choosing a fallback', () => {
    hooks.resource.data = {
      request_id: 'access-one',
      status: 'pending',
      resource_url: 'https://api.example.com/',
      reason: 'Read mail',
      revision: 1,
      agent_group_id: 'one',
      result: null,
      authentication: { type: 'mcp_oauth' },
      scopes: ['read'],
    };
    const created: Connection = {
      ...original,
      id: 'new-oauth',
      kind: 'mcp_oauth',
      scope_source: 'provider',
      granted_scopes: ['other'],
    };
    const onManage = vi.fn();
    const node = AccessRequestReview({
      id: 'access-one',
      connections: [original, created],
      preferredConnectionId: created.id,
      onCreate: vi.fn(),
      onManage,
      onSaved: vi.fn(),
    });
    expect(
      descendants(node)
        .filter((child) => child.type === 'option')
        .map((child) => child.props.value),
    ).toEqual(['']);
    descendants(node)
      .find((child) => child.type === 'button' && child.props.children === 'Review new credential')!
      .props.onClick();
    expect(onManage).toHaveBeenCalledWith(created);
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });
  it('lists only URL/mechanism-compatible credentials and passes creation suggestions intact', () => {
    const request = {
      request_id: 'access-one',
      status: 'pending',
      resource_url: 'https://api.example.com/',
      reason: 'Read the report',
      revision: 1,
      agent_group_id: 'one',
      result: null,
      authentication: { type: 'basic' as const },
    };
    hooks.resource.data = request;
    const wrongUrl = {
      ...original,
      id: 'wrong-url',
      services: [{ ...original.services[0], host: 'other.example.com' }],
    };
    const wrongMethod = {
      ...original,
      id: 'wrong-method',
      services: [{ ...original.services[0], auth: { type: 'bearer', token: 'TOKEN' } }],
    };
    const onCreate = vi.fn();
    const node = AccessRequestReview({
      id: request.request_id,
      connections: [original, wrongUrl, wrongMethod],
      onCreate,
      onManage: vi.fn(),
      onSaved: vi.fn(),
    });
    expect(
      descendants(node)
        .filter((child) => child.type === 'option')
        .map((child) => child.props.value),
    ).toEqual(['', original.id]);
    descendants(node)
      .find((child) => child.type === 'button' && child.props.children === 'Add account')!
      .props.onClick();
    expect(onCreate).toHaveBeenCalledWith(request);
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });
  it('prefills researched MCP OAuth settings but starts consent only on an explicit action', () => {
    const request = {
      resource_url: 'https://gmailmcp.example.com/mcp/v1',
      mcp_server: 'google-gmail',
      authentication: { type: 'mcp_oauth' as const },
      scopes: ['mail.read'],
    };
    const draw = newFormRenderer({ accessRequest: request });
    const node = draw();
    const kind = descendants(node).find(
      (child) =>
        child.type === 'select' &&
        (child.props as TestProps & { 'aria-label'?: string })['aria-label'] === 'Credential type',
    )!;
    expect(kind.props.value).toBe('mcp_oauth');
    const oauth = descendants(node).find(
      (child) => typeof child.type === 'function' && child.type.name === 'OAuthFields',
    )!;
    expect(oauth.props.scopes).toBe('mail.read');
    expect(oauth.props.resource).toBe(request.resource_url);
    expect(
      descendants(node).find((child) => child.type === 'button' && child.props.type === 'submit')?.props.disabled,
    ).toBe(false);
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });
  it('keeps the general credential table out of access-review mode', () => {
    hooks.resource.data = { connections: [original], groups, apps: [], canEditInstall: true };
    accessApprovalId.value = 'access-one';
    const node = CredentialsContent();
    expect(descendants(node).some((child) => child.type === AccessRequestReview)).toBe(true);
    expect(descendants(node).some((child) => child.type === CredentialsTable)).toBe(false);
  });
  it('lets the user pin a private granted connection and an account alias without copying headers', () => {
    hooks.resource.data = {
      grants: [
        {
          connection_id: original.id,
          label: original.label,
          owner: original.owner,
          services: original.services,
          status: 'active',
        },
      ],
    };
    const onAuthenticationChange = vi.fn();
    const node = McpConnectionAccess({
      gid: 'one',
      resourceUrl: 'https://api.example.com/mcp',
      serverName: 'gmail_personal',
      onAuthenticationChange,
      onOpenCredentials: vi.fn(),
    });
    descendants(node)
      .find((child) => child.type === 'select')!
      .props.onChange({ currentTarget: { value: original.id } });
    expect(onAuthenticationChange).toHaveBeenCalledWith({
      connection_id: original.id,
      account_alias: 'gmail_personal',
    });
    expect(JSON.stringify(onAuthenticationChange.mock.calls)).not.toContain('Authorization');
    expect(JSON.stringify(onAuthenticationChange.mock.calls)).not.toContain('BIND_');
  });
  it('uses a non-authorizing review action while retaining ordinary approval buttons', () => {
    const onReview = vi.fn(),
      onRespond = vi.fn();
    const approval = {
      approvalId: 'access-one',
      action: 'request_access',
      title: 'Request access',
      details: 'Read calendar',
      packages: null,
      options: [
        { label: 'Review access', value: 'review', selectedLabel: 'Review' },
        { label: 'Reject', value: 'reject', selectedLabel: 'Rejected' },
      ],
      agentGroupId: 'one',
      agentGroupName: 'One',
      createdAt: '2026-01-01',
      reviewRequired: true,
      stage: 'pending',
    };
    const card = ApprovalCard({ approval, busy: false, onReview, onRespond });
    const buttons = descendants(card).filter((node) => node.type === 'button');
    buttons[0].props.onClick();
    expect(onReview).toHaveBeenCalledOnce();
    expect(onRespond).not.toHaveBeenCalled();
    buttons[1].props.onClick();
    expect(onRespond).toHaveBeenCalledWith('reject');
    const simple = ApprovalCard({
      approval: {
        ...approval,
        action: 'install_packages',
        reviewRequired: false,
        options: [{ label: 'Approve', value: 'approve', selectedLabel: 'Approved' }],
      },
      busy: false,
      onReview,
      onRespond,
    });
    descendants(simple)
      .find((node) => node.type === 'button')!
      .props.onClick();
    expect(onRespond).toHaveBeenCalledWith('approve');
  });

  it('reopens failed requests without granting access or retaining the account or server choice', async () => {
    hooks.resource.data = {
      request_id: 'access-one',
      status: 'failed',
      revision: 3,
      resource_url: 'https://api.example.com/',
      reason: 'Read the report',
      result: { message: 'Grant may already exist.' },
    };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}')));
    const onSaved = vi.fn();
    const node = AccessRequestReview({
      id: 'access-one',
      connections: [original],
      onCreate: vi.fn(),
      onManage: vi.fn(),
      onSaved,
    }) as TestNode;
    hooks.slots[0] = original.id;
    hooks.slots[4] = true;
    const retry = descendants(node).find(
      (child) => child.type === 'button' && child.props.children === 'Review and retry',
    )!;
    await retry.props.onClick();
    await vi.waitFor(() => expect(onSaved).toHaveBeenCalledOnce());
    expect(vi.mocked(fetch)).toHaveBeenCalledOnce();
    const [url, options] = vi.mocked(fetch).mock.calls[0];
    expect(url).toBe('/ui/chat/api/credentials/access-requests/access-one/retry');
    expect(JSON.parse(String(options?.body))).toEqual({ request_revision: 3 });
    expect(hooks.resource.refresh).toHaveBeenCalled();
    expect(hooks.slots[0]).toBe('');
    expect(hooks.slots[4]).toBe(false);
  });

  it('uses the Allow access button as confirmation without a checkbox or permission notice', async () => {
    const request = {
      request_id: 'access-one',
      status: 'pending',
      resource_url: 'https://api.example.com/',
      reason: 'Read the report',
      revision: 1,
      agent_group_id: 'one',
      result: null,
    };
    hooks.resource.data = request;
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(
        async () =>
          new Response(
            JSON.stringify({
              request,
              connection: original,
              matches: true,
              grantBreadth: 'All current and future URL patterns.',
              verification: 'Authenticated operation not verified.',
            }),
          ),
      ),
    );
    const props = { id: 'access-one', connections: [original], onCreate: vi.fn(), onManage: vi.fn(), onSaved: vi.fn() };
    const draw = (): TestNode => {
      hooks.cursor = 0;
      hooks.effects = [];
      return AccessRequestReview(props) as TestNode;
    };
    let node = draw();
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
    descendants(node)
      .find((child) => child.type === 'select')!
      .props.onChange({ currentTarget: { value: original.id } });
    node = draw();
    for (const effect of hooks.effects) effect();
    await vi.waitFor(() => expect(hooks.slots[1]).toMatchObject({ matches: true }));
    node = draw();
    const allow = (): TestNode =>
      descendants(node).find((child) => child.type === 'button' && child.props.class === 'primary')!;
    expect(allow().props.disabled).toBe(false);
    expect(descendants(node).filter((child) => child.type === 'input' && child.props.type === 'checkbox')).toHaveLength(
      0,
    );
    expect(
      descendants(node)
        .filter((child) => child.type === 'label')
        .map((child) => child.props.children),
    ).not.toContain(
      'Allow this agent to use this connection, including its full permissions and current and future URL patterns.',
    );
    expect(
      descendants(node).some(
        (child) => child.type === 'p' && child.props.children === 'All current and future URL patterns.',
      ),
    ).toBe(false);
    expect(vi.mocked(fetch).mock.calls.every(([url]) => String(url).endsWith('/preview'))).toBe(true);
    props.connections = [{ ...original, revision: 'new-revision' }];
    node = draw();
    expect(allow().props.disabled).toBe(true);
    await allow().props.onClick();
    expect(vi.mocked(fetch)).toHaveBeenCalledOnce();
    props.connections = [{ ...original, status: 'disabled' }];
    node = draw();
    expect(allow().props.disabled).toBe(true);
    await allow().props.onClick();
    expect(vi.mocked(fetch)).toHaveBeenCalledOnce();
    props.connections = [original];
    node = draw();
    await allow().props.onClick();
    await vi.waitFor(() => expect(props.onSaved).toHaveBeenCalledOnce());
    const [url, options] = vi.mocked(fetch).mock.calls[1];
    expect(String(url)).toMatch(/\/apply$/);
    expect(JSON.parse(String(options?.body))).toMatchObject({
      connection_id: original.id,
      connection_revision: original.revision,
      request_revision: 1,
      configure_mcp: false,
    });
  });

  it('keeps named MCP setup compact and defaults the nickname to the selected account', async () => {
    const request = {
      request_id: 'access-one',
      status: 'pending',
      resource_url: 'https://api.example.com/',
      reason: 'Read the report',
      revision: 1,
      agent_group_id: 'one',
      mcp_server: 'search',
      result: null,
    };
    hooks.resource.data = request;
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(
        async () =>
          new Response(
            JSON.stringify({
              request,
              connection: original,
              matches: true,
              grantBreadth: 'Full access',
              verification: 'Not yet verified',
              mcp: {
                names: ['search'],
                revision: 'mcp-r1',
                configured: {
                  search: { connection_id: 'another-account', account_alias: 'Work account' },
                },
              },
            }),
          ),
      ),
    );
    const draw = (): TestNode => {
      hooks.cursor = 0;
      hooks.effects = [];
      return AccessRequestReview({
        id: request.request_id,
        connections: [original],
        onCreate: vi.fn(),
        onManage: vi.fn(),
        onSaved: vi.fn(),
      }) as TestNode;
    };
    let node = draw();
    find(node, 'select').props.onChange({ currentTarget: { value: original.id } });
    node = draw();
    for (const effect of hooks.effects) effect();
    await vi.waitFor(() => expect(hooks.slots[1]).toMatchObject({ matches: true }));
    node = draw();
    const checkboxes = descendants(node).filter((child) => child.type === 'input' && child.props.type === 'checkbox');
    expect(checkboxes).toHaveLength(1);
    checkboxes[0].props.onChange({ currentTarget: { checked: true } });
    node = draw();
    expect(descendants(node).filter((child) => child.type === 'select')).toHaveLength(1);
    const nickname = descendants(node).find(
      (child) => child.type === 'input' && child.props['aria-label'] === 'Account nickname',
    )!;
    expect(nickname.props.value).toBe(original.label);
    expect(
      descendants(node)
        .filter((child) => child.type === 'details')
        .every((child) => !child.props.open),
    ).toBe(true);
    const allow = (): TestNode =>
      descendants(node).find((child) => child.type === 'button' && child.props.children === 'Allow access')!;
    nickname.props.oninput({ currentTarget: { value: '' } });
    node = draw();
    expect(allow().props.disabled).toBe(true);
    nickname.props.oninput({ currentTarget: { value: 'Personal account' } });
    node = draw();
    expect(allow().props.disabled).toBe(false);
    await allow().props.onClick();
    const [, options] = vi.mocked(fetch).mock.calls.at(-1)!;
    expect(JSON.parse(String(options?.body))).toMatchObject({
      configure_mcp: true,
      mcp_server: 'search',
      account_alias: 'Personal account',
      config_revision: 'mcp-r1',
    });
  });
});
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
  const editor = ConnectionEditor({
    id: original.id,
    apps: [],
    onStart: vi.fn(),
    groups,
    onClose: vi.fn(),
    onSaved: vi.fn(),
  });
  const form = render(editor);
  return () => render(form);
}
function newFormRenderer(options: Partial<Parameters<typeof ConnectionEditor>[0]> = {}): () => TestNode {
  const form = ConnectionEditor({ apps: [], onStart: vi.fn(), groups, onClose: vi.fn(), onSaved: vi.fn(), ...options });
  return () => render(form);
}
function nameInput(node: unknown): TestNode {
  return descendants(node).find(
    (child) =>
      child.type === 'input' &&
      (child.props as TestProps & { 'aria-label'?: string })['aria-label'] === 'Credential name',
  )!;
}
function requestBody(): Record<string, unknown> {
  return JSON.parse(vi.mocked(fetch).mock.calls.at(-1)![1]!.body as string) as Record<string, unknown>;
}

describe('connection UI safety and ownership', () => {
  it.each([false, true])('uses the standard account dialog and authorization table (mobile=%s)', (mobile) => {
    credentialsOpen.value = true;
    isMobile.value = mobile;
    hooks.resource.data = { connections: [original], groups, apps: [], canEditInstall: false };
    const wrapper = CredentialsPage();
    expect(wrapper).not.toBeNull();
    const dialog = render(wrapper!);
    expect(dialog.type).toBe(MobileDialog);
    expect(dialog.props.title).toBe('My Credentials');
    expect(typeof dialog.props.onBack).toBe(mobile ? 'function' : 'undefined');
    expect(find(dialog, CredentialsTable)).toBeDefined();
    const labels = descendants(dialog)
      .map((child) => (typeof child.props.children === 'string' ? child.props.children : ''))
      .join(' ');
    expect(labels).not.toContain('Your personal keys');
    expect(labels).not.toContain('A connection can hold');
    expect(labels).not.toContain('Authorize a provider');
    expect(labels).not.toContain('Available to');
  });
  it('combines keys and accounts while keeping OAuth apps in their own section', () => {
    credentialsOpen.value = true;
    const account: Connection = { ...original, id: 'account', kind: 'mcp_oauth' };
    hooks.resource.data = { connections: [original, account], groups, apps: [], canEditInstall: false };
    const wrapper = CredentialsPage()!;
    let node = render(wrapper);
    expect(find(node, CredentialsTable).props.connections.map((item) => item.id)).toEqual(['pair', 'account']);
    expect(descendants(node).some((item) => item.props.children === 'Connected accounts')).toBe(false);
    expect(descendants(node).some((item) => item.props.children === 'Keys')).toBe(false);
    descendants(node)
      .find((item) => item.type === 'button' && item.props.children === 'OAuth apps')!
      .props.onClick();
    node = render(wrapper);
    expect(find(node, CredentialsTable)).toBeUndefined();
    expect(descendants(node).some((item) => item.props.children === 'No OAuth apps configured.')).toBe(true);
  });
  it('uses the OAuth app form and keeps a configured secret write-only and unchanged on a blank save', async () => {
    const app: AppInfo = {
      id: 'provider',
      label: 'Provider',
      source: 'user',
      issuer: 'https://accounts.example.com',
      client_id: 'client',
      api_hosts: ['api.example.com'],
      default_scopes: [],
      token_endpoint_auth_method: 'client_secret_post',
      identity: 'none',
      token_scope_separator: 'space',
      client_secret_set: true,
      authorization_params: { access_type: 'offline' },
    };
    const draw = (): TestNode => {
      hooks.cursor = 0;
      return OAuthAppDialog({
        app,
        canEditInstall: false,
        connections: [],
        groups,
        onClose: vi.fn(),
        onSaved: vi.fn(),
      }) as TestNode;
    };
    const node = draw();
    expect(find(node, OAuthAppForm)).toBeDefined();
    expect(find(node, 'textarea')).toBeUndefined();
    expect(find(node, SecretInput).props.value).toBe('');
    expect(descendants(node).filter((child) => child.type === 'input' && child.props.type === 'checkbox')).toHaveLength(
      0,
    );
    descendants(node)
      .find((item) => item.type === 'button' && item.props.children === 'Save app')!
      .props.onClick();
    await vi.waitFor(() => expect(vi.mocked(fetch)).toHaveBeenCalledOnce());
    expect(requestBody()).not.toHaveProperty('clientSecret');
    expect(requestBody()).toMatchObject({
      config: { authorization_params: { access_type: 'offline' }, client_id: 'client' },
    });
  });

  it('keeps new app validation quiet until editing, and rejects secrets for public clients', () => {
    let node: TestNode = OAuthAppDialog({
      canEditInstall: false,
      connections: [],
      groups,
      onClose: vi.fn(),
      onSaved: vi.fn(),
    });
    expect(
      descendants(node)
        .filter((child) => child.type === ErrorNotice)
        .every((child) => !child.props.message),
    ).toBe(true);
    hooks.slots = [];
    const app: AppInfo = {
      id: 'public',
      label: 'Public app',
      source: 'user',
      issuer: 'https://accounts.example.com',
      client_id: 'client',
      api_hosts: ['api.example.com'],
      default_scopes: [],
      token_endpoint_auth_method: 'none',
      client_secret_set: false,
      identity: 'none',
      token_scope_separator: 'space',
    };
    const draw = (): TestNode => {
      hooks.cursor = 0;
      return OAuthAppDialog({
        app,
        canEditInstall: false,
        connections: [],
        groups,
        onClose: vi.fn(),
        onSaved: vi.fn(),
      }) as TestNode;
    };
    node = draw();
    find(node, SecretInput).props.onInput('must-not-be-saved');
    node = draw();
    const save = descendants(node).find((child) => child.type === 'button' && child.props.children === 'Save app')!;
    expect(save.props.disabled).toBe(true);
    save.props.onClick();
    expect(fetch).not.toHaveBeenCalled();
    expect(
      descendants(node).some(
        (child) =>
          child.type === ErrorNotice && child.props.message === 'Public clients must not have a client secret.',
      ),
    ).toBe(true);
  });

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
    expect(descendants(node).filter((child) => child.type === 'input' && child.props.type === 'checkbox')).toHaveLength(
      0,
    );
    nameInput(node).props.oninput({ currentTarget: { value: 'Renamed credential' } });
    node = draw();
    await find(node, 'form').props.onSubmit({ preventDefault: vi.fn() });
    expect(requestBody()).toEqual({ label: 'Renamed credential', revision: original.revision });
    expect(requestBody()).not.toHaveProperty('values');
    expect(requestBody()).not.toHaveProperty('services');
  });

  it('rotates a provided component once, preserving the blank username and reviewed revision', async () => {
    const draw = formRenderer();
    let node = draw();
    descendants(node)
      .filter((child) => child.type === SecretInput)[1]
      .props.onInput('replacement');
    node = draw();
    await find(node, 'form').props.onSubmit({ preventDefault: vi.fn() });
    expect(fetch).toHaveBeenCalledOnce();
    expect(vi.mocked(fetch).mock.calls[0][0]).toBe('/ui/chat/api/credentials/connections/pair');
    expect(requestBody()).toMatchObject({ revision: '"reviewed"', values: { PASSWORD: 'replacement' } });
    expect(requestBody()).not.toHaveProperty('services');
    expect(descendants(node).filter((child) => child.type === 'input' && child.props.type === 'checkbox')).toHaveLength(
      0,
    );
  });

  it('uses routing form controls and saves changed destinations without a review checkbox', async () => {
    const draw = formRenderer();
    let node = draw();
    const routing = find(node, CredentialServiceForm);
    routing.props.onChange({ ...routing.props.route, pattern: 'https://different.example.com/api/*' });
    node = draw();
    expect(descendants(node).find((child) => child.props.type === 'submit')!.props.disabled).toBe(false);
    expect(find(node, 'textarea')).toBeUndefined();
    expect(descendants(node).filter((child) => child.type === 'input' && child.props.type === 'checkbox')).toHaveLength(
      0,
    );
    await find(node, 'form').props.onSubmit({ preventDefault: vi.fn() });
    expect(requestBody()).toMatchObject({
      services: [{ name: 'basic', host: 'different.example.com/api/*', https_only: true }],
    });
  });

  it('names new credentials from the first URL until the user edits the name', () => {
    const draw = newFormRenderer();
    let node = draw();
    let routing = find(node, CredentialServiceForm);
    routing.props.onChange({ ...routing.props.route, pattern: 'https://first.example.com/api/*' });
    node = draw();
    expect(nameInput(node).props.value).toBe('first.example.com');
    routing = find(node, CredentialServiceForm);
    routing.props.onChange({ ...routing.props.route, pattern: 'https://second.example.com/api/*' });
    node = draw();
    expect(nameInput(node).props.value).toBe('second.example.com');
    nameInput(node).props.oninput({ currentTarget: { value: 'My chosen name' } });
    node = draw();
    routing = find(node, CredentialServiceForm);
    routing.props.onChange({ ...routing.props.route, pattern: 'https://third.example.com/api/*' });
    node = draw();
    expect(nameInput(node).props.value).toBe('My chosen name');
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

  it('uses only the private personal collection in the shared agent table', () => {
    const node = GroupCredentials({ gid: 'one' });
    expect(find(node, CredentialsContent)).toBeDefined();
    hooks.resource.data = { connections: [original], groups, apps: [], canEditInstall: false };
    hooks.cursor = 0;
    const content = render(find(node, CredentialsContent));
    expect(find(content, CredentialsTable).props.onlyGroup).toBe('one');
    expect(hooks.urls).toEqual(['/ui/chat/api/credentials']);
    expect(descendants(content).some((child) => child.type === 'nav')).toBe(false);
    expect(find(content, MobileDialog)).toBeUndefined();
  });
  it('guides an empty owner library to personal Credentials without granting anything', () => {
    hooks.resource.data = { connections: [], groups, apps: [], canEditInstall: false };
    const node = CredentialsContent({ agent: { id: 'one' } });
    expect(
      descendants(node).some((child) => child.type === 'button' && child.props.children === 'Open My Credentials'),
    ).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
  });
  it('creates OAuth in the same editor and retries a saved draft without duplicating it', async () => {
    const start = vi.fn().mockRejectedValueOnce(new TypeError('Network unavailable')).mockResolvedValueOnce(undefined);
    const draw = newFormRenderer({ onStart: start });
    let node = draw();
    const route = find(node, CredentialServiceForm);
    route.props.onChange({ ...route.props.route, pattern: 'https://mcp.example.com/mcp' });
    node = draw();
    nameInput(node).props.oninput({ currentTarget: { value: 'My browser' } });
    node = draw();
    descendants(node)
      .find((child) => child.type === 'select')!
      .props.onChange({ currentTarget: { value: 'mcp_oauth' } });
    node = draw();
    expect(node.props.title).toBe('Add credential');
    expect(nameInput(node).props.value).toBe('My browser');
    const fields = descendants(node).find(
      (child) => typeof child.type === 'function' && child.type.name === 'OAuthFields',
    )!;
    find(render(fields), OAuthScopePicker).props.onChange('mcp');
    node = draw();
    expect(
      descendants(node).some((child) => typeof child.type === 'function' && child.type.name === 'OAuthReview'),
    ).toBe(false);
    expect(descendants(node).find((child) => child.props.type === 'submit')!.props.disabled).toBe(false);
    await find(node, 'form').props.onSubmit({ preventDefault: vi.fn() });
    expect(requestBody()).toMatchObject({
      label: 'My browser',
      kind: 'mcp_oauth',
      resource_url: 'https://mcp.example.com/mcp',
    });
    expect(requestBody()).not.toHaveProperty('services');
    node = draw();
    await find(node, 'form').props.onSubmit({ preventDefault: vi.fn() });
    expect(fetch).toHaveBeenCalledOnce();
    expect(start).toHaveBeenCalledTimes(2);
  });

  it('starts reconnect with valid fields and no acknowledgement checkbox', async () => {
    const start = vi.fn().mockResolvedValue(undefined);
    const connection: Connection = {
      ...original,
      kind: 'mcp_oauth',
      resource_url: 'https://mcp.example.com/mcp',
      requested_scopes: ['read'],
    };
    const node = OAuthConnectionDialog({
      connection,
      apps: [],
      groups,
      onStart: start,
      onClose: vi.fn(),
      onSaved: vi.fn(),
    });
    expect(descendants(node).filter((child) => child.type === 'input' && child.props.type === 'checkbox')).toHaveLength(
      0,
    );
    expect(descendants(node).find((child) => child.props.type === 'submit')!.props.disabled).toBe(false);
    await find(node, 'form').props.onSubmit({ preventDefault: vi.fn() });
    expect(start).toHaveBeenCalledWith(connection.id, {
      resource_url: connection.resource_url,
      scopes: ['read'],
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('keeps invalid OAuth fields blocked without an acknowledgement step', () => {
    const node = OAuthConnectionDialog({
      connection: { ...original, kind: 'mcp_oauth', resource_url: 'http://insecure.example/mcp' },
      apps: [],
      groups,
      onStart: vi.fn(),
      onClose: vi.fn(),
      onSaved: vi.fn(),
    });
    expect(descendants(node).find((child) => child.props.type === 'submit')!.props.disabled).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('runs an explicitly selected connection action without an acknowledgement checkbox', async () => {
    const onConfirm = vi.fn().mockResolvedValue(undefined);
    const onClose = vi.fn();
    const node = ConfirmCredentialAction({
      title: 'Disable credential',
      label: 'Disable',
      children: null,
      onConfirm,
      onClose,
    });
    expect(descendants(node).filter((child) => child.type === 'input' && child.props.type === 'checkbox')).toHaveLength(
      0,
    );
    const action = descendants(node).find((child) => child.type === 'button' && child.props.children === 'Disable')!;
    expect(action.props.disabled).toBe(false);
    action.props.onClick();
    await vi.waitFor(() => expect(onClose).toHaveBeenCalledOnce());
    expect(onConfirm).toHaveBeenCalledOnce();
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
