/**
 * Agent Vault egress (credential gateway spike).
 *
 * Groups listed in NANOCLAW_AGENT_VAULT_GROUPS get their egress from the
 * headless Agent Vault fork instead of OneCLI. Each container gets its own
 * gateway socket session: the gateway binds `egress.sock` in a fresh
 * directory under AGENT_VAULT_SOCKET_ROOT, NanoClaw mounts that directory, and
 * the in-container relay forwards 127.0.0.1:3128 to it. The socket itself is
 * the identity, so no gateway credential enters the container.
 *
 * Contract: docs/credential-gateway-spike.md.
 */
import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';

import { log } from './log.js';
import {
  AgentVaultError,
  agentVaultGroups,
  gatewayFailure,
  gatewayFetch,
  gatewaySettings,
  type GatewaySettings,
} from './modules/credentials/agent-vault-client.js';

export { agentVaultGroups, usesAgentVault } from './modules/credentials/agent-vault-client.js';

const SYSTEM_CA_BUNDLE = '/etc/ssl/certs/ca-certificates.crt';
// sun_path is 108 bytes including the terminating NUL.
const MAX_SOCKET_PATH = 107;

export const EGRESS_RELAY_PORT = 3128;
export const CONTAINER_EGRESS_DIR = '/run/nanoclaw/egress';
export const CONTAINER_CA_BUNDLE = '/run/nanoclaw/agent-vault-ca.pem';
const CONTAINER_EGRESS_SOCKET = `${CONTAINER_EGRESS_DIR}/egress.sock`;

const CA_ENV_VARS = [
  'SSL_CERT_FILE',
  'NODE_EXTRA_CA_CERTS',
  'REQUESTS_CA_BUNDLE',
  'CURL_CA_BUNDLE',
  'GIT_SSL_CAINFO',
  'DENO_CERT',
] as const;

/** Env keys this module sets; provider contributions must not override them. */
export function agentVaultEnvKeys(): Set<string> {
  return new Set(Object.keys(containerEnv()));
}

function containerEnv(): Record<string, string> {
  const proxy = `http://127.0.0.1:${EGRESS_RELAY_PORT}`;
  const out: Record<string, string> = {
    NANOCLAW_EGRESS_SOCKET: CONTAINER_EGRESS_SOCKET,
    HTTPS_PROXY: proxy,
    HTTP_PROXY: proxy,
    https_proxy: proxy,
    http_proxy: proxy,
    NO_PROXY: 'localhost,127.0.0.1',
    no_proxy: 'localhost,127.0.0.1',
    NODE_USE_ENV_PROXY: '1',
    GIT_TERMINAL_PROMPT: '0',
    // SDKs refuse to start without a key; the gateway replaces it on the wire.
    ANTHROPIC_API_KEY: 'placeholder',
  };
  for (const name of CA_ENV_VARS) out[name] = CONTAINER_CA_BUNDLE;
  return out;
}

function gateway(s: GatewaySettings, method: string, route: string, body?: unknown): Promise<Response> {
  return gatewayFetch(method, route, { body }, s);
}

function failure(res: Response, what: string): Promise<AgentVaultError> {
  return gatewayFailure(res, what);
}

let caPem: string | null = null;

/** System roots plus the gateway's root, rebuilt when missing or the CA changes. */
async function ensureCaBundle(s: GatewaySettings): Promise<void> {
  const res = await gateway(s, 'GET', '/v1/mitm/ca.pem');
  if (!res.ok) throw await failure(res, 'CA fetch');
  const pem = (await res.text()).trim();
  if (!pem.includes('BEGIN CERTIFICATE')) throw new AgentVaultError('Agent Vault CA response is not a PEM certificate');
  if (pem === caPem && fs.existsSync(s.caBundle)) return;
  const system = fs.existsSync(SYSTEM_CA_BUNDLE) ? fs.readFileSync(SYSTEM_CA_BUNDLE, 'utf8').trimEnd() + '\n' : '';
  fs.mkdirSync(path.dirname(s.caBundle), { recursive: true });
  const tmp = `${s.caBundle}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${system}${pem}\n`, { mode: 0o644 });
  fs.renameSync(tmp, s.caBundle);
  caPem = pem;
}

const CONTAINER_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;

/**
 * Session directory name for a container. Container names are too long for
 * Unix socket paths, so use a short hash; it's derived, not stored, so
 * cleanup still works after a host restart.
 */
export function egressDirName(containerName: string): string {
  return createHash('sha256').update(containerName).digest('hex').slice(0, 16);
}

function sessionDir(s: GatewaySettings, containerName: string): string {
  if (!CONTAINER_NAME_RE.test(containerName)) throw new Error(`Invalid container name: ${containerName}`);
  return path.join(s.socketRoot, egressDirName(containerName));
}

/**
 * Open a gateway socket session for this container and append its mounts and
 * env to the docker args. Throws when the gateway can't provide one; callers
 * treat that like a OneCLI outage and refuse to spawn.
 */
export async function applyAgentVaultEgress(
  args: string[],
  opts: { containerName: string; agentGroupId: string; label: string },
): Promise<void> {
  const s = gatewaySettings();
  await ensureCaBundle(s);
  const dir = sessionDir(s, opts.containerName);
  fs.mkdirSync(dir, { recursive: true, mode: 0o755 });
  const socketPath = path.join(fs.realpathSync(dir), 'egress.sock');
  if (Buffer.byteLength(socketPath) > MAX_SOCKET_PATH) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw new Error(`Agent Vault socket path is too long (${socketPath}); shorten AGENT_VAULT_SOCKET_ROOT`);
  }
  try {
    const res = await gateway(s, 'POST', '/v1/socket-sessions', {
      vault: opts.agentGroupId,
      label: opts.label,
      dir: fs.realpathSync(dir),
    });
    if (res.status !== 201) throw await failure(res, 'socket session');
  } catch (err) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw err;
  }

  args.push('-v', `${dir}:${CONTAINER_EGRESS_DIR}:ro`);
  args.push('-v', `${s.caBundle}:${CONTAINER_CA_BUNDLE}:ro`);
  for (const [key, value] of Object.entries(containerEnv())) args.push('-e', `${key}=${value}`);
  log.info('Agent Vault egress applied', { containerName: opts.containerName, vault: opts.agentGroupId });
}

interface SocketSessionItem {
  id: string;
  socket_path: string;
}

async function listSessions(s: GatewaySettings): Promise<SocketSessionItem[]> {
  const res = await gateway(s, 'GET', '/v1/socket-sessions');
  if (!res.ok) throw await failure(res, 'socket session list');
  const body = (await res.json().catch(() => null)) as { items?: SocketSessionItem[] } | null;
  if (!body) throw new AgentVaultError('Agent Vault socket session list is not JSON');
  return body.items ?? [];
}

/** Session directory name owning a gateway socket path, or null if it isn't ours. */
function ownerOf(s: GatewaySettings, socketPath: string): string | null {
  const dir = path.dirname(socketPath);
  // Before the root exists nothing of ours can be bound, so the raw path is fine.
  const root = fs.existsSync(s.socketRoot) ? fs.realpathSync(s.socketRoot) : s.socketRoot;
  return path.dirname(dir) === root && path.basename(socketPath) === 'egress.sock' ? path.basename(dir) : null;
}

async function deleteSessions(s: GatewaySettings, keep: (dirName: string) => boolean): Promise<string[]> {
  const removed: string[] = [];
  for (const item of await listSessions(s)) {
    const owner = ownerOf(s, item.socket_path);
    if (!owner || keep(owner)) continue;
    const res = await gateway(s, 'DELETE', `/v1/socket-sessions/${encodeURIComponent(item.id)}`);
    if (res.status !== 204 && res.status !== 404) throw await failure(res, 'socket session delete');
    removed.push(owner);
  }
  return removed;
}

/** Revoke this container's socket session and remove its directory. Gateway failures only log. */
export async function releaseAgentVaultEgress(containerName: string): Promise<void> {
  const s = gatewaySettings();
  if (!CONTAINER_NAME_RE.test(containerName)) return;
  const dir = sessionDir(s, containerName);
  if (!fs.existsSync(dir)) return;
  try {
    const own = egressDirName(containerName);
    await deleteSessions(s, (owner) => owner !== own);
  } catch (err) {
    if (!(err instanceof AgentVaultError)) throw err;
    log.warn('Agent Vault socket session release failed', { containerName, err: (err as Error).message });
  }
  fs.rmSync(dir, { recursive: true, force: true });
}

/**
 * Host startup: revoke sessions and remove directories for containers that
 * are no longer running. A no-op when Agent Vault isn't configured.
 */
export async function reconcileAgentVaultEgress(liveContainerNames: Set<string>): Promise<void> {
  const s = gatewaySettings();
  if (agentVaultGroups().size === 0 && !fs.existsSync(s.socketRoot)) return;
  const live = new Set([...liveContainerNames].map(egressDirName));
  try {
    const removed = await deleteSessions(s, (owner) => live.has(owner));
    if (removed.length) log.info('Agent Vault stale socket sessions revoked', { count: removed.length });
  } catch (err) {
    if (!(err instanceof AgentVaultError)) throw err;
    log.warn('Agent Vault socket session reconcile failed', { err: (err as Error).message });
  }
  if (!fs.existsSync(s.socketRoot)) return;
  for (const entry of fs.readdirSync(s.socketRoot, { withFileTypes: true })) {
    if (entry.isDirectory() && !live.has(entry.name)) {
      fs.rmSync(path.join(s.socketRoot, entry.name), { recursive: true, force: true });
    }
  }
}
