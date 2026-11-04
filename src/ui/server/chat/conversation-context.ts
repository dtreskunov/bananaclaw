import { getDb } from '../../../db/connection.js';
import {
  getMessagingGroup,
  getMessagingGroupAgentByPair,
  getMessagingGroupByPlatform,
} from '../../../db/messaging-groups.js';
import { findSessionForAgent } from '../../../db/sessions.js';
import { canAccessAgentGroup } from '../../../modules/permissions/access.js';
import { getIdentitiesForUser } from '../../../modules/permissions/db/identities.js';
import { isGlobalAdmin, isOwner } from '../../../modules/permissions/db/user-roles.js';
import { getChannelAdapter } from '../../../channels/channel-registry.js';
import { WEB_CHANNEL_TYPE } from '../../../channels/web.js';
/** Elevated access to non-web messaging contexts. Web chats are group-wide. */
export function isElevated(userId: string): boolean {
  return isOwner(userId) || isGlobalAdmin(userId);
}

/** Map an agent group to its shared web platform_id. */
export function platformIdFor(agentGroupId: string): string {
  return `group:${agentGroupId}`;
}

/**
 * Resolve the (channelType, messagingGroupId, sessionMode) the user is
 * targeting. Shared web rooms are authorized by the route-level agent-group
 * access check. Non-web overrides still require counterparty ownership;
 * elevated users may inspect them without that ownership check.
 */
export function resolveTargetMessagingGroup(
  userId: string,
  agentGroupId: string,
  override: { channelType: string; messagingGroupId: string } | undefined,
  elevated: boolean,
): { channelType: string; messagingGroupId: string; sessionMode: 'per-thread' | 'shared' | 'agent-shared' } | null {
  if (!override) {
    const platformId = platformIdFor(agentGroupId);
    const mg = getMessagingGroupByPlatform(WEB_CHANNEL_TYPE, platformId);
    if (!mg) return null;
    return { channelType: WEB_CHANNEL_TYPE, messagingGroupId: mg.id, sessionMode: 'per-thread' };
  }
  // Override path: shared web is group-authorized; non-web requires ownership.
  if (!elevated && !userOwnsMessagingGroup(userId, agentGroupId, override.channelType, override.messagingGroupId)) {
    return null;
  }
  const mga = getMessagingGroupAgentByPair(override.messagingGroupId, agentGroupId);
  if (!mga) return null;
  const mode = (mga.session_mode || 'per-thread') as 'per-thread' | 'shared' | 'agent-shared';
  return { channelType: override.channelType, messagingGroupId: override.messagingGroupId, sessionMode: mode };
}

/** Authorize: viewer is the counterparty of this messaging group. */
export function userOwnsMessagingGroup(
  userId: string,
  agentGroupId: string,
  channelType: string,
  mgId: string,
): boolean {
  if (channelType === WEB_CHANNEL_TYPE) {
    const platformId = platformIdFor(agentGroupId);
    const mg = getMessagingGroupByPlatform(WEB_CHANNEL_TYPE, platformId);
    return mg?.id === mgId;
  }
  // Accept either a user_dms row OR a userId whose channel prefix matches
  // the mg's channel and which is wired to this agent group. The latter
  // covers email-bot-style aliases where the cold-DM cache isn't written.
  const dmRow = getDb()
    .prepare('SELECT 1 FROM user_dms WHERE user_id = ? AND channel_type = ? AND messaging_group_id = ?')
    .get(userId, channelType, mgId);
  if (dmRow) return true;
  const viewerHandles = viewerHandlesForChannel(userId, channelType);
  if (viewerHandles.length === 0) return false;
  const mgaRow = getDb()
    .prepare(
      `SELECT 1 FROM messaging_group_agents mga
         JOIN messaging_groups mg ON mg.id = mga.messaging_group_id
        WHERE mga.messaging_group_id = ? AND mga.agent_group_id = ? AND mg.channel_type = ?`,
    )
    .get(mgId, agentGroupId, channelType);
  return !!mgaRow;
}

export function resolveSessionForMode(
  agentGroupId: string,
  messagingGroupId: string,
  sessionMode: 'per-thread' | 'shared' | 'agent-shared',
  threadId: string,
): { id: string } | undefined {
  // Look up the session that actually holds this thread's messages.
  // Order matters: a per-thread session for (ag, mg, threadId) is the
  // most specific match. Otherwise a shared session for (ag, mg) holds
  // every thread for that mg. Finally an agent-shared session (mg NULL)
  // is the fallback. Each step is scoped, so we never return a session
  // that belongs to a different messaging group.
  void sessionMode;
  return (
    findSessionForAgent(agentGroupId, messagingGroupId, threadId) ||
    findSessionForAgent(agentGroupId, messagingGroupId, null) ||
    (getDb()
      .prepare(
        `SELECT * FROM sessions
          WHERE agent_group_id = ? AND messaging_group_id IS NULL
            AND thread_id IS NULL AND status = 'active'
          ORDER BY created_at DESC LIMIT 1`,
      )
      .get(agentGroupId) as { id: string } | undefined)
  );
}

export interface TurnContext {
  sessionId?: string;
  channelType: string;
  platformIds: string[];
  threadId: string | null;
  canSend: boolean;
}

export function routeMatches(
  context: TurnContext,
  channel: string | null,
  platform: string | null,
  thread: string | null,
): boolean {
  return (
    channel === context.channelType &&
    platform !== null &&
    context.platformIds.includes(platform) &&
    thread === context.threadId
  );
}

export function resolveTurnContext(
  userId: string,
  groupId: string,
  threadId: string,
  override?: { channelType: string; messagingGroupId: string },
): TurnContext | null {
  if (!canAccessAgentGroup(userId, groupId).allowed) return null;
  const target = resolveTargetMessagingGroup(userId, groupId, override, isElevated(userId));
  if (!target) return null;
  const mg = getMessagingGroup(target.messagingGroupId);
  if (!mg || mg.channel_type !== target.channelType) return null;
  const isDm = threadId.startsWith('__dm:');
  if (isDm && threadId !== `__dm:${mg.id}`) return null;
  const session = resolveSessionForMode(groupId, mg.id, target.sessionMode, isDm ? '' : threadId);
  const owned = userOwnsMessagingGroup(userId, groupId, target.channelType, mg.id);
  const adapter = target.channelType === WEB_CHANNEL_TYPE ? null : getChannelAdapter(target.channelType);
  return {
    sessionId: session?.id,
    channelType: target.channelType,
    platformIds:
      isDm && target.channelType !== WEB_CHANNEL_TYPE && !isElevated(userId)
        ? viewerHandlesForChannel(userId, target.channelType)
        : [mg.platform_id],
    threadId: isDm ? null : threadId,
    canSend: owned && (target.channelType === WEB_CHANNEL_TYPE || !!adapter?.isConnected()),
  };
}

/**
 * For a non-web channel, return every handle the viewer holds on that
 * channel. We look up the `identities` table first (authoritative —
 * works for every canonical UUID user ID). Returns [] when the viewer has no
 * identity on the channel.
 */
export function viewerHandlesForChannel(userId: string, channelType: string): string[] {
  if (channelType === WEB_CHANNEL_TYPE) return [];
  // Most channels write `messages_in.platform_id` as `<channel>:<handle>`
  // (matches `messaging_groups.platform_id`); a few write the bare handle.
  // We accept either, so callers don't need to know per-channel quirks.
  const prefix = channelType + ':';
  const withVariants = (h: string, push: (s: string) => void) => {
    if (!h) return;
    push(h);
    if (h.startsWith(prefix)) push(h.slice(prefix.length));
    else push(prefix + h);
  };
  const set = new Set<string>();
  for (const ident of getIdentitiesForUser(userId)) {
    if (ident.channel === channelType && ident.handle) withVariants(ident.handle, (s) => set.add(s));
  }
  return [...set];
}
