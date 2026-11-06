import { UiResponse as Response } from '../api-test-fixtures';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppInfo, Connection, CredentialGroup, Service } from './CredentialsApi';
import type { AccountInteraction } from '../../../../shared/approval';
import { testAccountInteraction } from '../conversation-test-fixtures';
import { ConnectionActionDialog, ConnectionEditor, OAuthAppDialog, OAuthConnectionDialog } from './CredentialsDialogs';
import {
  ConfirmCredentialAction,
  CredentialDialog,
  ErrorNotice,
  SecretInput,
  useConnectionSignIn,
} from './CredentialsParts';
import { GroupCredentials, McpConnectionAccess, serviceMatchesResource } from './GroupCredentialAccess';
import { showToast } from './Toast';
import { AccessRequestRedirect, CredentialsContent, CredentialsPage } from './CredentialsPage';
import { CredentialsTable } from './CredentialsTable';
import { MobileDialog } from './MobileDialog';
import { ModalDialog } from './ModalDialog';
import { channelType, credentialsOpen, groupId, isMobile, messagingGroupId, threadId } from '../state';
import { CredentialAuthenticationForm, CredentialServiceForm } from './CredentialServiceForm';
import type { RouteDraft } from './credential-routing';
import { OAuthAppForm } from './OAuthAppForm';
import type { OAuthAppDraft } from './oauth-app-form';
import { OAuthScopePicker, ScopeList } from './OAuthScopePicker';
import { ApprovalCardFrame } from './ApprovalCard';
import { ApprovalMessageInput } from './ApprovalMessageInput';
import { AccessRequestReview } from './AccessRequestReview';
import { AccessRequestCard } from './AccessRequestCard';
import { accessApprovalId } from '../credentials-navigation';
import type { AccessRequirements } from '../../../../shared/access-authentication';

const hooks = vi.hoisted(() => {
  vi.stubGlobal('window', { matchMedia: () => ({ matches: false }) });
  return {
    slots: [] as unknown[],
    cursor: 0,
    effects: [] as (() => void | (() => void))[],
    urls: [] as string[],
    resource: { data: null as unknown, error: '', loading: false, refresh: vi.fn().mockResolvedValue(undefined) },
    request: null as AccountInteraction | null,
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
  groupId.value = 'one';
  threadId.value = 'thread-one';
  channelType.value = 'web';
  messagingGroupId.value = null;
  accessApprovalId.value = null;
  hooks.slots = [];
  hooks.cursor = 0;
  hooks.effects = [];
  hooks.urls = [];
  hooks.request = testAccountInteraction();
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
  busy?: boolean;
  auth: Service['auth'];
  savedLabel?: string;
  preferredKey?: string;
  message?: string;
  description?: string;
  href?: string;
  signInMessage?: unknown;
  'aria-label'?: string;
  open?: boolean;
  class?: string;
  scopes?: string | string[];
  unspecifiedScopes?: boolean;
  onScopes?: (value: string) => void;
  selectDiscovered?: boolean;
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
  onCreate(request: AccessRequirements): void | Promise<void>;
  onManage(connection: Connection, request?: AccessRequirements): void;
  onCreated(connection: Connection): void;
  accessRequest?: AccessRequirements;
  preferredConnectionId?: string;
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
    hooks.request = testAccountInteraction({
      requirements: {
        reason: 'Read mail',
        authentication: { type: 'mcp_oauth' },
        scopes: ['read'],
      },
    });
    const created: Connection = {
      ...original,
      id: 'new-oauth',
      kind: 'mcp_oauth',
      scope_source: 'provider',
      granted_scopes: ['other'],
    };
    const onManage = vi.fn();
    const node = AccessRequestReview({
      request: hooks.request!,
      connections: [original, created],
      preferredConnectionId: created.id,
      onCreate: vi.fn(),
      onManage,
      onSaved: vi.fn(),
    });
    expect(
      descendants(node)
        .filter((child) => child.type === 'input' && child.props.type === 'radio')
        .map((child) => child.props.value),
    ).toEqual([]);
    descendants(node)
      .find((child) => child.type === 'button' && child.props.children === 'Review the new account')!
      .props.onClick();
    expect(onManage).toHaveBeenCalledWith(created, expect.objectContaining({ scopes: ['read'] }));
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });
  it('lists only URL/mechanism-compatible credentials and starts setup separately before creation', async () => {
    const request = testAccountInteraction({
      requirements: {
        authentication: { type: 'basic' as const },
      },
    });
    hooks.request = request;
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
      request: hooks.request!,
      connections: [original, wrongUrl, wrongMethod],
      onCreate,
      onManage: vi.fn(),
      onSaved: vi.fn(),
    });
    expect(
      descendants(node)
        .filter((child) => child.type === 'input' && child.props.type === 'radio')
        .map((child) => child.props.value),
    ).toEqual([original.id]);
    await descendants(node)
      .find((child) => child.type === 'button' && child.props.children === 'Add account')!
      .props.onClick();
    expect(onCreate).toHaveBeenCalledWith(expect.objectContaining(request.requirements));
    expect(vi.mocked(fetch).mock.calls[0][0]).toBe('/ui/chat/api/credentials/access-requests/access-one/setup');
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
        (child.props as TestProps & { 'aria-label'?: string })['aria-label'] === 'Account type',
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
  it('routes legacy review links to the chat instead of rendering a second review screen', () => {
    hooks.resource.data = { connections: [original], groups, apps: [], canEditInstall: true };
    accessApprovalId.value = 'access-one';
    const node = CredentialsContent();
    expect(descendants(node).some((child) => child.type === AccessRequestRedirect)).toBe(true);
    expect(descendants(node).some((child) => child.type === AccessRequestReview)).toBe(false);
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
  it('hides the account selector with no matches without dropping an unavailable saved account', () => {
    hooks.resource.data = { grants: [] };
    const onAuthenticationChange = vi.fn();
    const onOpenCredentials = vi.fn();
    const node = McpConnectionAccess({
      gid: 'one',
      resourceUrl: 'https://other.example.com/mcp',
      serverName: 'tavily',
      authentication: { connection_id: 'saved-account', account_alias: 'Personal' },
      onAuthenticationChange,
      onOpenCredentials,
    });
    expect(descendants(node).some((child) => child.type === 'select')).toBe(false);
    expect(descendants(node).some((child) => child.type === 'span' && child.props.children === 'Account')).toBe(true);
    expect(
      descendants(node).some(
        (child) => child.type === 'p' && child.props.children === 'Your saved account is not available to this agent.',
      ),
    ).toBe(true);
    expect(descendants(node).find((child) => child.type === 'input')!.props.value).toBe('Personal');
    descendants(node)
      .find((child) => child.type === 'button' && child.props.children === 'Add an account')!
      .props.onClick();
    expect(onOpenCredentials).toHaveBeenCalledWith(true, undefined);
    expect(onAuthenticationChange).not.toHaveBeenCalled();
    expect(JSON.stringify(node)).not.toContain('Sign in as yourself');
    expect(JSON.stringify(node)).not.toContain('Account for these tools');
  });

  it('reopens failed requests without granting access or retaining the account or server choice', async () => {
    hooks.request = testAccountInteraction({
      status: 'failed',
      revision: 3,
      outcomeMessage: { message: 'Grant may already exist.' }.message,
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}')));
    const onSaved = vi.fn();
    const node = AccessRequestReview({
      request: hooks.request!,
      connections: [original],
      onCreate: vi.fn(),
      onManage: vi.fn(),
      onSaved,
    }) as TestNode;
    hooks.slots[0] = original.id;
    hooks.slots[5] = true;
    const retry = descendants(node).find(
      (child) => child.type === 'button' && child.props.children === 'Review and retry',
    )!;
    await retry.props.onClick();
    await vi.waitFor(() => expect(onSaved).toHaveBeenCalledOnce());
    expect(vi.mocked(fetch)).toHaveBeenCalledOnce();
    const [url, options] = vi.mocked(fetch).mock.calls[0];
    expect(url).toBe('/ui/chat/api/credentials/access-requests/access-one/retry');
    expect(JSON.parse(String(options?.body))).toEqual({ request_revision: 3 });
    expect(hooks.urls).not.toContain('/ui/chat/api/credentials/access-requests/access-one');
    expect(hooks.slots[0]).toBe('');
    expect(hooks.slots[5]).toBe(false);
  });

  it('uses the Allow access button as confirmation without a checkbox or permission notice', async () => {
    const request = testAccountInteraction({});
    hooks.request = request;
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(
        async () =>
          new Response(
            JSON.stringify({
              requestRevision: request.revision,
              connection: original,
              matches: true,
              grantBreadth: 'All current and future URL patterns.',
              verification: 'Authenticated operation not verified.',
            }),
          ),
      ),
    );
    const props = { connections: [original], onCreate: vi.fn(), onManage: vi.fn(), onSaved: vi.fn() };
    const draw = (): TestNode => {
      hooks.cursor = 0;
      hooks.effects = [];
      return AccessRequestReview({ ...props, request: hooks.request! }) as TestNode;
    };
    let node = draw();
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
    descendants(node)
      .find((child) => child.type === 'input' && child.props.type === 'radio')!
      .props.onChange({ currentTarget: { value: original.id } });
    node = draw();
    for (const effect of hooks.effects) effect();
    await vi.waitFor(() => expect(hooks.slots[1]).toMatchObject({ matches: true }));
    node = draw();
    const allow = (): TestNode =>
      descendants(node).find(
        (child) => child.type === 'button' && child.props.class === 'approval-btn approval-approve primary',
      )!;
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
    expect(descendants(node).some((child) => child.type === 'button' && child.props.children === 'Allow access')).toBe(
      false,
    );
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
    node = draw();
    expect(allow().props.disabled).toBe(true);
    expect(descendants(node).some((child) => child.props.children === 'Waiting for confirmation…')).toBe(true);
    expect(hooks.urls).not.toContain('/ui/chat/api/credentials/access-requests/access-one');
    hooks.request = { ...hooks.request!, status: 'completed', revision: hooks.request!.revision + 1 };
    node = draw();
    expect(descendants(node).some((child) => child.props.children === 'Access granted.')).toBe(true);
  });

  it('keeps named MCP setup compact and defaults the nickname to the selected account', async () => {
    const request = testAccountInteraction({
      requirements: {
        mcp_server: 'search',
      },
    });
    hooks.request = request;
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(
        async () =>
          new Response(
            JSON.stringify({
              requestRevision: request.revision,
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
        request: hooks.request!,
        connections: [original],
        onCreate: vi.fn(),
        onManage: vi.fn(),
        onSaved: vi.fn(),
      }) as TestNode;
    };
    let node = draw();
    descendants(node)
      .find((child) => child.type === 'input' && child.props.type === 'radio')!
      .props.onChange({ currentTarget: { value: original.id } });
    node = draw();
    for (const effect of hooks.effects) effect();
    await vi.waitFor(() => expect(hooks.slots[1]).toMatchObject({ matches: true }));
    node = draw();
    const checkboxes = descendants(node).filter((child) => child.type === 'input' && child.props.type === 'checkbox');
    expect(checkboxes).toHaveLength(1);
    checkboxes[0].props.onChange({ currentTarget: { checked: true } });
    node = draw();
    expect(descendants(node).filter((child) => child.type === 'select')).toHaveLength(0);
    const nickname = descendants(node).find(
      (child) => child.type === 'input' && child.props['aria-label'] === 'Account name shown to agent',
    )!;
    expect(nickname.props.value).toBe(original.label);
    expect(descendants(node).filter((child) => child.type === 'details')).toHaveLength(0);
    expect(
      descendants(node).some((child) => child.type === 'section' && child.props['aria-label'] === 'Access details'),
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

describe('transcript access review presentation', () => {
  it('opens account setup without showing permission controls in the transcript', async () => {
    hooks.request = testAccountInteraction({
      kind: 'account_setup',
      revision: 2,
      requirements: {
        resource_url: 'https://mcp.example.com/mcp',
        authentication: { type: 'mcp_oauth' },
      },
    });
    const onCreate = vi.fn();
    const draw = () => {
      hooks.cursor = 0;
      hooks.effects = [];
      return AccessRequestReview({
        request: hooks.request!,
        connections: [],
        onCreate,
        onManage: vi.fn(),
        onSaved: vi.fn(),
      }) as TestNode;
    };
    let node = draw();
    expect(find(node, OAuthScopePicker)).toBeUndefined();
    const signIn = () =>
      descendants(node).find((child) => child.type === 'button' && child.props.children === 'Sign in')!;
    expect(signIn().props.disabled).toBe(false);
    await signIn().props.onClick();
    expect(onCreate).toHaveBeenCalledWith(expect.objectContaining({ resource_url: 'https://mcp.example.com/mcp' }));
    expect(fetch).not.toHaveBeenCalled();
  });
  it('filters ready accounts by enabled permissions, not previously requested permissions', () => {
    hooks.request = testAccountInteraction({
      requirements: {
        authentication: { type: 'mcp_oauth' },
        scopes: ['read'],
      },
    });
    const account: Connection = {
      ...original,
      kind: 'mcp_oauth',
      requested_scopes: ['read', 'write'],
      granted_scopes: ['read'],
      scope_source: 'provider',
    };
    const node = AccessRequestReview({
      request: hooks.request!,
      connections: [
        account,
        { ...account, id: 'missing-permission', granted_scopes: ['write'] },
        { ...account, id: 'unknown-permissions', scope_source: 'unknown' },
      ],
      onCreate: vi.fn(),
      onManage: vi.fn(),
      onSaved: vi.fn(),
    });
    expect(
      descendants(node)
        .filter((child) => child.type === 'input' && child.props.type === 'radio')
        .map((child) => child.props.value),
    ).toEqual([account.id]);
    expect(
      descendants(node).filter((child) => child.type === 'button' && child.props.children === 'Sign in'),
    ).toHaveLength(2);
  });
  it('shows all enabled account permissions rather than implying the request is a permission ceiling', async () => {
    const request = testAccountInteraction({
      requirements: {
        authentication: { type: 'mcp_oauth' },
        scopes: ['read'],
      },
    });
    const account: Connection = {
      ...original,
      kind: 'mcp_oauth',
      granted_scopes: ['read', 'write'],
      scope_source: 'provider',
    };
    hooks.request = request;
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(Response.json({ requestRevision: request.revision, connection: account, matches: true })),
    );
    const draw = () => {
      hooks.cursor = 0;
      hooks.effects = [];
      return AccessRequestReview({
        request: hooks.request!,
        connections: [account],
        onCreate: vi.fn(),
        onManage: vi.fn(),
        onSaved: vi.fn(),
      }) as TestNode;
    };
    let node = draw();
    descendants(node)
      .find((child) => child.type === 'input' && child.props.type === 'radio')!
      .props.onChange(account.id);
    node = draw();
    for (const effect of hooks.effects) effect();
    await vi.waitFor(() => expect(hooks.slots[1]).toMatchObject({ matches: true }));
    node = draw();
    expect(
      descendants(node).some(
        (child) =>
          child.type === 'p' && Array.isArray(child.props.children) && child.props.children.includes('read, write'),
      ),
    ).toBe(true);
    expect(
      descendants(node).some(
        (child) =>
          child.type === 'p' &&
          child.props.children === 'The agent receives all enabled permissions on this account to act on your behalf.',
      ),
    ).toBe(true);
  });
  it('passes the required permissions into an existing-account sign-in dialog', () => {
    hooks.resource.data = { connections: [original], groups, apps: [], canEditInstall: true };
    const draw = () => {
      hooks.cursor = 0;
      hooks.effects = [];
      return AccessRequestCard({ request: hooks.request! }) as TestNode;
    };
    let node = draw();
    const review = find(node, AccessRequestReview);
    const request = { resource_url: 'https://api.example.com/', scopes: ['read'] };
    review.props.onManage({ ...original, kind: 'mcp_oauth' }, request);
    node = draw();
    expect(find(node, OAuthConnectionDialog).props.accessRequest).toEqual(request);
    expect(fetch).not.toHaveBeenCalled();
  });
  it('shows only relevant OAuth setup information with no empty account picker', () => {
    hooks.request = testAccountInteraction({
      kind: 'account_setup',
      revision: 2,
      requirements: {
        resource_url: 'https://mcp.example.com/mcp',
        reason: 'A lengthy explanation of the missing account.',
        authentication: { type: 'mcp_oauth', app_id: 'provider' },
        scopes: ['read'],
      },
    });
    const node = AccessRequestReview({
      request: hooks.request!,
      connections: [],
      apps: [
        {
          id: 'provider',
          label: 'Provider',
          source: 'install',
          issuer: 'https://auth.example.com',
          client_id: 'test-client',
          client_secret_set: false,
          token_endpoint_auth_method: 'none',
          authorization_endpoint: 'https://auth.example.com/authorize',
          api_hosts: [],
          default_scopes: [],
          identity: 'none',
          token_scope_separator: 'space',
        },
      ],
      onCreate: vi.fn(),
      onManage: vi.fn(),
      onSaved: vi.fn(),
    });
    const buttons = descendants(node)
      .filter((child) => child.type === 'button')
      .map((child) => child.props.children);
    expect(buttons).toEqual(['Decline', 'Sign in']);
    expect(descendants(node).some((child) => child.type === 'fieldset' || child.type === 'blockquote')).toBe(false);
    expect(descendants(node).some((child) => child.props['aria-label'] === 'Access details')).toBe(false);
    expect(
      descendants(node).some(
        (child) => child.type === 'p' && child.props.children === 'https://auth.example.com/authorize',
      ),
    ).toBe(true);
    expect(descendants(node).some((child) => child.type === 'li' && child.props.children === 'read')).toBe(false);
    expect(find(node, OAuthScopePicker)).toBeUndefined();
    expect(fetch).not.toHaveBeenCalled();
  });
  it('reports an unavailable setup API without flashing a dialog or starting sign-in', async () => {
    hooks.request = testAccountInteraction({
      requirements: {
        resource_url: 'https://mcp.example.com/mcp',
        authentication: { type: 'mcp_oauth' },
        scopes: ['read'],
      },
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ error: 'not_found' }, { status: 404 })));
    const onCreate = vi.fn();
    const draw = () => {
      hooks.cursor = 0;
      hooks.effects = [];
      return AccessRequestReview({
        request: hooks.request!,
        connections: [],
        onCreate,
        onManage: vi.fn(),
        onSaved: vi.fn(),
      }) as TestNode;
    };
    const node = draw();
    await descendants(node)
      .find((child) => child.type === 'button' && child.props.children === 'Sign in')!
      .props.onClick();
    const next = draw();
    expect(
      descendants(next)
        .filter((child) => child.type === ErrorNotice)
        .map((child) => child.props.message),
    ).toContain('Account setup unavailable. Reload and retry.');
    expect(onCreate).not.toHaveBeenCalled();
  });
  it('hides draft account controls while OAuth sign-in is pending', () => {
    hooks.request = testAccountInteraction({
      kind: 'account_setup',
      revision: 2,
      requirements: {
        authentication: { type: 'mcp_oauth' },
      },
    });
    const node = AccessRequestReview({
      request: hooks.request!,
      connections: [{ ...original, kind: 'mcp_oauth', status: 'draft' }],
      signingIn: true,
      signInMessage: 'Sign in',
      onCreate: vi.fn(),
      onManage: vi.fn(),
      onSaved: vi.fn(),
    });
    expect(descendants(node).some((child) => child.type === 'fieldset')).toBe(false);
    expect(
      descendants(node)
        .filter((child) => child.type === 'button')
        .map((child) => child.props.children),
    ).toEqual(['Decline']);
    expect(descendants(node).some((child) => child.type === ApprovalMessageInput)).toBe(false);
  });
  it('uses the common account editor to review permissions before creating an OAuth account', async () => {
    hooks.resource.data = { connections: [], groups, apps: [], canEditInstall: true };
    const draw = () => {
      hooks.cursor = 0;
      hooks.effects = [];
      return AccessRequestCard({ request: hooks.request! }) as TestNode;
    };
    let node = draw();
    const review = find(node, AccessRequestReview);
    await review.props.onCreate({
      resource_url: 'https://mcp.example.com/mcp',
      authentication: { type: 'mcp_oauth' },
      scopes: ['read'],
    });
    node = draw();
    expect(find(node, ConnectionEditor).props.accessRequest).toMatchObject({ scopes: ['read'] });
    expect(window.open).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });
  it('uses a compact native modal for account dialogs and retains an explicit wider app editor', () => {
    const node = CredentialDialog({ title: 'Account', children: 'Body', onClose: vi.fn() });
    expect(node.type).toBe(ModalDialog);
    expect(node.props.maxWidth).toBe('520px');
    const wide = CredentialDialog({ title: 'App', children: 'Body', onClose: vi.fn(), maxWidth: '760px' });
    expect(wide.props.maxWidth).toBe('760px');
  });
  it('shows an account setup request without an impossible Allow access action', () => {
    hooks.request = testAccountInteraction({
      requirements: {
        reason: 'Finish the report',
      },
    });
    const node = AccessRequestReview({
      request: hooks.request!,
      connections: [],
      onCreate: vi.fn(),
      onManage: vi.fn(),
      onSaved: vi.fn(),
    });
    expect(node.props.title).toBe('Set up an account');
    const buttons = descendants(node)
      .filter((child) => child.type === 'button')
      .map((child) => child.props.children);
    expect(buttons).toContain('Add account');
    expect(buttons).toContain('Decline');
    expect(buttons).not.toContain('Allow access');
    expect(descendants(node).some((child) => child.type === 'fieldset')).toBe(false);
    expect(
      descendants(node).some((child) => child.type === 'legend' && child.props.children === 'Choose an account'),
    ).toBe(false);
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });
  it('treats a ready account with suspended agent access as an access request', () => {
    hooks.request = testAccountInteraction({
      requirements: {
        reason: 'Finish the report',
      },
    });
    const node = AccessRequestReview({
      request: hooks.request!,
      connections: [{ ...original, grants: [{ vault: 'one', services: ['basic'], status: 'suspended' }] }],
      onCreate: vi.fn(),
      onManage: vi.fn(),
      onSaved: vi.fn(),
    });
    expect(node.props.title).toBe('Allow account access?');
    expect(descendants(node).some((child) => child.type === 'button' && child.props.children === 'Allow access')).toBe(
      true,
    );
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });
  it('confirms setup using a metadata-only endpoint, never the grant endpoint', async () => {
    const request = testAccountInteraction({
      kind: 'account_setup',
      revision: 2,
      requirements: {
        reason: 'Finish the report',
      },
    });
    hooks.request = request;
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        Response.json({
          requestRevision: request.revision,
          connection: original,
          matches: true,
          mcp: { names: ['search'], revision: 'config' },
        }),
      ),
    );
    const onSaved = vi.fn();
    const draw = () => {
      hooks.cursor = 0;
      hooks.effects = [];
      return AccessRequestReview({
        request: hooks.request!,
        connections: [original],
        onCreate: vi.fn(),
        onManage: vi.fn(),
        onSaved,
      }) as TestNode;
    };
    let node = draw();
    descendants(node)
      .find((child) => child.type === 'input' && child.props.type === 'radio')!
      .props.onChange({
        currentTarget: { value: original.id },
      });
    node = draw();
    for (const effect of hooks.effects) effect();
    await vi.waitFor(() => expect(hooks.slots[1]).toMatchObject({ matches: true }));
    node = draw();
    expect(descendants(node).filter((child) => child.type === 'input' && child.props.type === 'checkbox')).toHaveLength(
      0,
    );
    const confirm = descendants(node).find(
      (child) => child.type === 'button' && child.props.children === 'Confirm account setup',
    )!;
    expect(confirm.props.disabled).toBe(false);
    confirm.props.onClick();
    await vi.waitFor(() => expect(onSaved).toHaveBeenCalledOnce());
    const [url, options] = vi.mocked(fetch).mock.calls.at(-1)!;
    expect(String(url)).toBe('/ui/chat/api/credentials/access-requests/access-one/account');
    expect(JSON.parse(String(options?.body))).toEqual({
      connection_id: original.id,
      connection_revision: original.revision,
      request_revision: 2,
    });
    expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url).endsWith('/apply'))).toBe(false);
  });
  it('reuses approval-card framing and distinguishes identically named tools and accounts', () => {
    hooks.request = testAccountInteraction({
      agentGroupName: 'My Agent',
      requirements: {
        reason: 'Finish the report',
        mcp_server: 'SnapTrade',
      },
    });
    const node = AccessRequestReview({
      request: hooks.request!,
      connections: [{ ...original, label: 'SnapTrade', account: 'you@example.com' }],
      onCreate: vi.fn(),
      onManage: vi.fn(),
      onSaved: vi.fn(),
    });
    expect(node.type).toBe(ApprovalCardFrame);
    expect(node.props.title).toBe('Allow account access?');
    const labels = descendants(node)
      .filter((child) => child.type === 'strong')
      .map((child) => child.props.children);
    expect(labels).toContain('Tools:');
    expect(labels).toContain('Account:');
    expect(
      descendants(node).some((child) => child.type === 'blockquote' && child.props.children === 'Finish the report'),
    ).toBe(true);
    expect(descendants(node).filter((child) => child.type === 'details')).toHaveLength(0);
  });

  it('reuses account creation and sign-in without granting access when an account is added', () => {
    hooks.resource.data = { connections: [original], groups, apps: [], canEditInstall: true };
    const draw = () => {
      hooks.cursor = 0;
      hooks.effects = [];
      return AccessRequestCard({ request: hooks.request! }) as TestNode;
    };
    let node = draw();
    const review = descendants(node).find((child) => child.type === AccessRequestReview)!;
    review.props.onCreate({
      resource_url: 'https://api.example.com/',
      mcp_server: 'SnapTrade',
      authentication: { type: 'basic' },
    });
    node = draw();
    const editor = descendants(node).find((child) => child.type === ConnectionEditor)!;
    expect(editor.props.accessRequest).toMatchObject({ mcp_server: 'SnapTrade' });
    editor.props.onCreated({ ...original, id: 'new-account' });
    node = draw();
    expect(descendants(node).find((child) => child.type === AccessRequestReview)!.props.preferredConnectionId).toBe(
      'new-account',
    );
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });

  it('keeps loading failures retryable without enabling approval', () => {
    hooks.request = testAccountInteraction({
      requirements: {
        reason: 'Read',
      },
    });
    const onReloadAccounts = vi.fn();
    const node = AccessRequestReview({
      request: hooks.request!,
      connections: [],
      accountsError: 'Could not load accounts',
      onReloadAccounts,
      onCreate: vi.fn(),
      onManage: vi.fn(),
      onSaved: vi.fn(),
    });
    expect(descendants(node).some((child) => child.type === 'fieldset')).toBe(false);
    descendants(node)
      .find((child) => child.type === 'button' && child.props.children === 'Try again')!
      .props.onClick();
    expect(onReloadAccounts).toHaveBeenCalledOnce();
    expect(
      descendants(node).find((child) => child.type === 'button' && child.props.children === 'Allow access')!.props
        .disabled,
    ).toBe(true);
  });

  it('opens the original chat from an existing private review link without applying access', () => {
    hooks.resource.data = hooks.request;
    vi.stubGlobal('location', {
      href: 'https://nanoclaw.example/?access_request=access-one#credentials',
      hash: '#credentials',
    });
    vi.stubGlobal('history', { state: null, replaceState: vi.fn() });
    credentialsOpen.value = true;
    accessApprovalId.value = 'access-one';
    AccessRequestRedirect({ id: 'access-one' });
    for (const effect of hooks.effects) effect();
    expect(location.hash).toBe('#g/one/t/thread-one');
    expect(credentialsOpen.value).toBe(false);
    expect(accessApprovalId.value).toBe(null);
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
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
    onClose: vi.fn(),
    onSaved: vi.fn(),
  });
  const form = render(editor);
  return () => render(form);
}
function newFormRenderer(options: Partial<Parameters<typeof ConnectionEditor>[0]> = {}): () => TestNode {
  const form = ConnectionEditor({ apps: [], onStart: vi.fn(), onClose: vi.fn(), onSaved: vi.fn(), ...options });
  return () => render(form);
}
function nameInput(node: unknown): TestNode {
  return descendants(node).find(
    (child) =>
      child.type === 'input' && (child.props as TestProps & { 'aria-label'?: string })['aria-label'] === 'Account name',
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
        onClose: vi.fn(),
        onSaved: vi.fn(),
      }) as TestNode;
    };
    const node = draw();
    expect(find(node, OAuthAppForm)).toBeDefined();
    expect(find(node, OAuthAppForm).props.selectDiscovered).toBe(false);
    expect(descendants(node).some((child) => child.props['aria-label'] === 'App ID')).toBe(false);
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
    expect(vi.mocked(fetch).mock.calls[0][0]).toBe('/ui/chat/api/credentials/oauth-apps/provider?scope=user');
    expect(requestBody()).toMatchObject({
      config: { authorization_params: { access_type: 'offline' }, client_id: 'client' },
    });
  });

  it('does not overwrite a newer app name when asynchronous scope defaults arrive', () => {
    const dialog = OAuthAppDialog({ canEditInstall: false, onClose: vi.fn(), onSaved: vi.fn() });
    let current = find(dialog, OAuthAppForm).props.draft;
    const form = OAuthAppForm({
      draft: current,
      busy: false,
      onChange: (update) => {
        current = typeof update === 'function' ? update(current) : update;
      },
    });
    const picker = find(form, OAuthScopePicker);
    current = { ...current, label: 'Name typed during discovery' };
    picker.props.onChange('discovered:read');
    expect(current.label).toBe('Name typed during discovery');
    expect(current.scopes).toBe('discovered:read');
  });

  it('uses only App name and keeps an automatically generated app ID stable across retries', async () => {
    vi.mocked(fetch)
      .mockRejectedValueOnce(new TypeError('Network unavailable'))
      .mockResolvedValueOnce(new Response('{}'));
    const saved = vi.fn();
    const draw = (): TestNode => {
      hooks.cursor = 0;
      return OAuthAppDialog({ canEditInstall: false, onClose: vi.fn(), onSaved: saved });
    };
    let node = draw();
    expect(descendants(node).some((child) => child.props['aria-label'] === 'App ID')).toBe(false);
    const form = find(node, OAuthAppForm);
    expect(form.props.selectDiscovered).toBe(true);
    form.props.onChange({
      ...form.props.draft,
      label: 'Personal app',
      issuer: 'https://accounts.example.com',
      client_id: 'public-client',
      apiHosts: 'api.example.com',
      token_endpoint_auth_method: 'none',
    });
    node = draw();
    descendants(node)
      .find((child) => child.type === 'button' && child.props.children === 'Save app')!
      .props.onClick();
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(hooks.slots[4]).toBe(false));
    node = draw();
    descendants(node)
      .find((child) => child.type === 'button' && child.props.children === 'Save app')!
      .props.onClick();
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    const first = String(vi.mocked(fetch).mock.calls[0][0]);
    expect(first).toMatch(/\/oauth-apps\/app-[0-9a-f-]+\?scope=user$/);
    expect(vi.mocked(fetch).mock.calls[1][0]).toBe(first);
    expect(requestBody()).toMatchObject({ config: { label: 'Personal app' } });
  });

  it('shows only actual granted scopes without a Permissions expando or affected sections', () => {
    hooks.resource.data = {
      ...original,
      kind: 'mcp_oauth',
      resource_url: 'https://mcp.example.com/mcp',
      requested_scopes: ['requested-only'],
      granted_scopes: ['read', 'write'],
      scope_source: 'provider',
    };
    const node = formRenderer()();
    expect(find(node, ScopeList).props.scopes).toEqual(['read', 'write']);
    expect(
      descendants(node).some(
        (child) =>
          child.props.children === 'Requested scopes' ||
          child.props.children === 'Provider-reported scopes' ||
          child.props.children === 'Permissions' ||
          child.props.children === 'Affected agents',
      ),
    ).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('does not present requested or unknown scopes as granted permissions', () => {
    hooks.resource.data = {
      ...original,
      kind: 'mcp_oauth',
      resource_url: 'https://mcp.example.com/mcp',
      requested_scopes: ['requested-only'],
      granted_scopes: null,
      scope_source: 'unknown',
    };
    const node = formRenderer()();
    expect(find(node, ScopeList)).toBeUndefined();
    expect(descendants(node).some((child) => child.props.children === 'Not reported by the provider.')).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('keeps new app validation quiet until editing, and rejects secrets for public clients', () => {
    let node: TestNode = OAuthAppDialog({
      canEditInstall: false,
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
    expect(descendants(node).some((child) => child.props.children === 'Affected agents')).toBe(false);
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

  it('saves one credential authentication recipe for multiple destination-only rows', async () => {
    const draw = newFormRenderer();
    let node = draw();
    let routes = descendants(node).filter((child) => child.type === CredentialServiceForm);
    routes[0].props.onChange({ ...routes[0].props.route, pattern: 'https://api.example.com/*' });
    node = draw();
    descendants(node)
      .find((child) => child.type === 'button' && child.props.children === 'Add URL pattern')!
      .props.onClick();
    node = draw();
    routes = descendants(node).filter((child) => child.type === CredentialServiceForm);
    routes[1].props.onChange({ ...routes[1].props.route, pattern: 'https://uploads.example.com/*' });
    node = draw();
    find(node, CredentialAuthenticationForm).props.onChange({
      type: 'api-key',
      key: 'TOKEN',
      location: 'query',
      parameter: 'api_key',
    });
    node = draw();
    find(node, SecretInput).props.onInput('synthetic-key');
    node = draw();
    expect(descendants(node).filter((child) => child.type === CredentialAuthenticationForm)).toHaveLength(1);
    for (const route of descendants(node).filter((child) => child.type === CredentialServiceForm))
      expect(descendants(render(route)).some((child) => child.type === 'select')).toBe(false);
    node = draw();
    await find(node, 'form').props.onSubmit({ preventDefault: vi.fn() });
    expect(requestBody()).toMatchObject({
      services: [
        { host: 'api.example.com/*', auth: { type: 'api-key', key: 'TOKEN', location: 'query', parameter: 'api_key' } },
        {
          host: 'uploads.example.com/*',
          auth: { type: 'api-key', key: 'TOKEN', location: 'query', parameter: 'api_key' },
        },
      ],
      values: { TOKEN: 'synthetic-key' },
    });
  });

  it('preserves a saved query substitution on rename and reuses its value for an explicit placement change', async () => {
    vi.mocked(fetch).mockImplementation(async () => new Response(JSON.stringify(original)));
    const saved: Connection = {
      ...original,
      credentials: ['SAVED_KEY'],
      services: [
        {
          name: 'query',
          host: 'api.example.com',
          auth: { type: 'passthrough' },
          substitutions: [{ key: 'SAVED_KEY', placeholder: '__SAVED_KEY__', in: ['query'] }],
        },
      ],
    };
    hooks.resource.data = saved;
    const draw = formRenderer();
    let node = draw();
    const auth = find(node, CredentialAuthenticationForm);
    expect(auth.props.savedLabel).toBe('Saved query authentication');
    expect(auth.props.preferredKey).toBe('SAVED_KEY');
    expect(find(node, CredentialServiceForm).props.busy).toBe(true);
    nameInput(node).props.oninput({ currentTarget: { value: 'Renamed saved query' } });
    node = draw();
    await find(node, 'form').props.onSubmit({ preventDefault: vi.fn() });
    expect(requestBody()).toEqual({ label: 'Renamed saved query', revision: original.revision });
    node = draw();
    find(node, CredentialAuthenticationForm).props.onChange({
      type: 'api-key',
      key: 'SAVED_KEY',
      location: 'query',
      parameter: 'api_key',
    });
    node = draw();
    await find(node, 'form').props.onSubmit({ preventDefault: vi.fn() });
    expect(requestBody()).not.toHaveProperty('values');
    expect(requestBody()).toMatchObject({
      services: [
        {
          name: 'query',
          auth: { type: 'api-key', key: 'SAVED_KEY', location: 'query', parameter: 'api_key' },
        },
      ],
    });
    expect((requestBody().services as Service[])[0].substitutions).toBeUndefined();
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
      action: 'delete',
      onClose: vi.fn(),
      onSaved: vi.fn(),
    });
    expect(node.type).toBe(ConfirmCredentialAction);
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
    expect(node.props.title).toBe('Add an account');
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
    const savedFields = descendants(node).find(
      (child) => typeof child.type === 'function' && child.type.name === 'OAuthFields',
    )!;
    expect(savedFields.props.selectDiscovered).toBe(false);
    expect(savedFields.props.scopes).toBe('mcp');
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

  it('does not send an empty scope request when reconnecting an unfinished draft', () => {
    const node = OAuthConnectionDialog({
      connection: {
        ...original,
        kind: 'mcp_oauth',
        status: 'draft',
        resource_url: 'https://mcp.example.com/mcp',
        requested_scopes: [],
      },
      apps: [],
      onStart: vi.fn(),
      onClose: vi.fn(),
      onSaved: vi.fn(),
    });
    const fields = descendants(node).find(
      (child) => typeof child.type === 'function' && child.type.name === 'OAuthFields',
    )!;
    expect(fields.props.scopes).toBe('');
    expect(fields.props.unspecifiedScopes).toBe(false);
    expect(descendants(node).find((child) => child.props.type === 'submit')!.props.disabled).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
  });
  it('preserves required permissions on retry and refuses a selection that omits them', async () => {
    const onStart = vi.fn();
    const props = {
      connection: {
        ...original,
        kind: 'mcp_oauth' as const,
        status: 'draft' as const,
        resource_url: 'https://mcp.example.com/mcp',
        requested_scopes: [],
      },
      accessRequest: { resource_url: 'https://mcp.example.com/mcp', scopes: ['read'] },
      apps: [],
      onStart,
      onClose: vi.fn(),
      onSaved: vi.fn(),
    };
    const draw = () => {
      hooks.cursor = 0;
      hooks.effects = [];
      return OAuthConnectionDialog(props) as TestNode;
    };
    let node = draw();
    const fields = () =>
      descendants(node).find((child) => typeof child.type === 'function' && child.type.name === 'OAuthFields')!;
    expect(fields().props.scopes).toBe('read');
    fields().props.onScopes!('write');
    node = draw();
    expect(descendants(node).find((child) => child.props.type === 'submit')!.props.disabled).toBe(true);
    await find(node, 'form').props.onSubmit({ preventDefault: vi.fn() });
    expect(onStart).not.toHaveBeenCalled();
    fields().props.onScopes!('read');
    node = draw();
    await find(node, 'form').props.onSubmit({ preventDefault: vi.fn() });
    expect(onStart).toHaveBeenCalledWith(original.id, {
      resource_url: props.connection.resource_url,
      scopes: ['read'],
    });
  });
  it('uses confirmed permissions as the reconnect baseline instead of a broader rejected request', () => {
    const node = OAuthConnectionDialog({
      connection: {
        ...original,
        kind: 'mcp_oauth',
        resource_url: 'https://mcp.example.com/mcp',
        requested_scopes: ['read', 'write'],
        granted_scopes: ['read'],
        scope_source: 'provider',
      },
      accessRequest: { resource_url: 'https://mcp.example.com/mcp', scopes: ['read'] },
      apps: [],
      onStart: vi.fn(),
      onClose: vi.fn(),
      onSaved: vi.fn(),
    });
    const fields = descendants(node).find(
      (child) => typeof child.type === 'function' && child.type.name === 'OAuthFields',
    )!;
    expect(fields.props.scopes).toBe('read');
    expect(fields.props.selectDiscovered).toBe(true);
  });
  it('does not carry ungranted draft permissions into a newly scoped request', () => {
    const node = OAuthConnectionDialog({
      connection: {
        ...original,
        kind: 'mcp_oauth',
        status: 'draft',
        resource_url: 'https://mcp.example.com/mcp',
        requested_scopes: ['write'],
        granted_scopes: null,
        app_id: 'provider',
      },
      accessRequest: { resource_url: 'https://mcp.example.com/mcp', scopes: ['read'] },
      apps: [
        {
          id: 'provider',
          label: 'Provider',
          source: 'install',
          issuer: 'https://auth.example.com',
          client_id: 'test-client',
          client_secret_set: false,
          token_endpoint_auth_method: 'none',
          api_hosts: ['mcp.example.com'],
          default_scopes: ['write'],
          identity: 'none',
          token_scope_separator: 'space',
        },
      ],
      onStart: vi.fn(),
      onClose: vi.fn(),
      onSaved: vi.fn(),
    });
    const fields = descendants(node).find(
      (child) => typeof child.type === 'function' && child.type.name === 'OAuthFields',
    )!;
    expect(fields.props.scopes).toBe('read');
  });

  it('keeps invalid OAuth fields blocked without an acknowledgement step', () => {
    const node = OAuthConnectionDialog({
      connection: { ...original, kind: 'mcp_oauth', resource_url: 'http://insecure.example/mcp' },
      apps: [],
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
      .find((child) => child.type === 'button' && child.props.children === 'Manage your accounts')!
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
