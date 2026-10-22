/**
 * Host-side client for the headless Agent Vault credential gateway.
 *
 * The only code that reads the host agent's token. Spawn (egress), the
 * group settings routes and the OAuth callback relay all go through here; the
 * token never reaches a browser or a container.
 *
 * Contract: docs/credential-gateway-agent-vault-fork-proposal.md.
 */
import fs from 'fs';
import path from 'path';

import { DATA_DIR } from '../../config.js';
import { readEnvFile } from '../../env.js';

const PROJECT_ROOT = path.dirname(DATA_DIR);
const DEFAULT_GATEWAY_URL = 'http://127.0.0.1:14321';
const DEFAULT_TIMEOUT_MS = 10_000;

/** A gateway call failed: unreachable, unreadable token, or a non-2xx answer. */
export class AgentVaultError extends Error {
  constructor(
    message: string,
    /** HTTP status from the gateway; absent when it couldn't be reached. */
    readonly status?: number,
    /** Machine-readable code from the gateway's error body, e.g. `service_conflict`. */
    readonly code?: string,
    /** Catalog provider named by a `registration_unsupported` failure. */
    readonly provider?: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }

  get unreachable(): boolean {
    return this.status === undefined;
  }
}

function env(name: string): string | undefined {
  if (process.env[name] !== undefined) return process.env[name];
  return readEnvFile([name])[name];
}

export interface GatewaySettings {
  url: string;
  tokenFile: string;
  socketRoot: string;
  caBundle: string;
}

export function gatewaySettings(): GatewaySettings {
  const socketRoot = path.resolve(PROJECT_ROOT, env('AGENT_VAULT_SOCKET_ROOT') || 'data/agent-vault/sessions');
  return {
    url: (env('NANOCLAW_AGENT_VAULT_URL') || DEFAULT_GATEWAY_URL).replace(/\/$/, ''),
    tokenFile: path.resolve(PROJECT_ROOT, env('AGENT_VAULT_BOOTSTRAP_TOKEN_FILE') || 'data/agent-vault/host-token'),
    socketRoot,
    caBundle: path.join(path.dirname(socketRoot), 'ca-bundle.pem'),
  };
}

/** Agent group IDs moved to Agent Vault (spike-only switch until `credential_backend` lands). */
export function agentVaultGroups(): Set<string> {
  return new Set(
    (env('NANOCLAW_AGENT_VAULT_GROUPS') || '')
      .split(',')
      .map((id) => id.trim())
      .filter(Boolean),
  );
}

export function usesAgentVault(agentGroupId: string): boolean {
  return agentVaultGroups().has(agentGroupId);
}

/** Each agent group has exactly one vault, named after the group. */
export function vaultName(agentGroupId: string): string {
  return agentGroupId;
}

export interface GatewayRequestOptions {
  body?: unknown;
  /** Send the host token; false only for the gateway's public endpoints. */
  auth?: boolean;
  timeoutMs?: number;
}

/** Raw gateway call. Throws AgentVaultError only when the gateway can't be reached. */
export async function gatewayFetch(
  method: string,
  route: string,
  opts: GatewayRequestOptions = {},
  s: GatewaySettings = gatewaySettings(),
): Promise<Response> {
  const headers: Record<string, string> = {};
  if (opts.auth !== false) {
    let token: string;
    try {
      token = fs.readFileSync(s.tokenFile, 'utf8').trim();
    } catch (err) {
      throw new AgentVaultError(
        `Agent Vault host token unreadable at ${s.tokenFile}: ${(err as Error).message}`,
        undefined,
        undefined,
        undefined,
        { cause: err },
      );
    }
    headers.Authorization = `Bearer ${token}`;
  }
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
  try {
    return await fetch(`${s.url}${route}`, {
      method,
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      signal: AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
  } catch (err) {
    throw new AgentVaultError(
      `Agent Vault gateway unreachable at ${s.url}: ${(err as Error).message}`,
      undefined,
      undefined,
      undefined,
      { cause: err },
    );
  }
}

/** Turns a non-2xx gateway response into an AgentVaultError carrying its code and message. */
export async function gatewayFailure(res: Response, what: string): Promise<AgentVaultError> {
  const text = await res.text().catch(() => '');
  type ErrorBody = { error?: unknown; code?: unknown; provider?: unknown };
  let parsed: ErrorBody | null;
  try {
    parsed = JSON.parse(text) as ErrorBody | null;
  } catch (err) {
    if (!(err instanceof SyntaxError)) throw err;
    parsed = null;
  }
  const message = typeof parsed?.error === 'string' ? parsed.error : text.slice(0, 300);
  return new AgentVaultError(
    `Agent Vault ${what} failed: HTTP ${res.status}${message ? ` ${message}` : ''}`,
    res.status,
    typeof parsed?.code === 'string' ? parsed.code : undefined,
    typeof parsed?.provider === 'string' ? parsed.provider : undefined,
  );
}

/** JSON gateway call: returns the parsed body on 2xx (null for 204), throws AgentVaultError otherwise. */
export async function gatewayJson<T>(
  method: string,
  route: string,
  what: string,
  opts: GatewayRequestOptions = {},
): Promise<T> {
  const res = await gatewayFetch(method, route, opts);
  if (!res.ok) throw await gatewayFailure(res, what);
  if (res.status === 204) return null as T;
  const body = (await res.json().catch(() => undefined)) as T | undefined;
  if (body === undefined) throw new AgentVaultError(`Agent Vault ${what} response is not JSON`, res.status);
  return body;
}

/** The user-facing part of an AgentVaultError, without the "Agent Vault … failed: HTTP n" prefix. */
export function gatewayMessage(err: AgentVaultError): string {
  return err.message.replace(/^Agent Vault .*? failed: HTTP \d+ ?/, '') || err.message;
}
