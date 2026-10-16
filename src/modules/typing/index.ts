/**
 * Typing indicator refresh — default module.
 *
 * Most platforms expire a typing indicator after 5–10s, so a one-shot
 * call on message arrival goes stale long before the agent finishes
 * thinking. This module keeps it alive by re-firing `setTyping` on a
 * short interval — but only while the agent is actually WORKING, gated
 * on fresh session-link signals after an initial grace period.
 *
 * Shutdown signal: the container sends `turn.end` on the SDK's `result` /
 * `error` event. The session-link listener stops refreshing immediately (the
 * platform indicator then expires on its own); each refresh tick
 * re-checks it as a fallback.
 *
 * Default module status:
 *   - Lives in src/modules/ for signaling (not really core), but ships
 *     on main and is imported directly by core. No registry, no hook.
 *   - Removing requires editing src/router.ts, src/delivery.ts, and
 *     src/container-runner.ts to drop the calls.
 */
import { getRunningSessions } from '../../db/sessions.js';
import { getMessagingGroup } from '../../db/messaging-groups.js';
import { log } from '../../log.js';
import { isSessionProcessing, readSessionTurnEndedAt } from '../../session-manager.js';
import { getSessionSignalLastSeenAt, onSessionSignal } from '../../session-link.js';

const TYPING_REFRESH_MS = 4000;
/**
 * Grace window from startTypingRefresh: fire typing unconditionally
 * for this long regardless of heartbeat state. Covers container
 * spawn/wake latency (5–12s on cold start before first heartbeat).
 */
const TYPING_GRACE_MS = 15000;
/**
 * After the grace window, a heartbeat must be mtimed within this
 * many ms of now to count as "agent is working." Heartbeats land
 * every few hundred ms during active work, so 6s is well above
 * the working floor and small enough to stop typing quickly when
 * the agent goes idle.
 */
const HEARTBEAT_FRESH_MS = 6000;

interface TypingAdapter {
  setTyping?(channelType: string, platformId: string, threadId: string | null, instance?: string): Promise<void>;
}

interface TypingTarget {
  agentGroupId: string;
  channelType: string;
  platformId: string;
  threadId: string | null;
  /** Adapter instance that owns the chat; undefined = default (= channelType). */
  instance?: string;
  interval: NodeJS.Timeout;
  startedAt: number;
  paused: boolean;
}

let adapter: TypingAdapter | null = null;
const typingRefreshers = new Map<string, TypingTarget>();

/**
 * Bind the typing module to the channel delivery adapter so it can
 * call `setTyping`. Called once by `src/delivery.ts` inside
 * `setDeliveryAdapter`. Passing a fresh adapter replaces the prior
 * binding and leaves active refreshers in place (they'll use the
 * new adapter on their next tick).
 */
export function setTypingAdapter(a: TypingAdapter): void {
  adapter = a;
}

function triggerTyping(entry: Pick<TypingTarget, 'channelType' | 'platformId' | 'threadId' | 'instance'>): void {
  // Typing is best-effort — don't let it fail delivery or routing.
  adapter?.setTyping?.(entry.channelType, entry.platformId, entry.threadId, entry.instance).catch(() => {});
}

function isHeartbeatFresh(sessionId: string): boolean {
  const lastSeenAt = getSessionSignalLastSeenAt(sessionId);
  return lastSeenAt > 0 && Date.now() - lastSeenAt < HEARTBEAT_FRESH_MS;
}

export function startTypingRefresh(
  sessionId: string,
  agentGroupId: string,
  channelType: string,
  platformId: string,
  threadId: string | null,
  instance?: string,
): void {
  const existing = typingRefreshers.get(sessionId);
  if (existing) {
    // Already refreshing means this input joined the in-flight turn (for
    // example, steering). Preserve the turn boundary (startedAt) so the
    // turn-end check still compares against the turn's real start.
    existing.paused = false;
    // Keep the stored entry self-consistent: a re-trigger can arrive from
    // a different chat address (agent-shared sessions span messaging
    // groups, possibly on different platforms/instances), so the address
    // fields and the owning instance must move together — a torn entry
    // (old address + new instance) would hand e.g. a telegram platformId
    // to a Slack instance's setTyping on the next interval tick.
    existing.channelType = channelType;
    existing.platformId = platformId;
    existing.threadId = threadId;
    existing.instance = instance;
    triggerTyping(existing);
    return;
  }

  // Immediate tick + periodic refresh.
  const startedAt = Date.now();
  const interval = setInterval(() => {
    const entry = typingRefreshers.get(sessionId);
    if (!entry) return; // stopped externally since this tick was scheduled

    // turn.end normally stops typing directly from the session-link listener;
    // keep the same check here as a defensive fallback.
    if (stopIfTurnEnded(sessionId, entry)) return;

    const withinGrace = Date.now() - entry.startedAt < TYPING_GRACE_MS;
    if (withinGrace || isHeartbeatFresh(sessionId)) {
      entry.paused = false;
      triggerTyping(entry);
      return;
    }

    // Out of grace AND heartbeat stale — stop re-firing so the platform
    // indicator expires, but keep the refresher paused so a transient
    // provider/event-loop stall can recover without a new inbound message.
    // Container exit and turn-end paths still remove it.
    entry.paused = true;
  }, TYPING_REFRESH_MS);
  // unref so a stale refresher can't hold the event loop alive.
  interval.unref();
  const entry: TypingTarget = {
    agentGroupId,
    channelType,
    platformId,
    threadId,
    instance,
    interval,
    startedAt,
    paused: false,
  };
  typingRefreshers.set(sessionId, entry);
  triggerTyping(entry);
}

function stopIfTurnEnded(sessionId: string, entry: TypingTarget): boolean {
  const turnEndedAt = readSessionTurnEndedAt(entry.agentGroupId, sessionId);
  if (turnEndedAt <= entry.startedAt) return false;
  stopTypingRefresh(sessionId);
  return true;
}

export function stopTypingRefresh(sessionId: string): void {
  const entry = typingRefreshers.get(sessionId);
  if (!entry) return;
  clearInterval(entry.interval);
  typingRefreshers.delete(sessionId);
}

onSessionSignal((sessionId, kind) => {
  const entry = typingRefreshers.get(sessionId);
  if (!entry) return;
  if (kind === 'turn.end') {
    stopIfTurnEnded(sessionId, entry);
    return;
  }
  if (kind === 'heartbeat' && entry.paused) {
    entry.paused = false;
    triggerTyping(entry);
  }
});

/**
 * Restart typing refreshers for any session whose container was adopted
 * across a host restart and is still mid-turn (`processing_ack` has a
 * `processing` row). The in-memory `typingRefreshers` map doesn't
 * survive the host process, so without this the UI sees no typing
 * indicator until the next inbound message even though the agent is
 * actively working.
 *
 * Idle adopted sessions are skipped — only the ones genuinely in the
 * middle of a turn get a refresher, so we don't flash dots for ~15s on
 * every restart.
 *
 * Safe to call once at startup after the channel adapter is wired
 * (`setTypingAdapter` has been called). No-op if called before then —
 * typing fires would silently drop.
 */
export function resumeTypingForRunningSessions(): void {
  if (!adapter) return;
  let resumed = 0;
  for (const session of getRunningSessions()) {
    try {
      if (!isSessionProcessing(session.agent_group_id, session.id)) continue;
      if (!session.messaging_group_id) continue;
      const mg = getMessagingGroup(session.messaging_group_id);
      if (!mg) continue;
      startTypingRefresh(session.id, session.agent_group_id, mg.channel_type, mg.platform_id, session.thread_id);
      resumed++;
    } catch (err) {
      log.warn('Failed to resume typing for session', { sessionId: session.id, err });
    }
  }
  if (resumed > 0) log.info('Resumed typing refreshers after host restart', { count: resumed });
}
