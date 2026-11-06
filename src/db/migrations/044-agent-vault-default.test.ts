import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, getDb, initTestDb } from '../connection.js';
import { agentVaultBackendGroups, ensureContainerConfig, getContainerConfig } from '../container-configs.js';
import { usesAgentVault } from '../../modules/credentials/agent-vault-client.js';
import { migrations, runMigrations } from './index.js';
import { convertStoreTimes } from '../storage-lifecycle.js';

beforeEach(() => {
  runMigrations(
    initTestDb(),
    migrations.filter((m) => m.version < 44),
  );
  convertStoreTimes(getDb());
});
afterEach(() => closeDb());
const group = (id: string): void => {
  getDb().prepare('INSERT INTO agent_groups(id,name,folder,created_at) VALUES(?,?,?,?)').run(id, id, id, 1767225600000);
};

describe('AgentVault defaults for new groups', () => {
  it('preserves every existing effective backend and configuration, including missing rows', () => {
    const db = getDb();
    for (const id of ['implicit', 'explicit', 'vault', 'missing']) group(id);
    db.exec(`INSERT INTO container_configs(agent_group_id,credential_backend,provider,model,mcp_servers,updated_at)
      VALUES ('implicit',NULL,'native','existing-model','{"api":{"type":"http","url":"https://example.test/mcp"}}',1767225600000),
        ('explicit','onecli',NULL,NULL,'{}',1767225600000),('vault','agent-vault',NULL,NULL,'{}',1767225600000);`);
    const before = getContainerConfig('implicit')!;
    runMigrations(
      db,
      migrations.filter((m) => m.version <= 44),
    );
    expect(getContainerConfig('implicit')).toEqual({ ...before, credential_backend: 'onecli' });
    expect(getContainerConfig('explicit')?.credential_backend).toBe('onecli');
    expect(getContainerConfig('vault')?.credential_backend).toBe('agent-vault');
    expect(getContainerConfig('missing')?.credential_backend).toBe('onecli');
    ensureContainerConfig('implicit');
    expect(() => usesAgentVault('implicit')).toThrow('Unsupported credential backend');
    expect(() => usesAgentVault('missing')).toThrow('Unsupported credential backend');
    expect(usesAgentVault('vault')).toBe(true);
    expect(db.pragma('foreign_key_check')).toEqual([]);
    runMigrations(
      db,
      migrations.filter((m) => m.version <= 44),
    );
    expect(getContainerConfig('implicit')).toEqual({ ...before, credential_backend: 'onecli' });
  });
  it('defaults every new config row to AgentVault without creating credentials or grants', () => {
    const db = getDb();
    runMigrations(
      db,
      migrations.filter((m) => m.version <= 44),
    );
    group('new');
    expect(usesAgentVault('new')).toBe(true);
    expect(agentVaultBackendGroups()).toContain('new');
    ensureContainerConfig('new');
    expect(getContainerConfig('new')?.credential_backend).toBe('agent-vault');
    expect(() => db.exec('UPDATE container_configs SET credential_backend=NULL')).toThrow();
    expect(() => db.exec("UPDATE container_configs SET credential_backend='unknown'")).toThrow();
    db.prepare("UPDATE container_configs SET credential_backend='onecli' WHERE agent_group_id='new'").run();
    expect(getContainerConfig('new')?.credential_backend).toBe('onecli');
    expect(() => usesAgentVault('new')).toThrow('Unsupported credential backend');
  });
  it('fails and rolls back rather than guessing an unsupported existing backend', () => {
    const db = getDb();
    group('bad');
    db.exec(
      "INSERT INTO container_configs(agent_group_id,credential_backend,updated_at) VALUES('bad','unexpected',1767225600000)",
    );
    expect(() => runMigrations(db)).toThrow('Unsupported credential backend');
    expect(getContainerConfig('bad')?.credential_backend).toBe('unexpected');
    expect(
      db.prepare("SELECT name FROM schema_version WHERE name='agent-vault-new-group-default'").get(),
    ).toBeUndefined();
  });
});
