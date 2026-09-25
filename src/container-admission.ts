/**
 * Container admission control — budgeting memory across agent containers.
 *
 * The host is often memory-constrained (a small LXC slice next to VMs on an
 * overcommitted node). Left ungated, a burst of inbound messages spawns one
 * container per session, each of which can spike to hundreds of MB mid-turn,
 * pushing the host into swap-thrash or OOM-kill.
 *
 * Admission spends a fixed memory budget, derived once at service startup from
 * the memory available then. Each container is charged a worst-case estimate
 * built from its agent group's container config, because configs differ by an
 * order of magnitude in how many processes they actually start: a `claude`
 * group runs the agent-runner plus the stdio MCP sidecar plus the provider CLI,
 * while a `native` group runs the agent-runner alone. Charging both the same
 * flat number either starves the cheap configs or overcommits the expensive
 * ones.
 *
 * There's still no live per-spawn memory math: agent containers swing ~10x
 * between idle (~tens of MB) and mid-inference (hundreds of MB), so a
 * worst-case estimate applied to the startup memory headroom is both simpler
 * and safer than chasing a moving target. What the config changes is *which*
 * worst case applies.
 *
 * When the budget is exhausted, admission EVICTs the least-recently-active
 * *idle* container to make room, and only REJECTs (defers) when nothing is
 * safely evictable. A rejected spawn leaves the inbound message pending;
 * host-sweep re-wakes it on its next tick.
 *
 * `decideAdmission` and `estimateContainerMb` are pure so the policy can be
 * unit-tested without a DB, filesystem, or live process table.
 * `snapshotRunning` does the impure part — reading heartbeats, container
 * configs, and session DBs to resolve each container's cost and whether it's
 * safely evictable — and feeds its result into `decideAdmission`.
 */

import fs from 'fs';

import { getContainerConfig } from './db/container-configs.js';
import { getSession } from './db/sessions.js';
import {
  countDueMessages,
  getProcessingClaims,
  openInboundDb,
  openOutboundDb,
} from './db/session-db.js';
import { defaultProvider } from './env.js';
import { log } from './log.js';
import { inboundDbPath, outboundDbPath } from './session-manager.js';
import { getSessionSignalLastSeenAt } from './session-link.js';

// Per-process worst-case allowances (MB). Together they decompose the flat
// 600MB figure this module used to charge every container, so a default
// `claude` group is priced exactly as before and only configs that genuinely
// run a different set of processes move.

/** The agent-runner Bun process itself. */
const RUNNER_MB = 150;

/**
 * The built-in `nanoclaw` stdio MCP server. A second Bun process, spawned for
 * every provider except `native`, which registers the same tools in-process
 * (see the `providerName !== 'native'` guard in the agent-runner entrypoint).
 */
const MCP_SIDECAR_MB = 100;

/** Each additional stdio MCP server from the config is another child process. */
const EXTRA_MCP_SERVER_MB = 100;

/**
 * The provider's own inference process. `claude` and `opencode` shell out to a
 * Node CLI that holds the conversation and streams the model. `native` has no
 * subprocess at all — it streams in-process via the ai SDK — but is still
 * charged for that work happening inside the runner.
 */
const PROVIDER_SUBPROCESS_MB: Record<string, number> = {
  claude: 350,
  opencode: 300,
  native: 100,
  mock: 0,
};

/** Unknown providers are charged the most expensive known one. */
const UNKNOWN_PROVIDER_MB = Math.max(...Object.values(PROVIDER_SUBPROCESS_MB));

export interface ContainerCostInputs {
  /** Resolved provider name. Absent or unrecognised is charged the dearest one. */
  provider?: string | null;
  /** The config's `mcpServers` map. Only stdio entries start a local process. */
  mcpServers?: Record<string, { type?: string }> | null;
}

/**
 * Worst-case footprint (MB) for one container running this config. Pure — the
 * caller resolves the provider, so an unknown or missing one is priced as the
 * most expensive rather than silently as the host default.
 */
export function estimateContainerMb(input: ContainerCostInputs): number {
  const provider = (input.provider ?? '').toLowerCase();
  const providerMb = PROVIDER_SUBPROCESS_MB[provider] ?? UNKNOWN_PROVIDER_MB;

  // Remote (http/sse) servers cost the host nothing; only stdio ones fork.
  const stdioServers = Object.values(input.mcpServers ?? {}).filter(
    (s) => !s?.type || s.type === 'stdio',
  ).length;

  const sidecarMb = provider === 'native' ? 0 : MCP_SIDECAR_MB;
  return RUNNER_MB + sidecarMb + providerMb + stdioServers * EXTRA_MCP_SERVER_MB;
}

// Groups usually leave `provider` NULL and inherit the fleet default, and
// resolving it hits .env. Memoized like the budget below: changing it needs a
// service restart anyway.
let defaultProviderMemo: string | undefined;

/** Estimate for the agent group behind a session; charges the dearest config if unreadable. */
export function estimateAgentGroupMb(agentGroupId: string): number {
  try {
    const row = getContainerConfig(agentGroupId);
    if (!row) return estimateContainerMb({});
    defaultProviderMemo ??= defaultProvider();
    return estimateContainerMb({
      provider: row.provider ?? defaultProviderMemo,
      mcpServers: JSON.parse(row.mcp_servers) as Record<string, { type?: string }>,
    });
  } catch {
    // Unreadable config — charge the worst case rather than letting admission
    // treat this container as free.
    return estimateContainerMb({});
  }
}

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
 * Memory budget (MB) admission may spend across all agent containers, taken
 * from the memory available the first time it's needed (i.e. the first spawn).
 * 0 means "no budget enforcement" (memory unreadable — e.g. a non-Linux dev
 * host — so fail open). Computed once, memoized, and logged on that first
 * computation: the budget intentionally reflects early headroom, not live
 * memory.
 */
let budget: number | undefined;

export function memoryBudgetMb(): number {
  if (budget === undefined) {
    const avail = readAvailableMemMb();
    budget = avail ?? 0;
    log.info('Container admission budget set', {
      budgetMb: budget === 0 ? 'unlimited' : budget,
      worstCaseEstPerContainerMb: estimateContainerMb({}),
    });
  }
  return budget;
}

export interface RunningContainer {
  sessionId: string;
  /** True when the container has no in-flight work and is safe to evict. */
  idle: boolean;
  /** Heartbeat mtime (ms) for LRU ordering; 0 when no heartbeat yet. */
  lastActivityMs: number;
  /** Worst-case footprint charged against the budget. */
  estMb: number;
}

export type AdmissionDecision =
  | { action: 'admit' }
  | { action: 'evict'; sessionId: string }
  | { action: 'reject'; reason: string };

/**
 * Pure admission policy: admit while the candidate fits in the remaining
 * budget, else evict the LRU idle container to make room, else reject (defer).
 * A `budgetMb` of 0 means no enforcement — always admit.
 */
export function decideAdmission(args: {
  budgetMb: number;
  candidateMb: number;
  running: RunningContainer[];
}): AdmissionDecision {
  const { budgetMb, candidateMb, running } = args;
  if (budgetMb <= 0) return { action: 'admit' };

  const usedMb = running.reduce((sum, c) => sum + c.estMb, 0);
  if (usedMb + candidateMb <= budgetMb) return { action: 'admit' };

  // Nothing left to evict: run it anyway rather than deadlocking the host on a
  // single container that can't fit the budget on its own.
  if (running.length === 0) return { action: 'admit' };

  const victim = running.filter((c) => c.idle).sort((a, b) => a.lastActivityMs - b.lastActivityMs)[0];
  return victim
    ? { action: 'evict', sessionId: victim.sessionId }
    : {
        action: 'reject',
        reason: `needs ${candidateMb}MB, ${usedMb}MB in use of ${budgetMb}MB across ${running.length} container(s)`,
      };
}


// Don't evict a container that showed activity within this window — it's
// likely mid-turn or between rapid follow-ups, not genuinely idle.
const IDLE_EVICT_GRACE_MS = 15_000;

/**
 * Resolve the running-container snapshot `decideAdmission` needs. For each
 * running session (except `excludeSessionId`, the one being admitted) work out
 * what it costs and whether it's safely evictable — no active processing claim,
 * no due inbound messages, and quiet past the grace window. Any read failure is
 * treated as "not idle" so we never evict a container we can't confirm is safe
 * to kill.
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
    let estMb = estimateContainerMb({});
    const s = getSession(sessionId);
    if (s) {
      estMb = estimateAgentGroupMb(s.agent_group_id);
      try {
        lastActivityMs = getSessionSignalLastSeenAt(s.id);
        const quiet = lastActivityMs === 0 || now - lastActivityMs > IDLE_EVICT_GRACE_MS;
        idle = quiet && !hasInFlightWork(s.agent_group_id, s.id);
      } catch {
        idle = false;
      }
    }
    out.push({ sessionId, idle, lastActivityMs, estMb });
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
