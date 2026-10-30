import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
const root = vi.hoisted(() => `/tmp/nanoclaw-mcp-bindings-${process.pid}`);
vi.mock('../../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../config.js')>()),
  DATA_DIR: `${root}/data`,
  GROUPS_DIR: `${root}/groups`,
}));
import { closeDb, getDb, initTestDb } from '../../db/connection.js';
import { runMigrations } from '../../db/migrations/index.js';
import { configFromDb, type McpHttpServerConfig } from '../../container-config.js';
import { getContainerConfig } from '../../db/container-configs.js';
import { getAgentGroup } from '../../db/agent-groups.js';
import { materializeMcpAuthentication, resolveMcpAuthentication } from './mcp-authentication.js';
import { parseMcpAuthentication } from '../../ui/shared/mcp-authentication.js';

let server: http.Server;
let services: Array<{ connection_id?: string; binding_handle?: string; host: string; name: string }>;
let status = 200;
const scopes: string[] = [];
const configured: Record<string, McpHttpServerConfig> = {
  gmail_personal: {
    type: 'http',
    url: 'https://gmail.example.test/mcp',
    headers: { authorization: 'stale-placeholder', 'X-Keep': 'retained' },
    authentication: { connection_id: 'conn-personal', account_alias: 'Personal' },
  },
  gmail_work: {
    type: 'http',
    url: 'https://gmail.example.test/mcp',
    authentication: { connection_id: 'conn-work', account_alias: 'Work' },
  },
};
beforeAll(async () => {
  fs.mkdirSync(`${root}/data/agent-vault`, { recursive: true, mode: 0o700 });
  fs.writeFileSync(`${root}/data/agent-vault/host-token`, 'synthetic-host-token', { mode: 0o600 });
  server = http.createServer((req, res) => {
    if (req.url !== '/discover' || req.headers.authorization !== 'Bearer synthetic-host-token') {
      res.writeHead(401).end();
      return;
    }
    const vault = String(req.headers['x-vault']);
    scopes.push(vault);
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify(
        status === 200
          ? {
              services: services.map((service) => ({
                ...service,
                binding_handle: service.binding_handle && service.binding_handle + (vault === 'group-two' ? '2' : '1'),
              })),
            }
          : { error: 'unavailable' },
      ),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  process.env.NANOCLAW_AGENT_VAULT_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  delete process.env.NANOCLAW_AGENT_VAULT_URL;
  fs.rmSync(root, { recursive: true, force: true });
});
beforeEach(() => {
  runMigrations(initTestDb());
  for (const id of ['group-one', 'group-two']) {
    getDb().prepare('INSERT INTO agent_groups(id,name,folder,created_at) VALUES(?,?,?,?)').run(id, id, id, 'before');
    getDb()
      .prepare('INSERT INTO container_configs(agent_group_id,mcp_servers,updated_at) VALUES(?,?,?)')
      .run(id, JSON.stringify(configured), 'before');
  }
  status = 200;
  scopes.length = 0;
  services = [
    {
      name: 'personal',
      connection_id: 'conn-personal',
      binding_handle: 'BIND_PERSONAL',
      host: 'gmail.example.test:443/mcp',
    },
    { name: 'work', connection_id: 'conn-work', binding_handle: 'BIND_WORK', host: 'gmail.example.test:443/mcp' },
  ];
});
afterEach(() => closeDb());

describe('host-resolved named MCP connections', () => {
  it('pins two accounts at the same endpoint using each group’s current handle', async () => {
    const one = await resolveMcpAuthentication('group-one', configured);
    const two = await resolveMcpAuthentication('group-two', configured);
    expect(scopes).toEqual(['group-one', 'group-two']);
    expect(one.servers.gmail_personal).toMatchObject({
      headers: { 'X-Keep': 'retained', 'X-AgentVault-Binding': 'BIND_PERSONAL1' },
    });
    expect(one.servers.gmail_work).toMatchObject({ headers: { 'X-AgentVault-Binding': 'BIND_WORK1' } });
    expect(two.servers.gmail_personal).toMatchObject({ headers: { 'X-AgentVault-Binding': 'BIND_PERSONAL2' } });
    expect('authentication' in one.servers.gmail_personal).toBe(false);
    expect(
      'headers' in one.servers.gmail_personal && one.servers.gmail_personal.headers?.authorization,
    ).toBeUndefined();
    expect(one.statuses).toMatchObject([
      { server: 'gmail_personal', account_alias: 'Personal', status: 'ready' },
      { server: 'gmail_work', account_alias: 'Work', status: 'ready' },
    ]);
  });
  it('does not replace a missing/revoked reference with the other account', async () => {
    services = services.filter((service) => service.connection_id !== 'conn-personal');
    const result = await resolveMcpAuthentication('group-one', configured);
    expect(result.servers.gmail_personal).toBeUndefined();
    expect(result.servers.gmail_work).toBeDefined();
    expect(result.statuses[0]).toMatchObject({ status: 'blocked', account_alias: 'Personal' });
  });
  it('blocks retargeted URLs, missing contracts and invalid references explicitly', async () => {
    const changed = structuredClone(configured);
    changed.gmail_personal.url = 'https://other.example.test/mcp';
    expect((await resolveMcpAuthentication('group-one', changed)).servers.gmail_personal).toBeUndefined();
    services = services.map(({ name, host }) => ({ name, host }));
    expect(Object.keys((await resolveMcpAuthentication('group-one', configured)).servers)).toHaveLength(0);
    expect(() =>
      parseMcpAuthentication({ connection_id: 'conn-personal', account_alias: 'Personal', token: 'secret' }),
    ).toThrow();
    expect(() => parseMcpAuthentication({ connection_id: 'conn-personal', account_alias: '' })).toThrow();
  });
  it('surfaces discovery failures instead of falling back to anonymous or another account', async () => {
    status = 503;
    const result = await resolveMcpAuthentication('group-one', configured);
    expect(Object.keys(result.servers)).toHaveLength(0);
    expect(result.statuses.every((item) => item.status === 'blocked' && item.reason?.includes('unavailable'))).toBe(
      true,
    );
  });
  it('keeps stable references in the DB and only materializes current transport selectors', async () => {
    const group = getAgentGroup('group-one')!,
      row = getContainerConfig('group-one')!;
    const config = configFromDb(row, group);
    fs.mkdirSync(`${root}/groups/group-one`, { recursive: true });
    await materializeMcpAuthentication(group.id, config);
    expect(getContainerConfig(group.id)?.mcp_servers).toBe(JSON.stringify(configured));
    const materialized = JSON.parse(fs.readFileSync(`${root}/groups/group-one/container.json`, 'utf8'));
    expect(materialized.mcpServers.gmail_work.headers['X-AgentVault-Binding']).toBe('BIND_WORK1');
    expect(materialized.mcpAccess[1]).toMatchObject({ account_alias: 'Work', status: 'ready' });
    expect(JSON.stringify(materialized)).not.toContain('synthetic-host-token');
  });
});
