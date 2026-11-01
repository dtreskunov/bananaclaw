import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, expect, it, vi } from 'vitest';
const gateway = vi.hoisted(() => ({ remove: vi.fn() }));
vi.mock('../../src/modules/credentials/agent-vault-client.js', () => ({ deleteVault: gateway.remove }));
import { cleanupGatewayGroups } from './agent-vault.js';
const roots: string[] = [];
afterEach(() => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
  roots.length = 0;
  vi.resetAllMocks();
});
it('removes only recorded group vaults and preserves the central database', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-uninstall-'));
  roots.push(root);
  fs.mkdirSync(path.join(root, 'data'));
  const db = new Database(path.join(root, 'data/v2.db'));
  db.exec("CREATE TABLE agent_groups(id TEXT); INSERT INTO agent_groups VALUES('group-one'),('group-two')");
  db.close();
  await cleanupGatewayGroups(root);
  expect(gateway.remove.mock.calls).toEqual([['group-one'], ['group-two']]);
  expect(fs.existsSync(path.join(root, 'data/v2.db'))).toBe(true);
});
it('does not hide failed revocations', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-uninstall-'));
  roots.push(root);
  fs.mkdirSync(path.join(root, 'data'));
  const db = new Database(path.join(root, 'data/v2.db'));
  db.exec("CREATE TABLE agent_groups(id TEXT); INSERT INTO agent_groups VALUES('group')");
  db.close();
  gateway.remove.mockRejectedValue(new Error('gateway unavailable'));
  await expect(cleanupGatewayGroups(root)).rejects.toThrow('gateway unavailable');
});
