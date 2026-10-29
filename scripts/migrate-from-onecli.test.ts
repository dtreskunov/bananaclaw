import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { parseArgs, readGroups, readVaultNames } from './migrate-from-onecli.js';

let directory: string | undefined;
afterEach(() => {
  vi.unstubAllEnvs();
  if (directory) fs.rmSync(directory, { recursive: true, force: true });
  directory = undefined;
});

describe('migration CLI gates', () => {
  it('defaults to read-only inventory and permits selecting one group', () => {
    expect(parseArgs([])).toEqual({ prepare: false });
    expect(parseArgs(['--group', 'ag-1'])).toEqual({ prepare: false, group: 'ag-1' });
  });

  it.each([
    ['--apply'],
    ['--provision'],
    ['--values-stdin'],
    ['--ack-source-policy'],
    ['--prepare', '--provision'],
    ['--yes'],
    ['--prepare'],
    ['--group'],
    ['--out', '/tmp/output'],
    ['--group', 'a', '--group', 'b'],
    ['--prepare', '--group', 'a', '--confirm-group', 'b', '--expect-digest', 'a'.repeat(64), '--out', '/tmp/output'],
    ['--prepare', '--group', 'a', '--confirm-group', 'a', '--expect-digest', 'stale', '--out', '/tmp/output'],
    ['--prepare', '--group', 'a', '--confirm-group', 'a', '--expect-digest', 'a'.repeat(64), '--out', 'relative'],
  ])('rejects unsafe/ambiguous options: %j', (...args) => {
    expect(() => parseArgs(args)).toThrow();
  });

  it('accepts only explicitly confirmed preparation', () => {
    expect(
      parseArgs([
        '--prepare',
        '--group',
        'ag-1',
        '--confirm-group',
        'ag-1',
        '--expect-digest',
        'a'.repeat(64),
        '--out',
        '/tmp/output',
      ]),
    ).toMatchObject({
      prepare: true,
      group: 'ag-1',
      confirmation: 'ag-1',
      digest: 'a'.repeat(64),
      out: '/tmp/output',
    });
  });

  it('does not retain the obsolete vault-local provisioning mode', () => {
    const args = ['--provision', '--group', 'ag-1', '--confirm-group', 'ag-1', '--expect-digest', 'a'.repeat(64)];
    expect(() => parseArgs(args)).toThrow('Unknown option: --provision');
    expect(() => parseArgs([...args, '--values-stdin', '--ack-source-policy', '--out', '/tmp/output'])).toThrow();
  });
});

describe('local inventory is readonly', () => {
  it('uses the gateway vault collection envelope and rejects malformed success responses', () => {
    expect([...readVaultNames({ vaults: [{ name: 'ag-1' }] })]).toEqual(['ag-1']);
    expect([...readVaultNames({ vaults: [] })]).toEqual([]);
    for (const input of [null, [], {}, { vaults: null }, { vaults: [{}] }]) {
      expect(() => readVaultNames(input)).toThrow('Invalid gateway vault inventory');
    }
  });

  function fixture(): string {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-inventory-'));
    const file = path.join(directory, 'v2.db');
    const db = new Database(file);
    db.exec(`CREATE TABLE agent_groups (id TEXT, name TEXT);
      CREATE TABLE container_configs (agent_group_id TEXT, credential_backend TEXT, provider TEXT, mcp_servers TEXT);
      INSERT INTO agent_groups VALUES ('ag-1','One'),('ag-2','Two'),('ag-3','Three');
      INSERT INTO container_configs VALUES ('ag-1',NULL,'native','{"local":{"command":"node","env":{"SECRET":"DO_NOT_EXPORT"}}}');
      INSERT INTO container_configs VALUES ('ag-2','agent-vault','claude','{}');`);
    db.close();
    return file;
  }

  it('preserves the database and exports no MCP credential fields', () => {
    vi.stubEnv('NANOCLAW_AGENT_VAULT_GROUPS', '');
    const file = fixture();
    const before = fs.readFileSync(file);
    const groups = readGroups(file);
    expect(groups).toMatchObject([
      { id: 'ag-1', name: 'One', backend: 'onecli', provider: 'native', mcpServerCount: 1 },
      { id: 'ag-2', name: 'Two', backend: 'agent-vault', provider: 'claude', mcpServerCount: 0 },
      { id: 'ag-3', name: 'Three', backend: 'onecli', provider: null, mcpServerCount: 0 },
    ]);
    expect(groups[0]!.mcpClients).toMatchObject([
      { name: 'local', transport: 'stdio', command: 'node', credentialEnvNames: ['SECRET'] },
    ]);
    expect(JSON.stringify(groups)).not.toContain('DO_NOT_EXPORT');
    expect(fs.readFileSync(file)).toEqual(before);
    expect(() => readGroups(file, 'unknown')).toThrow('does not exist');
  });

  it('does not retain the removed spike environment override', () => {
    vi.stubEnv('NANOCLAW_AGENT_VAULT_GROUPS', 'ag-1');
    expect(readGroups(fixture(), 'ag-1')[0]!.backend).toBe('onecli');
  });
});
