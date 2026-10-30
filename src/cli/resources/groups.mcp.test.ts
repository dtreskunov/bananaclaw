import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../container-runner.js', () => ({
  wakeContainer: vi.fn(),
  killContainer: vi.fn(),
  buildAgentGroupImage: vi.fn(),
}));
vi.mock('../../modules/approvals/index.js', () => ({
  registerApprovalHandler: vi.fn(),
  requestApproval: vi.fn(),
}));

import { closeDb, createAgentGroup, initTestDb, runMigrations } from '../../db/index.js';
import { ensureContainerConfig, getContainerConfig, updateContainerConfigJson } from '../../db/container-configs.js';
import { createSession } from '../../db/sessions.js';
import { requestApproval } from '../../modules/approvals/index.js';
import { dispatch } from '../dispatch.js';
import './groups.js';

const GROUP = 'ag-mcp';
const URL = 'https://bananabrowse.example/mcp/t_aaaaaaaaaaaaaaaaaaaaaa';
const add = (args: Record<string, unknown>) =>
  dispatch(
    { id: 'request', command: 'groups-config-add-mcp-server', args: { id: GROUP, name: 'bananabrowse', ...args } },
    { caller: 'host' },
  );
const servers = () => JSON.parse(getContainerConfig(GROUP)!.mcp_servers);

describe('groups config add-mcp-server transports', () => {
  beforeEach(() => {
    runMigrations(initTestDb());
    createAgentGroup({
      id: GROUP,
      name: 'MCP test',
      folder: GROUP,
      agent_provider: null,
      created_at: new Date().toISOString(),
    });
    ensureContainerConfig(GROUP);
    updateContainerConfigJson(GROUP, 'mcp_servers', { other: { command: 'existing', args: ['keep'] } });
    vi.clearAllMocks();
  });
  afterEach(() => closeDb());

  it('adds HTTP without a command and preserves unrelated servers', async () => {
    const result = await add({
      type: 'http',
      url: URL,
      headers: '{"Authorization":"Bearer onecli-placeholder"}',
      instructions: 'Use the browser',
    });
    expect(result.ok).toBe(true);
    expect(servers()).toEqual({
      other: { command: 'existing', args: ['keep'] },
      bananabrowse: {
        type: 'http',
        url: URL,
        headers: { Authorization: 'Bearer onecli-placeholder' },
        instructions: 'Use the browser',
      },
    });
  });

  it('accepts the transport alias and SSE', async () => {
    expect((await add({ transport: 'http', url: URL })).ok).toBe(true);
    expect(servers().bananabrowse).toEqual({ type: 'http', url: URL });
    expect((await add({ type: 'sse', url: 'http://localhost:8000/sse' })).ok).toBe(true);
    expect(servers().bananabrowse).toEqual({ type: 'sse', url: 'http://localhost:8000/sse' });
  });
  it('pins a stable reference and never silently switches to automatic matching on URL changes', async () => {
    expect((await add({ type: 'http', url: URL, connection: 'conn-personal', 'account-alias': 'Personal' })).ok).toBe(
      true,
    );
    expect(servers().bananabrowse.authentication).toEqual({
      connection_id: 'conn-personal',
      account_alias: 'Personal',
    });
    await add({ type: 'http', url: URL, 'account-alias': 'Work' });
    expect(servers().bananabrowse.authentication.account_alias).toBe('Work');
    await add({ type: 'http', url: URL + '-changed' });
    expect(servers().bananabrowse.authentication).toEqual({ connection_id: 'conn-personal', account_alias: 'Work' });
    await add({ type: 'http', url: URL + '-changed', connection: '' });
    expect(servers().bananabrowse.authentication).toBeUndefined();
  });

  it('sets long human-wait timeouts without changing other entries or re-add behavior', async () => {
    expect((await add({ type: 'http', url: URL, timeout: '600000' })).ok).toBe(true);
    expect(servers().bananabrowse.timeout).toBe(600000);
    await add({ type: 'http', url: URL });
    expect(servers().bananabrowse.timeout).toBe(600000);
    expect(servers().other).toEqual({ command: 'existing', args: ['keep'] });
    await add({ command: 'stdio', timeout: '1000' });
    expect(servers().bananabrowse.timeout).toBe(1000);
  });

  it('preserves remote metadata on re-add but never carries headers to another URL', async () => {
    updateContainerConfigJson(GROUP, 'mcp_servers', {
      bananabrowse: {
        type: 'http',
        url: URL,
        headers: { Authorization: 'Bearer onecli-placeholder' },
        instructions: 'Keep',
        timeout: 30000,
      },
    });
    await add({ type: 'http', url: URL });
    expect(servers().bananabrowse).toMatchObject({
      headers: { Authorization: 'Bearer onecli-placeholder' },
      instructions: 'Keep',
      timeout: 30000,
    });
    await add({ type: 'http', url: `${URL}-other` });
    expect(servers().bananabrowse).toEqual({ type: 'http', url: `${URL}-other`, instructions: 'Keep', timeout: 30000 });
    await add({ type: 'http', url: `${URL}-other`, headers: '{}' });
    expect(servers().bananabrowse.headers).toEqual({});
  });

  it('preserves existing stdio behavior and metadata', async () => {
    await add({ command: 'npx', args: '["server"]', env: '{"MODE":"test"}', instructions: 'Keep' });
    await add({ command: 'node' });
    expect(servers().bananabrowse).toEqual({
      command: 'node',
      args: ['server'],
      env: { MODE: 'test' },
      instructions: 'Keep',
    });
  });

  it('drops transport-specific fields when converting an entry', async () => {
    await add({ command: 'stdio', args: '["old"]', env: '{"OLD":"value"}' });
    await add({ type: 'http', url: URL });
    expect(servers().bananabrowse).toEqual({ type: 'http', url: URL });
    await add({ type: 'stdio', command: 'fresh' });
    expect(servers().bananabrowse).toEqual({ command: 'fresh', args: [], env: {} });
  });

  it.each([
    { type: 'http' },
    { type: 'invalid', url: URL },
    { type: 'http', transport: 'sse', url: URL },
    { type: 'http', url: 'file:///tmp/server' },
    { type: 'http', url: 'https://user:password@example.com/mcp' },
    { type: 'http', url: `${URL}#token` },
    { type: 'http', url: URL, command: 'not-stdio' },
    { type: 'http', url: URL, env: '{}' },
    { type: 'http', url: URL, args: '[]' },
    { type: 'http', url: URL, headers: '[]' },
    { type: 'http', url: URL, headers: '{"X":42}' },
    { type: 'http', url: URL, headers: 'broken-json' },
    { command: 'stdio', headers: '{}' },
    { command: 'stdio', url: URL },
    { command: 'stdio', args: '[42]' },
    { command: 'stdio', env: '{"X":false}' },
    { type: 'http', url: URL, timeout: '999' },
    { type: 'http', url: URL, timeout: '600001' },
    { type: 'http', url: URL, timeout: '1000.5' },
    { type: 'http', url: URL, timeout: 'not-a-number' },
    { type: 'http', url: URL, connection: 'conn-personal' },
    { type: 'http', url: URL, 'account-alias': 'Personal' },
    { type: 'http', url: URL, connection: 'conn-personal', 'account-alias': '' },
    { type: 'http', url: 'http://example.test/mcp', connection: 'conn-personal', 'account-alias': 'Personal' },
    { command: 'stdio', connection: 'conn-personal', 'account-alias': 'Personal' },
  ])('rejects invalid or mixed transport arguments without mutation: %j', async (args) => {
    const before = getContainerConfig(GROUP)!.mcp_servers;
    const result = await add(args);
    expect(result.ok).toBe(false);
    expect(getContainerConfig(GROUP)!.mcp_servers).toBe(before);
  });

  it('agent requests still require approval and cannot modify another group', async () => {
    createSession({
      id: 'mcp-session',
      agent_group_id: GROUP,
      messaging_group_id: null,
      thread_id: null,
      agent_provider: null,
      status: 'active',
      container_status: 'stopped',
      last_active: null,
      created_at: new Date().toISOString(),
    });
    const frame = {
      id: 'agent-request',
      command: 'groups-config-add-mcp-server',
      args: { name: 'bananabrowse', type: 'http', url: URL },
    };
    const ctx = { caller: 'agent' as const, agentGroupId: GROUP, sessionId: 'mcp-session', messagingGroupId: '' };
    const result = await dispatch(frame, ctx);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('approval-pending');
    expect(requestApproval).toHaveBeenCalledOnce();
    expect(servers().bananabrowse).toBeUndefined();
    const cross = await dispatch({ ...frame, args: { ...frame.args, id: 'another-group' } }, ctx);
    expect(cross.ok).toBe(false);
    if (!cross.ok) expect(cross.error.code).toBe('forbidden');
  });
});
