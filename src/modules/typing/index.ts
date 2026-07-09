/**
 * Typing indicator refresh — default module.
 *
 * Most platforms expire a typing indicator after 5–10s, so a one-shot
 * call on message arrival goes stale long before the agent finishes
 * thinking. This module keeps it alive by re-firing `setTyping` on a
 * short interval — but only while the agent is actually WORKING, gated
 * on the heartbeat file's mtime after an initial grace period.
 *
 * Shutdown signal: the container writes `turn_ended_at` to
 * `session_state` on the SDK's `result` / `error` event. The host's
 * active delivery loop calls `checkTurnEndedAndStop` once per tick (~1s)
 * to drop the indicator as soon as that flips, so a final answer or a
 * follow-up question stops the dots without waiting for the heartbeat
 * to age out.
 *
 * Default module status:
 *   - Lives in src/modules/ for signaling (not really core), but ships
 *     on main and is imported directly by core. No registry, no hook.
 *   - Removing requires editing src/router.ts, src/delivery.ts, and
 *     src/container-runner.ts to drop the calls.
 */
import fs from 'fs';

import { getRunningSessions } from '../../db/sessions.js';
import { getMessagingGroup } from '../../db/messaging-groups.js';
import { log } from '../../log.js';
import {
  heartbeatPath,
  isSessionProcessing,
  readSessionActivity,
  readSessionProgress,
  readSessionTurnEndedAt,
  type ActivityLine,
} from '../../session-manager.js';

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
  setTyping?(
    channelType: string,
    platformId: string,
    threadId: string | null,
    hint?: string,
    instance?: string,
    items?: ActivityLine[],
  ): Promise<void>;
  clearTyping?(channelType: string, platformId: string, threadId: string | null): Promise<void>;
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
}

let adapter: TypingAdapter | null = null;
const typingRefreshers = new Map<string, TypingTarget>();

// Last reduced snapshot sent per session. Typing refreshes still run for
// platform expiry, but unchanged web trace payloads are omitted.
const activitySnapshotHashes = new Map<string, string>();

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

async function triggerTyping(
  sessionId: string,
  agentGroupId: string,
  channelType: string,
  platformId: string,
  threadId: string | null,
  startedAt: number,
  instance?: string,
): Promise<void> {
  // Gate the hint on the activity file's mtime: suppress a stale hint left
  // over from the previous turn until this turn's container writes a fresh
  // line (the file isn't truncated until the waking container's first write).
  const hint = readSessionProgress(agentGroupId, sessionId, startedAt) ?? undefined;
  const snapshot = readSessionActivity(agentGroupId, sessionId, startedAt);
  const hash = JSON.stringify(snapshot);
  const items = activitySnapshotHashes.get(sessionId) === hash ? undefined : snapshot;
  activitySnapshotHashes.set(sessionId, hash);
  try {
    await adapter?.setTyping?.(channelType, platformId, threadId, hint, instance, items);
  } catch {
    // Typing is best-effort — don't let it fail delivery or routing.
  }
}

async function triggerClearTyping(channelType: string, platformId: string, threadId: string | null): Promise<void> {
  try {
    await adapter?.clearTyping?.(channelType, platformId, threadId);
  } catch {
    // Best-effort — same as triggerTyping.
  }
}

function isHeartbeatFresh(agentGroupId: string, sessionId: string): boolean {
  const hbPath = heartbeatPath(agentGroupId, sessionId);
  try {
    const stat = fs.statSync(hbPath);
    return Date.now() - stat.mtimeMs < HEARTBEAT_FRESH_MS;
  } catch {
    return false;
  }
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
    // Already refreshing. Fire an immediate tick for the new inbound
    // event and reset the grace window — the new message restarts
    // the container-wake latency budget. Also clear any lingering
    // post-delivery pause: a new inbound means the user expects
    // typing to show immediately.
    triggerTyping(sessionId, agentGroupId, channelType, platformId, threadId, Date.now(), instance).catch(() => {});
    existing.startedAt = Date.now();
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
    activitySnapshotHashes.delete(sessionId);
    return;
  }

  activitySnapshotHashes.delete(sessionId);
  // Immediate tick + periodic refresh.
  triggerTyping(sessionId, agentGroupId, channelType, platformId, threadId, Date.now(), instance).catch(() => {});
  const startedAt = Date.now();
  const interval = setInterval(() => {
    const entry = typingRefreshers.get(sessionId);
    if (!entry) return; // stopped externally since this tick was scheduled

    // turn_ended_at is also checked from the active delivery poll
    // (`checkTurnEndedAndStop`) for sub-second clear, but keep the
    // same check here in case the delivery poll lags or the session
    // isn't being actively polled.
    if (stopIfTurnEnded(sessionId, entry)) return;

    const withinGrace = Date.now() - entry.startedAt < TYPING_GRACE_MS;
    if (withinGrace || isHeartbeatFresh(entry.agentGroupId, sessionId)) {
      triggerTyping(
        sessionId,
        entry.agentGroupId,
        entry.channelType,
        entry.platformId,
        entry.threadId,
        entry.startedAt,
        entry.instance,
      ).catch(() => {});
      return;
    }

    // Out of grace AND heartbeat stale — agent is idle, stop refreshing.
    clearInterval(entry.interval);
    typingRefreshers.delete(sessionId);
    triggerClearTyping(entry.channelType, entry.platformId, entry.threadId).catch(() => {});
  }, TYPING_REFRESH_MS);
  // unref so a stale refresher can't hold the event loop alive.
  interval.unref();
  typingRefreshers.set(sessionId, {
    agentGroupId,
    channelType,
    platformId,
    threadId,
    instance,
    interval,
    startedAt,
  });
}

/**
 * Drop the typing indicator if the container has marked the current
 * turn as ended (final result delivered, or follow-up question asked
 * and now waiting on the user). Called once per active delivery tick
 * (~1s) so the dots disappear within a second of the agent finishing
 * — much faster than waiting for the next 4s refresh tick or for the
 * heartbeat to age out. Returns true if the refresher was stopped.
 */
export function checkTurnEndedAndStop(sessionId: string): boolean {
  const entry = typingRefreshers.get(sessionId);
  if (!entry) return false;
  return stopIfTurnEnded(sessionId, entry);
}

/**
 * Forward changed reduced activity snapshots at the ~1s active delivery
 * cadence instead of waiting for the 4s typing refresh tick. Only the web
 * UI renders the trace, so this is a no-op for other channels to avoid
 * hammering their typing APIs.
 */
export function flushActivity(sessionId: string): void {
  const entry = typingRefreshers.get(sessionId);
  if (!entry || entry.channelType !== 'web') return;
  const hash = JSON.stringify(readSessionActivity(entry.agentGroupId, sessionId, entry.startedAt));
  if (hash === activitySnapshotHashes.get(sessionId)) return;
  triggerTyping(
    sessionId,
    entry.agentGroupId,
    entry.channelType,
    entry.platformId,
    entry.threadId,
    entry.startedAt,
    entry.instance,
  ).catch(() => {});
}

function stopIfTurnEnded(sessionId: string, entry: TypingTarget): boolean {
  const turnEndedAt = readSessionTurnEndedAt(entry.agentGroupId, sessionId);
  if (turnEndedAt <= entry.startedAt) return false;
  clearInterval(entry.interval);
  typingRefreshers.delete(sessionId);
  activitySnapshotHashes.delete(sessionId);
  triggerClearTyping(entry.channelType, entry.platformId, entry.threadId).catch(() => {});
  return true;
}

export function stopTypingRefresh(sessionId: string): void {
  const entry = typingRefreshers.get(sessionId);
  if (!entry) return;
  clearInterval(entry.interval);
  typingRefreshers.delete(sessionId);
  activitySnapshotHashes.delete(sessionId);
  triggerClearTyping(entry.channelType, entry.platformId, entry.threadId).catch(() => {});
}

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
