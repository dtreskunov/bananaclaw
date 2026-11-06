import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../container-runner.js', () => ({
  wakeContainer: vi.fn(),
  killContainer: vi.fn(),
  buildAgentGroupImage: vi.fn(),
}));
vi.mock('../approvals/index.js', () => ({
  registerApprovalHandler: vi.fn(),
  requestApproval: vi.fn().mockResolvedValue('approval'),
  notifyAgent: vi.fn(),
}));

import { closeDb, createAgentGroup, initTestDb, runMigrations } from '../../db/index.js';
import { ensureContainerConfig, getContainerConfig, updateContainerConfigJson } from '../../db/container-configs.js';
import { dispatch } from '../../cli/dispatch.js';
import '../../cli/resources/groups.js';
import type { Session } from '../../types.js';
import { notifyAgent, requestApproval } from '../approvals/index.js';
import { applyAddMcpServer } from './apply.js';
import { handleAddMcpServer } from './request.js';

const session: Session = {
  id: 'session',
  agent_group_id: 'agent',
  messaging_group_id: null,
  thread_id: null,
  agent_provider: null,
  status: 'active',
  container_status: 'running',
  last_active: null,
  created_at: 1767225600000,
};
const initial = { unrelated: { command: 'keep', args: ['unchanged'] } };
const servers = () => JSON.parse(getContainerConfig(session.agent_group_id)!.mcp_servers);

beforeEach(() => {
  runMigrations(initTestDb());
  createAgentGroup({
    id: 'agent',
    name: 'Agent',
    folder: 'agent',
    agent_provider: null,
    created_at: 1767225600000,
  });
  ensureContainerConfig('agent');
  updateContainerConfigJson('agent', 'mcp_servers', initial);
  vi.clearAllMocks();
});
afterEach(() => closeDb());

describe('native MCP additions', () => {
  it.each([
    { command: 'pnpm', args: ['dlx', 'example'], env: { MODE: 'test' } },
    { url: 'https://mcp.example.com/mcp', headers: { 'X-Version': 'v1' } },
    { url: 'https://mcp.example.com/sse', transport: 'sse' },
  ])('matches host configuration semantics and defers verification until restart: %j', async (input) => {
    const request = { name: 'example', instructions: 'Use for the current task', timeout: 600000, ...input };
    await handleAddMcpServer(request, session, undefined, { originMessageId: 'human-request' });
    expect(requestApproval).toHaveBeenCalledOnce();
    expect(servers()).toEqual(initial);
    const approval = vi.mocked(requestApproval).mock.calls[0][0];
    expect(approval).toMatchObject({ action: 'add_mcp_server', originMessageId: 'human-request', session });
    const notify = vi.fn();
    await applyAddMcpServer({ session, payload: approval.payload, userId: 'admin', notify });
    const native = servers();
    expect(native.unrelated).toEqual(initial.unrelated);
    expect(native.example.timeout).toBe(600000);
    expect(native.example.instructions).toBe(request.instructions);
    expect(notify).toHaveBeenNthCalledWith(1, expect.stringContaining('automatic restart'));
    expect(notify).toHaveBeenNthCalledWith(2, expect.stringContaining('Verify'), { afterRestart: true });

    updateContainerConfigJson('agent', 'mcp_servers', initial);
    const host = await dispatch(
      {
        id: 'host',
        command: 'groups-config-add-mcp-server',
        args: { id: 'agent', ...request, type: 'url' in input ? (input.transport ?? 'http') : 'stdio' },
      },
      { caller: 'host' },
    );
    expect(host.ok).toBe(true);
    expect(servers()).toEqual(native);
  });

  it('preserves account references and metadata while dropping headers on an endpoint change', async () => {
    const authentication = { connection_id: 'personal', account_alias: 'Personal' };
    updateContainerConfigJson('agent', 'mcp_servers', {
      ...initial,
      example: {
        type: 'http',
        url: 'https://mcp.example.com/mcp',
        headers: { 'X-Keep': 'v1' },
        authentication,
        instructions: 'Keep',
        timeout: 30000,
      },
    });
    const notify = vi.fn();
    await applyAddMcpServer({
      session,
      payload: { name: 'example', url: 'https://mcp.example.com/mcp' },
      userId: 'admin',
      notify,
    });
    expect(servers().example.headers).toEqual({ 'X-Keep': 'v1' });
    await applyAddMcpServer({
      session,
      payload: { name: 'example', url: 'https://mcp.example.com/changed' },
      userId: 'admin',
      notify,
    });
    expect(servers().example).toEqual({
      type: 'http',
      url: 'https://mcp.example.com/changed',
      authentication,
      instructions: 'Keep',
      timeout: 30000,
    });
  });

  it('accepts existing approval payloads and pins only the explicitly supplied account', async () => {
    const authentication = { connection_id: 'personal', account_alias: 'Personal' };
    await applyAddMcpServer({
      session,
      payload: { name: 'example', url: 'https://mcp.example.com/mcp', transport: 'http', headers: {}, authentication },
      userId: 'admin',
      notify: vi.fn(),
    });
    expect(servers()).toEqual({
      ...initial,
      example: { type: 'http', url: 'https://mcp.example.com/mcp', headers: {}, authentication },
    });
  });

  it.each([
    { url: 'file:///tmp/server' },
    { url: 'https://mcp.example.com/mcp', command: 'mixed' },
    { url: 'https://mcp.example.com/mcp', headers: { 'X-Version': 42 } },
    { command: 'stdio', args: [42] },
    { command: 'stdio', authentication: { connection_id: 'personal', account_alias: 'Personal' } },
    { url: 'https://mcp.example.com/mcp', timeout: 600001 },
    { url: 'https://mcp.example.com/mcp', instructions: 42 },
  ])('reports invalid requests without creating approvals or mutating configuration: %j', async (input) => {
    await handleAddMcpServer({ name: 'example', ...input }, session);
    expect(requestApproval).not.toHaveBeenCalled();
    expect(notifyAgent).toHaveBeenCalledWith(session, expect.stringContaining('add_mcp_server failed:'), undefined);
    expect(servers()).toEqual(initial);
  });
});
