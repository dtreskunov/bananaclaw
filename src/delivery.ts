/**
 * Outbound message delivery.
 * Polls session outbound DBs for undelivered messages, delivers through channel adapters.
 *
 * Two-DB architecture:
 *   - Reads messages_out from outbound.db (container-owned, opened read-only)
 *   - Tracks delivery in inbound.db's `delivered` table (host-owned)
 *   - Never writes to outbound.db — preserves single-writer-per-file invariant
 */
import type Database from 'better-sqlite3';

import { getRunningSessions, getActiveSessions, createQuestion } from './db/sessions.js';
import { getAgentGroup } from './db/agent-groups.js';
import { getDb, hasTable } from './db/connection.js';
import { getMessagingGroup, getMessagingGroupByPlatform } from './db/messaging-groups.js';
import {
  getDueOutboundMessages,
  getDeliveredIds,
  markDelivered,
  markDeliveryFailed,
  migrateDeliveredTable,
} from './db/session-db.js';
import { log } from './log.js';
import { normalizeOptions } from './channels/ask-question.js';
import { clearOutbox, openInboundDb, openOutboundDb, readOutboxFiles, writeSessionMessage } from './session-manager.js';
import { extractOutboundText, indexMessage } from './search-index.js';
import { checkTurnEndedAndStop, flushActivity, setTypingAdapter } from './modules/typing/index.js';
import type { ActivityLine, OutboundFile, TypingMetadata } from './channels/adapter.js';
import type { Session } from './types.js';

const ACTIVE_POLL_MS = 1000;
const SWEEP_POLL_MS = 60_000;
const MAX_DELIVERY_ATTEMPTS = 3;

/** Track delivery attempt counts. Resets on process restart (gives failed messages a fresh chance). */
const deliveryAttempts = new Map<string, number>();

/**
 * Cap on how many delivery-failure bounce-backs we'll write into a single
 * session per process lifetime. Each terminal failure normally bounces once
 * (the failed message is marked failed and never reprocessed), but the agent's
 * corrective re-send is a *new* message that could also fail — without a cap a
 * stubborn agent re-sending to a permanently-broken destination would loop.
 * Resets on process restart, like deliveryAttempts.
 */
const MAX_BOUNCE_BACKS_PER_SESSION = 3;
const bounceBackCounts = new Map<string, number>();

/**
 * Sessions whose outbound queue is currently being drained.
 *
 * The active poll (1s, running sessions) and the sweep poll (60s, all
 * active sessions) both call deliverSessionMessages, and a running session
 * is in *both* result sets. Without this guard, the two timer chains can
 * race on the same outbound row: both read it as undelivered, both call
 * the channel adapter, both markDelivered (idempotent in the DB via
 * INSERT OR IGNORE — but the user has already seen the message twice).
 *
 * Skipping (vs. queueing) is correct: any message left over when the
 * second caller skips will be picked up on the next poll tick (~1s).
 */
const inflightDeliveries = new Set<string>();

export interface ChannelDeliveryAdapter {
  deliver(
    channelType: string,
    platformId: string,
    threadId: string | null,
    kind: string,
    content: string,
    files?: OutboundFile[],
    id?: string,
    /** Delivering adapter instance (defaults to channelType downstream).
     *  Host-internal only — containers never see instance. */
    instance?: string,
  ): Promise<string | undefined>;
  setTyping?(channelType: string, platformId: string, threadId: string | null, hint?: string, instance?: string, items?: ActivityLine[], metadata?: TypingMetadata): Promise<void>;
  clearTyping?(channelType: string, platformId: string, threadId: string | null): Promise<void>;
}

let deliveryAdapter: ChannelDeliveryAdapter | null = null;
let activePolling = false;
let sweepPolling = false;

/**
 * Callbacks fired when the delivery adapter is first set (and again if it's
 * replaced). Lets modules that need the adapter at boot (e.g. approvals →
 * OneCLI handler) hook in without core calling into the module directly.
 *
 * Not a general-purpose registry — narrow lifecycle hook only.
 */
type AdapterReadyCallback = (adapter: ChannelDeliveryAdapter) => void | Promise<void>;
const adapterReadyCallbacks: AdapterReadyCallback[] = [];

/** Current delivery adapter or null if not yet set. Modules use this in live
 *  message-flow handlers where the adapter is guaranteed to be set. For
 *  boot-time setup (before the adapter is ready), use onDeliveryAdapterReady. */
export function getDeliveryAdapter(): ChannelDeliveryAdapter | null {
  return deliveryAdapter;
}

export function onDeliveryAdapterReady(cb: AdapterReadyCallback): void {
  adapterReadyCallbacks.push(cb);
  if (deliveryAdapter) {
    // Already set — fire immediately so late registrations still run.
    void Promise.resolve()
      .then(() => cb(deliveryAdapter as ChannelDeliveryAdapter))
      .catch((err) => log.error('onDeliveryAdapterReady callback threw', { err }));
  }
}

export function setDeliveryAdapter(adapter: ChannelDeliveryAdapter): void {
  deliveryAdapter = adapter;
  // Forward to the typing module so it can fire setTyping on its own
  // interval. Direct call, not a registry — typing is a default module.
  setTypingAdapter(adapter);
  for (const cb of adapterReadyCallbacks) {
    void Promise.resolve()
      .then(() => cb(adapter))
      .catch((err) => log.error('onDeliveryAdapterReady callback threw', { err }));
  }
}

/** Start the active container poll loop (~1s). */
export function startActiveDeliveryPoll(): void {
  if (activePolling) return;
  activePolling = true;
  pollActive();
}

/** Start the sweep poll loop (~60s). */
export function startSweepDeliveryPoll(): void {
  if (sweepPolling) return;
  sweepPolling = true;
  pollSweep();
}

async function pollActive(): Promise<void> {
  if (!activePolling) return;

  try {
    const sessions = getRunningSessions();
    for (const session of sessions) {
      await deliverSessionMessages(session);
      // Forward any new activity-trace lines to the web UI at the ~1s
      // active cadence (no-op for non-web channels), then drop the typing
      // indicator as soon as the container marks the turn ended (set on
      // the SDK's result/error event). Both run every active tick so the
      // trace stays live and the dots clear within ~1s of the agent
      // finishing — the in-module 4s refresh tick is the fallback.
      flushActivity(session.id);
      checkTurnEndedAndStop(session.id);
    }
  } catch (err) {
    log.error('Active delivery poll error', { err });
  }

  setTimeout(pollActive, ACTIVE_POLL_MS);
}

async function pollSweep(): Promise<void> {
  if (!sweepPolling) return;

  try {
    const sessions = getActiveSessions();
    for (const session of sessions) {
      await deliverSessionMessages(session);
    }
  } catch (err) {
    log.error('Sweep delivery poll error', { err });
  }

  setTimeout(pollSweep, SWEEP_POLL_MS);
}

export async function deliverSessionMessages(session: Session): Promise<void> {
  // Reject re-entry from a concurrent poll on the same session — see the
  // comment on inflightDeliveries above.
  if (inflightDeliveries.has(session.id)) return;
  inflightDeliveries.add(session.id);

  try {
    await drainSession(session);
  } finally {
    inflightDeliveries.delete(session.id);
  }
}

async function drainSession(session: Session): Promise<void> {
  const agentGroup = getAgentGroup(session.agent_group_id);
  if (!agentGroup) return;

  let outDb: Database.Database;
  let inDb: Database.Database;
  try {
    outDb = openOutboundDb(agentGroup.id, session.id);
    inDb = openInboundDb(agentGroup.id, session.id);
  } catch {
    return; // DBs might not exist yet
  }

  try {
    // Read all due messages from outbound.db (read-only)
    const allDue = getDueOutboundMessages(outDb);
    if (allDue.length === 0) return;

    // Filter out already-delivered messages using inbound.db's delivered table
    const delivered = getDeliveredIds(inDb);
    const undelivered = allDue.filter((m) => !delivered.has(m.id));
    if (undelivered.length === 0) return;

    // Ensure platform_message_id column exists (migration for existing sessions)
    migrateDeliveredTable(inDb);

    for (const msg of undelivered) {
      try {
        const platformMsgId = await deliverMessage(msg, session, inDb);
        markDelivered(inDb, msg.id, platformMsgId ?? null);
        deliveryAttempts.delete(msg.id);

        // Fire-and-forget: index outbound chat messages for search.
        if (msg.kind === 'chat' || msg.kind === 'text') {
          try {
            const text = extractOutboundText(msg.content);
            if (text) {
              // OutboundMessage interface omits `timestamp` but SELECT * returns it.
              const ts = (msg as unknown as { timestamp: string }).timestamp || new Date().toISOString();
              indexMessage({
                id: msg.id,
                sessionId: session.id,
                agentGroupId: session.agent_group_id,
                messagingGroupId: session.messaging_group_id,
                channelType: msg.channel_type,
                threadId: msg.thread_id,
                direction: 'out',
                timestamp: ts,
                text,
              });
            }
          } catch {
            /* search index failures must never block delivery */
          }
        }

        // No post-delivery typing pause: turn_ended_at is now the
        // authoritative "nothing more is coming" signal, checked
        // on every active delivery tick. Intermediate deliveries
        // leave the indicator alone; the final result clears it.
      } catch (err) {
        const attempts = (deliveryAttempts.get(msg.id) ?? 0) + 1;
        deliveryAttempts.set(msg.id, attempts);
        if (attempts >= MAX_DELIVERY_ATTEMPTS) {
          log.error('Message delivery failed permanently, giving up', {
            messageId: msg.id,
            sessionId: session.id,
            attempts,
            err,
          });
          markDeliveryFailed(inDb, msg.id);
          deliveryAttempts.delete(msg.id);
          // Self-correcting safety net: tell the agent its reply never reached
          // the recipient so it can re-send to the right destination. Never let
          // this throw out of the loop — a failed bounce-back must not block
          // delivery of other messages.
          try {
            bounceBackDeliveryFailure(msg, session, err);
          } catch (bbErr) {
            log.warn('Delivery-failure bounce-back failed', { messageId: msg.id, sessionId: session.id, err: bbErr });
          }
        } else {
          log.warn('Message delivery failed, will retry', {
            messageId: msg.id,
            sessionId: session.id,
            attempt: attempts,
            maxAttempts: MAX_DELIVERY_ATTEMPTS,
            err,
          });
        }
      }
    }
  } finally {
    outDb.close();
    inDb.close();
  }
}

/**
 * Write a `delivery_failed` system message back into the session's inbound DB
 * so the agent learns its reply never reached the recipient and can re-send to
 * the correct destination. Renders to the LLM as a `<system_response
 * action="delivery_failed" ...>` block (see formatter.formatSystemMessage).
 *
 * Only fires for human-channel deliveries. Skips:
 *   - agent-to-agent and system kinds (their own paths handle failures),
 *   - the case where the failed destination *is* the session origin (re-sending
 *     to a channel that's itself down won't help),
 *   - sessions that have already exhausted MAX_BOUNCE_BACKS_PER_SESSION.
 */
function bounceBackDeliveryFailure(
  msg: { id: string; kind: string; platform_id: string | null; channel_type: string | null; content: string },
  session: Session,
  err: unknown,
): void {
  if (msg.kind === 'system' || msg.channel_type === 'agent') return;
  if (!msg.channel_type || !msg.platform_id) return;

  const mg = getMessagingGroupByPlatform(msg.channel_type, msg.platform_id);
  // If the failed target is the conversation's own origin, a re-send goes to the
  // same broken channel — bouncing back would just loop. Let it stay failed.
  if (mg && session.messaging_group_id && mg.id === session.messaging_group_id) return;

  const used = bounceBackCounts.get(session.id) ?? 0;
  if (used >= MAX_BOUNCE_BACKS_PER_SESSION) {
    log.warn('Delivery-failure bounce-back cap reached; not notifying agent', {
      sessionId: session.id,
      messageId: msg.id,
    });
    return;
  }

  // Resolve a friendly name for the destination the agent tried (what it wrote
  // in `to="..."`). Inlined SQL — mirrors the permission check in deliverMessage
  // — so core doesn't hard-depend on the agent-to-agent module.
  let failedName = mg?.name ?? `${msg.channel_type}/${msg.platform_id}`;
  if (mg && hasTable(getDb(), 'agent_destinations')) {
    const row = getDb()
      .prepare(
        "SELECT local_name FROM agent_destinations WHERE agent_group_id = ? AND target_type = 'channel' AND target_id = ? LIMIT 1",
      )
      .get(session.agent_group_id, mg.id) as { local_name?: string } | undefined;
    if (row?.local_name) failedName = row.local_name;
  }

  // Resolve the conversation origin so the guidance can name where to re-send.
  let originName: string | undefined;
  if (session.messaging_group_id) {
    const originMg = getMessagingGroup(session.messaging_group_id);
    originName = originMg?.name ?? undefined;
    if (hasTable(getDb(), 'agent_destinations')) {
      const row = getDb()
        .prepare(
          "SELECT local_name FROM agent_destinations WHERE agent_group_id = ? AND target_type = 'channel' AND target_id = ? LIMIT 1",
        )
        .get(session.agent_group_id, session.messaging_group_id) as { local_name?: string } | undefined;
      if (row?.local_name) originName = row.local_name;
    }
  }

  const originalText = extractOutboundText(msg.content) || undefined;
  const reason = err instanceof Error ? err.message : String(err);
  const guidance = originName
    ? `Your message was NOT delivered to "${failedName}". This conversation lives on "${originName}" — re-send your reply there so the person waiting actually receives it.`
    : `Your message was NOT delivered to "${failedName}". Re-send your reply to the destination this conversation lives on (see your destinations list) so the person waiting actually receives it.`;

  bounceBackCounts.set(session.id, used + 1);
  writeSessionMessage(session.agent_group_id, session.id, {
    id: `delivery-fail-${msg.id}`,
    kind: 'system',
    timestamp: new Date().toISOString(),
    content: JSON.stringify({
      action: 'delivery_failed',
      status: 'error',
      result: { failedDestination: failedName, originDestination: originName ?? null, reason, originalText, guidance },
    }),
    trigger: 1,
  });
  log.info('Wrote delivery-failure bounce-back to agent', {
    sessionId: session.id,
    messageId: msg.id,
    failedDestination: failedName,
    originDestination: originName,
  });
}

async function deliverMessage(
  msg: {
    id: string;
    kind: string;
    platform_id: string | null;
    channel_type: string | null;
    thread_id: string | null;
    content: string;
    in_reply_to: string | null;
  },
  session: Session,
  inDb: Database.Database,
): Promise<string | undefined> {
  if (!deliveryAdapter) {
    log.warn('No delivery adapter configured, dropping message', { id: msg.id });
    return;
  }

  const content = JSON.parse(msg.content);

  // System actions — handle internally (schedule_task, cancel_task, etc.)
  if (msg.kind === 'system') {
    await handleSystemAction(content, session, inDb);
    return;
  }

  // Agent-to-agent — route to target session via the agent-to-agent module.
  // Guarded by the channel_type check. If the module isn't installed the
  // `agent_destinations` table won't exist and `routeAgentMessage`'s permission
  // check will throw, which falls into the normal retry → mark-failed path.
  if (msg.channel_type === 'agent') {
    if (!hasTable(getDb(), 'agent_destinations')) {
      throw new Error(`agent-to-agent module not installed — cannot route message ${msg.id}`);
    }
    const { routeAgentMessage } = await import('./modules/agent-to-agent/agent-route.js');
    await routeAgentMessage(msg, session);
    return;
  }

  // Permission check: the source agent must be allowed to deliver to this
  // channel destination. Two ways it passes:
  //
  //   1. The target is the session's own origin chat (session.messaging_group_id
  //      matches). An agent can always reply to the chat it was spawned from;
  //      requiring a destinations row for the obvious case is a footgun.
  //
  //   2. Otherwise, the agent must have an explicit agent_destinations row
  //      targeting that messaging group. createMessagingGroupAgent() inserts
  //      these automatically when wiring, so an operator wiring additional
  //      chats to the agent doesn't need a separate ACL step.
  //
  // Failures throw — unlike a silent `return`, an Error falls into the retry
  // path in deliverSessionMessages and eventually marks the message as failed
  // (instead of marking it delivered when nothing was actually delivered,
  // which was the pre-refactor bug).
  let deliverInstance: string | undefined;
  if (msg.channel_type && msg.platform_id) {
    // Resolve the messaging group ORIGIN-SESSION-FIRST: when the message
    // targets the session's own chat address, the origin row wins even if
    // sibling instances share the same (channel_type, platform_id) — so the
    // reply goes out through the instance the message came in on. Otherwise
    // fall back to the by-platform lookup (default-instance-first).
    const originMg = session.messaging_group_id ? getMessagingGroup(session.messaging_group_id) : undefined;
    const mg =
      originMg && originMg.channel_type === msg.channel_type && originMg.platform_id === msg.platform_id
        ? originMg
        : getMessagingGroupByPlatform(msg.channel_type, msg.platform_id);
    if (!mg) {
      throw new Error(`unknown messaging group for ${msg.channel_type}/${msg.platform_id} (message ${msg.id})`);
    }
    const isOriginChat = session.messaging_group_id === mg.id;
    // Guarded: without the agent-to-agent module, `agent_destinations`
    // doesn't exist and we permit all non-origin channel sends (the
    // origin-chat case is always allowed regardless). Inlined SQL instead
    // of importing `hasDestination` so core doesn't depend on the module.
    if (!isOriginChat && hasTable(getDb(), 'agent_destinations')) {
      const row = getDb()
        .prepare(
          'SELECT 1 FROM agent_destinations WHERE agent_group_id = ? AND target_type = ? AND target_id = ? LIMIT 1',
        )
        .get(session.agent_group_id, 'channel', mg.id);
      if (!row) {
        throw new Error(
          `unauthorized channel destination: ${session.agent_group_id} cannot send to ${mg.channel_type}/${mg.platform_id}`,
        );
      }
    }
    deliverInstance = mg.instance;
  }

  // Track durable questions for ask_user_question flow.
  // Guarded: without the interactive module, `questions` doesn't
  // exist and we skip persistence — the card still delivers to the user,
  // but the response path has nowhere to land and will log unclaimed.
  if (content.type === 'ask_question' && content.questionId && hasTable(getDb(), 'questions')) {
    const title = content.title as string | undefined;
    const questionText = content.question as string | undefined;
    const responseMode = content.responseMode as 'choice' | 'text' | 'choice_or_text' | undefined;
    const rawOptions = content.options as unknown;
    if (!title || !questionText || !responseMode || !Array.isArray(rawOptions)) {
      log.error('ask_question missing required fields — not persisting', {
        questionId: content.questionId,
      });
    } else {
      const inserted = createQuestion({
        question_id: content.questionId,
        session_id: session.id,
        message_out_id: msg.id,
        in_reply_to: msg.in_reply_to,
        platform_id: msg.platform_id,
        channel_type: msg.channel_type,
        thread_id: msg.thread_id,
        title,
        question_text: questionText,
        response_mode: responseMode,
        options: normalizeOptions(rawOptions as never),
        status: 'pending',
        answer_value: null,
        answer_type: null,
        answered_by: null,
        answered_at: null,
        cancelled_at: null,
        created_at: new Date().toISOString(),
      });
      if (inserted) {
        log.info('Pending question created', { questionId: content.questionId, sessionId: session.id });
      }
    }
  }

  // Channel delivery
  if (!msg.channel_type || !msg.platform_id) {
    log.warn('Message missing routing fields', { id: msg.id });
    return;
  }

  // Read file attachments from outbox if the content declares files.
  // File I/O lives in session-manager.ts (symmetric with inbound
  // extractAttachmentFiles) — delivery just hands buffers to the adapter.
  const files =
    Array.isArray(content.files) && content.files.length > 0
      ? readOutboxFiles(session.agent_group_id, session.id, msg.id, content.files as string[])
      : undefined;

  const platformMsgId = await deliveryAdapter.deliver(
    msg.channel_type,
    msg.platform_id,
    msg.thread_id,
    msg.kind,
    msg.content,
    files,
    msg.id,
    deliverInstance,
  );
  log.info('Message delivered', {
    id: msg.id,
    channelType: msg.channel_type,
    platformId: msg.platform_id,
    platformMsgId,
    fileCount: files?.length,
  });

  clearOutbox(session.agent_group_id, session.id, msg.id);

  return platformMsgId;
}

/**
 * Delivery action registry.
 *
 * Modules register handlers for system-kind outbound message actions via
 * `registerDeliveryAction`. Core checks the registry first in
 * `handleSystemAction` and falls through to the inline switch when no
 * handler is registered. The switch will shrink as modules are extracted
 * (scheduling, approvals, agent-to-agent) and eventually only its default
 * branch remains.
 *
 * Default when no handler registered and the switch doesn't match: log
 * "Unknown system action" and return.
 */
export type DeliveryActionHandler = (
  content: Record<string, unknown>,
  session: Session,
  inDb: Database.Database,
) => Promise<void>;

const actionHandlers = new Map<string, DeliveryActionHandler>();

export function registerDeliveryAction(action: string, handler: DeliveryActionHandler): void {
  if (actionHandlers.has(action)) {
    log.warn('Delivery action handler overwritten', { action });
  }
  actionHandlers.set(action, handler);
}

/** Look up a registered delivery-action handler. Lets module registrations be behavior-tested. */
export function getDeliveryAction(action: string): DeliveryActionHandler | undefined {
  return actionHandlers.get(action);
}

/**
 * Handle system actions from the container agent.
 * These are written to messages_out because the container can't write to inbound.db.
 * The host applies them to inbound.db here.
 */
async function handleSystemAction(
  content: Record<string, unknown>,
  session: Session,
  inDb: Database.Database,
): Promise<void> {
  const action = content.action as string;
  log.info('System action from agent', { sessionId: session.id, action });

  const registered = actionHandlers.get(action);
  if (registered) {
    await registered(content, session, inDb);
    return;
  }

  log.warn('Unknown system action', { action });
}

export function stopDeliveryPolls(): void {
  activePolling = false;
  sweepPolling = false;
}
