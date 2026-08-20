/**
 * fx (https://fx.sh) agent provider.
 *
 * Talks to the `fx acp` CLI over newline-delimited JSON-RPC on stdin/stdout
 * (Agent Client Protocol). The CLI is used rather than the `libfx` N-API
 * addon deliberately: libfx 0.0.3's native core aborts with SIGILL while
 * handling `initialize` on some x86-64 hosts (verified on Intel N100 under
 * both Node 22 and Bun 1.3), whereas the released static binary is stable.
 *
 * One `fx acp` process is shared per container and holds a single ACP
 * session, which matches NanoClaw's one-container-per-session model. fx
 * allows only one in-flight prompt per session, so `push()` enqueues and the
 * event generator drains turns sequentially — the same shape the OpenCode
 * provider uses.
 */
import { spawn, type ChildProcess } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { startFxGatewayShim, type FxGatewayShim } from './fx-gateway-shim.js';

import { registerProvider } from './provider-registry.js';
import { mcpServersToFxConfig } from './mcp-to-fx.js';
import { startFxMcpShims, type FxMcpShims } from './fx-mcp-shim.js';
import { createModelCatalog, type RawLimits } from './model-catalog.js';
import type {
  ActivityStep,
  AgentProvider,
  AgentQuery,
  FileAttachment,
  ModelLimits,
  ProviderEvent,
  ProviderOptions,
  QueryInput,
  QueryPushOptions,
  TurnUsage,
} from './types.js';

function log(msg: string): void {
  console.error(`[fx-provider] ${msg}`);
}

const FX_BIN = process.env.FX_BIN || 'fx';

/**
 * fx keeps its auth/settings/session state under $HOME/.fx and has no env knob
 * to move it, so the host mounts a per-session directory straight over
 * ~/.fx instead. Deliberately do NOT redirect HOME here: fx also discovers
 * skills under $HOME/.claude/skills, and pointing HOME at a state-only mount
 * would leave the agent with no skills at all.
 *
 * Disables the OS keychain, which does not exist in the container and
 * otherwise makes fx block on credential storage.
 */
export function fxProcessEnv(): Record<string, string> {
  const env: Record<string, string> = {
    FX_DISABLE_KEYCHAIN: '1',
  };

  const shim = ensureGatewayShim();
  if (shim) {
    env.FX_GATEWAY_BASE_URL = shim.baseUrl;
    env.FX_GATEWAY_CHAT_URL = shim.chatUrl;
    // fx refuses to start without a key. The real credential is injected by
    // OneCLI at the proxy, so a placeholder is all the process ever sees.
    if (!process.env.AI_GATEWAY_API_KEY) env.AI_GATEWAY_API_KEY = 'placeholder';
  }
  return env;
}

let gatewayShim: FxGatewayShim | null = null;

/**
 * Starts the loopback credential shim unless the operator pinned the gateway
 * URLs explicitly (self-hosted gateway, or a test pointing at a stub), in which
 * case their values are passed straight through.
 */
function ensureGatewayShim(): FxGatewayShim | null {
  if (process.env.FX_GATEWAY_BASE_URL || process.env.FX_GATEWAY_CHAT_URL) return null;
  if (!gatewayShim) gatewayShim = startFxGatewayShim();
  return gatewayShim;
}

let mcpShims: FxMcpShims | null = null;

/**
 * Remote MCP servers need the same credential-injection hop as the gateway.
 * Started once per process: the server list comes from the container config and
 * does not change while the runner is alive.
 */
function ensureMcpShims(servers: ProviderOptions['mcpServers']): FxMcpShims {
  if (!mcpShims) mcpShims = startFxMcpShims(servers);
  return mcpShims;
}

/** fx reports these when a turn ends; anything else is treated as an error. */
type StopReason = 'end_turn' | 'cancelled' | 'refused' | 'max_tokens' | string;

/** Upstream errors older than this belong to a previous turn. */
const UPSTREAM_ERROR_TTL_MS = 60_000;

/**
 * fx collapses every upstream failure into stopReason 'refused' with no detail,
 * and whatever partial text it emitted is usually its own chain-of-thought
 * rather than an explanation. The shim saw the real HTTP error, so prefer it —
 * a rate limit and a bad API key are very different problems for the operator.
 */
export function refusalMessage(
  partialText: string,
  upstream: { status: number; message: string; at: number } | null = gatewayShim?.lastUpstreamError() ?? null,
  now: number = Date.now(),
): string {
  if (upstream && now - upstream.at <= UPSTREAM_ERROR_TTL_MS) {
    const detail = upstream.message.trim();
    return `AI Gateway returned ${upstream.status}${detail ? `: ${detail}` : ''}`;
  }
  return partialText.trim() || 'fx refused the request (check AI Gateway credentials and model access)';
}

interface JsonRpcMessage {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}

/** ACP `session/update` payload; only the fields we map are modelled. */
interface SessionUpdate {
  sessionUpdate: string;
  content?: { type?: string; text?: string };
  toolCallId?: string;
  title?: string;
  kind?: string;
  status?: string;
  rawInput?: Record<string, unknown>;
}

const STALE_SESSION_RE = /session not found|unknown session|no such session|failed to load session/i;

/**
 * fx has no ACP event carrying token counts, so its own append-only ledger at
 * ~/.fx/usage.jsonl is the only source. Reading it by byte offset scopes a
 * read to a single turn without re-counting earlier ones.
 */
function fxUsageLogPath(): string {
  // HOME, not os.homedir(): the state mount is keyed off the container's HOME,
  // and Bun's os.homedir() ignores the env var.
  return path.join(process.env.HOME || os.homedir(), '.fx', 'usage.jsonl');
}

function fxUsageOffset(): number {
  try {
    return fs.statSync(fxUsageLogPath()).size;
  } catch {
    return 0;
  }
}

/** One `generation` fact — a single model round trip. */
interface FxUsageFact {
  model?: string;
  input_tokens?: number;
  output_tokens?: number;
  cache_read_tokens?: number;
  cache_write_tokens?: number;
  reasoning_tokens?: number;
  total_cost?: number;
}

export function sumFxUsageFacts(facts: FxUsageFact[]): TurnUsage | null {
  if (facts.length === 0) return null;
  const usage: TurnUsage = {
    cost_usd: 0,
    input_tokens: 0,
    output_tokens: 0,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    reasoning_tokens: 0,
    model: '',
  };
  for (const f of facts) {
    usage.cost_usd += f.total_cost ?? 0;
    // fx's input_tokens already includes cache_read_tokens; the DB column is
    // the uncached remainder so the UI's "input + cache read" reads right.
    const cacheRead = f.cache_read_tokens ?? 0;
    usage.input_tokens += Math.max(0, (f.input_tokens ?? 0) - cacheRead);
    usage.output_tokens += f.output_tokens ?? 0;
    usage.cache_read_tokens += cacheRead;
    usage.cache_write_tokens += f.cache_write_tokens ?? 0;
    usage.reasoning_tokens = (usage.reasoning_tokens ?? 0) + (f.reasoning_tokens ?? 0);
    if (f.model) usage.model = f.model;
  }
  // Context occupancy is the last round trip alone, not the sum.
  const last = facts[facts.length - 1];
  const resident =
    (last.input_tokens ?? 0) + (last.cache_write_tokens ?? 0) + (last.output_tokens ?? 0);
  if (resident > 0) usage.context_tokens = resident;
  return usage;
}

/**
 * Model limits for the context/output budget bars.
 *
 * fx reports no limits over ACP, so they come from the gateway's own catalog —
 * the same endpoint fx resolves its model list from, so anything fx can run is
 * described here.
 */
const FX_CATALOG_PATH = '/coding-agent/v1/models';
const FX_CATALOG_TIMEOUT_MS = 10_000;

interface FxCatalogModel {
  id?: string;
  context_window?: number;
  max_tokens?: number;
}

/** Exported for tests. Interpretation of the numbers is the catalog's job. */
export function fxLimitsFromCatalog(models: FxCatalogModel[]): Map<string, RawLimits> {
  const out = new Map<string, RawLimits>();
  for (const m of models) {
    if (!m.id) continue;
    const context = m.context_window ?? 0;
    const output = m.max_tokens ?? 0;
    if (context <= 0 && output <= 0) continue;
    out.set(m.id, { context, output });
  }
  return out;
}

/** Goes through the shim so the request takes the same proxy hop as fx's own. */
function fxCatalogUrl(): string | null {
  const base = ensureGatewayShim()?.baseUrl ?? process.env.FX_GATEWAY_BASE_URL;
  return base ? `${base.replace(/\/+$/, '')}${FX_CATALOG_PATH}` : null;
}

const fxModelCatalog = createModelCatalog('fx', async () => {
  const url = fxCatalogUrl();
  if (!url) return new Map<string, RawLimits>();
  const res = await fetch(url, { signal: AbortSignal.timeout(FX_CATALOG_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = (await res.json()) as { data?: FxCatalogModel[] };
  return fxLimitsFromCatalog(json.data ?? []);
});

/** Test seam: drop the memoized catalog. */
export function resetFxModelCatalog(): void {
  fxModelCatalog.reset();
}

/** Sum every generation fx logged after `offset`. Exported for tests. */
export function readFxUsageSince(offset: number): TurnUsage | null {
  let raw: string;
  try {
    const fd = fs.openSync(fxUsageLogPath(), 'r');
    try {
      const size = fs.fstatSync(fd).size;
      if (size <= offset) return null;
      const buf = Buffer.alloc(size - offset);
      fs.readSync(fd, buf, 0, buf.length, offset);
      raw = buf.toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
  } catch (err) {
    // No log yet is the normal state until fx bills its first generation.
    if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
      log(`could not read usage log: ${err instanceof Error ? err.message : String(err)}`);
    }
    return null;
  }
  const facts: FxUsageFact[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line) as { kind?: string; fact?: FxUsageFact };
      if (entry.kind === 'generation' && entry.fact) facts.push(entry.fact);
    } catch {
      // Half-written trailing line — drop it rather than lose the whole turn.
    }
  }
  return sumFxUsageFacts(facts);
}

/**
 * fx derives a session's permission mode from its mode id, and only `code` and
 * `ask` are registered. `code` means permission mode `auto`, where fx resolves
 * every sensitive call with its own model-based classifier and never asks the
 * client — which silently denied all MCP tool calls. `ask` routes each decision
 * to session/request_permission, which the dispatcher below auto-approves.
 * Both modes carry the same full tool policy, so nothing is withheld.
 */
const DEFAULT_MODE = 'ask';

/** Handshake/config calls are local and fast; anything slower is a wedge. */
const REQUEST_TIMEOUT_MS = Number(process.env.FX_REQUEST_TIMEOUT_MS) || 60_000;
/** A prompt covers a whole multi-step turn, so it needs real headroom. */
const PROMPT_TIMEOUT_MS = Number(process.env.FX_PROMPT_TIMEOUT_MS) || 20 * 60_000;

function isAllowOption(option: { optionId?: string; kind?: string }): boolean {
  const probe = `${option.kind ?? ''} ${option.optionId ?? ''}`.toLowerCase();
  return probe.includes('allow');
}

class FxRuntime {
  private proc: ChildProcess;
  private buf = '';
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (m: JsonRpcMessage) => void; reject: (e: Error) => void }>();
  /** Set while a turn is streaming; receives session/update payloads. */
  private updateSink: ((u: SessionUpdate) => void) | null = null;
  private exited = false;

  constructor(env: Record<string, string | undefined>, cwd: string) {
    this.proc = spawn(FX_BIN, ['acp'], {
      cwd,
      env: { ...process.env, ...fxProcessEnv(), ...env } as NodeJS.ProcessEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.proc.stdout?.on('data', (d: Buffer) => this.onData(d));
    this.proc.stderr?.on('data', (d: Buffer) => {
      const text = d.toString().trim();
      if (text) log(`stderr: ${text.slice(0, 500)}`);
    });
    this.proc.on('exit', (code) => {
      this.exited = true;
      const err = new Error(`fx acp exited with code ${code}`);
      for (const waiter of this.pending.values()) waiter.reject(err);
      this.pending.clear();
    });
  }

  private onData(chunk: Buffer): void {
    this.buf += chunk.toString();
    let idx: number;
    while ((idx = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, idx);
      this.buf = this.buf.slice(idx + 1);
      if (!line.trim()) continue;
      let msg: JsonRpcMessage;
      try {
        msg = JSON.parse(line) as JsonRpcMessage;
      } catch {
        log(`unparseable line: ${line.slice(0, 200)}`);
        continue;
      }
      this.dispatch(msg);
    }
  }

  private dispatch(msg: JsonRpcMessage): void {
    if (msg.method === 'session/update') {
      this.updateSink?.(msg.params?.update as SessionUpdate);
      return;
    }
    if (msg.method === 'session/request_permission') {
      // The container is the sandbox, so a headless turn auto-approves rather
      // than stalling on a prompt no human will ever see.
      const options = (msg.params?.options ?? []) as Array<{ optionId?: string; kind?: string }>;
      const pick = options.find(isAllowOption) ?? options[0];
      this.send({
        jsonrpc: '2.0',
        id: msg.id,
        result: pick?.optionId
          ? { outcome: { outcome: 'selected', optionId: pick.optionId } }
          : { outcome: { outcome: 'cancelled' } },
      });
      return;
    }
    if (msg.id === undefined) return;
    const waiter = this.pending.get(msg.id);
    if (!waiter) return;
    this.pending.delete(msg.id);
    waiter.resolve(msg);
  }

  private send(payload: Record<string, unknown>): void {
    if (this.exited) throw new Error('fx acp process has exited');
    this.proc.stdin?.write(`${JSON.stringify(payload)}\n`);
  }

  request(method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      // Without a deadline a stalled ACP call hangs until the host's absolute
      // session ceiling, producing no logs at all — a silent 30-minute wedge.
      // `session/prompt` legitimately runs long (multi-step turns), so it gets
      // a far larger budget than the setup handshake.
      const timeoutMs = method === 'session/prompt' ? PROMPT_TIMEOUT_MS : REQUEST_TIMEOUT_MS;
      const timer = setTimeout(() => {
        if (!this.pending.delete(id)) return;
        reject(new Error(`fx acp request '${method}' timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      // Don't let a pending deadline hold the process open.
      timer.unref?.();
      const settle = (fn: () => void): void => {
        clearTimeout(timer);
        fn();
      };
      this.pending.set(id, {
        resolve: (msg) =>
          settle(() => {
            if (msg.error) reject(new Error(msg.error.message));
            else resolve(msg.result ?? {});
          }),
        reject: (err) => settle(() => reject(err)),
      });
      try {
        this.send({ jsonrpc: '2.0', id, method, params });
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err as Error);
      }
    });
  }

  notify(method: string, params: Record<string, unknown> = {}): void {
    this.send({ jsonrpc: '2.0', method, params });
  }

  setUpdateSink(sink: ((u: SessionUpdate) => void) | null): void {
    this.updateSink = sink;
  }

  kill(): void {
    this.proc.kill('SIGTERM');
  }
}

let sharedRuntime: Promise<FxRuntime> | null = null;

async function ensureRuntime(options: ProviderOptions, cwd: string): Promise<FxRuntime> {
  if (!sharedRuntime) {
    sharedRuntime = (async () => {
      const rt = new FxRuntime(options.env ?? {}, cwd);
      await rt.request('initialize', { protocolVersion: 1, clientCapabilities: {} });
      return rt;
    })();
  }
  return sharedRuntime;
}

/** Test hook — drops the memoized process so the next query starts fresh. */
export function destroySharedFxRuntime(): void {
  const rt = sharedRuntime;
  sharedRuntime = null;
  void rt?.then((r) => r.kill()).catch(() => {});
  gatewayShim?.stop();
  gatewayShim = null;
  mcpShims?.stop();
  mcpShims = null;
}

/** Map an ACP tool status onto the ActivityStep status vocabulary. */
export function mapToolStatus(status: string | undefined): 'pending' | 'running' | 'completed' | 'error' {
  switch (status) {
    case 'completed':
      return 'completed';
    case 'failed':
    case 'error':
      return 'error';
    case 'in_progress':
    case 'running':
      return 'running';
    default:
      return 'pending';
  }
}

/**
 * Convert one ACP session update into a NanoClaw activity step. Returns null
 * for updates that carry no trace value (message chunks, session info).
 */
export function activityStepFromUpdate(update: SessionUpdate): ActivityStep | null {
  switch (update.sessionUpdate) {
    case 'tool_call':
    case 'tool_call_update': {
      const id = update.toolCallId ?? 'tool';
      return {
        kind: 'tool',
        id,
        tool: update.title || update.kind || 'tool',
        status: mapToolStatus(update.status),
        detail: typeof update.content?.text === 'string' ? update.content.text : undefined,
        title: update.title,
      };
    }
    case 'agent_thought_chunk':
      return update.content?.text
        ? { kind: 'internal', id: `thought-${Date.now()}`, text: update.content.text }
        : null;
    default:
      return null;
  }
}

/**
 * Both `session/new` and `session/load` re-derive the MCP runtime from the
 * `mcpServers` they are given, so a load that omits the list shuts every
 * server down and the agent resumes with no tools.
 */
export function sessionOpenRequest(
  input: { cwd: string; continuation?: string },
  mcpServers: unknown[],
): { method: 'session/new' | 'session/load'; params: Record<string, unknown> } {
  return input.continuation
    ? {
        method: 'session/load',
        params: { sessionId: input.continuation, cwd: input.cwd, mcpServers },
      }
    : { method: 'session/new', params: { cwd: input.cwd, mcpServers } };
}

const MCP_TOOL_GUIDANCE = `<mcp_tools>
Your tool list does not include MCP tools directly — every one of them sits behind mcp_search_tools and mcp_select_tool. So when an instruction tells you to call a nanoclaw tool such as set_thread_title or send_message, that tool exists even though you cannot see it in your tool list.

Reach it the usual way: mcp_search_tools with the server alias "nanoclaw" and the use case, then mcp_select_tool with one exact result, then call the tool on the following step once its schema is advertised.

Never skip an instructed tool, and never report it as unavailable, just because it is absent from your tool list.
</mcp_tools>`;

export class FxProvider implements AgentProvider {
  readonly supportsNativeSlashCommands = false;
  // fx defers MCP schemas out of the base advertisement (only mcp_search_tools
  // and mcp_select_tool are listed), and upstream tracks models failing to route
  // through it as a known gap. Restate fx's own search→select flow so an
  // instructed tool is not dismissed as missing.
  readonly mcpToolGuidance = MCP_TOOL_GUIDANCE;
  // fx has no CLAUDE.local.md-style native memory file, so the runner supplies
  // the persistent memory/ tree instead.
  readonly usesMemoryScaffold = true;

  private readonly options: ProviderOptions;

  constructor(options: ProviderOptions = {}) {
    this.options = options;
  }

  isSessionInvalid(err: unknown): boolean {
    const msg = err instanceof Error ? err.message : String(err);
    return STALE_SESSION_RE.test(msg);
  }

  /** fx logs the gateway's own model id, so it keys the catalog directly. */
  modelLimits(usage: TurnUsage): Promise<ModelLimits> {
    return fxModelCatalog.limitsFor(usage.model);
  }

  private async openSession(rt: FxRuntime, input: QueryInput): Promise<string> {
    const shims = ensureMcpShims(this.options.mcpServers);
    const { method, params } = sessionOpenRequest(
      input,
      mcpServersToFxConfig(this.options.mcpServers, undefined, shims.urlFor),
    );
    const opened = await rt.request(method, params);
    // A loaded session comes back in fx's default `ask` mode, so config is
    // reapplied on both paths.
    const sessionId = (opened.sessionId as string) ?? input.continuation!;
    await this.applyConfig(rt, sessionId);
    return sessionId;
  }

  private async applyConfig(rt: FxRuntime, sessionId: string): Promise<void> {
    const set = async (configId: string, value: string): Promise<void> => {
      try {
        await rt.request('session/set_config_option', { sessionId, configId, value });
      } catch (err) {
        log(`could not set ${configId}=${value}: ${err instanceof Error ? err.message : String(err)}`);
      }
    };
    await set('mode', DEFAULT_MODE);
    if (this.options.model) await set('model', this.options.model);
  }

  query(input: QueryInput): AgentQuery {
    const pending: Array<{ text: string; files?: FileAttachment[] }> = [];
    let waiting: (() => void) | null = null;
    let ended = false;
    let aborted = false;
    let cancelActive: (() => void) | null = null;

    pending.push({ text: buildPrompt(input.prompt, input.systemContext?.instructions), files: input.files });

    const self = this;

    async function* gen(): AsyncGenerator<ProviderEvent> {
      const rt = await ensureRuntime(self.options, input.cwd);
      let sessionId: string | undefined;

      while (!aborted) {
        while (pending.length === 0 && !ended && !aborted) {
          await new Promise<void>((resolve) => {
            waiting = resolve;
          });
          waiting = null;
        }
        if (aborted) return;
        if (pending.length === 0 && ended) return;

        const turn = pending.shift()!;

        if (!sessionId) {
          sessionId = await self.openSession(rt, input);
          yield { type: 'init', continuation: sessionId };
        }

        // Drain updates through a queue so the generator can yield them in
        // order while `session/prompt` is still in flight.
        const queue: SessionUpdate[] = [];
        let notify: (() => void) | null = null;
        rt.setUpdateSink((u) => {
          queue.push(u);
          notify?.();
        });

        cancelActive = () => rt.notify('session/cancel', { sessionId });

        let text = '';
        let settled: { stopReason?: StopReason; error?: Error } | null = null;
        const usageOffset = fxUsageOffset();
        const promptDone = rt
          .request('session/prompt', {
            sessionId,
            prompt: buildPromptBlocks(turn.text, turn.files),
          })
          .then((res) => {
            settled = { stopReason: res.stopReason as StopReason };
          })
          .catch((error: Error) => {
            settled = { error };
          })
          .finally(() => notify?.());

        while (!settled || queue.length > 0) {
          if (queue.length === 0) {
            await new Promise<void>((resolve) => {
              notify = resolve;
            });
            notify = null;
            continue;
          }
          const update = queue.shift()!;
          yield { type: 'activity' };
          if (update?.sessionUpdate === 'agent_message_chunk' && update.content?.text) {
            text += update.content.text;
            continue;
          }
          const step = activityStepFromUpdate(update);
          if (step) yield { type: 'progress', step };
        }

        await promptDone;
        rt.setUpdateSink(null);
        cancelActive = null;

        // Emitted before the outcome branches: a refused or errored turn still
        // burned tokens, and dropping them silently under-reports spend.
        const usage = readFxUsageSince(usageOffset);
        if (usage) yield { type: 'usage', data: usage };

        const outcome = settled as { stopReason?: StopReason; error?: Error } | null;
        if (outcome?.error) {
          yield { type: 'error', message: outcome.error.message, retryable: false };
          continue;
        }
        const stop = outcome?.stopReason;
        if (stop === 'cancelled') return;
        if (stop === 'refused') {
          yield {
            type: 'error',
            message: refusalMessage(text),
            retryable: false,
          };
          continue;
        }
        yield { type: 'result', text: text.trim() ? text : null };
      }
    }

    return {
      push(message: string, files?: FileAttachment[], _options?: QueryPushOptions) {
        pending.push({ text: message, files });
        waiting?.();
        return true;
      },
      end() {
        ended = true;
        waiting?.();
      },
      abort() {
        aborted = true;
        cancelActive?.();
        waiting?.();
      },
      events: gen(),
    };
  }
}

/**
 * fx advertises `promptCapabilities.image: false`, so attachments cannot be
 * sent as native content blocks. Reference them by path instead — the agent
 * has filesystem access to the same inbox directory.
 */
export function buildPromptBlocks(text: string, files?: FileAttachment[]): Array<Record<string, unknown>> {
  if (!files?.length) return [{ type: 'text', text }];
  const manifest = files.map((f) => `- ${f.filename} (${f.mime}): ${f.path}`).join('\n');
  return [{ type: 'text', text: `${text}\n\nAttached files (read them from disk):\n${manifest}` }];
}

// fx has no system-prompt channel over ACP, so the harness block rides in the
// user turn. Fence it the way OpenCode does or the model reads it as user speech.
export function buildPrompt(prompt: string, instructions?: string): string {
  return instructions ? `<system>\n${instructions}\n</system>\n\n${prompt}` : prompt;
}

registerProvider('fx', (options) => new FxProvider(options));
