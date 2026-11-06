/**
 * Shared mutation entry-point for adding an agent-to-agent destination.
 *
 * Both the chat path (MCP tool → host system action) and the UI path
 * (REST handler in src/ui/server/chat/destinations.ts) funnel through
 * here on auto-apply and on the approve-side of an approval. Keeps the
 * destination-projection invariant (see db/agent-destinations.ts) in
 * exactly one place.
 *
 * Caller responsibility:
 *   - Authorization. This module does not consult `user_roles`. Callers
 *     MUST call authorizeAgentLink first and only invoke applyAgentLink
 *     when the decision is `auto`, OR after an approval handler fires.
 *   - Source / target group existence. Already validated by authorize.
 */
import { getAgentGroup } from '../../db/agent-groups.js';
import { getSessionsByAgentGroup } from '../../db/sessions.js';
import { log } from '../../log.js';
import { createDestination, deleteDestination, getDestinationByName, normalizeName } from './db/agent-destinations.js';
import { writeDestinations } from './write-destinations.js';

export interface ApplyAgentLinkInput {
  sourceAgentGroupId: string;
  targetAgentGroupId: string;
  /** Local name on the source side. Normalized internally. */
  localName: string;
  /** Audit: which user requested it. Pass null for system-initiated links. */
  createdBy: string | null;
  /**
   * Also create the reverse link (target → source). When set, the same
   * local name (or `reverseLocalName` if given) is used as the target's
   * name for the source.
   */
  alsoReverse?: boolean;
  reverseLocalName?: string;
}

export interface ApplyAgentLinkResult {
  forward: { agent_group_id: string; local_name: string; target_id: string };
  reverse: { agent_group_id: string; local_name: string; target_id: string } | null;
}

export class AgentLinkError extends Error {
  constructor(
    public code:
      | 'invalid_local_name'
      | 'name_collision'
      | 'reverse_name_collision'
      | 'unknown_source_group'
      | 'unknown_target_group',
    message: string,
  ) {
    super(message);
    this.name = 'AgentLinkError';
  }
}

const NAME_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;

export function validateLocalName(name: string): string {
  const normalized = normalizeName(name);
  if (!NAME_RE.test(normalized)) {
    throw new AgentLinkError(
      'invalid_local_name',
      `local_name must be 1–40 lowercase alphanumeric or dashes (got "${normalized}")`,
    );
  }
  return normalized;
}

export async function applyAgentLink(input: ApplyAgentLinkInput): Promise<ApplyAgentLinkResult> {
  const source = getAgentGroup(input.sourceAgentGroupId);
  if (!source) throw new AgentLinkError('unknown_source_group', 'source agent group not found');
  const target = getAgentGroup(input.targetAgentGroupId);
  if (!target) throw new AgentLinkError('unknown_target_group', 'target agent group not found');

  const forwardName = validateLocalName(input.localName);
  if (getDestinationByName(source.id, forwardName)) {
    throw new AgentLinkError('name_collision', `destination "${forwardName}" already exists on source agent`);
  }

  let reverseName: string | null = null;
  if (input.alsoReverse) {
    reverseName = validateLocalName(input.reverseLocalName ?? source.folder ?? source.name);
    if (getDestinationByName(target.id, reverseName)) {
      throw new AgentLinkError(
        'reverse_name_collision',
        `reverse destination "${reverseName}" already exists on target agent`,
      );
    }
  }

  const now = Date.now();

  createDestination({
    agent_group_id: source.id,
    local_name: forwardName,
    target_type: 'agent',
    target_id: target.id,
    created_at: now,
    created_by: input.createdBy,
  });

  if (reverseName) {
    createDestination({
      agent_group_id: target.id,
      local_name: reverseName,
      target_type: 'agent',
      target_id: source.id,
      created_at: now,
      created_by: input.createdBy,
    });
  }

  // Projection invariant — must run for EVERY active session of every agent
  // group whose destination map changed. Source always; target only when
  // the reverse row was inserted.
  projectToAllSessions(source.id);
  if (reverseName) projectToAllSessions(target.id);

  log.info('Agent link applied', {
    source: source.id,
    target: target.id,
    forwardName,
    reverseName,
    createdBy: input.createdBy,
  });

  return {
    forward: { agent_group_id: source.id, local_name: forwardName, target_id: target.id },
    reverse: reverseName ? { agent_group_id: target.id, local_name: reverseName, target_id: source.id } : null,
  };
}

function projectToAllSessions(agentGroupId: string): void {
  for (const session of getSessionsByAgentGroup(agentGroupId)) {
    try {
      writeDestinations(agentGroupId, session.id);
    } catch (err) {
      log.warn('Destination projection failed for session (continuing)', {
        agentGroupId,
        sessionId: session.id,
        err,
      });
    }
  }
}

/**
 * Remove a destination row. Safe to call any time — only revokes capability,
 * never grants it. Caller is responsible for the source-side admin check
 * (see authorizeAgentLinkRemoval).
 */
export function removeAgentLink(sourceAgentGroupId: string, localName: string): { removed: boolean } {
  const existing = getDestinationByName(sourceAgentGroupId, localName);
  if (!existing) return { removed: false };
  deleteDestination(sourceAgentGroupId, localName);
  projectToAllSessions(sourceAgentGroupId);
  log.info('Agent destination removed', { source: sourceAgentGroupId, localName });
  return { removed: true };
}
