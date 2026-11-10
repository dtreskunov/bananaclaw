import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, getDb, initTestDb } from '../connection.js';
import { agentVaultBackendGroups, ensureContainerConfig, getContainerConfig, updateContainerConfigScalars, parseSoftTurnTokenBudget } from '../container-configs.js';
import { configFromDb } from '../../container-config.js';
import { getAgentGroup } from '../agent-groups.js';
import { usesAgentVault } from '../../modules/credentials/agent-vault-client.js';
import { runMigrations } from './index.js';

beforeEach(() => {
  runMigrations(initTestDb());
  getDb().exec("INSERT INTO agent_groups(id,name,folder,created_at) VALUES('g','Group','group',0)");
});
afterEach(closeDb);

describe('current container configuration defaults', () => {
  it('defaults new groups and config rows to AgentVault without creating credentials or grants', () => {
    expect(usesAgentVault('g')).toBe(true);
    expect(agentVaultBackendGroups()).toContain('g');
    ensureContainerConfig('g');
    expect(getContainerConfig('g')).toMatchObject({
      credential_backend: 'agent-vault',
      cli_scope: 'group',
      skills: '"all"',
      mcp_servers: '{}',
      packages_apt: '[]',
      packages_npm: '[]',
      packages_pip: '[]',
      model_params: '{}',
      disabled_skills: '[]',
      additional_mounts: '[]',
      voice_input_backend: null,
      voice_input_enabled: 1,
      soft_turn_token_budget: null,
    });
    expect(getDb().prepare("SELECT name FROM sqlite_schema WHERE name='credential_connections'").get()).toBeUndefined();
  });

    it('validates, materializes, clears and preserves the advisory policy', () => {
      ensureContainerConfig('g');
      updateContainerConfigScalars('g', { soft_turn_token_budget: 100 });
      expect(configFromDb(getContainerConfig('g')!, getAgentGroup('g')!).softTurnTokenBudget).toBe(100);
      runMigrations(getDb());
      expect(getContainerConfig('g')?.soft_turn_token_budget).toBe(100);
      updateContainerConfigScalars('g', { soft_turn_token_budget: null });
      expect(configFromDb(getContainerConfig('g')!, getAgentGroup('g')!).softTurnTokenBudget).toBeUndefined();
    });

    it.each([0, -1, 1.5, false, 'no', ' ', Infinity, Number.MAX_SAFE_INTEGER + 1])(
      'rejects invalid advisory threshold %s without modifying configuration', value => {
        expect(() => parseSoftTurnTokenBudget(value)).toThrow('positive safe integer');
        ensureContainerConfig('g');
        expect(() => getDb().prepare('UPDATE container_configs SET soft_turn_token_budget=?').run(value)).toThrow();
        expect(getContainerConfig('g')?.soft_turn_token_budget).toBeNull();
      },
    );

  it.each([null, 'onecli', 'unexpected'])(
    'rejects retired or invalid credential backend %j on insert and update',
    (backend) => {
      const db = getDb();
      expect(() =>
        db
          .prepare('INSERT INTO container_configs(agent_group_id,credential_backend,updated_at) VALUES(?,?,0)')
          .run('g', backend),
      ).toThrow();
      ensureContainerConfig('g');
      expect(() => db.prepare('UPDATE container_configs SET credential_backend=?').run(backend)).toThrow();
      expect(getContainerConfig('g')?.credential_backend).toBe('agent-vault');
    },
  );

  it('preserves voice input settings and other configuration without retired audio-note columns', () => {
    const db = getDb();
    db.exec(`INSERT INTO container_configs(agent_group_id,provider,model,voice_input_backend,voice_input_enabled,model_params,updated_at)
      VALUES('g','claude','existing-model','future-provider',0,'{"max_tokens":1024}',1767225600123)`);
    const before = db.prepare('SELECT * FROM container_configs').get();
    runMigrations(db);
    ensureContainerConfig('g');
    expect(db.prepare('SELECT * FROM container_configs').get()).toEqual(before);
    const columns = (db.pragma('table_info(container_configs)') as { name: string }[]).map(({ name }) => name);
    expect(columns).not.toContain('voice_mode');
    expect(columns).not.toContain('transcription_model');
    expect(() => db.exec('UPDATE container_configs SET voice_input_enabled=2')).toThrow();
    expect(db.pragma('foreign_key_check')).toEqual([]);
  });
});
