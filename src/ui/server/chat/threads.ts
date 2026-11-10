import { getDb } from '../../../db/connection.js';
import { getMessagingGroupByPlatform, getMessagingGroupAgentByPair } from '../../../db/messaging-groups.js';
import { getSessionsByAgentGroup, findSessionByAgentGroup } from '../../../db/sessions.js';
import { getThreadForksForAgentGroup } from '../../../db/thread-forks.js';
import { canAccessAgentGroup, listAccessibleAgentGroups } from '../../../modules/permissions/access.js';
import { getChannelAdapter } from '../../../channels/channel-registry.js';
import { WEB_CHANNEL_TYPE } from '../../../channels/web.js';
import type { ThreadSummary, AgentGroupSummary } from '../../shared/thread.js';
import {
  readSessionThreadSummary,
  readSummaryTurns,
  readSummaryQueuedRoutes,
  assertThreadSummariesReady,
  type ThreadSummarySpec,
} from '../../../thread-summaries.js';
import { getSessionActiveTurn } from '../../../session-link.js';
import type { AttentionTarget } from '../../shared/attention.js';
import { readInteractionSync } from './attention.js';
import {
  isElevated,
  platformIdFor,
  resolveTurnContext,
  routeMatches,
  viewerHandlesForChannel,
} from './conversation-context.js';
import { conversationUnread } from './read-state.js';
import { getAgentGroup } from '../../../db/agent-groups.js';
import { peerConversationId } from '../../shared/peer-conversation.js';

interface UserMessagingContext {
  messagingGroupId: string;
  channelType: string;
  platformId: string;
  sessionMode: 'per-thread' | 'shared' | 'agent-shared';
}

/**
 * All messaging-group contexts the viewer could plausibly have threads
 * in, scoped to one agent group. Always includes the implicit web mg if
 * one exists. For every other mga wired to the agent group, includes the
 * mg iff the viewer's userId carries the matching channel prefix — we
 * don't require a user_dms entry, because email-bot-style adapters don't
 * always write one, and we filter per-thread later by inbound platform_id.
 */
/**
 * Cheap viewer-scoped "does this user have any threads they can see in
 * this group" probe. Used by the dropdown filter so groups the viewer
 * has no actual conversations in are hidden by default. Owners/global
 * admins can still see those groups by enabling the "Show all" toggle
 * (which uses {@link listThreadsForViewer} for spectator-mode
 * threads listing).
 *
 * "Content" means "viewer has at least one session in a messaging
 * group they own" — not just "the messaging group exists". A web mg is
 * provisioned eagerly when a user clicks into a group; we only count
 * the group as having content once a session row exists.
 *
 * Non-web channels: we still report `hasContent=true` whenever the
 * viewer has a matching identity AND the (mg, agent_group) pair has
 * any session, even if no thread belongs to the viewer — confirming
 * "you have threads here" via per-thread filtering would require
 * opening every session DB, too expensive for the dropdown.
 */
export function viewerHasContent(userId: string, agentGroupId: string): boolean {
  const ctxs = listUserMessagingContexts(userId, agentGroupId);
  // Web contexts always count — the user can start a new thread even
  // without existing sessions. Non-web contexts require a session to
  // exist (we can't know if ANY thread belongs to the viewer without
  // opening every session DB).
  if (ctxs.some((c) => c.channelType === WEB_CHANNEL_TYPE)) return true;
  const stmt = getDb().prepare(
    'SELECT 1 AS x FROM sessions WHERE agent_group_id = ? AND messaging_group_id = ? LIMIT 1',
  );
  for (const ctx of ctxs) {
    if (stmt.get(agentGroupId, ctx.messagingGroupId)) return true;
  }
  // Agent-shared session (no mg link) is shared by everyone with a
  // messaging context, so it also counts.
  if (
    ctxs.length > 0 &&
    getDb()
      .prepare(
        'SELECT 1 FROM sessions WHERE agent_group_id = ? AND messaging_group_id IS NULL AND thread_id IS NULL LIMIT 1',
      )
      .get(agentGroupId)
  )
    return true;
  return getSessionsByAgentGroup(agentGroupId).some(
    (session) => !!readSessionThreadSummary({ agentGroupId, sessionId: session.id }).peerConversations?.length,
  );
}

function listUserMessagingContexts(userId: string, agentGroupId: string): UserMessagingContext[] {
  const out: UserMessagingContext[] = [];
  const seen = new Set<string>();

  // Web: one shared messaging group for every member of the agent group.
  const webPlatformId = platformIdFor(agentGroupId);
  const webMg = getMessagingGroupByPlatform(WEB_CHANNEL_TYPE, webPlatformId);
  if (webMg) {
    const mga = getMessagingGroupAgentByPair(webMg.id, agentGroupId);
    if (mga) {
      out.push({
        messagingGroupId: webMg.id,
        channelType: WEB_CHANNEL_TYPE,
        platformId: webMg.platform_id,
        sessionMode: (mga.session_mode || 'per-thread') as UserMessagingContext['sessionMode'],
      });
      seen.add(webMg.id);
    }
  }

  // Every other mga wired to this agent group. Include iff the viewer's
  // userId prefix matches the mg's channel.
  type Row = {
    mg_id: string;
    channel_type: string;
    platform_id: string;
    session_mode: string | null;
  };
  const rows = getDb()
    .prepare(
      `SELECT mg.id AS mg_id, mg.channel_type, mg.platform_id, mga.session_mode
         FROM messaging_groups mg
         JOIN messaging_group_agents mga ON mga.messaging_group_id = mg.id
        WHERE mga.agent_group_id = ? AND mg.channel_type != ?`,
    )
    .all(agentGroupId, WEB_CHANNEL_TYPE) as Row[];
  for (const r of rows) {
    if (seen.has(r.mg_id)) continue;
    const viewerHandles = viewerHandlesForChannel(userId, r.channel_type);
    if (viewerHandles.length === 0) continue;
    // platformId on the context is informational — the rail filters per
    // thread against the full handle set, not just this one.
    out.push({
      messagingGroupId: r.mg_id,
      channelType: r.channel_type,
      platformId: viewerHandles[0],
      sessionMode: (r.session_mode || 'per-thread') as UserMessagingContext['sessionMode'],
    });
    seen.add(r.mg_id);
  }
  return out;
}

/**
 * List all chat threads across every messaging group the viewer is in
 * for this agent group. We dispatch based on the actual session rows
 * (whether a session has a thread_id) rather than the configured
 * session_mode, so the listing stays correct when mga.session_mode and
 * the session table have drifted (e.g. mode was changed mid-life).
 */
export async function listThreadsForViewer(
  userId: string,
  agentGroupId: string,
  attention?: AttentionTarget[],
  options: { projectActivity?: boolean } = {},
): Promise<ThreadSummary[]> {
  const visibility = () => {
    const spectator = isElevated(userId);
    const contexts = spectator
      ? listAgentMessagingContexts(agentGroupId)
      : listUserMessagingContexts(userId, agentGroupId);
    const handles = contexts.map((ctx) => viewerHandlesForChannel(userId, ctx.channelType));
    return { spectator, contexts, handles };
  };
  if (!canAccessAgentGroup(userId, agentGroupId).allowed) throw new Error('Thread list access denied');
  const before = visibility();
  // Let commit notices refresh their durable projections before the indexed read.
  await Promise.resolve();
  if (!canAccessAgentGroup(userId, agentGroupId).allowed || JSON.stringify(before) !== JSON.stringify(visibility())) {
    throw new Error('Thread visibility changed before publication; retry the request');
  }
  const threads = collectThreadsForContexts(agentGroupId, before.contexts, before.spectator, before.handles);
  if (options.projectActivity === false) return threads;
  return withThreadAttention(
    agentGroupId,
    withExecutionActivity(userId, agentGroupId, threads),
    attention ?? readInteractionSync(userId).attention,
  );
}

export function withThreadAttention(
  groupId: string,
  threads: ThreadSummary[],
  attention: AttentionTarget[],
): ThreadSummary[] {
  const waiting = new Set(
    attention
      .filter((target) => target.origin.agentGroupId === groupId)
      .map((target) =>
        JSON.stringify([target.origin.channelType, target.origin.messagingGroupId, target.origin.threadId]),
      ),
  );
  if (!waiting.size) return threads;
  return threads.map((thread) =>
    waiting.has(JSON.stringify([thread.channelType, thread.messagingGroupId, thread.threadId]))
      ? { ...thread, waiting: true }
      : thread,
  );
}

function withExecutionActivity(userId: string, agentGroupId: string, threads: ThreadSummary[]): ThreadSummary[] {
  const live = new Map(
    [...new Set(threads.map((thread) => thread.sessionId))].map((sessionId) => [
      sessionId,
      getSessionActiveTurn(sessionId),
    ]),
  );
  const saved = new Map([...live.keys()].map((sessionId) => [sessionId, readSummaryTurns(sessionId)]));
  const queued = new Map([...live.keys()].map((sessionId) => [sessionId, readSummaryQueuedRoutes(sessionId)]));
  return threads.map((thread) => {
    const context = resolveTurnContext(userId, agentGroupId, thread.threadId, {
      channelType: thread.channelType,
      messagingGroupId: thread.messagingGroupId,
    });
    if (context?.sessionId !== thread.sessionId) return { ...thread, activity: 'idle' };
    const unread = conversationUnread(userId, agentGroupId, context);
    const state = live.get(thread.sessionId)!;
    const current =
      state.turn && routeMatches(context, state.turn.channelType, state.turn.platformId, state.turn.threadId)
        ? state.turn
        : null;
    const durable = saved
      .get(thread.sessionId)
      ?.find((turn) => routeMatches(context, turn.channel_type, turn.platform_id, turn.thread_id || null));
    const pending = queued
      .get(thread.sessionId)
      ?.some((route) => routeMatches(context, route.channel_type, route.platform_id, route.thread_id || null));
    const running =
      pending ||
      (current && !(durable?.id === current.id && durable.phase === 'settled')) ||
      (durable && durable.phase !== 'settled');
    const activity = running ? 'running' : 'idle';
    return {
      ...thread,
      activity,
      ...(unread ? { unread: true } : {}),
      ...(running && !pending && (!state.connected || !current) ? { activityStale: true } : {}),
    };
  });
}

export function readAgentActivity(
  userId: string,
  attention: AttentionTarget[],
  selectedGroupId: string | null,
  selectedThreads: ThreadSummary[],
): AgentGroupSummary[] {
  assertThreadSummariesReady();
  const groups = listAccessibleAgentGroups(userId);
  const waiting = new Set(attention.map((target) => target.origin.agentGroupId));
  return groups.map((group): AgentGroupSummary => {
    const spectator = isElevated(userId);
    const contexts = spectator ? listAgentMessagingContexts(group.id) : listUserMessagingContexts(userId, group.id);
    const handles = contexts.map((context) => viewerHandlesForChannel(userId, context.channelType));
    const overlay = waiting.has(group.id) ? { waiting: true } : {};
    const threads =
      group.id === selectedGroupId
        ? selectedThreads
        : withExecutionActivity(userId, group.id, collectThreadsForContexts(group.id, contexts, spectator, handles));
    const running = threads.filter((thread) => thread.activity === 'running');
    return {
      id: group.id,
      activity: running.length ? 'running' : 'idle',
      threadCount: threads.length,
      ...(threads.some((thread) => thread.unread)
        ? { unreadThreadCount: threads.filter((thread) => thread.unread).length }
        : {}),
      ...overlay,
      ...(running.length && running.every((thread) => thread.activityStale) ? { activityStale: true } : {}),
    };
  });
}

/**
 * Spectator view: list every thread for every messaging group wired to
 * this agent group, regardless of viewer ownership. Used by the "Show
 * all" admin toggle so owners/global admins can inspect activity in
 * groups they don't actively participate in. The route handler MUST
 * gate this on `hasAdminPrivilege(userId, agentGroupId)`.
 */
function listAgentMessagingContexts(agentGroupId: string): UserMessagingContext[] {
  // Enumerate every messaging group wired to this agent group, with no
  // viewer-handle filter so all conversations are visible.
  type Row = { mg_id: string; channel_type: string; platform_id: string; session_mode: string | null };
  const rows = getDb()
    .prepare(
      `SELECT mg.id AS mg_id, mg.channel_type, mg.platform_id, mga.session_mode
         FROM messaging_groups mg
         JOIN messaging_group_agents mga ON mga.messaging_group_id = mg.id
        WHERE mga.agent_group_id = ?`,
    )
    .all(agentGroupId) as Row[];
  const ctxs: UserMessagingContext[] = rows.map((r) => ({
    messagingGroupId: r.mg_id,
    channelType: r.channel_type,
    platformId: r.platform_id,
    sessionMode: (r.session_mode || 'per-thread') as UserMessagingContext['sessionMode'],
  }));
  return ctxs;
}

function collectThreadsForContexts(
  agentGroupId: string,
  ctxs: UserMessagingContext[],
  spectator: boolean,
  handles: string[][],
): ThreadSummary[] {
  const out: ThreadSummary[] = [];
  const sessions = getSessionsByAgentGroup(agentGroupId);
  type Plan = {
    spec: ThreadSummarySpec;
    session: Pick<(typeof sessions)[number], 'id' | 'last_active' | 'created_at'>;
    contexts: UserMessagingContext[];
    mode: ThreadSummary['sessionMode'];
  };
  const plans: Plan[] = [];
  const sharedPlans: Plan[] = [];
  for (const ctx of ctxs) {
    const perThread = getDb()
      .prepare(
        `SELECT id, thread_id, last_active, created_at FROM sessions
       WHERE agent_group_id = ? AND messaging_group_id = ? AND thread_id IS NOT NULL`,
      )
      .all(agentGroupId, ctx.messagingGroupId) as Pick<
      (typeof sessions)[number],
      'id' | 'thread_id' | 'last_active' | 'created_at'
    >[];
    for (const session of perThread) {
      if (session.thread_id === null) continue;
      plans.push({
        spec: {
          agentGroupId,
          sessionId: session.id,
          thread: {
            channelType: ctx.channelType,
            platformId: ctx.platformId,
            threadId: session.thread_id,
          },
        },
        session,
        contexts: [ctx],
        mode: 'per-thread',
      });
    }
    const session = sessions.find(
      (s) => s.messaging_group_id === ctx.messagingGroupId && s.thread_id === null && s.status === 'active',
    );
    if (session)
      sharedPlans.push({
        spec: { agentGroupId, sessionId: session.id },
        session,
        contexts: [ctx],
        mode: 'shared',
      });
  }
  plans.push(...sharedPlans);
  if (ctxs.length && sessions.some((s) => s.messaging_group_id === null && s.thread_id === null)) {
    const session = findSessionByAgentGroup(agentGroupId);
    if (session)
      plans.push({
        spec: { agentGroupId, sessionId: session.id },
        session,
        contexts: ctxs,
        mode: 'agent-shared',
      });
  }
  const summaries = plans.map((plan) => readSessionThreadSummary(plan.spec));
  const remaining = new Set(getSessionsByAgentGroup(agentGroupId).map((session) => session.id));
  const dmSummaries: ThreadSummary[] = [];
  const agentSummaries: ThreadSummary[] = [];
  for (const [index, plan] of plans.entries()) {
    if (!remaining.has(plan.session.id)) continue;
    const scan = summaries[index];
    const usage =
      scan.turnCount > 0 ? { totalCost: scan.totalCost, totalTokens: scan.totalTokens, turnCount: scan.turnCount } : {};
    for (const thread of scan.threads) {
      const ctx = plan.contexts.find((c) => c.channelType === thread.channelType && c.platformId === thread.platformId);
      if (!ctx) continue;
      if (
        plan.mode === 'per-thread' &&
        !spectator &&
        ctx.channelType !== WEB_CHANNEL_TYPE &&
        !handles[ctxs.indexOf(ctx)].some((handle) => scan.owners.includes(handle))
      )
        continue;
      const target = plan.mode === 'agent-shared' ? agentSummaries : out;
      target.push({
        ...thread,
        activity: 'idle',
        sessionId: plan.session.id,
        messagingGroupId: ctx.messagingGroupId,
        sessionMode: plan.mode,
        lastActivityAt:
          thread.lastActivityAt ??
          (plan.mode === 'per-thread' ? (plan.session.last_active ?? plan.session.created_at) : null),
        counterparty: ctx.channelType === WEB_CHANNEL_TYPE ? undefined : thread.platformId,
        ...usage,
      });
    }
    if (plan.mode !== 'shared') continue;
    const ctx = plan.contexts[0];
    if (ctx.channelType === WEB_CHANNEL_TYPE) continue;
    const owned = handles[ctxs.indexOf(ctx)];
    const dms = scan.dms.filter(
      (dm) => dm.channelType === ctx.channelType && (spectator || owned.includes(dm.platformId)),
    );
    if (!dms.length) continue;
    const reply = scan.dmReplies.find((r) => r.channelType === ctx.channelType);
    const times = [...dms.map((dm) => dm.lastActivityAt), reply?.lastActivityAt]
      .filter((value): value is number => value != null)
      .sort((a, b) => b - a);
    const platformId = dms[dms.length - 1].platformId;
    dmSummaries.push({
      threadId: `__dm:${ctx.messagingGroupId}`,
      sessionId: plan.session.id,
      channelType: ctx.channelType,
      messagingGroupId: ctx.messagingGroupId,
      platformId,
      sessionMode: 'shared',
      title: 'Direct messages',
      lastActivityAt: times[0] ?? null,
      messageCount: dms.reduce((total, dm) => total + dm.messageCount, reply?.messageCount ?? 0),
      activity: 'idle',
      counterparty: platformId,
      kind: 'dm',
    });
  }
  out.push(...dmSummaries, ...agentSummaries);
  for (const session of sessions) {
    const cached = plans.findIndex((plan) => plan.session.id === session.id);
    const scan = cached >= 0 ? summaries[cached] : readSessionThreadSummary({ agentGroupId, sessionId: session.id });
    for (const peer of scan.peerConversations ?? []) {
      out.push({
        threadId: peerConversationId(session.id, peer.threadId),
        sessionId: session.id,
        channelType: 'agent',
        messagingGroupId: session.id,
        platformId: agentGroupId,
        sessionMode: 'agent-shared',
        title: peer.title,
        counterparty: peer.peerIds.map((id) => getAgentGroup(id)?.name || id).join(', '),
        lastActivityAt: peer.lastActivityAt,
        messageCount: peer.messageCount,
        activity: 'idle',
      });
    }
  }

  // Stamp canSend by channel — true iff the adapter is registered and
  // connected. Web is always sendable (handled by submitWebInbound).
  const canSendByChannel = new Map<string, boolean>();
  for (const t of out) {
    if (canSendByChannel.has(t.channelType)) continue;
    if (t.channelType === WEB_CHANNEL_TYPE) {
      canSendByChannel.set(t.channelType, true);
    } else {
      const a = getChannelAdapter(t.channelType);
      canSendByChannel.set(t.channelType, !!a && a.isConnected());
    }
  }
  for (const t of out) t.canSend = canSendByChannel.get(t.channelType) === true;

  out.sort((a, b) => (b.lastActivityAt ?? -Infinity) - (a.lastActivityAt ?? -Infinity));

  // Deduplicate by threadId — keep the entry with the latest activity.
  // This can happen when the same thread_id exists under multiple
  // messaging groups (e.g. user logged in via two identities).
  const seen = new Set<string>();
  const deduped: ThreadSummary[] = [];
  for (const t of out) {
    if (seen.has(t.threadId)) continue;
    seen.add(t.threadId);
    deduped.push(t);
  }
  if (stampForkLineage(agentGroupId, deduped)) {
    deduped.sort((a, b) => (b.lastActivityAt ?? -Infinity) - (a.lastActivityAt ?? -Infinity));
  }
  return deduped;
}

/**
 * Annotate threads with their fork lineage.
 *
 * Parent liveness is checked against the sessions table rather than against
 * the threads in this listing: a viewer may legitimately be unable to see the
 * parent, and rendering that as "forked from a deleted thread" would be a
 * lie. Only a genuinely absent session counts as deleted.
 *
 * A branch also floors its activity at the moment it was created. Its copied
 * messages carry the parent's original timestamps, so a branch cut from an
 * old thread would otherwise be filed under that old date and land far down
 * the rail — right next to an identically titled parent. Returns true when a
 * floor was applied, telling the caller to re-sort.
 */
function stampForkLineage(agentGroupId: string, threads: ThreadSummary[]): boolean {
  const forks = getThreadForksForAgentGroup(agentGroupId);
  if (forks.length === 0) return false;

  const byThread = new Map(forks.map((f) => [f.thread_id, f]));
  const titles = new Map(threads.map((t) => [t.threadId, t.title]));
  const childrenByParent = new Map<string, { threadId: string; messageId: string; title: string }[]>();
  for (const f of [...forks].sort((a, b) => a.created_at - b.created_at)) {
    // A branch the viewer can't see would render as a link that 404s.
    const title = titles.get(f.thread_id);
    if (title === undefined) continue;
    const list = childrenByParent.get(f.parent_thread_id) ?? [];
    list.push({ threadId: f.thread_id, messageId: f.parent_message_id, title });
    childrenByParent.set(f.parent_thread_id, list);
  }

  const liveParents = new Set<string>();
  const parentIds = [...new Set(forks.map((f) => f.parent_thread_id))];
  for (let i = 0; i < parentIds.length; i += 500) {
    const chunk = parentIds.slice(i, i + 500);
    const rows = getDb()
      .prepare(
        `SELECT thread_id FROM sessions
          WHERE agent_group_id = ? AND thread_id IN (${chunk.map(() => '?').join(',')})`,
      )
      .all(agentGroupId, ...chunk) as { thread_id: string }[];
    for (const r of rows) liveParents.add(r.thread_id);
  }

  let resorted = false;
  for (const t of threads) {
    const fork = byThread.get(t.threadId);
    if (fork) {
      t.forkedFrom = {
        threadId: fork.parent_thread_id,
        messageId: fork.parent_message_id,
        // The stored title is a snapshot from fork time; prefer the live one,
        // which is what the rail and the parent's own link show.
        title: titles.get(fork.parent_thread_id) ?? fork.parent_title,
        fidelity: fork.fidelity,
        deleted: !liveParents.has(fork.parent_thread_id),
      };
      if (t.lastActivityAt === null || fork.created_at > t.lastActivityAt) {
        t.lastActivityAt = fork.created_at;
        resorted = true;
      }
    }
    const children = childrenByParent.get(t.threadId);
    if (children) t.forkChildren = children;
  }
  return resorted;
}
