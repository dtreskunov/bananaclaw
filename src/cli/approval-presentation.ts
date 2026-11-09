import { getAgentGroup } from '../db/agent-groups.js';
import { getMessagingGroup, getMessagingGroupAgent } from '../db/messaging-groups.js';
import { getPendingApproval } from '../modules/permissions/db/pending-user-approvals.js';
import { getUserDisplayName } from '../modules/permissions/db/users.js';
import { getResource } from './crud.js';
import { lookup } from './registry.js';

const REFERENCES: Record<string, [string, string]> = {
  user: ['users', 'User'],
  user_id: ['users', 'User'],
  group: ['agent_groups', 'Agent'],
  agent_group_id: ['agent_groups', 'Agent'],
  messaging_group_id: ['messaging_groups', 'Channel'],
  added_by: ['users', 'Added by'],
  granted_by: ['users', 'Granted by'],
  created_by: ['users', 'Created by'],
};

function entityName(table: string, id: string): string | undefined {
  if (table === 'users') return getUserDisplayName(id);
  if (table === 'agent_groups') return getAgentGroup(id)?.name;
  if (table === 'messaging_groups') {
    const group = getMessagingGroup(id);
    return group ? `${group.name || group.platform_id} (${group.channel_type})` : undefined;
  }
  if (table === 'messaging_group_agents') {
    const wiring = getMessagingGroupAgent(id);
    if (wiring)
      return `${entityName('messaging_groups', wiring.messaging_group_id) || 'Unavailable channel'} -> ${entityName('agent_groups', wiring.agent_group_id) || 'Unavailable agent'}`;
  }
  if (table === 'pending_user_approvals') {
    const pending = getPendingApproval(id);
    return pending ? pending.display_name || pending.email || `${pending.provider} sign-in` : undefined;
  }
  return undefined;
}

export function presentCliApproval(command: string, args: Record<string, unknown>) {
  const resource = getResource(lookup(command)?.resource ?? '');
  const lines = new Set<string>();
  for (const [key, value] of Object.entries(args)) {
    if (typeof value !== 'string') continue;
    let reference = REFERENCES[key];
    if (key === 'id' && resource)
      reference = REFERENCES[resource.idColumn] ?? [
        resource.table,
        resource.table === 'agent_groups' ? 'Agent' : resource.name,
      ];
    if (key === 'target_id' && (args.target_type === 'agent' || args.target_type === 'channel'))
      reference = [args.target_type === 'agent' ? 'agent_groups' : 'messaging_groups', 'Destination'];
    if (!reference) continue;
    const name = entityName(reference[0], value);
    if (name) lines.add(`${reference[1]}: ${name}`);
  }
  const argString = Object.entries(args)
    .map(([key, value]) => `--${key} ${typeof value === 'string' ? value : JSON.stringify(value)}`)
    .join(' ');
  return { summary: [...lines].join('\n'), command: `ncl ${command}${argString ? ' ' + argString : ''}` };
}
