/**
 * Container Runner v2
 * Spawns agent containers with session folder + agent group folder mounts.
 * The container runs the v2 agent-runner which polls the session DB.
 */
import { ChildProcess, execSync, spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

import { OneCLI } from '@onecli-sh/sdk';

import {
  CONTAINER_IMAGE,
  CONTAINER_IMAGE_BASE,
  CONTAINER_INSTALL_LABEL,
  DATA_DIR,
  GROUPS_DIR,
  ONECLI_API_KEY,
  ONECLI_URL,
  TIMEZONE,
} from './config.js';
import { materializeContainerJson } from './container-config.js';
import type { McpServerConfig } from './container-config.js';
import {
  decideAdmission,
  maxConcurrentContainers,
  snapshotRunning,
} from './container-admission.js';
import { getContainerConfig } from './db/container-configs.js';
import { updateContainerConfigScalars, updateContainerConfigJson } from './db/container-configs.js';
import { readEnvFile } from './env.js';
import {
  CONTAINER_RUNTIME_BIN,
  dumpContainerProcesses,
  hostGatewayArgs,
  isRootlessPodman,
  readonlyMountArgs,
  stopContainer,
} from './container-runtime.js';
import { EGRESS_NETWORK, egressNetworkArgs, ensureEgressNetwork } from './egress-lockdown.js';
import { composeGroupClaudeMd } from './claude-md-compose.js';
import { getAgentGroup } from './db/agent-groups.js';
import { getDb, hasTable } from './db/connection.js';
import { initGroupFilesystem } from './group-init.js';
import { stopTypingRefresh } from './modules/typing/index.js';
import { log } from './log.js';
import { validateAdditionalMounts } from './modules/mount-security/index.js';
import { ensureOneCliAgent } from './onecli-agent.js';
// Provider host-side config barrel — each provider that needs host-side
// container setup self-registers on import.
import './providers/index.js';
import {
  getProviderContainerConfig,
  providerProvidesAgentSurfaces,
  type ProviderContainerContribution,
  type VolumeMount,
} from './providers/provider-container-registry.js';
import {
  heartbeatPath,
  markContainerRunning,
  markContainerStopped,
  sessionDir,
  writeSessionRouting,
} from './session-manager.js';
import type { AgentGroup, Session } from './types.js';

const onecli = new OneCLI({ url: ONECLI_URL, apiKey: ONECLI_API_KEY });

/** Active containers tracked by session ID. */
const activeContainers = new Map<string, { process: ChildProcess; containerName: string; adopted?: boolean }>();

export interface McpProbeResult {
  ok: boolean;
  latencyMs: number;
  phase?: 'input' | 'container' | 'connect' | 'tools/list';
  error?: string;
  serverInfo?: { name: string; version: string };
  tools?: string[];
}

/**
 * In-flight wake promises, keyed by session id. Deduplicates concurrent
 * `wakeContainer` calls while the first spawn is still mid-setup (async
 * buildContainerArgs, OneCLI gateway apply, etc.) — otherwise a second
 * wake in that window passes the `activeContainers.has` check and spawns
 * a duplicate container against the same session directory, producing
 * racy double-replies.
 */
const wakePromises = new Map<string, Promise<boolean>>();

export function getActiveContainerCount(): number {
  return activeContainers.size;
}

export function isContainerRunning(sessionId: string): boolean {
  return activeContainers.has(sessionId);
}

/**
 * Wake up a container for a session. If already running or mid-spawn, no-op
 * (the in-flight wake promise is reused).
 *
 * The container runs the v2 agent-runner which polls the session DB.
 *
 * Contract: never throws. Returns `true` on successful spawn, `false` on
 * transient spawn failure (e.g. OneCLI gateway unreachable). Callers don't
 * need to wrap — the inbound row stays pending and host-sweep retries on
 * its next tick. Callers that care (e.g. the router's typing indicator)
 * can branch on the boolean.
 */
export function wakeContainer(session: Session): Promise<boolean> {
  if (activeContainers.has(session.id)) {
    log.debug('Container already running', { sessionId: session.id });
    return Promise.resolve(true);
  }
  const existing = wakePromises.get(session.id);
  if (existing) {
    log.debug('Container wake already in-flight — joining existing promise', { sessionId: session.id });
    return existing;
  }
  const promise = admitThenSpawn(session)
    .catch((err) => {
      log.warn('wakeContainer failed — host-sweep will retry', { sessionId: session.id, err });
      return false;
    })
    .finally(() => {
      wakePromises.delete(session.id);
    });
  wakePromises.set(session.id, promise);
  return promise;
}

// Bound on eviction rounds per spawn attempt, so a pathological state can't
// evict the whole fleet to admit one container.
const MAX_EVICT_ROUNDS = 4;

/**
 * Admission gate in front of `spawnContainer`. Caps concurrent containers at
 * the memory-derived limit (see container-admission.ts): evicts an idle
 * container to make room when possible, or defers the spawn (returns false) —
 * the inbound message stays pending and host-sweep re-wakes it on its next
 * tick. A cap of 0 (memory unreadable) means always spawn.
 */
async function admitThenSpawn(session: Session): Promise<boolean> {
  const cap = maxConcurrentContainers();
  if (cap > 0) {
    for (let round = 0; round <= MAX_EVICT_ROUNDS; round++) {
      const decision = decideAdmission({
        maxContainers: cap,
        running: snapshotRunning(activeContainers.keys(), session.id),
      });
      if (decision.action === 'admit') break;
      if (decision.action === 'evict') {
        log.info('Admission evicting idle container to free a slot', {
          evicting: decision.sessionId,
          forSession: session.id,
        });
        await evictContainer(decision.sessionId);
        continue;
      }
      log.info('Admission deferring spawn — host-sweep will retry', {
        sessionId: session.id,
        reason: decision.reason,
      });
      return false;
    }
  }
  await spawnContainer(session);
  return true;
}

/** Kill a container and resolve once it has actually exited (bounded wait). */
function evictContainer(sessionId: string): Promise<void> {
  return new Promise((resolve) => {
    if (!activeContainers.has(sessionId)) {
      resolve();
      return;
    }
    let done = false;
    const finish = (): void => {
      if (!done) {
        done = true;
        resolve();
      }
    };
    killContainer(sessionId, 'admission-evict', finish);
    // Safety net in case the exit signal never arrives.
    setTimeout(finish, 8000);
  });
}

async function spawnContainer(session: Session): Promise<void> {
  const agentGroup = getAgentGroup(session.agent_group_id);
  if (!agentGroup) {
    log.error('Agent group not found', { agentGroupId: session.agent_group_id });
    return;
  }

  // Refresh the destination map and default reply routing so any admin
  // changes take effect on wake. Destinations come from the agent-to-agent
  // module — skip when the module isn't installed (table absent).
  if (hasTable(getDb(), 'agent_destinations')) {
    const { writeDestinations } = await import('./modules/agent-to-agent/write-destinations.js');
    writeDestinations(agentGroup.id, session.id);
  }
  writeSessionRouting(agentGroup.id, session.id);

  // Materialize container.json from DB — writes fresh file and returns
  // the config object, threaded through provider resolution, buildMounts,
  // and buildContainerArgs so we don't re-read.
  const containerConfig = materializeContainerJson(agentGroup.id);

  // Per-group filesystem state lives forever after first creation. Init is
  // idempotent: it only writes paths that don't already exist, so this call
  // is a no-op for groups that have spawned before. Runs before the provider
  // contribution so a surfaces-providing provider finds the group dir ready.
  const providerName = resolveProviderName(session.agent_provider, containerConfig.provider);
  initGroupFilesystem(agentGroup, { provider: providerName });

  // Resolve the effective provider + any host-side contribution it declares
  // (extra mounts, env passthrough). Computed once and threaded through both
  // buildMounts and buildContainerArgs so side effects (mkdir, etc.) fire once.
  const { provider, contribution } = resolveProviderContribution(session, agentGroup, containerConfig);

  const mounts = buildMounts(agentGroup, session, containerConfig, provider, contribution);
  // Docker/podman container names allow only [a-zA-Z0-9_.-]. Folder names
  // can include characters that are legal on disk but not in container
  // names — notably `@` for email-alias bots (groups/leet@bot.example.com/).
  // Sanitize for the container-name slot only; mount paths use the raw
  // folder (those tolerate `@`).
  const folderSlug = agentGroup.folder.replace(/@/g, '_at_').replace(/[^a-zA-Z0-9_.-]/g, '-');
  const containerName = `nanoclaw-v2-${folderSlug}-${Date.now()}`;
  // OneCLI agent identifier is always the agent group id — stable across
  // sessions and reversible via getAgentGroup() for approval routing.
  const agentIdentifier = agentGroup.id;
  const args = await buildContainerArgs(
    mounts,
    containerName,
    agentGroup,
    containerConfig,
    provider,
    contribution,
    agentIdentifier,
    session.id,
  );

  log.info('Spawning container', { sessionId: session.id, agentGroup: agentGroup.name, containerName });

  // Clear any orphan heartbeat from a previous container instance — the
  // sweep's ceiling check treats a missing file as "fresh spawn, give grace"
  // (host-sweep.ts line 87). Without this, the stale mtime can trigger an
  // immediate kill before the new container touches the file itself.
  fs.rmSync(heartbeatPath(agentGroup.id, session.id), { force: true });

  // Detached mode (`-d` in buildContainerArgs). `docker run -d` exits as
  // soon as the container is created with the container ID on stdout, or
  // non-zero with create/pull errors on stderr. The actual lifecycle is
  // tracked by a separate `docker wait` watcher (see attachWatcher) so the
  // container has no foreground console attachment to break when the host
  // restarts — that broken-console death is exactly what made adopted
  // containers die ~10s after a graceful host restart (conmon: "Failed to
  // write to remote console socket").
  const runProc = spawn(CONTAINER_RUNTIME_BIN, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let runStderr = '';
  runProc.stderr?.on('data', (data) => {
    runStderr += data.toString();
  });
  runProc.stdout?.on('data', () => {
    /* container ID; not needed — we know the name */
  });

  const runCode: number | null = await new Promise((resolve) => {
    runProc.once('close', (code) => resolve(code));
    runProc.once('error', (err) => {
      log.error('docker run spawn error', { sessionId: session.id, err });
      resolve(-1);
    });
  });

  if (runCode !== 0) {
    const tail = runStderr.trim().split('\n').slice(-20).join('\n');
    log.warn('Container failed to start (docker run exited non-zero)', {
      sessionId: session.id,
      containerName,
      code: runCode,
      stderr: tail,
    });
    // Make sure no stale row says we're running.
    markContainerStopped(session.id);
    stopTypingRefresh(session.id);
    return;
  }

  // Now the container is running detached. Attach the lifecycle watcher;
  // the close handler registered here is the single source of cleanup.
  attachContainerWatcher(session.id, containerName);
}

const MCP_PROBE_OUTPUT_LIMIT = 64 * 1024;
const MCP_PROBE_HOST_TIMEOUT_MS = 45_000;
const MAX_CONCURRENT_MCP_PROBES = 2;
const activeMcpProbeGroups = new Set<string>();

/** Run an MCP initialize + tools/list check in a disposable group container. */
export async function runMcpProbeContainer(
  agentGroupId: string,
  serverConfig: McpServerConfig,
): Promise<McpProbeResult> {
  const agentGroup = getAgentGroup(agentGroupId);
  if (!agentGroup) throw new Error('Agent group not found');
  if (activeMcpProbeGroups.has(agentGroupId)) {
    return { ok: false, latencyMs: 0, phase: 'container', error: 'An MCP probe is already running for this group' };
  }
  if (activeMcpProbeGroups.size >= MAX_CONCURRENT_MCP_PROBES) {
    return { ok: false, latencyMs: 0, phase: 'container', error: 'Too many MCP probes are already running' };
  }
  activeMcpProbeGroups.add(agentGroupId);

  const probeId = `mcp-probe-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const probeSession: Session = {
    id: probeId,
    agent_group_id: agentGroup.id,
    messaging_group_id: null,
    thread_id: null,
    agent_provider: null,
    status: 'active',
    container_status: 'stopped',
    last_active: null,
    created_at: new Date().toISOString(),
  };
  const probeDir = sessionDir(agentGroup.id, probeId);
  fs.mkdirSync(probeDir, { recursive: true });

  let containerName: string | undefined;
  try {
    const containerConfig = materializeContainerJson(agentGroup.id);
    const providerName = resolveProviderName(null, containerConfig.provider, resolveEnv('DEFAULT_PROVIDER'));
    initGroupFilesystem(agentGroup, { provider: providerName });
    const { provider, contribution } = resolveProviderContribution(probeSession, agentGroup, containerConfig);
    const mounts = buildMounts(agentGroup, probeSession, containerConfig, provider, contribution);
    const folderSlug = agentGroup.folder.replace(/@/g, '_at_').replace(/[^a-zA-Z0-9_.-]/g, '-').slice(0, 48);
    containerName = `nanoclaw-mcp-probe-${folderSlug}-${Date.now()}`;
    const args = await buildContainerArgs(
      mounts,
      containerName,
      agentGroup,
      containerConfig,
      provider,
      contribution,
      agentGroup.id,
      probeId,
      'mcp-probe',
    );
    return await executeMcpProbe(containerName, args, serverConfig);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.warn('MCP probe container failed', { agentGroupId, err: message });
    return {
      ok: false,
      latencyMs: 0,
      phase: 'container',
      error: message.replace(/[\r\n]+/g, ' ').slice(0, 1_000) || 'Failed to start probe container',
    };
  } finally {
    activeMcpProbeGroups.delete(agentGroupId);
    if (containerName) {
      try {
        stopContainer(containerName);
      } catch {
        /* the --rm probe normally removed itself */
      }
    }
    fs.rmSync(probeDir, { recursive: true, force: true });
  }
}

async function executeMcpProbe(
  containerName: string,
  args: string[],
  serverConfig: McpServerConfig,
): Promise<McpProbeResult> {
  const proc = spawn(CONTAINER_RUNTIME_BIN, args, { stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '';
  let outputExceeded = false;
  let timedOut = false;

  proc.stdout?.on('data', (chunk) => {
    if (stdout.length < MCP_PROBE_OUTPUT_LIMIT) stdout += chunk.toString();
    else outputExceeded = true;
  });
  proc.stderr?.on('data', () => {});
  proc.stdin?.end(JSON.stringify(serverConfig));

  const timer = setTimeout(() => {
    timedOut = true;
    try {
      stopContainer(containerName);
    } catch {
      /* process close below reports the timeout */
    }
  }, MCP_PROBE_HOST_TIMEOUT_MS);

  const spawnError = await new Promise<Error | null>((resolve) => {
    proc.once('close', () => resolve(null));
    proc.once('error', (error) => resolve(error));
  });
  clearTimeout(timer);

  if (timedOut) {
    return { ok: false, latencyMs: MCP_PROBE_HOST_TIMEOUT_MS, phase: 'container', error: 'Probe container timed out' };
  }
  if (spawnError) {
    return { ok: false, latencyMs: 0, phase: 'container', error: spawnError.message };
  }
  if (outputExceeded) {
    return { ok: false, latencyMs: 0, phase: 'container', error: 'Probe output exceeded its limit' };
  }

  const line = stdout.trim().split('\n').filter(Boolean).at(-1);
  if (line) {
    try {
      return JSON.parse(line) as McpProbeResult;
    } catch {
      /* report the bounded runtime diagnostics below */
    }
  }
  return {
    ok: false,
    latencyMs: 0,
    phase: 'container',
    error: 'Probe container did not return a valid result',
  };
}

/**
 * Attach a `docker wait <name>` watcher to a running container and register
 * it in `activeContainers`. The watcher's `close` event fires when the
 * container exits — the one place that drives markContainerStopped, the
 * activeContainers delete, and typing-refresh shutdown. Used by both the
 * fresh-spawn path (after `docker run -d` succeeds) and adoption.
 *
 * No host-side idle timeout. Stale/stuck detection is driven by the host
 * sweep reading heartbeat mtime + processing_ack claim age + container_state
 * (see src/host-sweep.ts). This avoids killing long-running legitimate work
 * on a wall-clock timer.
 */
function attachContainerWatcher(sessionId: string, containerName: string): void {
  const watcher = spawn(CONTAINER_RUNTIME_BIN, ['wait', containerName], { stdio: 'ignore' });
  activeContainers.set(sessionId, { process: watcher, containerName });
  markContainerRunning(sessionId);

  watcher.on('close', (code) => {
    activeContainers.delete(sessionId);
    markContainerStopped(sessionId);
    stopTypingRefresh(sessionId);
    log.info('Container exited', { sessionId, code, containerName });
  });

  watcher.on('error', (err) => {
    activeContainers.delete(sessionId);
    markContainerStopped(sessionId);
    stopTypingRefresh(sessionId);
    log.error('Container watcher error', { sessionId, containerName, err });
  });
}

/** Kill a container for a session. */
export function killContainer(sessionId: string, reason: string, onExit?: () => void): void {
  const entry = activeContainers.get(sessionId);
  if (!entry) return;

  if (onExit) {
    // entry.process is the `docker wait` watcher — its close fires when the
    // container exits, which is exactly the signal onExit cares about.
    entry.process.once('close', onExit);
  }

  log.info('Killing container', { sessionId, reason, containerName: entry.containerName });

  // Forensic snapshot before kill — the container runs with --rm so its
  // filesystem and per-container log entries cease to be queryable once it's
  // gone. Limited to silent-stuck reasons so normal shutdowns stay quiet.
  if (reason === 'absolute-ceiling' || reason === 'claim-stuck') {
    const procs = dumpContainerProcesses(entry.containerName);
    if (procs) {
      log.warn('Container process snapshot before kill', {
        sessionId,
        containerName: entry.containerName,
        reason,
        processes: procs,
      });
    }
  }

  try {
    stopContainer(entry.containerName);
  } catch {
    // `docker stop` failed (container already gone, daemon error, etc.).
    // Killing the watcher subprocess does nothing to the container, so
    // escalate with `docker kill <name>`.
    try {
      execSync(`${CONTAINER_RUNTIME_BIN} kill ${entry.containerName}`, { stdio: 'pipe' });
    } catch (err) {
      log.warn('docker kill fallback failed', {
        sessionId,
        containerName: entry.containerName,
        err,
      });
    }
  }
}

/**
 * Re-attach to containers that survived a host restart.
 *
 * For each `{ name, sessionId }` returned by `cleanupOrphans`, spawn a
 * `docker wait <name>` watcher and register it in `activeContainers`.
 * The watcher exits when the container exits, so the existing close
 * lifecycle (markContainerStopped + map cleanup + typing refresh stop)
 * fires identically to a freshly-spawned container.
 *
 * Without this, `isContainerRunning(sessionId)` would return false after
 * host restart (the map is empty), host-sweep would think no container is
 * running, and `wakeContainer` would spawn a SECOND container against the
 * same session DB — two writers on outbound.db, racy double-replies.
 */
export function adoptRunningContainers(adopt: Array<{ name: string; sessionId: string }>): void {
  for (const { name, sessionId } of adopt) {
    if (activeContainers.has(sessionId)) {
      // Should not happen on startup (map is empty), but be safe.
      log.warn('Skipping adoption — session already has an active container', {
        sessionId,
        containerName: name,
      });
      continue;
    }
    log.info('Adopting running container', { sessionId, containerName: name });
    attachContainerWatcher(sessionId, name);
  }
}

/**
 * Resolve the provider name for a session:
 *
 *   sessions.agent_provider
 *     → container_configs.provider
 *     → DEFAULT_PROVIDER (env)
 *     → 'claude'
 *
 * Pure so the precedence can be unit-tested without a DB or filesystem.
 * Callers in the runtime path pass `readDefaultProvider()` for the env
 * default; tests can pass any value.
 */
export function resolveProviderName(
  sessionProvider: string | null | undefined,
  containerConfigProvider: string | null | undefined,
  envDefaultProvider: string | null | undefined = null,
): string {
  return (sessionProvider || containerConfigProvider || envDefaultProvider || 'claude').toLowerCase();
}

function resolveProviderContribution(
  session: Session,
  agentGroup: AgentGroup,
  containerConfig: import('./container-config.js').ContainerConfig,
): { provider: string; contribution: ProviderContainerContribution } {
  const provider = resolveProviderName(
    session.agent_provider,
    containerConfig.provider,
    resolveEnv('DEFAULT_PROVIDER'),
  );
  const fn = getProviderContainerConfig(provider);
  const contribution = fn
    ? fn({
        sessionDir: sessionDir(agentGroup.id, session.id),
        agentGroupId: agentGroup.id,
        groupDir: path.resolve(GROUPS_DIR, agentGroup.folder),
        selectedSkills: selectedSkillNames(containerConfig),
        hostEnv: process.env,
        containerConfig,
      })
    : {};
  return { provider, contribution };
}

export function buildMounts(
  agentGroup: AgentGroup,
  session: Session,
  containerConfig: import('./container-config.js').ContainerConfig,
  provider: string,
  providerContribution: ProviderContainerContribution,
): VolumeMount[] {
  const projectRoot = process.cwd();

  // Default agent surfaces (composed project doc, skill links, provider state
  // dir) apply unless the provider's registration declares it provides its
  // own — a capability, never a provider name. See provider-container-registry.
  const defaultSurfaces = !providerProvidesAgentSurfaces(provider);

  const claudeDir = path.join(DATA_DIR, 'v2-sessions', agentGroup.id, '.claude-shared');
  if (defaultSurfaces) {
    // Sync skill symlinks based on container.json selection before mounting.
    syncSkillSymlinks(claudeDir, containerConfig);

    // Compose CLAUDE.md fresh every spawn from the shared base, enabled skill
    // fragments, and MCP server instructions. See `claude-md-compose.ts`.
    composeGroupClaudeMd(agentGroup);
  }

  const mounts: VolumeMount[] = [];
  const sessDir = sessionDir(agentGroup.id, session.id);
  const groupDir = path.resolve(GROUPS_DIR, agentGroup.folder);

  // Session folder at /workspace (contains inbound.db, outbound.db, outbox/, .claude/)
  mounts.push({ hostPath: sessDir, containerPath: '/workspace', readonly: false });

  // Agent group folder at /workspace/agent (RW for working files + CLAUDE.local.md)
  mounts.push({ hostPath: groupDir, containerPath: '/workspace/agent', readonly: false });

  // container.json — nested RO mount on top of RW group dir so the agent
  // can read its config but cannot modify it.
  const containerJsonPath = path.join(groupDir, 'container.json');
  if (fs.existsSync(containerJsonPath)) {
    mounts.push({ hostPath: containerJsonPath, containerPath: '/workspace/agent/container.json', readonly: true });
  }

  // Composer-managed CLAUDE.md artifacts — nested RO mounts. These are
  // regenerated from the shared base + fragments on every spawn; any
  // agent-side writes would be clobbered, so enforce read-only. Only
  // CLAUDE.local.md (per-group memory) remains RW via the group-dir mount.
  // `.claude-shared.md` is a symlink whose target (`/app/CLAUDE.md`) is
  // already RO-mounted, so writes through it fail regardless — no need for
  // a nested mount there.
  const composedClaudeMd = path.join(groupDir, 'CLAUDE.md');
  if (defaultSurfaces && fs.existsSync(composedClaudeMd)) {
    mounts.push({ hostPath: composedClaudeMd, containerPath: '/workspace/agent/CLAUDE.md', readonly: true });
  }
  const fragmentsDir = path.join(groupDir, '.claude-fragments');
  if (defaultSurfaces && fs.existsSync(fragmentsDir)) {
    mounts.push({ hostPath: fragmentsDir, containerPath: '/workspace/agent/.claude-fragments', readonly: true });
  }

  // Global memory directory — always read-only.
  const globalDir = path.join(GROUPS_DIR, 'global');
  if (fs.existsSync(globalDir)) {
    mounts.push({ hostPath: globalDir, containerPath: '/workspace/global', readonly: true });
  }

  // Shared CLAUDE.md — read-only, imported by the composed entry point via
  // the `.claude-shared.md` symlink inside the group dir.
  const sharedClaudeMd = path.join(process.cwd(), 'container', 'CLAUDE.md');
  if (defaultSurfaces && fs.existsSync(sharedClaudeMd)) {
    mounts.push({ hostPath: sharedClaudeMd, containerPath: '/app/CLAUDE.md', readonly: true });
  }

  // Per-group .claude-shared at /home/node/.claude (Claude state, settings,
  // skill symlinks)
  if (defaultSurfaces) {
    mounts.push({ hostPath: claudeDir, containerPath: '/home/node/.claude', readonly: false });
  }

  // Shared agent-runner source — read-only, same code for all groups.
  const agentRunnerSrc = path.join(projectRoot, 'container', 'agent-runner', 'src');
  mounts.push({ hostPath: agentRunnerSrc, containerPath: '/app/src', readonly: true });

  // Shared skills — read-only, symlinks in .claude-shared/skills/ point here.
  const skillsSrc = path.join(projectRoot, 'container', 'skills');
  if (fs.existsSync(skillsSrc)) {
    mounts.push({ hostPath: skillsSrc, containerPath: '/app/skills', readonly: true });
  }

  // Additional mounts from container config
  if (containerConfig.additionalMounts && containerConfig.additionalMounts.length > 0) {
    const validated = validateAdditionalMounts(containerConfig.additionalMounts, agentGroup.name);
    mounts.push(...validated);
  }

  // Provider-contributed mounts (e.g. opencode-xdg)
  if (providerContribution.mounts) {
    mounts.push(...providerContribution.mounts);
  }

  return mounts;
}

function readRequiredEnv(skillMdPath: string): string | null {
  let text: string;
  try {
    text = fs.readFileSync(skillMdPath, 'utf8');
  } catch {
    return null;
  }
  if (!text.startsWith('---')) return null;
  const end = text.indexOf('\n---', 3);
  if (end === -1) return null;
  const fm = text.slice(3, end);
  const m = fm.match(/^requires_env:\s*([A-Za-z_][A-Za-z0-9_]*)\s*$/m);
  return m ? m[1] : null;
}

function isTruthyEnv(v: string | undefined): boolean {
  if (!v) return false;
  return ['1', 'true', 'yes', 'on'].includes(v.trim().toLowerCase());
}

// Resolve an env var via process.env first, then the .env file (which the
// systemd unit doesn't load). Mirrors what isUiEnabled() etc. do.
function resolveEnv(name: string): string | undefined {
  if (process.env[name] !== undefined) return process.env[name];
  const file = readEnvFile([name]);
  return file[name];
}

/**
 * Sync skills in .claude-shared/skills/ to match the container.json selection.
 *
 * By default each entry is a symlink to a container path (/app/skills/<name>),
 * dangling on the host but valid inside the container. fx's skill discovery
 * refuses to follow symlinked candidates — it reports every one as "SKILL.md is
 * unreadable or not a regular file" and loads no skills at all — so for fx we
 * copy the real directories out of container/skills/ instead. The copy is
 * refreshed on every spawn so upstream skill edits still propagate.
 */
function syncSkillSymlinks(claudeDir: string, containerConfig: import('./container-config.js').ContainerConfig): void {
  const skillsDir = path.join(claudeDir, 'skills');
  if (!fs.existsSync(skillsDir)) {
    fs.mkdirSync(skillsDir, { recursive: true });
  }

  // Determine desired skill set (recomputes from the shared dir for 'all'),
  // then skip skills whose `requires_env: FOO` frontmatter names an env var
  // that isn't truthy, so the agent doesn't surface commands the host won't
  // honor.
  const sharedSkillsDir = path.join(process.cwd(), 'container', 'skills');
  const desired = selectedSkillNames(containerConfig).filter((s) => {
    const required = readRequiredEnv(path.join(sharedSkillsDir, s, 'SKILL.md'));
    if (!required) return true;
    return isTruthyEnv(resolveEnv(required));
  });
  const desiredSet = new Set(desired);
  const materialize = containerConfig.provider === 'fx';

  // Remove entries not in the desired set. Under fx also drop symlinks, so a
  // provider switch converts them to copies.
  for (const entry of fs.readdirSync(skillsDir)) {
    const entryPath = path.join(skillsDir, entry);
    let isSymlink = false;
    try {
      isSymlink = fs.lstatSync(entryPath).isSymbolicLink();
    } catch {
      continue;
    }
    // This dir is the agent's ~/.claude/skills, so a real directory here may be
    // a user-installed skill. Only touch what this function created: symlinks,
    // and (under fx) copies that shadow a container/skills entry.
    const ours = isSymlink || (materialize && fs.existsSync(path.join(sharedSkillsDir, entry)));
    if (!ours) continue;
    if (!desiredSet.has(entry) || (materialize && isSymlink)) {
      fs.rmSync(entryPath, { recursive: true, force: true });
    }
  }

  // Create desired skills: real copies for fx, container-path symlinks otherwise.
  for (const skill of desired) {
    const linkPath = path.join(skillsDir, skill);
    const source = path.join(sharedSkillsDir, skill);
    if (materialize && fs.existsSync(source)) {
      // Refresh unconditionally — skills are small text files and this keeps
      // the copy from drifting behind container/skills/. `dereference` matters:
      // a skill dir may itself be a symlink into a checkout outside the repo,
      // and copying it as a symlink would reproduce a host path the container
      // cannot resolve.
      fs.rmSync(linkPath, { recursive: true, force: true });
      fs.cpSync(source, linkPath, { recursive: true, dereference: true });
      continue;
    }
    let exists = false;
    try {
      fs.lstatSync(linkPath);
      exists = true;
    } catch {
      /* missing */
    }
    if (!exists) {
      fs.symlinkSync(`/app/skills/${skill}`, linkPath);
    }
  }
}

/**
 * Resolve the group's skill selection to concrete names — `'all'` recomputes
 * from `container/skills/` so newly-added upstream skills appear automatically.
 */
function selectedSkillNames(containerConfig: import('./container-config.js').ContainerConfig): string[] {
  if (containerConfig.skills !== 'all') return containerConfig.skills;
  const sharedSkillsDir = path.join(process.cwd(), 'container', 'skills');
  return fs.existsSync(sharedSkillsDir)
    ? fs.readdirSync(sharedSkillsDir).filter((e) => {
        try {
          return fs.statSync(path.join(sharedSkillsDir, e)).isDirectory();
        } catch {
          return false;
        }
      })
    : [];
}

async function buildContainerArgs(
  mounts: VolumeMount[],
  containerName: string,
  agentGroup: AgentGroup,
  containerConfig: import('./container-config.js').ContainerConfig,
  _provider: string,
  providerContribution: ProviderContainerContribution,
  agentIdentifier: string | undefined,
  sessionId: string,
  launchMode: 'agent' | 'mcp-probe' = 'agent',
): Promise<string[]> {
  // Agent containers use -d: no foreground console is attached to the host,
  // so they survive host restarts and can be adopted. MCP probes use -i so
  // one config arrives on stdin and one result returns before --rm cleanup.
  //
  // Session/agent-group labels let `adoptRunningContainers` (called at host
  // startup) match each running container back to its session in the DB.
  // Without these labels, a graceful host restart can't tell which surviving
  // container belongs to which session and would either kill them all
  // (losing in-flight turn state) or risk spawning duplicates.
  const args: string[] = [
    'run',
    launchMode === 'agent' ? '-d' : '-i',
    '--rm',
    '--name',
    containerName,
    '--label',
    CONTAINER_INSTALL_LABEL,
    '--label',
    launchMode === 'agent' ? `nanoclaw-session=${sessionId}` : 'nanoclaw-mcp-probe=true',
    '--label',
    `nanoclaw-agent-group=${agentGroup.id}`,
  ];

  // Rootless Podman: UID 0 inside the container maps to the host user
  // (e.g. denis/1000). The Dockerfile sets USER node (UID 1000) which would
  // map to an unmapped high UID and can't write to bind mounts. Override to
  // root so the in-container process effectively runs as the host user.
  // NOTE: --userns=keep-id is NOT used — it triggers storage-chown-by-maps
  // which hangs or takes minutes on large images in nested container envs.
  if (isRootlessPodman()) {
    args.push('--user=0:0');
    // Forcing UID 0 bypasses the Dockerfile's USER node, so HOME defaults to
    // /root instead of /home/node where .claude is mounted. Pin it explicitly.
    args.push('-e', 'HOME=/home/node');
  }

  // Environment — only vars read by code we don't own.
  // Everything NanoClaw-specific is in container.json (read by runner at startup).
  args.push('-e', `TZ=${TIMEZONE}`);

  // MCP timeouts. Read by Claude Code (MCP_TIMEOUT, MCP_TOOL_TIMEOUT) and by
  // our opencode mapper (MCP_TOOL_TIMEOUT → mcp[name].timeout). Pulled from
  // process.env then .env (the systemd unit doesn't load .env). Forwarded so
  // a single host-side knob configures both providers.
  for (const key of ['MCP_TIMEOUT', 'MCP_TOOL_TIMEOUT'] as const) {
    const value = resolveEnv(key);
    if (value) args.push('-e', `${key}=${value}`);
  }

  // KSM page-merge opt-in toggle. The runner enables it by default; forward
  // an explicit host-side value (e.g. KSM_MERGE=0) so it can be disabled.
  {
    const ksm = resolveEnv('KSM_MERGE');
    if (ksm) args.push('-e', `KSM_MERGE=${ksm}`);
  }

  // Provider-contributed env vars (e.g. XDG_DATA_HOME, OPENCODE_*, NO_PROXY).
  if (providerContribution.env) {
    for (const [key, value] of Object.entries(providerContribution.env)) {
      args.push('-e', `${key}=${value}`);
    }
  }

  // Egress lockdown when enabled — throws if it can't be established, aborting
  // the spawn rather than running with open egress. Otherwise the host gateway.
  if (ensureEgressNetwork()) {
    args.push(...egressNetworkArgs());
    log.info('Egress lockdown active', { containerName, network: EGRESS_NETWORK });
  } else {
    args.push(...hostGatewayArgs());
  }

  // User mapping
  const hostUid = process.getuid?.();
  const hostGid = process.getgid?.();
  if (hostUid != null && hostUid !== 0 && hostUid !== 1000) {
    args.push('--user', `${hostUid}:${hostGid}`);
    args.push('-e', 'HOME=/home/node');
  }

  // Volume mounts
  for (const mount of mounts) {
    if (mount.readonly) {
      args.push(...readonlyMountArgs(mount.hostPath, mount.containerPath));
    } else {
      args.push('-v', `${mount.hostPath}:${mount.containerPath}`);
    }
  }

  // OneCLI gateway — injects HTTPS_PROXY + certs so container API calls
  // are routed through the agent vault for credential injection, and mounts
  // any credential stubs the gateway serves (e.g. a sentinel auth file).
  // Runs AFTER the volume mounts so a stub nested inside one of our mounts
  // (a parent dir mounted RW above it) lands later in the args and isn't
  // shadowed by it. Treated as a transient hard failure: if we can't wire
  // the gateway, we don't spawn. The caller (router or host-sweep) catches
  // the throw, leaves the inbound message pending, and the next sweep tick
  // retries.
  if (agentIdentifier) {
    await ensureOneCliAgent(onecli, agentGroup.name, agentIdentifier);
  }
  const onecliApplied = await onecli.applyContainerConfig(args, { addHostMapping: false, agent: agentIdentifier });
  if (!onecliApplied) {
    throw new Error('OneCLI gateway not applied — refusing to spawn container without credentials');
  }
  // The SDK sets SSL_CERT_FILE (OpenSSL/Node) but git/curl read their CA
  // bundle from CURL_CA_BUNDLE / GIT_SSL_CAINFO. Without these, `git clone`
  // through the OneCLI HTTPS proxy fails with "server certificate verification failed".
  args.push('-e', 'CURL_CA_BUNDLE=/tmp/onecli-combined-ca.pem');
  args.push('-e', 'GIT_SSL_CAINFO=/tmp/onecli-combined-ca.pem');
  log.info('OneCLI gateway applied', { containerName });

  // Override entrypoint: run v2 entry point directly via Bun (no tsc, no stdin).
  args.push('--entrypoint', 'bash');

  // Use per-agent-group image if one has been built, otherwise base image
  const imageTag = containerConfig.imageTag || CONTAINER_IMAGE;
  args.push(imageTag);

  args.push('-c', launchMode === 'agent'
    ? 'exec bun run /app/src/index.ts'
    : 'exec bun run /app/src/mcp-probe.ts');

  return args;
}

/** Build a per-agent-group Docker image with custom packages. */
/** Package specs reach here from `ncl` and self-mod, and a version constraint
 * like `mcp<2` is a shell redirect unless quoted. */
function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

export function packageDockerfile(
  from: string,
  packages: { apt: string[]; npm: string[]; pip: string[] },
): string {
  let dockerfile = `FROM ${from}\nUSER root\n`;
  if (packages.apt.length > 0) {
    const specs = packages.apt.map(shellQuote).join(' ');
    dockerfile += `RUN apt-get update && apt-get install -y ${specs} && rm -rf /var/lib/apt/lists/*\n`;
  }
  if (packages.pip.length > 0) {
    // Install into the shared venv at /opt/agent-venv (set up in the base image)
    // so console scripts land on PATH and we avoid PEP 668 system-install errors.
    dockerfile += `RUN /opt/agent-venv/bin/pip install --no-cache-dir ${packages.pip.map(shellQuote).join(' ')}\n`;
  }
  if (packages.npm.length > 0) {
    // pnpm skips build scripts unless packages are allowlisted. Append each
    // to /root/.npmrc (base image sets it up for agent-browser) so packages
    // with postinstall — e.g. playwright, puppeteer, native addons — don't
    // install silently broken.
    const allowlist = packages.npm
      .map((p) => `echo ${shellQuote(`only-built-dependencies[]=${p}`)} >> /root/.npmrc`)
      .join(' && ');
    dockerfile += `RUN ${allowlist} && pnpm install -g ${packages.npm.map(shellQuote).join(' ')}\n`;
  }
  return dockerfile + 'USER node\n';
}

export async function buildAgentGroupImage(agentGroupId: string): Promise<void> {
  const agentGroup = getAgentGroup(agentGroupId);
  if (!agentGroup) throw new Error('Agent group not found');

  const configRow = getContainerConfig(agentGroup.id);
  if (!configRow) throw new Error('Container config not found');
  const aptPackages = JSON.parse(configRow.packages_apt) as string[];
  const npmPackages = JSON.parse(configRow.packages_npm) as string[];
  const pipPackages = JSON.parse(configRow.packages_pip) as string[];
  if (aptPackages.length === 0 && npmPackages.length === 0 && pipPackages.length === 0) {
    throw new Error('No packages to install. Use install_packages first.');
  }

  const dockerfile = packageDockerfile(CONTAINER_IMAGE, {
    apt: aptPackages,
    npm: npmPackages,
    pip: pipPackages,
  });

  const imageTag = `${CONTAINER_IMAGE_BASE}:${agentGroupId}`;

  log.info('Building per-agent-group image', {
    agentGroupId,
    imageTag,
    apt: aptPackages,
    npm: npmPackages,
    pip: pipPackages,
  });

  // Write Dockerfile to temp file and build
  const tmpDockerfile = path.join(DATA_DIR, `Dockerfile.${agentGroupId}`);
  fs.writeFileSync(tmpDockerfile, dockerfile);
  try {
    execSync(`${CONTAINER_RUNTIME_BIN} build -t ${imageTag} -f ${tmpDockerfile} .`, {
      cwd: DATA_DIR,
      stdio: 'pipe',
      timeout: 900_000,
    });
  } finally {
    fs.unlinkSync(tmpDockerfile);
  }

  // Store the image tag in the DB
  updateContainerConfigScalars(agentGroup.id, { image_tag: imageTag });

  log.info('Per-agent-group image built', { agentGroupId, imageTag });
}
