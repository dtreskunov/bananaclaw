export interface AgentProvider {
  /**
   * True if the provider's underlying SDK handles slash commands natively and
   * wants them passed through as raw text. When false, the poll-loop formats
   * slash commands like any other chat message.
   */
  readonly supportsNativeSlashCommands: boolean;

  /**
   * Optional. When true, the runner scaffolds a persistent `memory/` tree in the
   * agent's workspace at boot. Providers with their own native memory (e.g.
   * Claude's `CLAUDE.local.md`) omit this and get nothing — memory is opt-in per
   * provider, never gated on a provider name.
   */
  readonly usesMemoryScaffold?: boolean;

  /**
   * Optional. Prepended to the system instructions when the provider's harness
   * does not advertise MCP tools directly, so the model is told how to reach
   * them. Providers that expose MCP tools in the plain tool list omit this.
   */
  readonly mcpToolGuidance?: string;

  /**
   * Optional. Called by the poll-loop after each completed exchange (a
   * result, a wrapping retry, or an error). Providers whose harness keeps no
   * on-disk transcript implement this to persist exchanges themselves (e.g.
   * markdown into the agent's `conversations/` dir); providers that persist
   * and archive their own transcript (e.g. the Claude Agent SDK's `.jsonl`)
   * omit it. Best-effort: the loop catches and logs anything it throws. The
   * implementation lives with the provider, never in the runner.
   */
  onExchangeComplete?(exchange: ProviderExchange): void;

  /** Start a new query. Returns a handle for streaming input and output. */
  query(input: QueryInput): AgentQuery;

  /**
   * True if the given error indicates the stored continuation is invalid
   * (missing transcript, unknown session, etc.) and should be cleared.
   */
  isSessionInvalid(err: unknown): boolean;

  /**
   * Optional pre-resume maintenance. Given the stored continuation token,
   * decide whether its backing transcript has grown too large or too old to
   * resume cheaply. Return a non-null reason string to tell the caller to drop
   * the continuation and start a fresh session (the provider archives any
   * recoverable summary first); return null to keep resuming.
   *
   * Guards the cold-resume failure mode: a long-lived hub session accumulates
   * days of history — including base64 image blocks the agent Read — and the
   * SDK reloads the whole .jsonl on every resume. Past a threshold the first
   * turn alone can exceed the host's idle ceiling, so the container is killed
   * before it ever replies. Providers without an on-disk transcript omit this.
   */
  maybeRotateContinuation?(continuation: string, cwd: string): string | null;

  /**
   * Optional native thread fork. Branch the provider's own session at a
   * given turn and return a continuation for the copy, leaving the
   * original untouched.
   *
   * Implemented only by providers whose backend can split a session
   * server-side. Everything else omits it and the runner falls back to
   * replaying a plain-text digest of the inherited history — correct, but
   * without the parent's tool results, cache state or reasoning trace.
   *
   * Return null (rather than throwing) to decline a fork the provider
   * could not honor; the caller degrades to the digest either way, but a
   * null says "not possible" instead of "something broke".
   */
  forkContinuation?(input: ForkContinuationInput): Promise<string | null>;
}

export interface ForkContinuationInput {
  /** The parent session's continuation token, as issued by this provider. */
  continuation: string;
  /**
   * Provider-private handle for the turn to branch at — everything up to
   * and including it carries over. Captured when the parent turn ran.
   */
  anchorRef: string;
  cwd: string;
}

/** One prompt/result round-trip, as reported to `onExchangeComplete`. */
export interface ProviderExchange {
  /** The user prompt this exchange answers (never an internal retry nudge). */
  prompt: string;
  result: string | null;
  /** Continuation/thread id in effect for the exchange, if any. */
  continuation?: string;
  status: 'completed' | 'undelivered' | 'error';
}

/**
 * Options passed to provider constructors. Fields are common to most
 * providers; individual providers may ignore any they don't need.
 */
export interface ProviderOptions {
  assistantName?: string;
  mcpServers?: Record<string, McpServerConfig>;
  env?: Record<string, string | undefined>;
  additionalDirectories?: string[];
  /**
   * Model alias (`sonnet`, `opus`, `haiku`) or full model ID. Passed through
   * to the underlying SDK. If omitted, the SDK default is used.
   */
  model?: string;
  /**
   * Reasoning effort (`'low' | 'medium' | 'high' | 'xhigh' | 'max'`). Passed
   * through to the underlying SDK. If omitted, the SDK default is used.
   */
  effort?: string;
  /**
   * Freeform provider-knob bag from `container_configs.model_params`.
   * Always an object. Providers pick out keys they understand and ignore
   * the rest (with a one-shot startup warn). Common keys: `max_tokens`,
   * `temperature`, `top_p`, `thinking_budget_tokens`.
   */
  modelParams?: Record<string, unknown>;
}

/** A file attachment to include inline alongside the text prompt. */
export interface FileAttachment {
  /** Absolute path inside the container (e.g. /workspace/agent/inbox/msg-id/photo.jpg). */
  path: string;
  /** MIME type (e.g. image/jpeg, application/pdf). */
  mime: string;
  /** Display name shown to the user. */
  filename: string;
}

export interface QueryInput {
  /** Initial prompt (already formatted by agent-runner). */
  prompt: string;

  /**
   * Opaque continuation token from a previous query. The provider decides
   * what this means (session ID, thread ID, nothing at all).
   */
  continuation?: string;

  /** Working directory inside the container. */
  cwd: string;

  /**
   * File attachments to include inline with the prompt. Providers that
   * support multimodal input pass these as native file content parts.
   */
  files?: FileAttachment[];

  /**
   * System context to inject. Providers translate this into whatever their
   * SDK expects (preset append, full system prompt, per-turn injection…).
   */
  systemContext?: {
    instructions?: string;
  };
}

export type McpStdioServerConfig = {
  type?: 'stdio';
  command: string;
  args?: string[];
  env?: Record<string, string>;
  /** Per-server request timeout (ms). Overrides the shared MCP_TOOL_TIMEOUT default. */
  timeout?: number;
};

export type McpHttpServerConfig = {
  type: 'http' | 'sse';
  url: string;
  headers?: Record<string, string>;
  /** Per-server request timeout (ms). Overrides the shared MCP_TOOL_TIMEOUT default. */
  timeout?: number;
};

export type McpServerConfig = McpStdioServerConfig | McpHttpServerConfig;

export interface QueryPushOptions {
  tools?: 'enabled' | 'disabled';
}

export interface AgentQuery {
  /** Push a follow-up message into the active query. */
  push(
    message: string,
    files?: FileAttachment[],
    options?: QueryPushOptions,
  ): boolean;

  /** Signal that no more input will be sent. */
  end(): void;

  /** Output event stream. */
  events: AsyncIterable<ProviderEvent>;

  /** Force-stop the query. */
  abort(): void;
}

/**
 * Per-turn provider usage snapshot. Provider-agnostic — both Claude and
 * OpenCode (and future providers) emit the same shape. Values are
 * per-turn deltas, not session-cumulative.
 */
export interface TurnUsage {
  cost_usd: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  reasoning_tokens?: number;
  num_turns?: number;
  duration_ms?: number;
  duration_api_ms?: number;
  model: string;
  context_window?: number;
  max_output_tokens?: number;
}

/**
 * One step of a turn's activity trace, in structured form. Providers emit
 * these instead of pre-formatted human strings — the presentation ("Using
 * `bash` tool", code block, truncation) is done in the UI layer, as late as
 * possible. `detail` carries the primary raw argument (bash command, grep
 * pattern, file path, url, …) with its newlines INTACT, so the UI can render
 * a real multi-line code block.
 */
export type ActivityStep =
  | {
      kind: 'tool'; id: string; tool: string;
      status: 'pending' | 'running' | 'completed' | 'error';
      detail?: string; title?: string; error?: string; durationMs?: number;
      rejectedBeforeExecution?: boolean;
    }
  | { kind: 'internal'; id: string; text: string }
  | { kind: 'file'; id: string; path?: string; name?: string; mime?: string }
  | { kind: 'patch'; id: string; files: string[] }
  | { kind: 'retry'; id: string; attempt: number; error?: string }
  | { kind: 'compaction'; id: string; auto?: boolean }
  | { kind: 'subtask'; id: string; agent?: string; description?: string }
  | { kind: 'notification'; id: string; text: string };

// Priority-ordered keys we consider the "primary argument" of a tool call.
// Covers both provider naming conventions (opencode `filePath`, Claude
// `file_path`) so neither provider needs a per-tool switch. `content` and
// other bulky fields are deliberately absent — we never ship file bodies.
const ACTIVITY_DETAIL_KEYS = [
  'command', 'pattern', 'query', 'filePath', 'file_path',
  'notebook_path', 'url', 'description', 'prompt', 'path',
];

const TODO_STATUS_LABELS: Record<string, string> = {
  completed: 'Completed',
  in_progress: 'In progress',
  pending: 'Pending',
  cancelled: 'Cancelled',
};

/** Render structured todo-tool input as a compact, safe activity checklist. */
export function formatTodoActivityDetail(input: Record<string, unknown> | undefined): string | undefined {
  if (!Array.isArray(input?.todos)) return undefined;
  const lines = input.todos.flatMap((value) => {
    if (!value || typeof value !== 'object') return [];
    const todo = value as Record<string, unknown>;
    if (typeof todo.content !== 'string' || !todo.content.trim()) return [];
    const status = typeof todo.status === 'string'
      ? TODO_STATUS_LABELS[todo.status] ?? singleWordLabel(todo.status)
      : 'Task';
    const priority = typeof todo.priority === 'string' && todo.priority.trim()
      ? ` (${singleWordLabel(todo.priority)} priority)`
      : '';
    return [`${status}: ${todo.content.trim()}${priority}`];
  });
  return lines.length > 0 ? lines.join('\n') : undefined;
}

function singleWordLabel(value: string): string {
  const label = value.replace(/[_-]+/g, ' ').trim();
  return label ? label[0].toUpperCase() + label.slice(1) : value;
}

/**
 * Provider-agnostic: pick the first string-valued "primary argument" from a
 * tool input, preserving internal newlines (only leading blank lines and
 * trailing whitespace are trimmed). Returns undefined when nothing suitable
 * is present (e.g. `todowrite`).
 */
export function pickActivityDetail(input: Record<string, unknown> | undefined): string | undefined {
  if (!input) return undefined;
  for (const k of ACTIVITY_DETAIL_KEYS) {
    const v = input[k];
    if (typeof v === 'string' && v.trim()) {
      return v.replace(/^\n+/, '').replace(/\s+$/, '');
    }
  }
  return formatTodoActivityDetail(input);
}

export type ProviderEvent =
  | { type: 'init'; continuation: string }
  /**
   * Final turn output. `strippedToEmpty` marks the case where the model's
  * assistant produced recoverable output but no deliverable text (e.g. a
  * reply buried inside an unclosed `<think>`, or an OpenCode completion that
  * stopped mid-reasoning with finish="unknown"). The poll-loop uses this to
  * distinguish an interrupted/swallowed reply (nudge-worthy) from a genuinely
  * silent turn (nothing to recover).
   * Only OpenCode sets it; Claude strips in-loop, so it stays undefined there.
   */
  | {
      type: 'result';
      text: string | null;
      strippedToEmpty?: boolean;
      malformedToolCall?: boolean;
      finishReason?: string;
      recoveredFromUnclosedThink?: boolean;
    }
  | { type: 'error'; message: string; retryable: boolean; classification?: string }
  | { type: 'progress'; step: ActivityStep }
  /**
   * One assistant message finished within the current turn. Emitted purely so
   * the runner can bound degenerate loops: a model that keeps emitting text
   * steps without ever calling a tool is invisible to the tool-based runaway
   * guards, and the provider's prompt loop will step forever. Providers with
   * no per-step message boundary omit it.
   */
  | { type: 'assistant_message' }
  /**
   * Per-turn usage data emitted just before the corresponding `result`
   * event. The poll-loop stashes this and writes it to `turn_usage` in
   * outbound.db once the result row is created.
   */
  | { type: 'usage'; data: TurnUsage }
  /**
   * Provider-private handle for the turn just finished, emitted just before
   * the corresponding `result`. The poll-loop stashes it and writes it to
   * `turn_checkpoints` in outbound.db once the result row is created, where
   * a later fork can find it and cut the provider's session at this exact
   * point. Providers with no server-side session to branch never emit it.
   */
  | { type: 'checkpoint'; ref: string }
  /**
   * Liveness signal. Providers MUST yield this on every underlying SDK
   * event (tool call, thinking, partial message, anything) so the
   * poll-loop's idle timer stays honest during long tool runs.
   */
  | { type: 'activity' };
