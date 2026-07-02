/**
 * Container admission control — capping concurrent agent containers.
 *
 * The host is often memory-constrained (a small LXC slice next to VMs on an
 * overcommitted node). Left ungated, a burst of inbound messages spawns one
 * container per session, each of which can spike to hundreds of MB mid-turn,
 * pushing the host into swap-thrash or OOM-kill.
 *
 * The cap is derived once, at service startup, from the memory available then
 * divided by a conservative per-container estimate — no tuning knobs. There's
 * no live per-spawn memory math: agent containers swing ~10x between idle
 * (~tens of MB) and mid-inference (hundreds of MB), so a fixed worst-case
 * estimate applied to the startup memory headroom is both simpler and safer
 * than chasing a moving target.
 *
 * When the cap is reached, admission EVICTs the least-recently-active *idle*
 * container (no in-flight work) to make room, and only REJECTs (defers) when
 * nothing is safely evictable. A rejected spawn leaves the inbound message
 * pending; host-sweep re-wakes it on its next tick.
 *
 * `decideAdmission` is pure so the policy can be unit-tested without a DB,
 * filesystem, or live process table. `snapshotRunning` does the impure part —
 * reading heartbeats and session DBs to resolve which containers are safely
 * evictable — and feeds its result into `decideAdmission`.
 */

import fs from 'fs';

import { getSession } from './db/sessions.js';
import {
  countDueMessages,
  getProcessingClaims,
  openInboundDb,
  openOutboundDb,
} from './db/session-db.js';
import { log } from './log.js';
import { heartbeatPath, inboundDbPath, outboundDbPath } from './session-manager.js';

/**
 * Conservative per-container peak footprint estimate (MB) — the whole
 * container (agent-runner + provider server + any MCP children) at full tilt.
 * Containers idle near ~30MB but can spike to hundreds mid-inference, so the
 * cap is sized for the worst case.
 */
const CONTAINER_EST_MB = 600;

/**
 * Live available memory for this host / cgroup, in MB, or null if unreadable.
 * Uses /proc/meminfo MemAvailable, which under lxcfs reflects the container's
 * own cgroup limit (not the physical node) — exactly NanoClaw's slice.
 */
export function readAvailableMemMb(): number | null {
  try {
    const info = fs.readFileSync('/proc/meminfo', 'utf8');
    const m = info.match(/^MemAvailable:\s+(\d+)\s*kB/m);
    if (m) return Math.floor(Number(m[1]) / 1024);
  } catch {
    /* fall through */
  }
  return null;
}

/**
 * Concurrent-container cap derived from the memory available the first time
 * it's needed (i.e. the first spawn). 0 means "no cap" (memory unreadable —
 * e.g. a non-Linux dev host — so fail open). Computed once, memoized, and
 * logged on that first computation: the cap intentionally reflects early
 * headroom, not live memory.
 */
let cap: number | undefined;

export function maxConcurrentContainers(): number {
  if (cap === undefined) {
    const avail = readAvailableMemMb();
    cap = avail == null ? 0 : Math.max(1, Math.floor(avail / CONTAINER_EST_MB));
    log.info('Container admission cap set', {
      maxContainers: cap === 0 ? 'unlimited' : cap,
      availableMemMb: avail,
      estPerContainerMb: CONTAINER_EST_MB,
    });
  }
  return cap;
}

export interface RunningContainer {
  sessionId: string;
  /** True when the container has no in-flight work and is safe to evict. */
  idle: boolean;
  /** Heartbeat mtime (ms) for LRU ordering; 0 when no heartbeat yet. */
  lastActivityMs: number;
}

export type AdmissionDecision =
  | { action: 'admit' }
  | { action: 'evict'; sessionId: string }
  | { action: 'reject'; reason: string };

/**
 * Pure admission policy: admit while under the cap, else evict the LRU idle
 * container to make room, else reject (defer). `maxContainers` of 0 means no
 * cap — always admit.
 */
export function decideAdmission(args: { maxContainers: number; running: RunningContainer[] }): AdmissionDecision {
  const { maxContainers, running } = args;
  if (maxContainers > 0 && running.length >= maxContainers) {
    const victim = running.filter((c) => c.idle).sort((a, b) => a.lastActivityMs - b.lastActivityMs)[0];
    return victim
      ? { action: 'evict', sessionId: victim.sessionId }
      : { action: 'reject', reason: `at cap ${maxContainers} (${running.length} running)` };
  }
  return { action: 'admit' };
}

// Don't evict a container that showed activity within this window — it's
// likely mid-turn or between rapid follow-ups, not genuinely idle.
const IDLE_EVICT_GRACE_MS = 15_000;

/**
 * Resolve the running-container snapshot `decideAdmission` needs. For each
 * running session (except `excludeSessionId`, the one being admitted) work out
 * whether it's safely evictable — no active processing claim, no due inbound
 * messages, and quiet past the grace window. Any read failure is treated as
 * "not idle" so we never evict a container we can't confirm is safe to kill.
 */
export function snapshotRunning(
  runningSessionIds: Iterable<string>,
  excludeSessionId: string,
): RunningContainer[] {
  const now = Date.now();
  const out: RunningContainer[] = [];
  for (const sessionId of runningSessionIds) {
    if (sessionId === excludeSessionId) continue;
    let idle = false;
    let lastActivityMs = 0;
    const s = getSession(sessionId);
    if (s) {
      try {
        const hbPath = heartbeatPath(s.agent_group_id, s.id);
        lastActivityMs = fs.existsSync(hbPath) ? fs.statSync(hbPath).mtimeMs : 0;
        const quiet = lastActivityMs === 0 || now - lastActivityMs > IDLE_EVICT_GRACE_MS;
        idle = quiet && !hasInFlightWork(s.agent_group_id, s.id);
      } catch {
        idle = false;
      }
    }
    out.push({ sessionId, idle, lastActivityMs });
  }
  return out;
}

/** True if the session has an active processing claim or due inbound messages. */
function hasInFlightWork(agentGroupId: string, sessionId: string): boolean {
  try {
    const outDb = openOutboundDb(outboundDbPath(agentGroupId, sessionId));
    try {
      if (getProcessingClaims(outDb).length > 0) return true;
    } finally {
      outDb.close();
    }
    const inDb = openInboundDb(inboundDbPath(agentGroupId, sessionId));
    try {
      if (countDueMessages(inDb) > 0) return true;
    } finally {
      inDb.close();
    }
    return false;
  } catch {
    // Can't verify — assume work in flight so we don't evict it.
    return true;
  }
}
