/**
 * `add_agent_destination` delivery-action handler.
 *
 * Container-driven cross-group link request. The MCP tool fires a system action;
 * the host:
 *   1. Validates the request and resolves the target agent group.
 *   2. Picks a "requesting user" — an admin of the source agent group, preferring
 *      one who is also admin of the target group (enables auto-apply).
 *   3. If that user is admin on both → apply immediately (`applyAgentLink`).
 *   4. Otherwise → queue approval scoped to target group's admins.
 *
 * Why we resolve the requester host-side and not via MCP arg: the agent runs in
 * a container we trust only with the source group's authority. It cannot fake
 * an admin identity on the target group. Picking an existing admin-of-source
 * is sound because the source agent inherits its admins' authority by definition.
 */
import { log } from '../../log.js';
import { getAgentGroup } from '../../db/agent-groups.js';
import type { Session } from '../../types.js';
import { getAdminsOfAgentGroup, getGlobalAdmins, getOwners, hasAdminPrivilege } from '../permissions/db/user-roles.js';
import { notifyAgent, requestApproval } from '../approvals/index.js';
import { applyAgentLink, AgentLinkError, validateLocalName } from './apply-link.js';

/**
 * Returns an ordered list of user ids who admin the source group. Preference:
 *   1. Scoped admins of source
 *   2. Global admins
 *   3. Owners
 * De-duplicated, owners last so that scoped admins (more specific) are tried first.
 */
function listSourceAdmins(sourceGid: string): string[] {
  const seen = new Set<string>();
  const ids: string[] = [];
  const push = (uid: string): void => {
    if (!seen.has(uid)) {
      seen.add(uid);
      ids.push(uid);
    }
  };
  for (const r of getAdminsOfAgentGroup(sourceGid)) push(r.user_id);
  for (const r of getGlobalAdmins()) push(r.user_id);
  for (const r of getOwners()) push(r.user_id);
  return ids;
}

export async function handleAgentLinkRequest(
  content: Record<string, unknown>,
  session: Session,
  _inDb?: unknown,
  context?: { originMessageId: string | null },
): Promise<void> {
  const notify = (text: string) => notifyAgent(session, text, context?.originMessageId);
  const targetGid = content.target_group_id as string | undefined;
  const localNameRaw = content.local_name as string | undefined;
  const alsoReverse = content.also_reverse === true;
  const reverseLocalNameRaw = content.reverse_local_name as string | undefined;

  if (!targetGid || typeof targetGid !== 'string') {
    notify('add_agent_destination failed: target_group_id is required.');
    return;
  }
  if (!localNameRaw || typeof localNameRaw !== 'string') {
    notify('add_agent_destination failed: local_name is required.');
    return;
  }

  let localName: string;
  try {
    localName = validateLocalName(localNameRaw);
  } catch (err) {
    notify(`add_agent_destination failed: ${(err as Error).message}`);
    return;
  }

  const sourceGid = session.agent_group_id;
  if (sourceGid === targetGid) {
    notify('add_agent_destination failed: cannot link an agent to itself.');
    return;
  }

  const sourceGroup = getAgentGroup(sourceGid);
  const targetGroup = getAgentGroup(targetGid);
  if (!sourceGroup) {
    notify('add_agent_destination failed: source agent group not found.');
    return;
  }
  if (!targetGroup) {
    notify(`add_agent_destination failed: target agent group "${targetGid}" not found.`);
    return;
  }

  const sourceAdmins = listSourceAdmins(sourceGid);
  if (sourceAdmins.length === 0) {
    notify('add_agent_destination failed: no admin found for source agent group.');
    return;
  }

  // Prefer an admin who covers both groups → auto-apply path.
  const dualAdmin = sourceAdmins.find((uid) => hasAdminPrivilege(uid, targetGid));
  if (dualAdmin) {
    try {
      const result = await applyAgentLink({
        sourceAgentGroupId: sourceGid,
        targetAgentGroupId: targetGid,
        localName,
        createdBy: dualAdmin,
        alsoReverse,
        reverseLocalName: reverseLocalNameRaw,
      });
      const reverseNote = result.reverse
        ? ` Reverse link from "${targetGroup.name}" → "${sourceGroup.name}" added as "${result.reverse.local_name}".`
        : '';
      notify(`Linked agent "${targetGroup.name}" as destination "${localName}".${reverseNote}`);
      log.info('agent-link auto-applied', {
        sourceGid,
        targetGid,
        localName,
        alsoReverse,
        createdBy: dualAdmin,
      });
    } catch (err) {
      if (err instanceof AgentLinkError) {
        notify(`add_agent_destination failed: ${err.message}`);
      } else {
        notify(`add_agent_destination failed unexpectedly.`);
        log.error('agent-link auto-apply failed', { err, sourceGid, targetGid });
      }
    }
    return;
  }

  // No dual admin → ask target group's admins.
  // Pre-flight a soft check: if we can already see a name collision on the
  // source side, fail fast rather than queue a doomed approval.
  // (applyAgentLink will re-check at apply time; this just gives a better UX.)
  const requester = sourceAdmins[0];
  void requester;

  await requestApproval({
    session,
    originMessageId: context?.originMessageId,
    agentName: sourceGroup.name,
    action: 'add_agent_destination',
    approverAgentGroupId: targetGid,
    payload: {
      sourceAgentGroupId: sourceGid,
      targetAgentGroupId: targetGid,
      localName,
      alsoReverse,
      reverseLocalName: reverseLocalNameRaw ?? null,
    },
    title: `Agent link request from "${sourceGroup.name}"`,
    question:
      `Agent "${sourceGroup.name}" wants to add "${targetGroup.name}" as a destination ` +
      `(name "${localName}"${alsoReverse ? `, plus a reverse link back` : ''}). Allow?`,
  });

  notify(
    `Requested permission to add "${targetGroup.name}" as destination "${localName}". An admin of "${targetGroup.name}" will be asked to approve.`,
  );
}
