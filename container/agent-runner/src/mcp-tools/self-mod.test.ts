import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { closeSessionDb, initTestSessionDb } from '../db/connection.js';
import { getUndeliveredMessages } from '../db/messages-out.js';
import { addMcpServer, installPackages } from './self-mod.js';

beforeEach(() => initTestSessionDb());
afterEach(() => closeSessionDb());

describe('add_mcp_server', () => {
  it.each([
    { command: 'pnpm', args: ['dlx', 'example'], env: { MODE: 'test' } },
    { url: 'https://mcp.example.com/mcp' },
    { url: 'https://mcp.example.com/sse', transport: 'sse' },
  ])('submits stdio and remote additions with an explicit pending/finish-turn receipt: %j', async (input) => {
    const request = { name: 'example', instructions: 'Use the documented tools', timeout: 600000, ...input };
    const result = await addMcpServer.handler(request);
    expect(result.isError).not.toBe(true);
    expect(result.content[0].text).toContain('not installed yet');
    expect(result.content[0].text).toContain('Do not resubmit');
    expect(result.content[0].text).toContain('finish this turn');
    expect(result.content[0].text).toContain('After approval and the automatic restart, request_access');
    const messages = getUndeliveredMessages();
    expect(messages).toHaveLength(1);
    expect(result.content[0].text).toContain(`ncl approvals withdraw --id ${messages[0].id}`);
    expect(JSON.parse(messages[0].content).requestId).toBe(messages[0].id);
    expect(JSON.parse(messages[0].content)).toMatchObject({ action: 'add_mcp_server', ...request });
  });

  it('returns a stable withdrawal reference for package installation', async () => {
    const result = await installPackages.handler({ apt: ['jq'], reason: 'Read JSON' });
    const [message] = getUndeliveredMessages();
    expect(JSON.parse(message.content)).toMatchObject({ requestId: message.id, action: 'install_packages' });
    expect(result.content[0].text).toContain(`ncl approvals withdraw --id ${message.id}`);
  });

  it.each([
    { agent_group_id: 'other-agent' },
    { id: 'other-agent' },
    { group: 'other-agent' },
    { timeout: 999 },
    { timeout: 600001 },
    { timeout: 1000.5 },
    { instructions: 42 },
    { headers: { 'X-Version': 42 } },
    { transport: 'tcp' },
    { transport: ['http'] },
    { env: { MODE: 'test' } },
  ])('rejects target overrides and invalid remote options before submission: %j', async (input) => {
    const result = await addMcpServer.handler({ name: 'example', url: 'https://mcp.example.com/mcp', ...input });
    expect(result.isError).toBe(true);
    expect(getUndeliveredMessages()).toHaveLength(0);
  });
});
