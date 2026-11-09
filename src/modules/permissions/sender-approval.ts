/**
 * Unknown-sender approval flow.
 *
 * When `messaging_groups.unknown_sender_policy = 'request_approval'` and a
 * non-member writes into a wired chat, the access gate drops the routing
 * attempt and calls `requestSenderApproval` to:
 *
 *   1. Pick an eligible approver (owner / admin of the agent group).
 *   2. Open / reuse a DM to that approver on a reachable channel.
 *   3. Deliver an Approve / Deny card.
 *   4. Record a pending_sender_approvals row that holds the original message
 *      so it can be re-routed on approve.
 *
 * On approve: the handler in index.ts adds an agent_group_members row for
 * the sender and re-invokes routeInbound with the stored event — the second
 * routing attempt passes the gate because the user is now a member.
 *
 * Failure modes (logged + row NOT created, so the dedup gate lets a future
 * attempt try again):
 *   - No eligible approver in user_roles — fresh install, no owner yet.
 *   - Approver has no reachable DM (no user_dms row + channel can't
 *     openDM) — e.g. owner hasn't registered on any channel we're wired to.
 *   - Delivery adapter missing.
 *
 * Dedup: `pending_sender_approvals` has UNIQUE(messaging_group_id,
 * sender_identity). A retry / rapid second message from the same unknown
 * sender is silently dropped (no duplicate card sent).
 */
import { normalizeOptions, type NormalizedOption } from '../../channels/approval-request.js';
import { getMessagingGroup } from '../../db/messaging-groups.js';
import { getDeliveryAdapter } from '../../delivery.js';
import { log } from '../../log.js';
import type { InboundEvent } from '../../channels/adapter.js';
import { pickApprovalDelivery, pickApprover } from '../approvals/primitive.js';
import {
  createPendingSenderApproval,
  getPendingSenderApproval,
  hasInFlightSenderApproval,
} from './db/pending-sender-approvals.js';
import { hasAdminPrivilege } from './db/user-roles.js';
import { getPrimaryIdentityForChannel } from './db/identities.js';
import { getUser } from './db/users.js';
import { parseSender } from './sender.js';

const APPROVAL_OPTIONS = normalizeOptions([
  { label: 'Allow', selectedLabel: '✅ Allowed', value: 'approve' },
  { label: 'Deny', selectedLabel: '❌ Denied', value: 'reject' },
]);

export interface RequestSenderApprovalInput {
  messagingGroupId: string;
  agentGroupId: string;
  senderIdentity: string; // users.id UUID, not a platform handle
  senderName: string | null;
  event: InboundEvent;
}

function senderDisplay(userId: string, senderName: string | null, event: InboundEvent): string {
  const sender = parseSender(event.message.content);
  const handle = sender?.handle ?? getPrimaryIdentityForChannel(userId, event.channelType)?.handle;
  const identity = handle ? (handle.includes(':') ? handle : `${event.channelType}:${handle}`) : userId;
  const name = senderName?.trim() || sender?.name?.trim() || getUser(userId)?.display_name?.trim();
  return name && name !== handle && name !== identity ? `${name} (${identity})` : identity;
}

export async function resendSenderApproval(id: string): Promise<{ approvalId: string; resent: true }> {
  const row = getPendingSenderApproval(id);
  if (!row) throw new Error('Pending sender approval not found');
  if (!hasAdminPrivilege(row.approver_user_id, row.agent_group_id))
    throw new Error('The recorded approver is no longer authorized');
  const origin = getMessagingGroup(row.messaging_group_id);
  if (!origin) throw new Error('Approval origin is unavailable');
  const target = await pickApprovalDelivery([row.approver_user_id], origin.channel_type);
  if (!target) throw new Error('The recorded approver has no reachable DM');
  const adapter = getDeliveryAdapter();
  if (!adapter) throw new Error('Approval delivery is unavailable');
  const saved: unknown = JSON.parse(row.options_json);
  const validOption = (value: unknown): value is NormalizedOption =>
    !!value &&
    typeof value === 'object' &&
    'label' in value &&
    typeof value.label === 'string' &&
    'selectedLabel' in value &&
    typeof value.selectedLabel === 'string' &&
    'value' in value &&
    typeof value.value === 'string';
  if (!Array.isArray(saved) || !saved.every(validOption)) throw new Error('Stored approval options are invalid');
  const event: InboundEvent = JSON.parse(row.original_message);
  await adapter.deliver(
    target.messagingGroup.channel_type,
    target.messagingGroup.platform_id,
    null,
    'chat-sdk',
    JSON.stringify({
      type: 'approval_request',
      approvalId: row.id,
      title: row.title,
      body: `${senderDisplay(row.sender_identity, row.sender_name, event)} wants to talk to your agent in ${origin.name || 'this channel'}. Allow?`,
      options: saved,
    }),
  );
  log.info('Pending sender approval reissued', { approvalId: row.id, approver: row.approver_user_id });
  return { approvalId: row.id, resent: true };
}

export async function requestSenderApproval(input: RequestSenderApprovalInput): Promise<void> {
  const { messagingGroupId, agentGroupId, senderIdentity, senderName, event } = input;

  // In-flight dedup: don't spam the admin if the same unknown sender
  // retries while a card is already pending.
  if (hasInFlightSenderApproval(messagingGroupId, senderIdentity)) {
    log.debug('Unknown-sender approval already in flight — dropping retry', {
      messagingGroupId,
      senderIdentity,
    });
    return;
  }

  const approvers = pickApprover(agentGroupId);
  if (approvers.length === 0) {
    log.warn('Unknown-sender approval skipped — no owner or admin configured', {
      messagingGroupId,
      agentGroupId,
      senderIdentity,
    });
    return;
  }

  const originMg = getMessagingGroup(messagingGroupId);
  const originChannelType = originMg?.channel_type ?? '';
  const target = await pickApprovalDelivery(approvers, originChannelType);
  if (!target) {
    log.warn('Unknown-sender approval skipped — no DM channel for any approver', {
      messagingGroupId,
      agentGroupId,
      senderIdentity,
    });
    return;
  }

  const approvalId = `nsa-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const originName = originMg?.name ?? `a ${originChannelType} channel`;

  const title = '👤 New sender';
  const question = `${senderDisplay(senderIdentity, senderName, event)} wants to talk to your agent in ${originName}. Allow?`;

  createPendingSenderApproval({
    id: approvalId,
    messaging_group_id: messagingGroupId,
    agent_group_id: agentGroupId,
    sender_identity: senderIdentity,
    sender_name: senderName,
    original_message: JSON.stringify(event),
    approver_user_id: target.userId,
    created_at: Date.now(),
    title,
    options_json: JSON.stringify(APPROVAL_OPTIONS),
  });

  const adapter = getDeliveryAdapter();
  if (!adapter) {
    // Without a delivery adapter, the card can't be sent. Log + leave the
    // row in place so the admin can see it via DB or manual tooling; the
    // dedup gate will suppress further cards until it's cleared.
    log.error('Unknown-sender approval row created but no delivery adapter is wired', {
      approvalId,
    });
    return;
  }

  try {
    await adapter.deliver(
      target.messagingGroup.channel_type,
      target.messagingGroup.platform_id,
      null,
      'chat-sdk',
      JSON.stringify({
        type: 'approval_request',
        approvalId,
        title,
        body: question,
        options: APPROVAL_OPTIONS,
      }),
    );
    log.info('Unknown-sender approval card delivered', {
      approvalId,
      senderIdentity,
      approver: target.userId,
      messagingGroupId,
      agentGroupId,
    });
  } catch (err) {
    log.error('Unknown-sender approval card delivery failed', {
      approvalId,
      err,
    });
  }
}

/**
 * Option value the admin clicked that means "allow" — shared with the
 * response handler so the two sides can't drift.
 */
export const APPROVE_VALUE = 'approve';
export const REJECT_VALUE = 'reject';
