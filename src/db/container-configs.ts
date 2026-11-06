import type { ContainerConfigRow } from '../types.js';
import { getDb } from './connection.js';
import { toEpoch, decodeTimes, decodeTimeRows } from './time.js';

import { recordHostChange } from './transaction.js';

const SCALAR_COLUMNS = new Set([
  'provider',
  'upstream_provider',
  'model',
  'small_model',
  'effort',
  'image_tag',
  'assistant_name',
  'max_messages_per_prompt',
  'cli_scope',
  'voice_input_backend',
  'voice_input_enabled',
]);
const JSON_COLUMNS = new Set([
  'skills',
  'disabled_skills',
  'mcp_servers',
  'packages_apt',
  'packages_npm',
  'packages_pip',
  'additional_mounts',
  'model_params',
]);

export function getContainerConfig(agentGroupId: string): ContainerConfigRow | undefined {
  return decodeTimes<ContainerConfigRow | undefined>(getDb().prepare('SELECT * FROM container_configs WHERE agent_group_id = ?').get(agentGroupId), ['updated_at']);
}

export function getAllContainerConfigs(): ContainerConfigRow[] {
  return decodeTimeRows<ContainerConfigRow>(getDb().prepare('SELECT * FROM container_configs').all(), ['updated_at']);
}

/** Insert a new config row. Caller must supply all JSON fields (use defaults for empty). */
export function createContainerConfig(config: ContainerConfigRow): void {
  if (config.credential_backend != null && config.credential_backend !== 'agent-vault')
    throw new Error('Unsupported credential backend; review the archived group before restoring its access');
  getDb()
    .prepare(
      `INSERT INTO container_configs (
        agent_group_id, provider, model, effort, image_tag, assistant_name,
        max_messages_per_prompt, skills, mcp_servers, packages_apt, packages_npm,
        packages_pip, additional_mounts, model_params, voice_input_backend, voice_input_enabled, credential_backend, updated_at
      ) VALUES (
        @agent_group_id, @provider, @model, @effort, @image_tag, @assistant_name,
        @max_messages_per_prompt, @skills, @mcp_servers, @packages_apt, @packages_npm,
        @packages_pip, @additional_mounts, @model_params, @voice_input_backend, @voice_input_enabled, @credential_backend, @updated_at
      )`,
    )
    .run({
      ...config,
      updated_at: toEpoch(config.updated_at),
      voice_input_backend: config.voice_input_backend ?? null,
      voice_input_enabled: config.voice_input_enabled ?? 1,
      credential_backend: config.credential_backend ?? 'agent-vault',
    });
  recordHostChange({ kind: 'configuration', groupId: config.agent_group_id });
}

/** Create an empty config row with sensible defaults. Idempotent — no-ops if row exists. */
export function ensureContainerConfig(agentGroupId: string): void {
  getDb()
    .prepare(
      `INSERT OR IGNORE INTO container_configs (agent_group_id, updated_at)
       VALUES (?, ?)`,
    )
    .run(agentGroupId, Date.now());
  recordHostChange({ kind: 'configuration', groupId: agentGroupId });
}

/** Update scalar fields on a config row. Only touches fields present in `updates`. */
export function updateContainerConfigScalars(
  agentGroupId: string,
  updates: Partial<
    Pick<
      ContainerConfigRow,
      | 'provider'
      | 'upstream_provider'
      | 'model'
      | 'small_model'
      | 'effort'
      | 'image_tag'
      | 'assistant_name'
      | 'max_messages_per_prompt'
      | 'cli_scope'
      | 'voice_input_backend'
      | 'voice_input_enabled'
    >
  >,
): void {
  const fields: string[] = [];
  const values: Record<string, unknown> = { agent_group_id: agentGroupId };

  for (const [key, value] of Object.entries(updates)) {
    if (value !== undefined) {
      if (!SCALAR_COLUMNS.has(key)) throw new Error(`Invalid scalar column: ${key}`);
      fields.push(`${key} = @${key}`);
      values[key] = value;
    }
  }
  if (fields.length === 0) return;

  fields.push('updated_at = @updated_at');
  values.updated_at = Date.now();

  getDb()
    .prepare(`UPDATE container_configs SET ${fields.join(', ')} WHERE agent_group_id = @agent_group_id`)
    .run(values);
  recordHostChange({ kind: 'configuration', groupId: agentGroupId });
}

/** Overwrite a JSON column wholesale. Used for skills, mcp_servers, packages_*, additional_mounts, model_params. */
export function updateContainerConfigJson(
  agentGroupId: string,
  column:
    | 'skills'
    | 'disabled_skills'
    | 'mcp_servers'
    | 'packages_apt'
    | 'packages_npm'
    | 'packages_pip'
    | 'additional_mounts'
    | 'model_params',
  value: unknown,
): void {
  if (!JSON_COLUMNS.has(column)) throw new Error(`Invalid JSON column: ${column}`);
  const now = Date.now();
  getDb()
    .prepare(`UPDATE container_configs SET ${column} = ?, updated_at = ? WHERE agent_group_id = ?`)
    .run(JSON.stringify(value), now, agentGroupId);
  recordHostChange({ kind: 'configuration', groupId: agentGroupId });
}

export function deleteContainerConfig(agentGroupId: string): void {
  getDb().prepare('DELETE FROM container_configs WHERE agent_group_id = ?').run(agentGroupId);
  recordHostChange({ kind: 'configuration', groupId: agentGroupId });
}

/** AgentVault is also the default while a newly created group's config is initialized. */
export function agentVaultBackendGroups(): string[] {
  return (
    getDb()
      .prepare(
        `SELECT g.id AS agent_group_id FROM agent_groups g
      LEFT JOIN container_configs c ON c.agent_group_id=g.id
      WHERE c.agent_group_id IS NULL OR c.credential_backend='agent-vault'`,
      )
      .all() as {
      agent_group_id: string;
    }[]
  ).map((r) => r.agent_group_id);
}
