import { randomUUID } from 'crypto';

import { getAgentGroup, getAgentGroupByEmailSlug } from '../../db/agent-groups.js';
import {
  createMessagingGroup,
  createMessagingGroupAgent,
  getMessagingGroup,
  getMessagingGroupAgentByPair,
  getMessagingGroupAgents,
  getMessagingGroupByPlatform,
  updateMessagingGroup,
} from '../../db/messaging-groups.js';
import { getSessionsByAgentGroup } from '../../db/sessions.js';
import { readEnvFile } from '../../env.js';
import type { AgentGroup, MessagingGroup } from '../../types.js';
import {
  createDestination,
  deleteDestination,
  getDestinationByName,
  getDestinationByTarget,
} from '../agent-to-agent/db/agent-destinations.js';
import { writeDestinations } from '../agent-to-agent/write-destinations.js';

export interface AgentEmailConfig {
  available: boolean;
  baseDomain: string | null;
}

export function getAgentEmailConfig(): AgentEmailConfig {
  const env = readEnvFile(['RESEND_API_KEY', 'RESEND_FROM_ADDRESS']);
  const from = String(env.RESEND_FROM_ADDRESS || '')
    .trim()
    .toLowerCase();
  const at = from.lastIndexOf('@');
  const baseDomain = at > 0 && at < from.length - 1 ? from.slice(at + 1) : null;
  return { available: !!env.RESEND_API_KEY && !!baseDomain, baseDomain };
}

export function sanitizeEmailSlug(input: string): string {
  return input
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63)
    .replace(/-+$/g, '');
}

export function isValidEmailSlug(slug: string): boolean {
  return /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(slug);
}

export function agentEmailAddress(group: Pick<AgentGroup, 'email_slug'>, baseDomain: string | null): string | null {
  return group.email_slug && baseDomain ? `${group.email_slug}@${baseDomain}` : null;
}

export function allocateEmailSlug(group: Pick<AgentGroup, 'id' | 'name'>, baseDomain: string): string | null {
  const base = sanitizeEmailSlug(group.name);
  if (!base) return null;

  if (emailSlugAvailable(group.id, base, baseDomain)) return base;
  for (let suffix = 2; suffix < 1000; suffix++) {
    const candidate = sanitizeEmailSlug(`${base}-${suffix}`);
    if (emailSlugAvailable(group.id, candidate, baseDomain)) return candidate;
  }
  return null;
}

export function emailSlugAvailable(agentGroupId: string, slug: string, baseDomain: string): boolean {
  const existingGroup = getAgentGroupByEmailSlug(slug);
  if (existingGroup && existingGroup.id !== agentGroupId) return false;

  const existingMailbox = getMessagingGroupByPlatform('resend', `resend:${slug}@${baseDomain}`, 'resend');
  if (!existingMailbox) return true;
  const agents = getMessagingGroupAgents(existingMailbox.id);
  return agents.length > 0 && agents.every((agent) => agent.agent_group_id === agentGroupId);
}

/** Resolve current or historical managed aliases while the owning agent has email enabled. */
export function getEnabledAgentGroupForEmailAlias(alias: string): AgentGroup | undefined {
  const mailbox = getMessagingGroupByPlatform('resend', `resend:${alias.toLowerCase()}`, 'resend');
  if (!mailbox) return undefined;
  for (const wiring of getMessagingGroupAgents(mailbox.id)) {
    const group = getAgentGroup(wiring.agent_group_id);
    if (group?.email_enabled) return group;
  }
  return undefined;
}

function createMailbox(group: AgentGroup, address: string): MessagingGroup {
  const createdAt = new Date().toISOString();
  const mailbox: MessagingGroup = {
    id: `mg-${Date.now()}-${randomUUID().slice(0, 6)}`,
    channel_type: 'resend',
    platform_id: `resend:${address}`,
    instance: 'resend',
    name: address,
    is_group: 1,
    unknown_sender_policy: 'public',
    denied_at: null,
    created_at: createdAt,
  };
  createMessagingGroup(mailbox);
  return mailbox;
}

/** Reconcile central routing after email_slug/email_enabled changes. */
export function reconcileAgentEmail(group: AgentGroup, baseDomain: string): void {
  const existingCanonical = getDestinationByName(group.id, 'email');

  if (!group.email_enabled || !group.email_slug) {
    if (existingCanonical?.target_type === 'channel') {
      const target = getMessagingGroup(existingCanonical.target_id);
      if (target?.channel_type === 'resend') deleteDestination(group.id, 'email');
    }
    return;
  }

  const address = `${group.email_slug}@${baseDomain}`;
  let mailbox = getMessagingGroupByPlatform('resend', `resend:${address}`, 'resend');
  if (!mailbox) mailbox = createMailbox(group, address);
  else updateMessagingGroup(mailbox.id, { name: address, is_group: 1, unknown_sender_policy: 'public' });

  if (
    existingCanonical &&
    (existingCanonical.target_type !== 'channel' || existingCanonical.target_id !== mailbox.id)
  ) {
    deleteDestination(group.id, 'email');
  }

  if (!getMessagingGroupAgentByPair(mailbox.id, group.id)) {
    createMessagingGroupAgent({
      id: `mga-${Date.now()}-${randomUUID().slice(0, 6)}`,
      messaging_group_id: mailbox.id,
      agent_group_id: group.id,
      engage_mode: 'pattern',
      engage_pattern: '.',
      sender_scope: 'all',
      ignored_message_policy: 'drop',
      session_mode: 'shared',
      priority: 0,
      created_at: new Date().toISOString(),
    });
  }

  const targetDestination = getDestinationByTarget(group.id, 'channel', mailbox.id);
  if (targetDestination && targetDestination.local_name !== 'email') {
    deleteDestination(group.id, targetDestination.local_name);
  }
  if (!getDestinationByTarget(group.id, 'channel', mailbox.id)) {
    createDestination({
      agent_group_id: group.id,
      local_name: 'email',
      target_type: 'channel',
      target_id: mailbox.id,
      created_at: new Date().toISOString(),
      created_by: null,
    });
  }
}

export function projectAgentEmailDestinations(agentGroupId: string): void {
  for (const session of getSessionsByAgentGroup(agentGroupId)) {
    try {
      writeDestinations(agentGroupId, session.id);
    } catch {
      // A missing or concurrently removed session will refresh on its next wake.
    }
  }
}
