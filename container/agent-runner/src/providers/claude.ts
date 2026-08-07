import fs from 'fs';
import os from 'os';
import path from 'path';

import { query as sdkQuery, type HookCallback, type PreCompactHookInput } from '@anthropic-ai/claude-agent-sdk';

import { clearContainerToolInFlight, setContainerToolInFlight } from '../db/connection.js';
import { registerProvider } from './provider-registry.js';
import type { ActivityStep, AgentProvider, AgentQuery, McpServerConfig, ProviderEvent, ProviderOptions, QueryInput } from './types.js';
import { pickActivityDetail } from './types.js';

function log(msg: string): void {
  console.error(`[claude-provider] ${msg}`);
}

// ── Model parameters (model_params bag) ────────────────────────────────
// Keys this provider knows how to apply. `max_tokens` is plumbed via
// ANTHROPIC_MAX_TOKENS (the Claude Code CLI honors that env), since the
// agent-SDK doesn't expose a per-query output cap. `thinking_budget_tokens`
// becomes `thinking: { type: 'enabled', budgetTokens: n }`.
const CLAUDE_KNOWN_PARAM_KEYS = new Set<string>(['max_tokens', 'thinking_budget_tokens']);

/**
 * Pure: map model_params to env-var entries the Claude Code CLI honors.
 * Today: `max_tokens` -> `ANTHROPIC_MAX_TOKENS`. Returns `{}` when nothing
 * applies. Exported for tests.
 */
export function paramsToClaudeEnv(modelParams: Record<string, unknown> | undefined): Record<string, string> {
  if (!modelParams) return {};
  const out: Record<string, string> = {};
  const maxTokens = modelParams.max_tokens;
  if (typeof maxTokens === 'number' && Number.isFinite(maxTokens) && maxTokens > 0) {
    out.ANTHROPIC_MAX_TOKENS = String(Math.floor(maxTokens));
  }
  return out;
}

/**
 * Pure: map `thinking_budget_tokens` to the SDK `thinking` option. Returns
 * undefined to mean "don't pass `thinking`" (let the SDK default apply).
 * Exported for tests.
 */
export function paramsToClaudeThinking(
  modelParams: Record<string, unknown> | undefined,
): { type: 'enabled'; budgetTokens: number } | undefined {
  if (!modelParams) return undefined;
  const budget = modelParams.thinking_budget_tokens;
  if (typeof budget === 'number' && Number.isFinite(budget) && budget > 0) {
    return { type: 'enabled', budgetTokens: Math.floor(budget) };
  }
  return undefined;
}

let warnedUnknownClaudeKeys = false;
function warnUnknownClaudeParamsOnce(modelParams: Record<string, unknown> | undefined): void {
  if (warnedUnknownClaudeKeys || !modelParams) return;
  const unknown = Object.keys(modelParams).filter((k) => !CLAUDE_KNOWN_PARAM_KEYS.has(k));
  if (unknown.length === 0) return;
  warnedUnknownClaudeKeys = true;
  log(
    `ignoring unknown model_params: ${unknown.join(', ')} (recognized: ${[...CLAUDE_KNOWN_PARAM_KEYS].join(', ')})`,
  );
}

// Deferred SDK builtins that either sidestep nanoclaw's own scheduling or
// don't fit our async message-passing model (they're designed for Claude
// Code's interactive UI and would hang here).
//
// - CronCreate / CronDelete / CronList / ScheduleWakeup: we have durable
//   scheduling via mcp__nanoclaw__schedule_task.
// - AskUserQuestion: SDK returns a placeholder instead of blocking on a
//   real answer — we have mcp__nanoclaw__ask_user_question that persists
//   the question and blocks on the real reply.
// - EnterPlanMode / ExitPlanMode / EnterWorktree / ExitWorktree: Claude
//   Code UI affordances; in a headless container they'd appear stuck.
const SDK_DISALLOWED_TOOLS = [
  'CronCreate',
  'CronDelete',
  'CronList',
  'ScheduleWakeup',
  'AskUserQuestion',
  'EnterPlanMode',
  'ExitPlanMode',
  'EnterWorktree',
  'ExitWorktree',
];

// Tool allowlist for NanoClaw agent containers. MCP-tool entries are derived
// at the call site from the registered `mcpServers` map so that any server
// added via `add_mcp_server` (or wired in container.json directly) is
// reachable to the agent — without this, the SDK's allowedTools filter
// silently drops every MCP namespace not listed here.
const TOOL_ALLOWLIST = [
  'Bash',
  'Read',
  'Write',
  'Edit',
  'Glob',
  'Grep',
  'WebSearch',
  'WebFetch',
  'Task',
  'TaskOutput',
  'TaskStop',
  'TeamCreate',
  'TeamDelete',
  'SendMessage',
  'TodoWrite',
  'ToolSearch',
  'Skill',
  'NotebookEdit',
];

// MCP server names are sanitized by the SDK when forming tool prefixes:
// any character outside [A-Za-z0-9_-] becomes '_'. Mirror that here so our
// allowlist patterns match what the SDK actually exposes.
function mcpAllowPattern(serverName: string): string {
  return `mcp__${serverName.replace(/[^a-zA-Z0-9_-]/g, '_')}__*`;
}

interface SDKUserMessage {
  type: 'user';
  message: { role: 'user'; content: string };
  parent_tool_use_id: null;
  session_id: string;
}

/**
 * Push-based async iterable for streaming user messages to the Claude SDK.
 */
class MessageStream {
  private queue: SDKUserMessage[] = [];
  private waiting: (() => void) | null = null;
  private done = false;

  push(text: string): void {
    this.queue.push({
      type: 'user',
      message: { role: 'user', content: text },
      parent_tool_use_id: null,
      session_id: '',
    });
    this.waiting?.();
  }

  end(): void {
    this.done = true;
    this.waiting?.();
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<SDKUserMessage> {
    while (true) {
      while (this.queue.length > 0) {
        yield this.queue.shift()!;
      }
      if (this.done) return;
      await new Promise<void>((r) => {
        this.waiting = r;
      });
      this.waiting = null;
    }
  }
}

// ── Transcript archiving (PreCompact hook) ──

interface ParsedMessage {
  role: 'user' | 'assistant';
  content: string;
}

function parseTranscript(content: string): ParsedMessage[] {
  const messages: ParsedMessage[] = [];
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry.type === 'user' && entry.message?.content) {
        const text = typeof entry.message.content === 'string' ? entry.message.content : entry.message.content.map((c: { text?: string }) => c.text || '').join('');
        if (text) messages.push({ role: 'user', content: text });
      } else if (entry.type === 'assistant' && entry.message?.content) {
        const textParts = entry.message.content.filter((c: { type: string }) => c.type === 'text').map((c: { text: string }) => c.text);
        const text = textParts.join('');
        if (text) messages.push({ role: 'assistant', content: text });
      }
    } catch {
      /* skip unparseable lines */
    }
  }
  return messages;
}

function formatTranscriptMarkdown(messages: ParsedMessage[], title?: string | null, assistantName?: string): string {
  const now = new Date();
  const dateStr = now.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true });
  const lines = [`# ${title || 'Conversation'}`, '', `Archived: ${dateStr}`, '', '---', ''];
  for (const msg of messages) {
    const sender = msg.role === 'user' ? 'User' : assistantName || 'Assistant';
    const content = msg.content.length > 2000 ? msg.content.slice(0, 2000) + '...' : msg.content;
    lines.push(`**${sender}**: ${content}`, '');
  }
  return lines.join('\n');
}

/**
 * PreToolUse hook: record the current tool + its declared timeout so the host
 * sweep can widen its stuck tolerance while Bash is running a long-declared
 * script. Defense-in-depth: if SDK_DISALLOWED_TOOLS slips through somehow,
 * block the call here instead of letting the agent hang.
 */
const preToolUseHook: HookCallback = async (input) => {
  const i = input as { tool_name?: string; tool_input?: Record<string, unknown> };
  const toolName = i.tool_name ?? '';
  if (SDK_DISALLOWED_TOOLS.includes(toolName)) {
    return {
      decision: 'block',
      stopReason: `Tool '${toolName}' is not available in this environment — use the nanoclaw equivalent.`,
    } as unknown as ReturnType<HookCallback>;
  }
  // Bash exposes its timeout via the tool_input.timeout field (ms). Any other
  // tool: no declared timeout.
  const declaredTimeoutMs =
    toolName === 'Bash' && typeof i.tool_input?.timeout === 'number' ? (i.tool_input.timeout as number) : null;
  try {
    setContainerToolInFlight(toolName, declaredTimeoutMs);
  } catch (err) {
    log(`PreToolUse: failed to record container_state: ${err instanceof Error ? err.message : String(err)}`);
  }
  return { continue: true };
};

/** Clear in-flight tool on PostToolUse / PostToolUseFailure. */
const postToolUseHook: HookCallback = async () => {
  try {
    clearContainerToolInFlight();
  } catch (err) {
    log(`PostToolUse: failed to clear container_state: ${err instanceof Error ? err.message : String(err)}`);
  }
  return { continue: true };
};

// ── Progress hints ────────────────────────────────────────────────────────
// Translate the tool_use / thinking blocks the SDK streams in `assistant`
// messages into structured `progress` ProviderEvents. The poll-loop persists
// these to the `.activity` file (and turn_activity), which the host forwards
// to the web UI where the presentation happens. Mirrors the OpenCode
// provider's `formatProgressFromPart` — no human-readable formatting here.

/** Map a Claude tool_use block to a structured activity step. Passes the raw
 *  tool name through and picks the primary raw argument (newlines intact);
 *  the UI renders "Using `<tool>` tool" and the argument as a code block. */
export function formatClaudeToolUse(id: string, name: string, input: Record<string, unknown>): ActivityStep {
  const detail = pickActivityDetail(input);
  return { kind: 'tool', id, tool: name, status: 'running', ...(detail ? { detail } : {}) };
}

/**
 * Read a Claude transcript .jsonl, render a markdown summary, and drop it into
 * the agent's `conversations/` folder so context survives a compaction or a
 * session rotation. Best-effort: returns false (and logs) on any failure.
 */
function archiveTranscriptFile(transcriptPath: string | undefined, sessionId: string | undefined, assistantName?: string): boolean {
  if (!transcriptPath || !fs.existsSync(transcriptPath)) {
    log('No transcript found for archiving');
    return false;
  }

  try {
    const content = fs.readFileSync(transcriptPath, 'utf-8');
    const messages = parseTranscript(content);
    if (messages.length === 0) return false;

    // Try to get summary from sessions index
    let summary: string | undefined;
    const indexPath = path.join(path.dirname(transcriptPath), 'sessions-index.json');
    if (fs.existsSync(indexPath)) {
      try {
        const index = JSON.parse(fs.readFileSync(indexPath, 'utf-8'));
        summary = index.entries?.find((e: { sessionId: string; summary?: string }) => e.sessionId === sessionId)?.summary;
      } catch {
        /* ignore */
      }
    }

    const name = summary
      ? summary.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50)
      : `conversation-${new Date().getHours().toString().padStart(2, '0')}${new Date().getMinutes().toString().padStart(2, '0')}`;

    const conversationsDir = process.env.NANOCLAW_CONVERSATIONS_DIR || '/workspace/agent/conversations';
    fs.mkdirSync(conversationsDir, { recursive: true });
    const filename = `${new Date().toISOString().split('T')[0]}-${name}.md`;
    fs.writeFileSync(path.join(conversationsDir, filename), formatTranscriptMarkdown(messages, summary, assistantName));
    log(`Archived conversation to ${filename}`);
    return true;
  } catch (err) {
    log(`Failed to archive transcript: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

function createPreCompactHook(assistantName?: string): HookCallback {
  return async (input) => {
    const preCompact = input as PreCompactHookInput;
    archiveTranscriptFile(preCompact.transcript_path, preCompact.session_id, assistantName);
    return {};
  };
}

// ── Continuation rotation (cold-resume guard) ──

/**
 * Resume cost is dominated by transcript size. Past this many bytes a fresh
 * cold container can't reload the .jsonl before the host's 30-min idle ceiling
 * fires, so the session is dropped and started clean. Operator-overridable.
 */
function transcriptRotateBytes(): number {
  return Number(process.env.CLAUDE_TRANSCRIPT_ROTATE_BYTES) || 12 * 1024 * 1024;
}

/**
 * Secondary age trigger, measured from the transcript's first entry. 0 (or a
 * non-positive value) disables the age check; size alone then governs.
 */
function transcriptRotateAgeMs(): number {
  const raw = process.env.CLAUDE_TRANSCRIPT_ROTATE_AGE_DAYS;
  if (raw === undefined || raw.trim() === '') return 14 * 86_400_000;
  const days = Number(raw);
  if (!Number.isFinite(days)) return 14 * 86_400_000;
  // Explicit non-positive override disables the age check; size alone governs.
  return days > 0 ? days * 86_400_000 : Infinity;
}

function claudeProjectsDir(): string {
  const base = process.env.CLAUDE_CONFIG_DIR || path.join(process.env.HOME || os.homedir(), '.claude');
  return path.join(base, 'projects');
}

/**
 * Locate the .jsonl backing a session id. The SDK names project dirs by a
 * mangled cwd; rather than reproduce that convention we scan project dirs for
 * `<sessionId>.jsonl` (session ids are UUIDs, so this is unambiguous).
 */
function findTranscriptPath(sessionId: string): string | null {
  const projects = claudeProjectsDir();
  let dirs: string[];
  try {
    dirs = fs.readdirSync(projects);
  } catch {
    return null;
  }
  for (const dir of dirs) {
    const candidate = path.join(projects, dir, `${sessionId}.jsonl`);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

/** Epoch-ms of the first transcript entry, or null if unreadable. */
function transcriptStartMs(transcriptPath: string): number | null {
  try {
    const fd = fs.openSync(transcriptPath, 'r');
    try {
      const buf = Buffer.alloc(4096);
      const n = fs.readSync(fd, buf, 0, buf.length, 0);
      const firstLine = buf.toString('utf-8', 0, n).split('\n', 1)[0];
      const ts = JSON.parse(firstLine)?.timestamp;
      const ms = ts ? Date.parse(ts) : NaN;
      return Number.isNaN(ms) ? null : ms;
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
}

// ── Provider ──

/**
 * Claude Code auto-compacts context at this window (tokens). Kept here so
 * the generic bootstrap doesn't need to know about Claude-specific env vars.
 *
 * Operator override: set CLAUDE_CODE_AUTO_COMPACT_WINDOW in the host env to
 * raise or lower the threshold without editing source — useful when running
 * with a 1M-context model variant or when emergency-tuning a deployment.
 */
const CLAUDE_CODE_AUTO_COMPACT_WINDOW = process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW || '165000';

/**
 * MCP timeouts read by Claude Code (parseInt(process.env.MCP_TIMEOUT) and
 * parseInt(process.env.MCP_TOOL_TIMEOUT) inside the bundled CLI). The
 * built-in default for connect is 30s and for tool calls is ~60s, which
 * trips on Tavily search/extract/crawl, Context7, and other slow remote
 * tools. Match the 120s cap used in mcpServersToOpenCodeConfig.
 */
const MCP_TIMEOUT_MS = process.env.MCP_TIMEOUT || '120000';
const MCP_TOOL_TIMEOUT_MS = process.env.MCP_TOOL_TIMEOUT || '120000';

/**
 * Stale-session detection. Matches Claude Code's error text when a
 * resumed session can't be found — missing transcript .jsonl, unknown
 * session ID, etc.
 */
const STALE_SESSION_RE = /no conversation found|ENOENT.*\.jsonl|session.*not found/i;

export class ClaudeProvider implements AgentProvider {
  readonly supportsNativeSlashCommands = true;

  private assistantName?: string;
  private mcpServers: Record<string, McpServerConfig>;
  private env: Record<string, string | undefined>;
  private additionalDirectories?: string[];
  private model?: string;
  private effort?: string;
  private modelParams: Record<string, unknown>;

  constructor(options: ProviderOptions = {}) {
    this.assistantName = options.assistantName;
    this.mcpServers = options.mcpServers ?? {};
    this.additionalDirectories = options.additionalDirectories;
    this.model = options.model;
    this.effort = options.effort;
    this.modelParams = options.modelParams ?? {};
    warnUnknownClaudeParamsOnce(this.modelParams);
    this.env = {
      ...(options.env ?? {}),
      CLAUDE_CODE_AUTO_COMPACT_WINDOW,
      MCP_TIMEOUT: MCP_TIMEOUT_MS,
      MCP_TOOL_TIMEOUT: MCP_TOOL_TIMEOUT_MS,
      ...paramsToClaudeEnv(this.modelParams),
    };
  }

  isSessionInvalid(err: unknown): boolean {
    const msg = err instanceof Error ? err.message : String(err);
    return STALE_SESSION_RE.test(msg);
  }

  maybeRotateContinuation(continuation: string): string | null {
    const transcriptPath = findTranscriptPath(continuation);
    if (!transcriptPath) return null;

    let size: number;
    try {
      size = fs.statSync(transcriptPath).size;
    } catch {
      return null;
    }

    const maxBytes = transcriptRotateBytes();
    const startMs = transcriptStartMs(transcriptPath);
    const ageMs = startMs === null ? 0 : Date.now() - startMs;
    const maxAgeMs = transcriptRotateAgeMs();

    let reason: string | null = null;
    if (size > maxBytes) {
      reason = `transcript ${(size / 1_048_576).toFixed(1)}MB > ${(maxBytes / 1_048_576).toFixed(0)}MB cap`;
    } else if (startMs !== null && ageMs > maxAgeMs) {
      reason = `transcript ${(ageMs / 86_400_000).toFixed(1)}d old > ${(maxAgeMs / 86_400_000).toFixed(0)}d cap`;
    }
    if (!reason) return null;

    // Preserve a readable summary, then move the heavy .jsonl out of the
    // resume path so the SDK starts a fresh session and the disk is reclaimed.
    archiveTranscriptFile(transcriptPath, continuation, this.assistantName);
    try {
      fs.renameSync(transcriptPath, `${transcriptPath}.rotated-${Date.now()}`);
    } catch (err) {
      log(`Failed to move rotated transcript aside: ${err instanceof Error ? err.message : String(err)}`);
    }
    return reason;
  }

  query(input: QueryInput): AgentQuery {
    const stream = new MessageStream();
    stream.push(input.prompt);

    const instructions = input.systemContext?.instructions;

    const thinking = paramsToClaudeThinking(this.modelParams);

    const sdkResult = sdkQuery({
      prompt: stream,
      options: {
        cwd: input.cwd,
        additionalDirectories: this.additionalDirectories,
        resume: input.continuation,
        pathToClaudeCodeExecutable: '/pnpm/claude',
        systemPrompt: instructions ? { type: 'preset' as const, preset: 'claude_code' as const, append: instructions } : undefined,
        allowedTools: [
          ...TOOL_ALLOWLIST,
          ...Object.keys(this.mcpServers).map(mcpAllowPattern),
        ],
        disallowedTools: SDK_DISALLOWED_TOOLS,
        env: this.env,
        model: this.model,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        effort: this.effort as any,
        ...(thinking ? { thinking } : {}),
        // In rootless-podman-on-LXC we run as --user=0:0 so host bind mounts
        // are accessible. Claude Code refuses bypassPermissions as root, so
        // fall back to 'auto' which still honours allowedTools/disallowedTools.
        permissionMode: process.getuid?.() === 0 ? 'auto' : 'bypassPermissions',
        allowDangerouslySkipPermissions: process.getuid?.() !== 0,
        settingSources: ['project', 'user', 'local'],
        mcpServers: this.mcpServers,
        hooks: {
          PreToolUse: [{ hooks: [preToolUseHook] }],
          PostToolUse: [{ hooks: [postToolUseHook] }],
          PostToolUseFailure: [{ hooks: [postToolUseHook] }],
          PreCompact: [{ hooks: [createPreCompactHook(this.assistantName)] }],
        },
      },
    });

    let aborted = false;

    async function* translateEvents(): AsyncGenerator<ProviderEvent> {
      let messageCount = 0;
      // SDK result fields are session-cumulative. Track previous values
      // to compute per-turn deltas.
      let prevCost = 0;
      let prevInput = 0;
      let prevOutput = 0;
      let prevCacheRead = 0;
      let prevCacheWrite = 0;
      for await (const message of sdkResult) {
        if (aborted) return;
        messageCount++;

        // Yield activity for every SDK event so the poll loop knows the agent is working
        yield { type: 'activity' };

        if (message.type === 'system' && message.subtype === 'init') {
          yield { type: 'init', continuation: message.session_id };
        } else if (message.type === 'assistant') {
          // Surface identified tool calls. Private thinking is intentionally
          // omitted from user-visible activity.
          const blocks = (message as { message?: { content?: unknown } }).message?.content;
          if (Array.isArray(blocks)) {
            for (const b of blocks) {
              const blk = b as { type?: string; id?: string; name?: string; input?: Record<string, unknown> };
              if (blk.type === 'tool_use' && blk.id && blk.name) {
                yield { type: 'progress', step: formatClaudeToolUse(blk.id, blk.name, blk.input ?? {}) };
              }
            }
          }
        } else if (message.type === 'result') {
          const text = 'result' in message ? (message as { result?: string }).result ?? null : null;
          const m = message as { is_error?: boolean; subtype?: string };

          // Extract usage from both success and error result events.
          const r = message as {
            total_cost_usd?: number;
            usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number };
            modelUsage?: Record<string, { inputTokens?: number; outputTokens?: number; cacheReadInputTokens?: number; cacheCreationInputTokens?: number; costUSD?: number; contextWindow?: number; maxOutputTokens?: number }>;
            num_turns?: number;
            duration_ms?: number;
            duration_api_ms?: number;
          };
          if (typeof r.total_cost_usd === 'number' || r.usage) {
            const curCost = r.total_cost_usd ?? 0;
            const curInput = r.usage?.input_tokens ?? 0;
            const curOutput = r.usage?.output_tokens ?? 0;
            const curCacheRead = r.usage?.cache_read_input_tokens ?? 0;
            const curCacheWrite = r.usage?.cache_creation_input_tokens ?? 0;
            // Primary model = key with highest costUSD (or first key).
            let model = '';
            let contextWindow: number | undefined;
            let maxOutputTokens: number | undefined;
            if (r.modelUsage) {
              let best = '';
              let bestCost = -1;
              for (const [k, v] of Object.entries(r.modelUsage)) {
                if ((v.costUSD ?? 0) > bestCost) { bestCost = v.costUSD ?? 0; best = k; }
                if (!contextWindow && v.contextWindow) contextWindow = v.contextWindow;
                if (!maxOutputTokens && v.maxOutputTokens) maxOutputTokens = v.maxOutputTokens;
              }
              model = best;
            }
            yield {
              type: 'usage',
              data: {
                cost_usd: Math.max(0, curCost - prevCost),
                input_tokens: Math.max(0, curInput - prevInput),
                output_tokens: Math.max(0, curOutput - prevOutput),
                cache_read_tokens: Math.max(0, curCacheRead - prevCacheRead),
                cache_write_tokens: Math.max(0, curCacheWrite - prevCacheWrite),
                num_turns: r.num_turns,
                duration_ms: r.duration_ms,
                duration_api_ms: r.duration_api_ms,
                model,
                context_window: contextWindow,
                max_output_tokens: maxOutputTokens,
              },
            };
            prevCost = curCost;
            prevInput = curInput;
            prevOutput = curOutput;
            prevCacheRead = curCacheRead;
            prevCacheWrite = curCacheWrite;
          }

          if (m.is_error || (m.subtype && m.subtype !== 'success')) {
            const lower = (text || m.subtype || 'unknown error').toLowerCase();
            const classification = /credit|quota|balance|insufficient|payment/.test(lower)
              ? 'quota'
              : /unauthor|forbidden|api key|auth/.test(lower)
                ? 'auth'
                : m.subtype || 'provider_error';
            yield {
              type: 'error',
              message: text || m.subtype || 'provider error',
              retryable: false,
              classification,
            };
            yield { type: 'result', text: null };
          } else {
            yield { type: 'result', text };
          }
        } else if (message.type === 'system' && (message as { subtype?: string }).subtype === 'api_retry') {
          yield { type: 'error', message: 'API retry', retryable: true };
        } else if (message.type === 'system' && (message as { subtype?: string }).subtype === 'rate_limit_event') {
          yield { type: 'error', message: 'Rate limit', retryable: false, classification: 'quota' };
        } else if (message.type === 'system' && (message as { subtype?: string }).subtype === 'compact_boundary') {
          const meta = (message as { compact_metadata?: { pre_tokens?: number } }).compact_metadata;
          const detail = meta?.pre_tokens ? ` (${meta.pre_tokens.toLocaleString()} tokens compacted)` : '';
          yield { type: 'result', text: `Context compacted${detail}.` };
        } else if (message.type === 'system' && (message as { subtype?: string }).subtype === 'task_notification') {
          const tn = message as { task_id?: string; summary?: string };
          yield { type: 'progress', step: { kind: 'notification', id: tn.task_id || `notification-${messageCount}`, text: tn.summary || 'Task notification' } };
        }
      }
      log(`Query completed after ${messageCount} SDK messages`);
    }

    return {
      push: (msg, _files, options) => {
        if (options?.tools === 'disabled') return false;
        stream.push(msg);
        return true;
      },
      end: () => stream.end(),
      events: translateEvents(),
      abort: () => {
        aborted = true;
        stream.end();
      },
    };
  }
}

registerProvider('claude', (opts) => new ClaudeProvider(opts));
