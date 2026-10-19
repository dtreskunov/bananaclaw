# NanoClaw Agent-Runner Details

Implementation-level details for the agent-runner inside the container. See [architecture.md](architecture.md) for the high-level design.

## Separation of Concerns

The agent-runner has two layers:

1. **Agent-runner core** — owns the poll loop, message formatting, DB reads/writes, MCP tool implementations, routing, status management, media handling. This is NanoClaw-specific and shared across all providers.

2. **Agent provider** — owns the SDK interaction. Takes formatted prompts, pushes them to the SDK, yields events back. Trunk ships the `claude` provider; additional providers (OpenCode, Codex, etc.) are installed by `/add-<provider>` skills from the `providers` branch.

The boundary: the agent-runner decides **what** to send and **what to do** with results. The provider decides **how** to talk to the SDK.

## AgentProvider Interface

```typescript
interface AgentProvider {
  /** Start a new query. Returns a handle for streaming input and output. */
  query(input: QueryInput): AgentQuery;
}

interface QueryInput {
  /** Initial prompt (already formatted by agent-runner).
   *  String for text-only. ContentBlock[] for multimodal (images, PDFs, audio). */
  prompt: string | ContentBlock[];

  /** Session ID to resume, if any */
  sessionId?: string;

  /** Resume from a specific point in the session (provider-specific, may be ignored) */
  resumeAt?: string;

  /** Working directory inside the container */
  cwd: string;

  /** MCP server configurations (normalized format — provider translates) */
  mcpServers: Record<string, McpServerConfig>;

  /** System prompt / developer instructions */
  systemPrompt?: string;

  /** Environment variables for the SDK process */
  env: Record<string, string | undefined>;

  /** Additional directories the agent can access */
  additionalDirectories?: string[];
}

interface McpServerConfig {
  command: string;
  args: string[];
  env: Record<string, string>;
}

interface AgentQuery {
  /** Optional per-call cancellation, advertised via supportsToolCancellation. */
  stopTool?(toolCallId: string): boolean;

  /** Push a follow-up message into the active query */
  push(message: string): void;

  /** Signal that no more input will be sent */
  end(): void;

  /** Output event stream */
  events: AsyncIterable<ProviderEvent>;

  /** Force-stop the query (e.g., container shutting down) */
  abort(): void;
}

type ProviderEvent =
  | { type: 'init'; sessionId: string }
  | { type: 'result'; text: string | null }
  | { type: 'error'; message: string; retryable: boolean; classification?: string }
  | { type: 'progress'; message: string };
```

### What the interface does NOT include

- **Message formatting** — the agent-runner formats messages before passing to the provider. The provider receives a ready-to-send prompt string.
- **Hooks** — Claude-specific. The Claude provider registers hooks internally (PreCompact, PreToolUse, etc.). Other providers don't need them.
- **Tool allowlists** — Claude uses `allowedTools`. Codex uses `approvalPolicy`. OpenCode uses `permission`. Each provider configures this internally based on the same intent: "allow everything, no prompting."
- **Session persistence** — Claude persists sessions to disk automatically. Codex and OpenCode manage their own session state. The agent-runner doesn't control this — it just passes `sessionId` and `resumeAt`.
- **Sandbox configuration** — provider-specific. Each provider configures its own sandbox internally.

### Provider event semantics

- **`init`** — emitted once per query when the provider establishes or resumes a session. The agent-runner captures `sessionId` for future resume.
- **`result`** — emitted when the agent produces a complete response. May be emitted multiple times per query (e.g., Claude's multi-turn with subagents). The agent-runner writes each result to messages_out. Providers that declare `structuredReplies` (native) attach structured `replies` / `silence` instead of text to parse.
- **`error`** — emitted on failure. `retryable` indicates whether the agent-runner should retry. `classification` is optional detail (e.g., 'quota', 'auth', 'transport').
- **`progress`** — optional, for logging. The agent-runner logs these but doesn't act on them.
- **`model_request`** — optional, emitted immediately before each model request by providers that declare `reportsModelRequests` (native). The runner records a zero-length `model:ready:<turnId>` activity step at the turn's first request, so the UI's AI stopwatch excludes queueing and turn setup. For other providers the marker is recorded at `init` and, on warm follow-up turns, at turn start.

Terminal provider failures also append a notification to the current turn's
activity trace, with the error detail. After an unrecoverable thrown query error,
the existing fresh-session acknowledgement query records **Asking model to
explain failure**, followed by whether model output, a system notice, or no
response was recorded. This does not retry the original request, replace its
continuation, or change its failed outcome. Returned provider errors keep their
system-notice path; transparent stale-session retries and errors on an already
settled warm transport do not add terminal-failure entries. These entries are
recorded prospectively, without rewriting historical traces.

## Provider Implementations

Only the `claude` provider ships in trunk. The Codex and OpenCode sections below document the provider interface for reference and for skills that install additional providers — they are not baked into the core image.

### Claude Provider

Wraps `@anthropic-ai/claude-agent-sdk`'s `query()`.

```typescript
class ClaudeProvider implements AgentProvider {
  query(input: QueryInput): AgentQuery {
    const stream = new MessageStream();  // AsyncIterable<SDKUserMessage>
    stream.push(input.prompt);

    const sdkQuery = query({
      prompt: stream,
      options: {
        cwd: input.cwd,
        resume: input.sessionId,
        resumeSessionAt: input.resumeAt,
        systemPrompt: input.systemPrompt
          ? { type: 'preset', preset: 'claude_code', append: input.systemPrompt }
          : undefined,
        mcpServers: input.mcpServers,  // already the right shape
        additionalDirectories: input.additionalDirectories,
        env: input.env,
        allowedTools: NANOCLAW_TOOL_ALLOWLIST,
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        hooks: {
          PreCompact: [{ hooks: [preCompactHook] }],
          PreToolUse: [{ matcher: 'Bash', hooks: [sanitizeBashHook] }],
        },
      },
    });

    return {
      push: (msg) => stream.push(msg),
      end: () => stream.end(),
      abort: () => sdkQuery.close(),
      events: translateClaudeEvents(sdkQuery),
    };
  }
}
```

`translateClaudeEvents` is an async generator that maps SDK messages to `ProviderEvent`:
- `message.type === 'system' && message.subtype === 'init'` → `{ type: 'init', sessionId }`
- `message.type === 'result'` → `{ type: 'result', text }`
- `message.type === 'system' && message.subtype === 'api_retry'` → `{ type: 'error', retryable: true }`
- `message.type === 'system' && message.subtype === 'rate_limit_event'` → `{ type: 'error', retryable: false, classification: 'quota' }`
- `message.type === 'system' && message.subtype === 'task_notification'` → `{ type: 'progress', message }`
- Everything else → logged, not emitted

**Claude-specific features preserved inside the provider:**
- `MessageStream` for async iterable input (push-based)
- `resumeSessionAt` for resume at specific message UUID
- PreCompact hook for transcript archiving
- PreToolUse hook for sanitizing bash env vars
- Full tool allowlist
- `additionalDirectories` for multi-directory access

### Codex Provider

Wraps `@openai/codex-sdk`.

```typescript
class CodexProvider implements AgentProvider {
  query(input: QueryInput): AgentQuery {
    const codex = new Codex(this.buildOptions(input));
    const thread = input.sessionId
      ? codex.resumeThread(input.sessionId, this.threadOptions(input))
      : codex.startThread(this.threadOptions(input));

    const abortController = new AbortController();
    let pendingFollowUp: string | null = null;

    return {
      push: (msg) => {
        // Codex doesn't support streaming input.
        // Store the follow-up and abort the current turn.
        pendingFollowUp = msg;
        abortController.abort();
      },
      end: () => { /* no-op — Codex turns end naturally */ },
      abort: () => abortController.abort(),
      events: this.run(thread, input.prompt, abortController, () => pendingFollowUp),
    };
  }

  private async *run(thread, prompt, abortController, getPendingFollowUp): AsyncIterable<ProviderEvent> {
    let currentPrompt = prompt;

    while (true) {
      try {
        const streamed = await thread.runStreamed(currentPrompt, {
          signal: abortController.signal,
        });

        let sessionId: string | undefined;
        let resultText = '';

        for await (const event of streamed.events) {
          if (event.type === 'thread.started') {
            sessionId = event.thread_id;
            yield { type: 'init', sessionId };
          }
          if (event.type === 'item.completed' && event.item.type === 'agent_message') {
            resultText = event.item.text || resultText;
          }
          if (event.type === 'turn.failed') {
            yield { type: 'error', message: event.error.message, retryable: false };
            return;
          }
        }

        yield { type: 'result', text: resultText || null };

        // Check if a follow-up was queued during this turn
        const followUp = getPendingFollowUp();
        if (followUp) {
          currentPrompt = followUp;
          // Reset for next iteration
          continue;
        }

        return;
      } catch (err) {
        if (abortController.signal.aborted && getPendingFollowUp()) {
          // Aborted because of follow-up — restart with new prompt
          currentPrompt = getPendingFollowUp();
          abortController = new AbortController();
          continue;
        }
        throw err;
      }
    }
  }
}
```

**Codex-specific behavior inside the provider:**
- `developer_instructions` for system prompt (loaded from CLAUDE.md)
- `git init` in workspace (Codex requires a git repo)
- Abort+restart pattern for follow-up messages
- `sandboxMode`, `approvalPolicy`, `networkAccessEnabled` from env vars
- Conversation archiving (Codex doesn't have PreCompact)

### OpenCode Provider

Wraps `@opencode-ai/sdk`.

```typescript
class OpenCodeProvider implements AgentProvider {
  query(input: QueryInput): AgentQuery {
    // OpenCode runs a local server — create it once, reuse across queries
    const { client, server } = await createOpencode({ config: this.buildConfig(input) });
    const { stream } = await client.event.subscribe();

    let aborted = false;
    let pendingFollowUp: string | null = null;

    return {
      push: (msg) => {
        pendingFollowUp = msg;
        server.close();  // interrupt current query
      },
      end: () => { /* no-op */ },
      abort: () => { aborted = true; server.close(); },
      events: this.run(client, server, stream, input, () => pendingFollowUp),
    };
  }

  private async *run(client, server, stream, input, getPendingFollowUp): AsyncIterable<ProviderEvent> {
    const session = await client.session.create();
    yield { type: 'init', sessionId: session.data.id };

    await client.session.promptAsync({
      path: { id: session.data.id },
      body: { parts: [{ type: 'text', text: input.prompt }] },
    });

    for await (const event of stream) {
      if (event.type === 'session.idle') {
        // Collect result text from accumulated message parts
        const resultText = this.extractResult(event);
        yield { type: 'result', text: resultText };

        const followUp = getPendingFollowUp();
        if (followUp) {
          await client.session.promptAsync({
            path: { id: session.data.id },
            body: { parts: [{ type: 'text', text: followUp }] },
          });
          continue;
        }

        return;
      }

      if (event.type === 'session.error') {
        yield { type: 'error', message: event.properties?.error?.data?.message, retryable: false };
        return;
      }
    }
  }
}
```

**OpenCode-specific behavior inside the provider:**
- Local gRPC/HTTP server lifecycle (`server.close()`)
- SSE event stream for output
- Provider/model selection via config (`OPENCODE_PROVIDER`, `OPENCODE_MODEL`)
- MCP config format translation (`type: 'local'`, `command: [cmd, ...args]`, `environment`)
- System prompt injected via `<system>` prefix in prompt text
- No resume support (sessions are always new or reused by ID)

### Native Provider: File and Shell Tools

The native provider's `read`, `write`, and `edit` tools accept absolute paths
or paths relative to the agent workspace, including paths outside it.
Symlinks follow normal filesystem behavior. The `patch` tool accepts Git-style
unified diffs with `a/` and `b/` file headers; paths after those prefixes may
also be absolute or relative to the workspace, including `../` paths.
It checks the entire patch before applying it.

These tools have the same filesystem access boundary as `bash`: the agent
container's mounts and operating-system permissions, not a tool-level workspace
allow-list. Read-only mounts remain read-only. The read size limit, exact-match
edit validation, and shell output/time limits still apply.

`glob` and `grep` accept an optional `path` argument selecting a directory to
search. It may be absolute or relative to the workspace, including outside
directories. Omitting it preserves workspace-only search. Results use paths
relative to the selected directory. Existing ignored directories, file-size
limits, and the 200-result cap are unchanged.

For example, `glob({ pattern: "*.txt", path: "/tmp" })` lists matching files
under `/tmp`, and `grep({ query: "needle", path: "../shared" })` searches a
sibling directory.

### Native Provider: Viewing local media

The native provider exposes these local-file tools when the model catalog
and selected adapter both support the input modality:

| Tool | Model input capability | Adapters | Accepted file formats |
| --- | --- | --- | --- |
| `view_image({ path })` | `image` | OpenAI Chat, Anthropic Messages | JPEG, PNG, GIF, WebP |
| `view_pdf({ path })` | `pdf` | OpenAI Chat, Anthropic Messages | PDF |
| `listen_audio({ path })` | `audio` | OpenAI Chat | WAV, MP3 |
| `view_video({ path })` | `video` | OpenAI Chat | MP4, WebM |

All four tools use the same registration, file reader, schema, budget validation,
and model-output path. They accept absolute paths, workspace-relative paths,
temporary browser artifacts, and symlinks within the container filesystem
boundary. They check file signatures rather than extensions and return the
**original bytes unchanged**, with source path and MIME metadata through the
AI SDK's `toModelOutput`. Unknown model capabilities and unsupported
adapter/modality combinations do not advertise the corresponding tool.
The model's media instructions are composed from the actual enabled tool set,
so unsupported tools are not mentioned. With no available media tools (including
disabled or wrap-up steps), the entire media-guidance section is omitted.
They do not render PDF pages, transcode audio/video, transcribe speech, extract
frames, call a second model, or provide text-only fallbacks. Audio in other
containers is rejected even though incoming user attachments may use the
separate audio-normalization path. Signature checks are not full decoding;
malformed or model-incompatible content can still be rejected by the provider.

OpenAI Chat cannot embed media in tool responses. The `tool-media.ts` middleware
moves image, PDF, audio, and video file outputs into adjacent user content after
all associated tool results, regardless of which tool produced them (including
MCP tools). Every moved part uses the same `Media returned by tool` metadata.
This changes only the wire representation, not saved history or input receipts.
Images use `image_url`, PDFs native file blocks, audio `input_audio`, and video
`video_url` with inline original bytes. Anthropic receives supported image/PDF
content directly in tool results. Unsupported non-media file results remain
unchanged; adapter or model rejections surface through normal error handling.

All four tools share the existing 16 MiB encoded inline-media budget, including
attachments, replayed history, and parallel tool calls. Invalid budgets use one
generic media error, and every modality uses the same over-budget guidance.
Limits, unstable files, and filesystem failures are explicit tool errors.
Media pressure reuses context-overflow recovery, including its two-attempt
per-turn bound, cancellation, usage accounting, protected inputs, and activity
events. New attachments and steering inputs are prepared again after compaction,
before ingestion or acknowledgement. A budget-blocked tool finishes its exchange
first; the runner then compacts and guides the model to retry only that failed
tool, never completed actions. Over-budget history is also compacted before the
next request. Files larger than the entire budget cannot benefit from compaction.
Protected/recent media can prevent recovery; failures and exhaustion are surfaced
without dropping protected inputs.

Successful multimodal results are snapshotted in incremental checkpoints and
final history, so resume does not require the source file. Compaction retains
the full original transcript but can omit older media from active context.
Reopening then requires the source path to still exist; files needed later should
be saved in the workspace because temporary container files disappear on exit.
No media is automatically reread or attached.

### Native Provider: Automatic and context-overflow compaction

The native provider automatically compacts at **75% context utilization**,
using the latest successful normal model step's prompt (including cached
input) plus output, not cumulative billing tokens or the rounded UI percentage.
The check runs between completed model/tool steps, after journaling their
results, only when another generation is needed. A final answer is delivered
without trailing compaction. Missing usage or an unknown model window disables
this proactive trigger, not emergency recovery. Utilization is not persisted:
the first successful step after a resume establishes a new measurement.

Each turn permits two proactive attempts, retaining the latest three exchange
groups. Successful compaction invalidates the triggering measurement; summary
calls cannot retrigger it. A failed proactive attempt emits an error activity
and notification, preserves the active context, and disables further proactive
attempts for that turn while normal generation continues. Reaching the
proactive limit emits a notification and does not itself fail the turn.
Per-turn policy owns eligibility, suppression, and the two attempt budgets;
the shared executor only runs the selected plan and reports its lifecycle.
Activity ordinals derive from the sum of proactive and emergency attempts,
without a separate sequence counter.

Recognized context rejections, including MiniMax's
`context window exceeds limit (2013)`, trigger automatic compaction inside the
native provider. Unrelated authentication, validation, and rate-limit errors
do not. Recovery retries only the rejected model step, keeps the same turn and
continuation, and shares a separate two-attempt emergency budget with inline
media recovery. Proactive attempts do not consume this budget. A rejected step
that already streamed text or tool execution is not automatically retried.

The full native transcript and checkpoint IDs remain unchanged. A persistent
`context_compactions` projection supplies a model-generated factual summary
plus recent history on subsequent requests and container resumes. Current input
and applied steering are retained verbatim; assistant tool calls and their
results are kept or summarized together. Forks still copy the original
checkpoint-bounded transcript, never a summary from a later point in time.

Summarization uses the current model with no tools. Transcript fragments omit
inline media bytes, not the archived originals, and the prompt preserves
completed actions, results, file paths, constraints, pending work, and unknown
side effects. Budgeted chronological chunks are summarized independently with
at most two concurrent requests, then reduced to one continuation summary.
Complete exchanges stay together where possible; oversized exchanges split
into labelled, ordered fragments carrying message and tool identities. The
originals are never truncated. Intermediate summaries remain temporary; only
the validated final summary is activated atomically.

A single chronological chunk that fits the final-request budget is summarized
directly with the final output allowance, avoiding an intermediate summary and
reduction call. A single leaf that fits only the larger intermediate request
budget still uses the two-stage path. Packing counts each fragment's UTF-8
bytes once and joins text only when closing a chunk, rather than repeatedly
scanning growing prefixes.

There is no model-specific tokenizer dependency. Request sizing conservatively
counts UTF-8 bytes as estimated tokens, with room for instructions, protocol
framing, and output. The combined request budget is the smaller of 128,000
estimated tokens or 25% of the model window (32,768 when unknown). Intermediate
output is capped at 2,048 tokens and final output at 8,192 tokens, additionally
bounded by model capability and one-sixteenth of the request budget. Summary
text must also fit a byte cap of four times its requested visible output tokens.

For catalog-declared reasoning models (and MiniMax-M3.1-Flash-Preview even when
metadata is unavailable), generation allowances include an additional reasoning
reserve: at most 8,192 tokens or one-sixteenth of the request budget. An empty,
length-limited response reporting reasoning gets one retry with twice that
reserve, provided the model output cap permits an increase. Source packing
reserves the larger allowance from the start. Both calls count toward the
64-request limit and share the overall deadline; visible summary targets and
byte caps do not grow. Reported visible tokens are checked separately when
reasoning usage is available.

MiniMax-M3.1-Flash-Preview summaries use low effort (`output_config.effort` for
Anthropic, `reasoning_effort` for Chat Completions), without changing normal
generation settings. This model cannot disable thinking, and thinking consumes
the generation allowance; see the [MiniMax compatibility documentation](https://platform.minimax.io/docs/api-reference/text-anthropic-api).
Summary diagnostics record request number, finish reason, output/reasoning
tokens, visible bytes and limits, never transcript or reasoning content.
Empty and oversized failures have distinct messages with these measurements.

Each compaction has a five-minute deadline, 60-second request timeouts, at most
32 leaf chunks, and at most 64 model requests, counting rejections and reduction.
There are no hidden SDK retries. A context-specific summarizer rejection splits
the offending request and summarizes its ordered fragments within the same
limits; other provider errors are surfaced without splitting. Work exceeding
the leaf limit is rejected before model calls. Empty, oversized, non-reducing,
failed, or cancelled summaries are not saved. Exhausted emergency recovery
surfaces an explicit provider failure rather than silently dropping history.

Compaction is recorded as its own activity with running/completed/failed/
interrupted lifecycle states and duration, including failed attempts. Its
model calls, usage, and cumulative model time are included in turn accounting
exactly once through the same call-end recorder as normal generations.
Occupancy is updated separately after a normal model/tool step settles;
summarization occupancy never replaces it, including partial reports on failure.
Concurrent request durations can sum to more than wall-clock time. Completion details
report source bytes and model request count. Existing lifecycle fields are
reused; no host protocol or database migration is needed.

Provider failure notices distinguish an unfinished turn from no execution:
completed native tool actions remain in the transcript and their effects are
not rolled back. Interrupted tools retain uncertain outcomes. Fallback
explanations and failed-turn replay instructions likewise avoid blindly
repeating completed actions.

### Native Provider: External MCP Tools

Group MCP entries can be configured through the admin CLI for any provider:

```bash
# Command-based transport (default)
ncl groups config add-mcp-server --id <group> --name local --command node --args '["server.js"]'

# Streamable HTTP; --transport http is an alias for --type http
ncl groups config add-mcp-server --id <group> --name remote --type http --url https://example.net/mcp

# Legacy SSE is also available with --type sse
```

Remote entries accept `--headers '<json-object>'`; stdio accepts `--env` and
`--args`. `--instructions` and `--timeout <milliseconds>` apply to both. Timeout
must be an integer from 1000 to 600000 ms; use a longer timeout for MCP calls
that wait for human approval, leaving execution headroom in the tool's own wait.
Use only verified credential-manager
placeholders, never raw secrets in CLI arguments or agent-visible configuration.
Changing an existing remote URL clears its old headers unless explicitly supplied;
re-adding the same URL preserves headers, instructions, and timeout. Other server
entries remain unchanged. Mixed stdio/remote arguments are rejected.

Agent-initiated changes require the existing administrator approval. Restart the
group afterward to load its updated MCP configuration; no image rebuild is needed.

The native provider (`providers/native.ts`) runs its built-in tools in-process
and connects to the group's external MCP servers itself
(`native/mcp-client.ts`). Each discovered tool is exposed as
`mcp__<server>__<tool>`.

External MCP tools are loaded on demand by default (`native/tool-search.ts`):

- `model_params.mcp_tool_search` accepts `always` (default, also `true`) or
  `never` (also `false`). `never` discovers all external tools eagerly and
  sends every tool definition on every model step.
- In `always` mode discovery itself is lazy: the first model request sees
  built-ins, `tool_search`, and configured server names/prefixes without
  connecting to external servers. An ordinary conversational turn never pays
  MCP startup cost. `tool_search` takes keywords, or
  `select:<name>[,<name>...]` for exact names, and loads matching tools for
  the next step.
- `tool_search` also accepts an optional exact `server` name. A targeted
  search or fully qualified `select:mcp__<server>__<tool>` discovers only
  that server; unscoped keywords and bare selections search all configured
  servers. Concurrent discovery shares a per-server promise. Successful
  catalogs/connections are reused within the query, not persisted across
  containers. Lazy discovery failures are explicit tool errors, not empty
  search results; a subsequent search can retry.
- A direct call to a catalog tool that is not loaded yet is rewritten into a
  `tool_search` select, so the model sees it loaded instead of an error.
- The loaded set is rebuilt from the conversation history on each turn: MCP
  tool calls plus `tool_search` results. It keeps the 30 most recently used
  tools, so it needs no extra state and follows forks and edits.

```bash
ncl groups config set-param --id <group> --key mcp_tool_search --value always
```

### Native Provider: Stopping one tool

Native queries advertise `supportsToolCancellation` and implement
`stopTool(toolCallId)`. The turn journal gives each announced/executing call its
own abort controller, combined with the query's signal. Stopping one call
aborts only that controller, including a request arriving just before execution.
Shell tools terminate their own process group; MCP clients cancel only the
corresponding request without closing the shared server connection.

An interrupted call is persisted as a valid tool-call/error-result pair and
reported to the model as an unknown outcome with a warning about possible
external side effects. The model continues within the same turn; other calls,
steering and queued inputs are untouched. Calls already completed cannot be
cancelled. Tools that complete despite cancellation retain their actual result.
Whole-query `abort('user')` and status-row Stop retain whole-turn cancellation.

### Native Provider: Final Message

Other providers end a turn with final text that must wrap each delivery in
`<message to="name">` blocks, with runner nudges when the wrapping is missing.
  In `always` mode history restoration never triggers discovery: after a
  query/container restart, the agent searches again before calling an external
  tool. Known history tools become available as their server is discovered.

Runner logs report native preparation time split into model setup, input
preparation, and eager MCP discovery, plus per-server connection and complete
paginated `tools/list` timings. These diagnostics contain server names, counts,
and durations, not endpoints, headers, arguments, or tool definitions. They do
not change the UI's authoritative model-readiness timestamp.
The native provider declares `structuredReplies` and uses a simpler contract:
**the final message is the reply.**

- The text of the step that ends the turn (a step with no tool calls) is sent
  verbatim to the conversation being answered.
#### Removing the native auto MCP mode

`auto` and the catalog-size heuristic have been removed. Groups with no
`mcp_tool_search` setting now use lazy `always` mode; explicit `never`/`false`
continues to expose tools directly. This changes startup/tool-search behavior,
not credentials or tool permissions.

- **Detect:** inspect `ncl groups config get --id <group>` for an explicit
  `model_params.mcp_tool_search: "auto"`. Unset values also change default.
- **Fix:** replace explicit `auto` with `ncl groups config set-param --id <group>
  --key mcp_tool_search --value always`, or choose `never` if that group requires
  eager direct tools. No database/schema migration is needed, and the runner
  does not rewrite stored settings. Retired/invalid values emit a warning and
  use `always`, rather than silently selecting a heuristic.
- **Verify:** restart the affected group with `ncl groups restart --id <group>`,
  send a new message, and check runner logs for `mcpMode:"always"` plus lazy
  discovery. Check that explicit `never` exposes external tools directly.
- **Rollback:** set `never` and restart to restore eager direct tools. To restore
  the old size-dependent behavior itself, restore the earlier runner source and
  explicitly set `auto`; this release no longer implements that behavior.

- Text written alongside tool calls is working notes and is never delivered.
- `send_message` (with `to`) covers other destinations and mid-turn updates.
- `no_reply({ reason })` (`native/reply.ts`) ends the turn without sending
  anything. Its reason, not the tool call, goes to the activity trace, and
  no empty-result notice is shown.

Recovery happens inside the provider's step loop:

- **Steering.** If guidance is applied after a final message, that message
  is a superseded draft: it stays in history but is not sent, and the next
  final message answers both.
- **Pointer reply.** A short final message like "see above", sent after at
  least 400 characters of undelivered text, is delivered as is; the runner
  only logs a warning (`final message may point at`) to measure how often
  it happens.
- **Step limit.** A turn runs at most 100 model steps (`MAX_STEPS`). If the
  model is still calling tools at the limit, one more step runs with no tools
  and a transient instruction to report what was done and what remains.

There is no `reply` tool: MiniMax ignores `tool_choice` and prefers to end
with plain text, so a tool-based reply was mostly bypassed anyway.

The `result` event carries `replies` (and `silence`), and the poll loop sends
them verbatim to the conversation being answered, without parsing tags or
nudging. Native histories written under the old wrap contract were rewritten
once to drop `<message>`/`<internal>` tags, so the model has no examples to
copy. The native prompt swaps the shared `module-core.md` fragment for
`native/core.md`, and the destinations section for a final-message version.

## Agent-Runner Core

Everything below is handled by the agent-runner, not the provider.

### Poll Loop

```
┌─────────────────────────────────────────┐
│                                         │
│  1. Query messages_in for pending rows  │
│     WHERE status = 'pending'            │
│     AND (process_after IS NULL          │
│          OR process_after <= now())     │
│                                         │
  Each normal step's system prompt includes budgeting guidance and a live
  used/remaining counter derived from `MAX_STEPS` and `stepsCompleted`. Steps
  count model rounds, not individual tool calls; a round can call multiple
  tools. The guidance recommends batching safe repetitive work, changing
  unproductive strategies, and reserving the last 10 steps for saving,
  verification, and a clear handoff. At 10 or fewer remaining steps, it
  explicitly tells the model to stop expanding scope; the final tools-disabled
  step reports zero remaining and asks for verified progress and next steps.
  The counter is not persisted in conversation history, survives compaction
  and steering without resetting, and resets for the next turn. Turns whose
  tools were disabled up front do not advertise this tool-use budget.
│  2. If rows found:                      │
│     a. Set status = 'processing'        │
│     b. Format messages by kind          │
│     c. Strip routing fields             │
│     d. Call provider.query(prompt)      │
│     e. Process provider events          │
│     f. Write results to messages_out    │
│     g. Set status = 'completed'         │
│                                         │
│  3. While query is active:              │
│     - Continue polling messages_in      │
│     - New messages → provider.push()    │
│                                         │
│  4. When query finishes:                │
│     - Back to step 1                    │
│     - If no messages, sleep + re-poll   │
│                                         │
└─────────────────────────────────────────┘
```

**Input during an active query:** Host-event notifications wake the runner's
follow-up watcher. Ordinary input waits until the current turn finishes before
`query.push()` starts another turn. Native alone advertises `supportsSteering`
and provides `query.steer({ id, prompt, files })`: eligible input can join the
current turn at a safe model/tool-step boundary. Web chat asks whether to steer
(default) or queue; external-channel chat steers automatically only within the
same conversation. Other providers retain queued follow-ups. A
`steering_applied` event associates the persisted guidance with the existing
turn's completion batch; acceptance alone never completes the message.
That acknowledgement also appends a normal **Steering message injected**
activity notification, with a distinct step ID and a durable position after the
input's consumption position. Its `detail` carries the steering message text,
not the prompt's routing/context wrappers, with the normal 2,000-character cap.
Existing notification rendering and persistence
handle it; queued/unapplied inputs and startup receipt recovery do not invent
injection events.
See [session-link.md](session-link.md#steering-native-provider) for durability,
recovery, exclusions, and rollout requirements.

**Pending queue and transcript order:** Active-turn follow-ups that remain queued
carry `queuedForNextTurn: true` in their durable input state, including inputs
released by Stop. Ordinary first, unclaimed inputs do not receive this flag.
Queued and accepted-but-unapplied steering inputs have no transcript position.
At the first processing claim (or `steering_applied` event), the runner assigns
an immutable `timelinePosition`; retries and recovery preserve it. Consumption
clears the queue flag; already-consumed retries never regain pending controls.
All outbound content, including tool sends and Stop
notices, receives a position from the same runner-private `timeline_clock`.
The clock allocates `max(Date.now() * 1000, previous + 1)`, preserving order
within a millisecond and across backwards wall-clock changes or restarts.
Schema initialization raises the clock floor to inherited input/output positions
when loading a fork or imported history, without lowering an existing clock.
Input positions are committed with their claims before provider execution;
thus a queued follow-up appears after the preceding final response but before
its own output. Actual message timestamps and sequence IDs remain unchanged.
The follow-up watcher enforces the result boundary for every provider, even
those whose `push()` accepts in-flight work; acceptance alone is not consumption.

**Editing pending web input:** Native also advertises `supportsInputEditing`.
Durable system `edit_input` requests bypass the prompt cap and are processed
synchronously before either initial claiming or follow-up/steering selection;
they never enter model prompts. The runner checks the original sender/routing,
pending status, processing acknowledgements, native ingestion journal and
expected text. Only `content.text` changes; attachments, IDs, ordering and
queue/steer intent remain intact. Buffered steering uses synchronous
`query.replaceSteering`; IDs are locked before attachment preparation yields,
so edits lose the race once preparation or ingestion starts. Receipts live in
`session_state` under `input-edit:<requestId>` and use the existing durable
`state.upsert` journal. Replayed requests return their original receipt without
reapplying text. The host projects accepted edits from its original request,
not arbitrary text supplied by the runner.
Runner-private `claimed_inputs` records are committed with processing claims
and never removed by retry cleanup; startup also retains legacy acknowledgements
before clearing them. Thus delayed edits cannot rewrite previously claimed
ordinary input after a crash, even when it is pending for retry.

**Canceling pending web input:** Native advertises `supportsInputCancellation`.
System `cancel_input` commands share the edit-control lane and never enter model
prompts. The same author, routing, claim and ingestion guards apply. Buffered
guidance is removed with `query.cancelSteering` only before preparation starts;
the active query is not aborted. The runner commits a terminal `cancelled` input
disposition and completed acknowledgement alongside an immutable
`input-cancel:<requestId>` receipt. No timeline position is allocated. A failed
commit after changing the provider buffer aborts the query rather than allowing
in-memory state to diverge silently. Replayed commands retain the original result,
and cancellation cannot be undone by retry cleanup or a subsequent edit.

**Idle behavior:** When no messages are pending, the runner waits for a host
event or the next scheduled due time. The container stays warm until the host
kills it (idle timeout).

**Idle detection exceptions:** The container should NOT be considered idle when:
- An `ask_user_question` tool call is pending (waiting for user response in messages_in)
- The agent is actively working (tool calls in progress, subagents running)

The agent-runner sends heartbeat, activity, progressive usage, and turn
completion over its private per-session Unix socket. The host uses the latest
accepted signal timestamp for typing freshness and stuck-container detection.

**Code layout:** `processQuery` in `poll-loop.ts` keeps upstream NanoClaw's
signature and section order (state → follow-up poll → event loop → catch/finally)
so upstream changes merge with few conflicts. Fork-only behavior lives in
`src/query/` and is reached from call sites marked `// FORK-HOOK:<name>`:

| Module                 | Owns                                                                          |
| ---------------------- | ----------------------------------------------------------------------------- |
| `recovery.ts`          | Delivery/malformed-tool/post-tool retries at each `result`; terminal notices   |
| `runaway-guard.ts`     | Per-turn loop backstops (duplicate sends, identical tool streaks, text steps)  |
| `steering.ts`          | Offering, applying and releasing native steering; published turn capabilities |
| `accounting.ts`        | Usage/checkpoint capture and flush at the result boundary; live-state reset   |
| `follow-up-watcher.ts` | Host-event/due-time wakeups, poll coalescing, fatal inbound-DB errors         |
| `notices.ts`           | "Stopped by user." finalization and warning rows for undelivered turns        |

Fork-only options (`provider`, `persistContinuation`, `promptTracker`,
`onBatchComplete`, `execution`, `deferFailureSettlement`) travel in the trailing
`fork` object instead of extra positional parameters.

### Message Formatting

The agent-runner transforms messages_in rows into a prompt string. The provider receives a ready-to-send string — it doesn't know about message kinds or routing.

**Routing context:** Channel routing fields and thread IDs stay in the runner.
Peer-agent inputs expose the source group ID as `sender_agent_id` (identity,
not a destination). A configured peer reply destination is named in `from`.
Without one, `from` is omitted and `reply_allowed="false"` marks the message
as one-way. A per-batch routing hint forbids inventing a reply address or
substituting the session's human channel. This does not grant reverse access.
Host-origin system messages retain their existing no-`from` formatting.

**Final-response recovery:** Bare final text remains scratchpad, not an
automatic channel delivery. If a tool sent content elsewhere but the final
confirmation is unwrapped (or was stripped as reasoning), the runner requests
a reporting-only correction with tools disabled and cross-destination message
blocks rejected during that correction. Only content on the same
channel, platform, and thread counts as an already-emitted reply for this
recovery decision. Completed actions are not repeated; unsupported or
exhausted recovery surfaces a report-failure notice. Same-route sends,
destination-aware duplicate suppression, and intentionally silent off-route
sends retain their existing behavior.

**Sender attribution:** The formatter uses `sender_user_id` when canonical attribution is available, otherwise `sender_identity`, otherwise an unknown sender. It does not infer identity from `content.senderId`, `content.author.userId`, or display names.

**Single message formatting by kind:**

- **`chat`** — format into message XML:
  ```xml
  <message sender="John" time="2024-01-01 10:00">
    Check this PR
  </message>
  ```

- **`chat-sdk`** — extract fields from serialized Chat SDK message:
  ```xml
  <message sender="John (john@slack)" time="2024-01-01 10:00">
    Check this PR
    [image: screenshot.png — https://signed-url...]
  </message>
  ```
  Attachments are listed inline. Images/PDFs that Claude handles natively are passed as content blocks (see Media Handling below).

- **`task`** — task prompt, optionally with script output:
  ```
  [SCHEDULED TASK]

  Script output:
  {"data": ...}

  Instructions:
  Review open PRs
  ```

- **`webhook`** — webhook payload:
  ```
  [WEBHOOK: github/pull_request]

  {"action": "opened", "pull_request": {...}}
  ```

- **`system`** — host action result (response to an earlier system request):
  ```
  [SYSTEM RESPONSE]

  Action: register_agent_group
  Status: success
  Result: {"agent_group_id": "ag-456"}
  ```

**Batch formatting:** Multiple pending messages are combined into one prompt:

```xml
<context timezone="America/Los_Angeles">
<messages>
<message sender="John" time="10:00">Check this PR</message>
<message sender="Jane" time="10:01">Already on it</message>
</messages>
```

Mixed kinds (e.g., a chat message + a system response) are combined with clear delimiters. Each section is labeled by kind.

**Command detection:** Messages starting with `/` are checked against a command list. Recognized commands bypass formatting and are passed raw to the provider (for Claude's slash command handling) or intercepted by the agent-runner (for NanoClaw-level commands like session reset).

### Routing

When the agent-runner picks up messages_in rows, it captures the routing fields from the batch:

```typescript
interface RoutingContext {
  platformId: string | null;
  channelType: string | null;
  threadId: string | null;
  inReplyTo: string | null;  // messages_in.id of the triggering message
}
```

When writing messages_out (either from provider results or MCP tool calls), the agent-runner copies this routing context by default. The agent never sees routing fields — it just produces text. The routing is implicit: "respond to whoever sent the message."

MCP tools that target a different destination (e.g., `send_to_agent`, `send_message` with explicit channel) override the routing context for that specific messages_out row.

An explicit agent destination can still inherit the current batch's `inReplyTo`. The host treats that as an exact reply only when the referenced inbound came from the selected target agent. References to channel messages or other agents do not become return routes; those messages are group-level sends.

### Status Management

The agent-runner manages the `status` and `status_changed` fields on messages_in:

```
pending → processing → completed
                    → failed (if provider returns error and max retries exhausted)
```

- **Pick up:** `UPDATE messages_in SET status = 'processing', status_changed = now(), tries = tries + 1 WHERE id IN (...)`
- **Complete:** `UPDATE messages_in SET status = 'completed', status_changed = now() WHERE id IN (...)`
- **Error:** Agent-runner does NOT set `failed` — it leaves the message as `processing`. The host detects stale processing via `status_changed` and handles retry logic (reset to pending with backoff). This keeps retry policy on the host side.

### MCP Tools

The agent-runner runs an MCP server that exposes NanoClaw tools to the agent. All tools write to the session DB.

**DB path:** The MCP server receives the session DB path via environment variable. It opens a second connection to the same SQLite file (WAL mode allows concurrent access).

#### send_message

Send a chat message to the current conversation (or a specified destination).

```typescript
{
  name: 'send_message',
  params: {
    text: string,          // message content
    channel?: string,      // optional: target channel type (default: reply to origin)
    platformId?: string,   // optional: target platform ID
    threadId?: string,     // optional: target thread ID
  }
}
```

Implementation: write a `messages_out` row with `kind: 'chat'`. If channel/platformId/threadId are provided, use those as routing. Otherwise, copy from the current routing context.

#### send_file

Send a file to the current conversation.

```typescript
{
  name: 'send_file',
  params: {
    path: string,          // file path (relative to /workspace/agent/ or absolute)
    text?: string,         // optional accompanying message
    filename?: string,     // display name (default: basename of path)
  }
}
```

Implementation:
1. Generate a message ID
2. Create `outbox/{messageId}/` directory
3. Copy the file into the outbox directory
4. Write a `messages_out` row with `files: [filename]` in the content

#### send_card

Send a structured card (interactive or display-only).

```typescript
{
  name: 'send_card',
  params: {
    card: CardElement,     // card structure (title, children, actions)
    fallbackText?: string, // text fallback for platforms without card support
  }
}
```

Implementation: write a `messages_out` row with `kind: 'chat-sdk'` and the card structure in content.

#### ask_user_question

Queue a durable interactive question. The tool returns immediately; an answer
or explicit skip arrives as an `interactive_response` input in a later turn.

```typescript
{
  name: 'ask_user_question',
  params: {
    question: string,
    responseMode: 'choice' | 'text' | 'choice_or_text',
    options?: (string | { label: string; selectedLabel?: string; value?: string })[],
    placeholder?: string,
    multiline?: boolean,
  }
}
```

Implementation:
1. Generate a `questionId`
2. Write a `messages_out` row with `kind: 'chat-sdk'` and a `type: 'ask_question'`
   payload containing the question, response mode, normalized options and ID
3. Return `status: 'awaiting_user'` immediately
4. The host persists the question and journals the eventual response using the
   deterministic input ID `question-response:<questionId>`, then wakes the runner

Choice modes require options. A second question is rejected while a previous one
is awaiting its response, including after Stop. No title or timeout is accepted
as part of the question contract. Approval and display-card titles are separate
and unchanged.

#### edit_message

Edit a previously sent message.

```typescript
{
  name: 'edit_message',
  params: {
    messageId: string,     // integer ID as shown to the agent
    text: string,          // new content
  }
}
```

Implementation: write a `messages_out` row with `operation: 'edit'`, the message ID, and new text.

#### add_reaction

Add an emoji reaction to a message.

```typescript
{
  name: 'add_reaction',
  params: {
    messageId: string,     // integer ID as shown to the agent
    emoji: string,         // emoji name (e.g., 'thumbs_up')
  }
}
```

Implementation: write a `messages_out` row with `operation: 'reaction'`.

#### send_to_agent

Send a message to another agent group.

```typescript
{
  name: 'send_to_agent',
  params: {
    agentGroupId: string,  // target agent group
    text: string,          // message content
    sessionId?: string,    // optional: target specific session
  }
}
```

Implementation: write a `messages_out` row with `channel_type: 'agent'`, `platform_id: agentGroupId`, `thread_id: sessionId`.

#### schedule_task

Schedule a one-shot or recurring task.

```typescript
{
  name: 'schedule_task',
  params: {
    prompt: string,             // task prompt
    processAfter: string,       // ISO timestamp for first run
    recurrence?: string,        // cron expression (optional)
    script?: string,            // pre-agent script (optional)
  }
}
```

Implementation: write a `messages_in` row (to self) with `kind: 'task'`, `process_after`, and optionally `recurrence`. The host sweep picks it up when due.

#### list_tasks

List active scheduled/recurring tasks.

```typescript
{
  name: 'list_tasks',
  params: {}
}
```

Implementation: query `messages_in WHERE recurrence IS NOT NULL AND status != 'failed'`.

#### cancel_task / pause_task / resume_task / update_task

Modify a scheduled task.

```typescript
{
  name: 'cancel_task',
  params: { taskId: string }
}
// pause_task: set status = 'paused' (new status value for recurring tasks)
// resume_task: set status = 'pending'
// update_task: merge { prompt?, recurrence?, processAfter?, script? } into the live row
```

Implementation: cancel/pause/resume update the live row(s) directly. update_task is sent as a system action — the host reads current content, merges supplied fields, and writes back. All four match by `(id = ? OR series_id = ?) AND kind='task' AND status IN ('pending','paused')`, so they reach the live next occurrence of a recurring task even when the agent passes the original (now-completed) id.

#### register_agent_group

Register a new agent group (admin only).

```typescript
{
  name: 'register_agent_group',
  params: {
    name: string,
    folder: string,
    platformId: string,        // messaging group to wire to
    channelType: string,
    triggerRules?: object,
    sessionMode?: 'shared' | 'per-thread',
  }
}
```

Implementation: write a `messages_out` row with `kind: 'system'`, `action: 'register_agent_group'`. The host reads, validates admin permission, creates the entity rows in the central DB, and writes a `system` messages_in response.

### Media Handling

#### Inbound (messages_in → agent prompt)

The agent-runner inspects attachments in chat/chat-sdk messages and handles them based on type and provider capability:

**Provider-native content blocks:**

| Type | Claude | Codex / OpenCode |
|------|--------|------------------|
| Images (JPEG, PNG, GIF, WebP) | Native image content block | Save to disk |
| PDFs | Native document content block | Save to disk |
| Audio | Native audio content block | Save to disk |
| Other files (code, data, video, archives) | Save to disk | Save to disk |

**"Save to disk"** means: download to `/workspace/downloads/{messageId}/`, reference in the prompt text:

```
<message sender="John" time="10:00">
  Check this spreadsheet
  [file available at: /workspace/downloads/msg-123/data.xlsx]
</message>
```

The agent can use tools (Read, Bash) to access saved files.

For channels where direct download isn't possible (e.g., WhatsApp buffered streams), the channel adapter serves the media via a local URL. The agent-runner downloads from that URL.

**Content block construction (Claude):** The agent-runner builds multi-part `MessageParam` content: `[{ type: 'image', source: { type: 'base64', media_type, data } }, { type: 'text', text: '...' }]`. The prompt passed to the provider is not a plain string in this case — the `QueryInput.prompt` field needs to support structured content for Claude. The provider's `query()` method handles the format-specific construction.

**Content block construction (Codex/OpenCode):** Everything is text. File references are inlined in the prompt string. The provider receives a plain string prompt.

#### Outbound (agent → messages_out)

Handled via the `send_file` MCP tool (see above). The agent explicitly decides to send a file — the agent-runner doesn't scan output for file references.

### Pre-Agent Scripts (Tasks)

For `task` kind messages with a `script` field in the content:

1. Agent-runner writes the script to a temp file
2. Executes with `bash` (30s timeout)
3. Parses last line of stdout as JSON: `{ wakeAgent: boolean, data?: unknown }`
4. If `wakeAgent === false`: mark message as completed, don't invoke the provider
5. If `wakeAgent === true`: enrich the prompt with script output, then invoke the provider

### Transcript Archiving

The agent-runner archives conversation transcripts before context compaction. For Claude, this is handled via the PreCompact hook (provider-internal). For other providers that don't have hooks, the agent-runner archives after each query completes based on the provider's output.

Archive location: `/workspace/agent/conversations/{date}-{summary}.md`

### Session Resume

The agent-runner tracks `sessionId` and `resumeAt` across queries:

- `sessionId` — captured from `ProviderEvent { type: 'init' }`. Passed back to `QueryInput.sessionId` on the next query.
- `resumeAt` — Claude-specific (last assistant message UUID). Stored by the agent-runner, passed to `QueryInput.resumeAt`. Providers that don't support this ignore it.

These are ephemeral to the container's lifetime. When the container is killed and restarted, the host passes the stored `sessionId` from the central DB's sessions table. `resumeAt` is lost on container restart (the provider resumes from the end of the session).

### Container Startup

The agent-runner receives configuration via:

- **Environment variables:** `AGENT_PROVIDER` (claude/codex/opencode), `NANOCLAW_ADMIN_USER_ID`, provider-specific vars (API keys, model overrides), `TZ`
- **Fixed mount paths:** Session DB at `/workspace/session.db`. Agent group folder at `/workspace/agent/`. System prompt from `/workspace/agent/CLAUDE.md` and `/workspace/global/CLAUDE.md`.
- **Optional startup config:** Some config may be passed as a JSON file at a fixed path (e.g., `/workspace/config.json`) for things like the session ID to resume, assistant name, and admin user ID. This avoids overloading environment variables.

The agent-runner reads config, creates the provider, and enters the poll loop. No stdin, no initial prompt — messages are already in the session DB.

### Provider Factory

```typescript
type ProviderName = 'claude' | string;

function createProvider(name: ProviderName, config: ProviderConfig): AgentProvider {
  // Trunk registers 'claude'; additional providers self-register when installed via skills.
  const factory = providerRegistry.get(name);
  if (!factory) throw new Error(`Unknown provider: ${name}`);
  return factory(config);
}
```

The provider name comes from the container's environment (`AGENT_PROVIDER` env var). The host resolves it from `container_configs.provider`, then `DEFAULT_PROVIDER`, then `claude`.

`ProviderConfig` contains provider-specific settings (API keys, model overrides, etc.) passed via environment variables — not via the interface. Each provider reads what it needs from `env`.

## Agent-Runner Properties

- MCP server is a separate Node process spawned by the provider (via `mcpServers` config)
- The MCP server binary is shared across providers — same tools, same DB access
- CLAUDE.md loading (global + per-group) — agent-runner reads and passes as `systemPrompt`
- Additional directories discovery (`/workspace/extra/*`)
- Logging via stderr (`[agent-runner] ...`)

## Related Documents

- **[architecture.md](architecture.md)** — High-level architecture (session DB schema, central DB, channel adapters, message flow)
- **[api-details.md](api-details.md)** — Channel adapter interface, message content examples, host delivery logic
