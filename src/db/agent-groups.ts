import type { AgentGroup } from '../types.js';
import { getDb } from './connection.js';
import { encodeTimes, decodeTimes, decodeTimeRows } from './time.js';

import { recordHostChange } from './transaction.js';

export function createAgentGroup(group: AgentGroup): void {
  getDb()
    .prepare(
      `INSERT INTO agent_groups (id, name, folder, agent_provider, created_at)
       VALUES (@id, @name, @folder, @agent_provider, @created_at)`,
    )
    .run(encodeTimes(group, ['created_at']));
  recordHostChange({ kind: 'access' });
}

export function getAgentGroup(id: string): AgentGroup | undefined {
  return decodeTimes<AgentGroup | undefined>(getDb().prepare('SELECT * FROM agent_groups WHERE id = ?').get(id), ['created_at']);
}

export function getAgentGroupByFolder(folder: string): AgentGroup | undefined {
  return decodeTimes<AgentGroup | undefined>(getDb().prepare('SELECT * FROM agent_groups WHERE folder = ?').get(folder), ['created_at']);
}

export function getAgentGroupBySiteSlug(slug: string): AgentGroup | undefined {
  return decodeTimes<AgentGroup | undefined>(getDb().prepare('SELECT * FROM agent_groups WHERE site_slug = ?').get(slug), ['created_at']);
}

export function getAgentGroupByEmailSlug(slug: string): AgentGroup | undefined {
  return decodeTimes<AgentGroup | undefined>(getDb().prepare('SELECT * FROM agent_groups WHERE email_slug = ?').get(slug), ['created_at']);
}

export function getAllAgentGroups(): AgentGroup[] {
  return decodeTimeRows<AgentGroup>(getDb().prepare('SELECT * FROM agent_groups ORDER BY name').all(), ['created_at']);
}

export function updateAgentGroup(
  id: string,
  updates: Partial<
    Pick<AgentGroup, 'name' | 'agent_provider' | 'site_slug' | 'site_enabled' | 'email_slug' | 'email_enabled'>
  >,
): void {
  const fields: string[] = [];
  const values: Record<string, unknown> = { id };

  for (const [key, value] of Object.entries(updates)) {
    if (value !== undefined) {
      fields.push(`${key} = @${key}`);
      values[key] = value;
    }
  }
  if (fields.length === 0) return;

  getDb()
    .prepare(`UPDATE agent_groups SET ${fields.join(', ')} WHERE id = @id`)
    .run(values);
  recordHostChange({ kind: 'access', groupId: id });
}

export function deleteAgentGroup(id: string): void {
  getDb().prepare('DELETE FROM agent_groups WHERE id = ?').run(id);
  recordHostChange({ kind: 'access' });
}
