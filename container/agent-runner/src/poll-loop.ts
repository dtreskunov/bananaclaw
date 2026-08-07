import { findByName, getAllDestinations, type DestinationEntry } from './destinations.js';
import { getPendingMessages, markProcessing, markCompleted, type MessageInRow } from './db/messages-in.js';
import { writeMessageOut } from './db/messages-out.js';
import { writeTurnUsage } from './db/turn-usage.js';
import { writeTurnActivity } from './db/turn-activity.js';
import { getInboundDb, getOutboundDb, touchHeartbeat, clearStaleProcessingAcks } from './db/connection.js';
import { clearContinuation, clearFailedTurn, clearTurnEnded, appendActivity, clearActivity, getActivityBuffer, getContinuation, getFailedTurn, migrateLegacyContinuation, setContinuation, setFailedTurn, setTurnEnded } from './db/session-state.js';
import { clearCurrentInReplyTo, setCurrentInReplyTo } from './current-batch.js';
import {
  formatMessages,
  extractFileAttachments,
  extractRouting,
  categorizeMessage,
  isClearCommand,
  isRunnerCommand,
  parseAssistantOutput,
  type RoutingContext,
} from './formatter.js';
import { isUploadTraceCommand, uploadTrace } from './upload-trace.js';
import { isAudioMime, transcribeAudio } from './transcribe.js';
import { appendThreadTitleRequest } from './thread-title-request.js';
import { getConfig } from './config.js';
import type { AgentProvider, AgentQuery, FileAttachment, ProviderEvent, ProviderExchange } from './providers/types.js';

const POLL_INTERVAL_MS = 1000;
const ACTIVE_POLL_INTERVAL_MS = 500;
const MAX_MALFORMED_TOOL_RECOVERY_ATTEMPTS = 2;

/**
 * Number of consecutive `database disk image is malformed` errors after which
 * the follow-up poll gives up and exits the process. At ACTIVE_POLL_INTERVAL_MS
 * = 500ms this is roughly 5 seconds — long enough to dodge a transient torn
 * read during a host write, short enough to recover quickly from a poisoned
 * page cache (host-sweep then respawns with a fresh mount).
 */
const CORRUPTION_STREAK_EXIT = 10;

/**
 * True for SQLite errors that indicate a corrupt READ view — almost always a
 * cross-mount page-cache coherency issue on Docker Desktop macOS rather than
 * actual file damage (host-side integrity_check passes). Reopening the DB
 * handle inside this process does NOT recover; only a fresh container mount
 * does. Caller's job is to exit so host-sweep respawns the container.
 */
export function isCorruptionError(msg: string): boolean {
  return (
    msg.includes('database disk image is malformed') ||
    msg.includes('SQLITE_CORRUPT') ||
    msg.includes('file is not a database')
  );
}

export function shouldDeferInteractiveResponse(messages: MessageInRow[], turnActive: boolean): boolean {
  return turnActive && messages.some((message) => message.kind === 'interactive_response');
}

/**
 * True for SQLite errors that indicate the DB file has been removed
 * (e.g. the host deleted the chat thread / session dir). The container
 * should exit immediately rather than poll a dead file forever.
 */
export function isMissingDbError(msg: string): boolean {
  return (
    msg.includes('unable to open database file') ||
    msg.includes('SQLITE_CANTOPEN') ||
    msg.includes('no such file or directory')
  );
}

function log(msg: string): void {
  console.error(`[poll-loop] ${msg}`);
}

function generateId(): string {
  return `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export interface PollLoopConfig {
  provider: AgentProvider;
  /**
   * Name of the provider (e.g. "claude", "codex", "opencode"). Used to key
   * the stored continuation per-provider so flipping providers doesn't
   * resurrect a stale id from a different backend.
   */
  providerName: string;
  cwd: string;
  systemContext?: {
    instructions?: string;
  };
  /**
   * Optional stop signal. In production the loop runs until the container
   * dies; tests pass a signal so an abandoned loop actually exits instead of
   * polling forever and stealing messages from the next test's DB.
   */
  signal?: AbortSignal;
}

/**
 * Main poll loop. Runs indefinitely until the process is killed.
 *
 * 1. Poll messages_in for pending rows
 * 2. Format into prompt, call provider.query()
 * 3. While query active: continue polling, push new messages via provider.push()
 * 4. On result: write messages_out
 * 5. Mark messages completed
 * 6. Loop
 */
export async function runPollLoop(config: PollLoopConfig): Promise<void> {
  // Resume the agent's prior session from a previous container run if one
  // was persisted. The continuation is opaque to the poll-loop — the
  // provider decides how to use it (Claude resumes a .jsonl transcript,
  // other providers may reload a thread ID, etc.). Keyed per-provider so
  // a Codex thread id never gets handed to Claude or vice versa.
  let continuation: string | undefined = migrateLegacyContinuation(config.providerName);

  // Before resuming, drop a session whose on-disk transcript has grown too
  // large/old to cold-resume within the host's idle ceiling. Without this a
  // long-lived hub keeps trying to reload an ever-growing .jsonl, hangs the
  // first turn, and gets killed before it can reply (then repeats forever).
  if (continuation) {
    const rotateReason = config.provider.maybeRotateContinuation?.(continuation, config.cwd);
    if (rotateReason) {
      log(`Rotating session — ${rotateReason}; starting fresh`);
      clearContinuation(config.providerName);
      continuation = undefined;
    }
  }

  if (continuation) {
    log(`Resuming agent session ${continuation}`);
  }

  // Clear leftover 'processing' acks from a previous crashed container.
  // This lets the new container re-process those messages.
  clearStaleProcessingAcks();

  // Warm the heartbeat as soon as the runner is up. Provider boot
  // (e.g. opencode SDK cold start, OpenRouter handshake) can take
  // longer than the host typing module's grace window before
  // processQuery's liveHandle starts touching it — leaving the
  // typing indicator to flicker off mid-cold-start.
  try { touchHeartbeat(); } catch { /* best-effort */ }

  let pollCount = 0;
  let isFirstPoll = true;

  // Honor the stop signal even while a warm, long-lived query is mid-flight.
  // The while-loop below only checks `signal.aborted` between batches; a warm
  // provider query (OpenCode/mock) blocks inside processQuery awaiting the next
  // pushed follow-up, so an abort that arrives during a turn would otherwise
  // never be noticed and the loop (plus its follow-up poller) would leak. In
  // production no signal is passed (the loop runs until the container dies), so
  // this only matters for tests — but a leaked poll loop there can steal
  // freshly-inserted messages from the next test's loop. Aborting the active
  // query wakes its generator, lets processQuery return, and the loop then sees
  // `signal.aborted` and exits.
  let activeQuery: AgentQuery | null = null;
  config.signal?.addEventListener('abort', () => {
    try { activeQuery?.abort(); } catch { /* best-effort */ }
  });

  while (true) {
    if (config.signal?.aborted) return;
    // Skip system messages — they're responses for MCP tools (e.g., ask_user_question)
    const messages = getPendingMessages(isFirstPoll).filter((m) => m.kind !== 'system');
    isFirstPoll = false;
    pollCount++;

    // Periodic heartbeat so we know the loop is alive
    if (pollCount % 30 === 0) {
      log(`Poll heartbeat (${pollCount} iterations, ${messages.length} pending)`);
    }

    if (messages.length === 0) {
      await sleep(POLL_INTERVAL_MS);
      continue;
    }

    // Accumulate gate: if the batch contains only trigger=0 rows
    // (context-only, router-stored under ignored_message_policy='accumulate'),
    // don't wake the agent. Leave them `pending` — they'll ride along the
    // next time a real trigger=1 message lands via this same getPendingMessages
    // query. Without this gate, a warm container keeps processing
    // (and potentially responding to) every accumulate-only batch, defeating
    // the "store as context, don't engage" contract. Host-side countDueMessages
    // gates the same way for wake-from-cold (see src/db/session-db.ts).
    if (!messages.some((m) => m.trigger === 1)) {
      await sleep(POLL_INTERVAL_MS);
      continue;
    }

    // Touch the heartbeat the moment we pick up a batch — before any
    // potentially-slow provider boot inside processQuery — so the host
    // typing indicator stays lit through cold-start.
    try { touchHeartbeat(); } catch { /* best-effort */ }

    const ids = messages.map((m) => m.id);
    markProcessing(ids);

    // Resync continuation from session_state at the top of each batch.
    // The local variable only gets updated on processQuery's success
    // return path; on the error path (and inside long-lived queries that
    // outlive a single batch via follow-up pushes) the canonical value
    // lives in session_state — written by the init handler and rolled
    // back by the failure-recovery path. Without this resync, after a
    // failed follow-up turn the next batch would start a brand-new
    // Claude session, dropping all prior context.
    const persisted = getContinuation(config.providerName);
    if (persisted !== continuation) {
      continuation = persisted;
    }

    const routing = extractRouting(messages);

    // Command handling: the host router gates filtered and unauthorized
    // admin commands before they reach the container. The only command
    // the runner handles directly is /clear (session reset).
    const normalMessages: MessageInRow[] = [];
    const commandIds: string[] = [];

    for (const msg of messages) {
      if ((msg.kind === 'chat' || msg.kind === 'chat-sdk') && isClearCommand(msg)) {
        log('Clearing session (resetting continuation)');
        continuation = undefined;
        clearContinuation(config.providerName);
        writeMessageOut({
          id: generateId(),
          kind: 'chat',
          platform_id: routing.platformId,
          channel_type: routing.channelType,
          thread_id: routing.threadId,
          content: JSON.stringify({ text: 'Session cleared.' }),
        });
        commandIds.push(msg.id);
        continue;
      }
      if ((msg.kind === 'chat' || msg.kind === 'chat-sdk') && isUploadTraceCommand(msg)) {
        log('Uploading session trace to Hugging Face');
        writeMessageOut({
          id: generateId(),
          kind: 'chat',
          platform_id: routing.platformId,
          channel_type: routing.channelType,
          thread_id: routing.threadId,
          content: JSON.stringify({ text: uploadTrace() }),
        });
        commandIds.push(msg.id);
        continue;
      }
      normalMessages.push(msg);
    }

    if (commandIds.length > 0) {
      markCompleted(commandIds);
    }

    if (normalMessages.length === 0) {
      const remainingIds = ids.filter((id) => !commandIds.includes(id));
      if (remainingIds.length > 0) markCompleted(remainingIds);
      log(`All ${messages.length} message(s) were commands, skipping query`);
      continue;
    }

    // Pre-task scripts: for any task rows with a `script`, run it before the
    // provider call. Scripts returning wakeAgent=false (or erroring) gate
    // their own task row only — surviving messages still go to the agent.
    // Without the scheduling module, the marker block is empty, `keep`
    // falls back to `normalMessages`, and no gating happens.
    let keep: MessageInRow[] = normalMessages;
    let skipped: string[] = [];
    // MODULE-HOOK:scheduling-pre-task:start
    const { applyPreTaskScripts } = await import('./scheduling/task-script.js');
    const preTask = await applyPreTaskScripts(normalMessages);
    keep = preTask.keep;
    skipped = preTask.skipped;
    if (skipped.length > 0) {
      markCompleted(skipped);
      log(`Pre-task script skipped ${skipped.length} task(s): ${skipped.join(', ')}`);
    }
    // MODULE-HOOK:scheduling-pre-task:end

    if (keep.length === 0) {
      log(`All ${normalMessages.length} non-command message(s) gated by script, skipping query`);
      continue;
    }

    // Format messages: passthrough commands get raw text (only if the
    // provider natively handles slash commands), others get XML.
    let prompt = formatMessagesWithCommands(keep, config.provider.supportsNativeSlashCommands);
    prompt = appendThreadTitleRequest(prompt, keep);

    // Replay any prior failed turn. The continuation rollback in
    // processQuery restores the agent to a session that completed before
    // the failure, so the resumed transcript has no record of the lost
    // user message or the error. Prepend a context block so the agent
    // knows what happened and can acknowledge it rather than acting as
    // if the user never spoke. Cleared regardless of whether the prompt
    // ends up being sent successfully — if the new turn also fails, its
    // own record will overwrite this one.
    const failed = getFailedTurn();
    if (failed) {
      clearFailedTurn();
      prompt = renderFailedTurnReplay(failed) + '\n\n' + prompt;
      log(`Replaying failed turn from ${new Date(failed.recorded_at).toISOString()}`);
    }

    log(`Processing ${keep.length} message(s), kinds: ${[...new Set(keep.map((m) => m.kind))].join(',')}`);

    // Process the query while concurrently polling for new messages
    const skippedSet = new Set(skipped);
    const processingIds = ids.filter((id) => !commandIds.includes(id) && !skippedSet.has(id));
    // Publish the batch's in_reply_to so MCP tools (send_message, send_file)
    // can stamp it on outbound rows — needed for a2a return-path routing.
    setCurrentInReplyTo(routing.inReplyTo);
    // Mutable holder so processQuery can report the most recent prompt
    // it actually pushed to the SDK. The initial batch's prompt is
    // seeded here; follow-up pushes overwrite it. On failure we record
    // *that* prompt as the failed turn — not the initial one, which
    // may have completed cleanly turns earlier in the same query.
    const promptTracker = { latest: prompt, routing };
    // Scheduled tasks run as isolated one-shot turns: a fresh provider
    // session (no chat continuation) so the model doesn't inherit the very
    // exchange that scheduled it — which made reasoning models treat the
    // task as already-handled and emit an empty result: the task fired but
    // nothing was sent. persistContinuation is also off, so the throwaway
    // task session id never clobbers the chat continuation AND the query is
    // ended right after the result (one-shot). Without that end, OpenCode's
    // long-lived query stays open on the task session with no events to warm
    // the heartbeat, which looked like a hung container.
    const isTaskOnly = keep.every((m) => m.kind === 'task');
    // Stale-session retry: if the first attempt fails because the stored
    // continuation is unusable (Claude Code returns "No conversation found
    // with session ID …" when the server-side session has expired or the
    // local transcript is gone), clear the continuation and retry once
    // with a fresh session — silently, so the user never sees the error.
    let attempt = 0;
    const rawFiles = extractFileAttachments(keep);
    const { prompt: resolvedPrompt, files } = await transcribeAudioFiles(rawFiles, prompt);
    prompt = resolvedPrompt;
    try {
      while (true) {
        const query = config.provider.query({
          prompt,
          continuation: isTaskOnly ? undefined : continuation,
          cwd: config.cwd,
          files: files.length > 0 ? files : undefined,
          systemContext: config.systemContext,
        });
        activeQuery = query;
        try {
          const result = await processQuery(
            query,
            routing,
            processingIds,
            config.providerName,
            isTaskOnly ? undefined : continuation,
            !isTaskOnly,
            promptTracker,
            config.provider.onExchangeComplete?.bind(config.provider),
            prompt,
          );
          if (!isTaskOnly && result.continuation && result.continuation !== continuation) {
            continuation = result.continuation;
            setContinuation(config.providerName, continuation);
          }
          if (result.unsurfacedError) {
            const errorRouting = result.unsurfacedError.routing;
            const tag = result.unsurfacedError.classification
              ? ` [${result.unsurfacedError.classification}]`
              : '';
            writeMessageOut({
              id: generateId(),
              kind: 'chat',
              platform_id: errorRouting.platformId,
              channel_type: errorRouting.channelType,
              thread_id: errorRouting.threadId,
              content: JSON.stringify({
                text: `⚠️ Agent provider error${tag}: ${result.unsurfacedError.message}\n\nYour message was not processed.`,
              }),
            });
            log(`Surfaced provider error to user: ${result.unsurfacedError.message}`);
          }
          break;
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          log(`Query error: ${errMsg}`);

          if (attempt === 0 && continuation && config.provider.isSessionInvalid(err)) {
            log(`Stale session detected (${continuation}) — clearing and retrying with fresh session`);
            continuation = undefined;
            clearContinuation(config.providerName);
            attempt++;
            continue;
          }

          // Non-recoverable, or retry already exhausted — record the
          // failed turn for replay, try a natural-language in-turn ack,
          // and fall back to a short static error message if the ack
          // also fails. Intentionally do NOT persist ack.continuation —
          // the ack runs in a fresh one-shot session with no real
          // conversation state; the user's next turn should resume the
          // rolled-back `continuation` we already have.
          try {
            setFailedTurn({ prompt: promptTracker.latest, error: errMsg, recorded_at: Date.now() });
          } catch (e) {
            log(`Failed to persist failed-turn record: ${e instanceof Error ? e.message : String(e)}`);
          }
          const failureRouting = promptTracker.routing;
          const ack = await tryAcknowledgeFailure(config, failureRouting, errMsg, undefined);
          if (!ack.delivered) {
            writeMessageOut({
              id: generateId(),
              kind: 'chat',
              platform_id: failureRouting.platformId,
              channel_type: failureRouting.channelType,
              thread_id: failureRouting.threadId,
              content: JSON.stringify({ text: friendlyProviderErrorFallback(errMsg) }),
            });
          }
          break;
        }
      }
    } finally {
      clearCurrentInReplyTo();
      activeQuery = null;
    }

    // Ensure completed even if processQuery ended without a result event
    // (e.g. stream closed unexpectedly).
    markCompleted(processingIds);
    log(`Completed ${ids.length} message(s)`);
  }
}

/**
 * Transcribe any audio files in the attachment list. Replaces audio entries
 * with transcript text prepended to the prompt. Non-audio files pass through.
 */
async function transcribeAudioFiles(
  files: FileAttachment[],
  prompt: string,
): Promise<{ prompt: string; files: FileAttachment[] }> {
  const cfg = getConfig();
  if (cfg.voiceMode !== 'transcribe') return { prompt, files };

  const nonAudio: FileAttachment[] = [];
  const transcripts: string[] = [];
  const model = cfg.transcriptionModel;
  for (const file of files) {
    if (!isAudioMime(file.mime)) {
      nonAudio.push(file);
      continue;
    }
    const text = await transcribeAudio(file.path, file.mime, model);
    if (text) {
      log(`Transcribed ${file.filename}: "${text.slice(0, 80)}${text.length > 80 ? '…' : ''}"`);
      transcripts.push(text);
    } else {
      log(`Transcription failed for ${file.filename}, passing as file`);
      nonAudio.push(file);
    }
  }
  if (transcripts.length > 0) {
    const prefix = transcripts.map((t) => `[voice message transcript]: ${t}`).join('\n');
    prompt = prefix + '\n\n' + prompt;
  }
  return { prompt, files: nonAudio };
}

/**
 * Format messages, handling passthrough commands differently.
 * When the provider handles slash commands natively (Claude Code),
 * passthrough commands are sent raw (no XML wrapping) so the SDK can
 * dispatch them. Otherwise they fall through to standard XML formatting.
 */
function formatMessagesWithCommands(messages: MessageInRow[], nativeSlashCommands: boolean): string {
  const parts: string[] = [];
  const normalBatch: MessageInRow[] = [];

  for (const msg of messages) {
    if (nativeSlashCommands && (msg.kind === 'chat' || msg.kind === 'chat-sdk')) {
      const cmdInfo = categorizeMessage(msg);
      if (cmdInfo.category === 'passthrough' || cmdInfo.category === 'admin') {
        // Flush normal batch first
        if (normalBatch.length > 0) {
          parts.push(formatMessages(normalBatch));
          normalBatch.length = 0;
        }
        // Pass raw command text (no XML wrapping) — SDK handles it natively
        parts.push(cmdInfo.text);
        continue;
      }
    }
    normalBatch.push(msg);
  }

  if (normalBatch.length > 0) {
    parts.push(formatMessages(normalBatch));
  }

  return parts.join('\n\n');
}

/**
 * Render the prior failed-turn record as an XML block to prepend to the
 * next prompt. Tells the agent verbatim what the user said last time and
 * what error the provider returned, so it can acknowledge the failure
 * instead of acting as if the message never happened. Paired with the
 * continuation rollback in processQuery — the resumed transcript has no
 * memory of the failed turn, so this block is the only signal.
 */
function renderFailedTurnReplay(failed: { prompt: string; error: string; recorded_at: number }): string {
  const when = new Date(failed.recorded_at).toISOString();
  return [
    `<previous_turn_failed at="${when}">`,
    `<user_message_that_was_not_processed>`,
    failed.prompt,
    `</user_message_that_was_not_processed>`,
    `<provider_error>${failed.error}</provider_error>`,
    `<note>The provider rejected only the single user turn shown above. Your earlier conversation history is intact — do not claim you have forgotten it. The user has already seen a one-line "your message couldn't be processed" notice, so you do not need to re-explain the failure.`,
    `\nThe user's intent in that failed turn still stands. Now: actually do what they asked, using your tools. If their current message is a retry/prod ("try again", "you there?", "all done?", etc.), interpret it as "complete the work from the failed turn" — do NOT respond with a verbal-only acknowledgement ("on it", "continuing", "doing it now", "yep, here") and end the turn without making the actual change. If their current message is unrelated, address that instead.</note>`,
    `</previous_turn_failed>`,
  ].join('\n');
}

interface AcknowledgeResult {
  /** True when the agent emitted at least one user-visible message
   *  during the ack turn — caller skips the static error fallback. */
  delivered: boolean;
}

/**
 * Static fallback message used only when both the agent's normal turn
 * AND the in-turn ack failed. Pulls the human-readable message out of
 * Claude Code-style API errors so the user gets one short line instead
 * of a wall of JSON. Best-effort — if extraction misses, returns a
 * generic message and drops the raw error entirely (the user can't act
 * on it anyway).
 */
export function friendlyProviderErrorFallback(errMsg: string): string {
  // Match either `"message":"..."` (JSON-escaped) or a bare error line
  // anywhere in the string. The first capture wins.
  const jsonMatch = errMsg.match(/"message"\s*:\s*"([^"\\]*(?:\\.[^"\\]*)*)"/);
  if (jsonMatch) {
    const quoted = jsonMatch[1].replace(/\\"/g, '"').replace(/\\n/g, ' ').trim();
    if (quoted) return `Your message couldn't be processed: "${quoted}". You may want to rephrase and try again.`;
  }
  // If the error is short, doesn't contain raw JSON or stack traces, surface
  // it directly — it's likely a human-readable provider message (e.g. budget
  // limits, rate limits, auth errors).
  const trimmed = errMsg.trim();
  if (trimmed.length <= 200 && !trimmed.includes('{') && !trimmed.includes('\n    at ')) {
    return `Your message couldn't be processed: "${trimmed}". You may want to rephrase and try again.`;
  }
  return "Your message couldn't be processed due to a provider error. You may want to rephrase and try again.";
}

/**
 * Best-effort in-turn acknowledgment of a provider failure.
 *
 * Runs in a FRESH session (no continuation) so whatever context tripped
 * the failure (e.g. a content-filter trigger in the rolled-back
 * transcript) can't immediately re-trip it. The user-supplied prompt is
 * also intentionally NOT included for the same reason.
 *
 * Single query call, no recursion. If it also fails (throws or returns
 * its own unsurfacedError) the caller falls back to a short static
 * message; nothing here calls setFailedTurn so a busted ack never
 * poisons the next turn's replay.
 */
async function tryAcknowledgeFailure(
  config: PollLoopConfig,
  routing: RoutingContext,
  errorMessage: string,
  errorClassification: string | undefined,
): Promise<AcknowledgeResult> {
  const tag = errorClassification ? ` (${errorClassification})` : '';
  const ackPrompt = [
    `<system>`,
    `The user's most recent message could not be processed because the model provider returned an error${tag}:`,
    ``,
    errorMessage,
    ``,
    `Briefly (one or two short sentences) tell the user that their message failed and, if useful, quote the most relevant phrase from the error verbatim so they can act on it. Do not retry the failed action. Do not speculate about causes beyond what the error literally says. Do not apologize at length.`,
    `</system>`,
  ].join('\n');

  // Always use a fresh session (no continuation). The rolled-back
  // transcript still carries whatever content tripped the filter, so
  // re-asking the model there often trips it again. The ack only needs
  // the error string itself — no conversation context required.
  log('Generating in-turn acknowledgment of provider error');
  try {
    const query = config.provider.query({
      prompt: ackPrompt,
      continuation: undefined,
      cwd: config.cwd,
      systemContext: config.systemContext,
    });
    await processQuery(query, routing, [], config.providerName, undefined, false);
    return { delivered: true };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    log(`Acknowledgment turn threw: ${errMsg}`);
    return { delivered: false };
  }
}

interface QueryResult {
  continuation?: string;
  /**
   * Last non-retryable provider error seen during the turn. Only set when
   * the turn produced no deliverable output (`sentAny === false`) and the
   * stream completed without throwing. If the SDK throws after yielding
   * the error result, that throw goes through the outer retry/error path
   * in runPollLoop instead — preserving the silent stale-session retry.
   */
  unsurfacedError?: { message: string; classification?: string; routing: RoutingContext };
}

async function processQuery(
  query: AgentQuery,
  routing: RoutingContext,
  initialBatchIds: string[],
  providerName: string,
  priorContinuation: string | undefined,
  persistContinuation = true,
  promptTracker?: { latest: string; routing: RoutingContext },
  onExchangeComplete?: (exchange: ProviderExchange) => void,
  initialPrompt = '',
): Promise<QueryResult> {
  let queryContinuation: string | undefined;
  let resultSeen = false;
  let done = false;
  // Set once we've pushed the recovery nudge this turn — a self-correction
  // retry asking the model to re-send its reply properly wrapped. Fires for
  // BOTH failure shapes: (a) the model emitted bare top-level text it forgot
  // to wrap (`hasUnwrapped`), and (b) the model buried its whole reply inside
  // reasoning that normalized to empty (`event.strippedToEmpty`). One-shot:
  // if the retry still delivers nothing we surface a generic error rather
  // than nudging again. Reset at every turn boundary (warm-query safety).
  let nudgedForDelivery = false;
  let deliveryErrorRouting: RoutingContext = routing;
  let malformedToolRecoveryAttempts = 0;
  let malformedToolRecoveryExhausted = false;
  let malformedToolErrorRouting: RoutingContext = routing;
  let malformedToolRecoveryMode: 'tool' | 'delivery' | null = null;
  let malformedToolRecoveryRouting: RoutingContext | null = null;
  let malformedToolRecoveryHadNativeTool = false;
  const executedToolCalls = new Map<string, {
    tool: string;
    detail?: string;
    status: 'running' | 'completed' | 'error';
  }>();
  let activeTurnRouting = routing;
  // OpenCode reasoning models occasionally stop after placing a future-work
  // announcement inside an unclosed <think>, without invoking any tools. Keep
  // the original batch claimed while one corrective continuation runs.
  let nudgedForPrematureCompletion = false;
  let prematureCompletionBatchIds: string[] = [];
  let toolActivityThisTurn = false;
  let substantiveToolActivityThisTurn = false;
  // Set when the post-nudge retry comes back as an `<internal>` note (the
  // model confirming, via the escape hatch in the nudge text, that it meant
  // to stay silent). Suppresses BOTH terminal notices — a deliberate no-op
  // must not surface as an error.
  let silenceConfirmed = false;
  // Set when a `result` event has no deliverable response and we did not nudge
  // it — either genuinely empty text or an initial all-<internal> scratchpad.
  // Distinct from `event.strippedToEmpty` (a swallowed reply → nudged, above)
  // and a post-nudge <internal> result (confirmed intentional silence).
  let emptyResultSeen = false;
  // A fresh batch is being processed \u2014 wipe any turn-ended marker from
  // the previous turn so the host typing module re-arms cleanly.
  try { clearTurnEnded(); } catch { /* best-effort */ }
  // Start each batch with a fresh activity trace so the web UI shows the
  // work for this wake, not a stale trace from the previous turn.
  try { clearActivity(); } catch { /* best-effort */ }
  let lastProviderError: { message: string; classification?: string } | null = null;
  let sentAny = false;
  // Captured from the provider's `usage` event; flushed at end of turn so
  // it can be linked to the last outbound row written this turn.
  let pendingUsage: import('./providers/types.js').TurnUsage | null = null;
  // Count of activity lines already persisted to turn_activity this batch.
  // Advanced after each result flush so multiple results in one query don't
  // re-persist earlier lines. Long-lived providers reuse this processQuery
  // across user turns, so reset both the buffer and this cursor at every
  // actual turn boundary rather than only when processQuery starts.
  let activityFlushedCount = 0;
  const resetActivityForNextTurn = () => {
    try { clearActivity(); } catch { /* best-effort */ }
    activityFlushedCount = 0;
  };

  // Per-push batch queue. Each push (initial + every follow-up) enqueues
  // its ids + routing. On `result` we drain the queue — only then are the
  // rows markCompleted'd. Earlier code marked follow-ups completed at push
  // time, which lost them silently when the provider collapsed multiple
  // queued prompts into one turn (OpenCode in particular) — the rows
  // looked "done" to the host but no reply was ever dispatched.
  type QueuedBatch = { ids: string[]; routing: RoutingContext };
  const turnBatchQueue: QueuedBatch[] = [{ ids: initialBatchIds, routing }];

  // Snapshot the outbound seq so the result handler can detect whether MCP
  // tools wrote anything this turn. Without this, an agent that calls
  // send_file / send_message and then returns a chatty final-text gets
  // a duplicate delivery via the <message>-wrap nudge path.
  const currentOutboundMax = (): number =>
    (getOutboundDb().prepare('SELECT COALESCE(MAX(seq), 0) AS m FROM messages_out').get() as { m: number }).m;
  let outboundMaxAtTurnStart = currentOutboundMax();

  /**
   * Count outbound rows written this turn that represent a real user-facing
   * reply (text, file, or any non-operation chat content) vs operation-only
   * rows (reactions, edits) and web-only internal-thought rows.
   *
   * A reaction or edit is NOT a substitute for answering the user; if the
   * agent only reacts and then leaves its final-result text unwrapped, the
   * nudge path must still fire so the answer isn't silently dropped.
   */
  const countTurnContentMessages = (since: number): number => {
    const rows = getOutboundDb()
      .prepare('SELECT kind, content FROM messages_out WHERE seq > ?')
      .all(since) as { kind: string; content: string }[];
    let n = 0;
    for (const r of rows) {
      // kind='internal' is the web thought-bubble surfaced by dispatchResultText
      // from <internal>...</internal> blocks — not a reply.
      if (r.kind === 'internal' || r.kind === 'system') continue;
      // chat-kind rows can carry either content (text/markdown/files) or a
      // bare operation (reaction/edit). Only the former counts as a reply.
      if (r.kind === 'chat') {
        type ContentShape = { operation?: unknown; text?: unknown; markdown?: unknown; files?: unknown };
        let parsed: ContentShape | null = null;
        try {
          parsed = JSON.parse(r.content) as ContentShape;
        } catch {
          parsed = null;
        }
        if (parsed && parsed.operation && !parsed.text && !parsed.markdown && !parsed.files) continue;
      }
      n++;
    }
    return n;
  };

  const turnOnlySentFutureWorkAnnouncements = (since: number): boolean => {
    const rows = getOutboundDb()
      .prepare("SELECT kind, content FROM messages_out WHERE seq > ? AND kind NOT IN ('internal', 'system')")
      .all(since) as { kind: string; content: string }[];
    if (rows.length === 0) return false;
    return rows.every((row) => {
      if (row.kind !== 'chat') return false;
      try {
        const content = JSON.parse(row.content) as { text?: unknown; delivery_origin?: unknown };
        return content.delivery_origin === 'send_message' &&
          typeof content.text === 'string' &&
          isFutureWorkMessage(content.text);
      } catch {
        return false;
      }
    });
  };

  // Prompt queue for the exchange hook — each result event consumes the
  // oldest unanswered prompt, except a wrapping-retry result, which answers
  // the same prompt again. Unused (and unmaintained) when the provider
  // doesn't implement `onExchangeComplete`.
  const archivePrompts: string[] = [initialPrompt];

  // Concurrent polling: push follow-ups into the active query as they arrive.
  // We do NOT force-end the stream on silence — keeping the query open avoids
  // re-spawning the SDK subprocess (~few seconds) and re-loading the .jsonl
  // transcript on every turn. The Anthropic prompt cache is server-side with
  // a 5-min TTL keyed on prefix hash, so stream lifecycle does NOT affect
  // cache lifetime — close+reopen within 5 min still gets cache hits.
  // Stream liveness is decided host-side via the heartbeat file + processing
  // claim age (see src/host-sweep.ts); if something is truly stuck, the host
  // will kill the container and messages get reset to pending.
  let pollInFlight = false;
  let endedForCommand = false;
  let corruptionStreak = 0;
  const resetMalformedToolRecovery = (): void => {
    malformedToolRecoveryAttempts = 0;
    malformedToolRecoveryExhausted = false;
    malformedToolRecoveryRouting = null;
    malformedToolRecoveryHadNativeTool = false;
    executedToolCalls.clear();
  };
  const exhaustMalformedToolRecovery = (failedRouting: RoutingContext): void => {
    malformedToolRecoveryExhausted = true;
    malformedToolErrorRouting = failedRouting;
  };
  const pollHandle = setInterval(() => {
    if (done || pollInFlight || endedForCommand) return;
    pollInFlight = true;

    void (async () => {
      try {
        const pending = getPendingMessages();

        // Slash commands need a fresh query: /clear resets the SDK's
        // resume id (fixed at sdkQuery() time); admin/passthrough commands
        // (/compact, /cost, …) only dispatch when they're the first input
        // of a query — pushed mid-stream they arrive as plain text and
        // the SDK never runs them. Abort the active stream and leave the
        // rows pending; the outer loop handles them on next iteration via
        // the canonical command path + formatMessagesWithCommands. Abort,
        // not end: end() lets an in-flight turn run to completion, which
        // can block the command (e.g. /clear during a long task) for as
        // long as the turn takes.
        if (pending.some((m) => isRunnerCommand(m))) {
          log('Pending slash command — aborting active stream so outer loop can process');
          endedForCommand = true;
          query.abort();
          return;
        }

        // Scheduled tasks must never be folded into an active query. A task
        // pushed as a follow-up inherits the in-flight conversation context —
        // often the very exchange that just scheduled it — and the model
        // treats it as already-handled, emitting an empty result: the task
        // fires but nothing is sent. Instead, end the stream and leave the
        // task rows pending so the outer loop runs each task as its own clean
        // turn (fresh prompt + the pre-task script hook, which then runs
        // exactly once). Unlike the command path we use end(), not abort():
        // a task is not urgent, so let any in-flight reply finish rather than
        // cutting it off. The follow-up poll only runs while a turn is active,
        // so this fires only when a task lands mid-turn; a task arriving at an
        // idle container is already handled directly by the outer loop.
        if (pending.some((m) => m.kind === 'task')) {
          log('Pending scheduled task — ending active stream so it runs as its own turn');
          endedForCommand = true;
          query.end();
          return;
        }

        // Skip legacy system messages (MCP tool responses).
        // Thread routing is the router's concern — if a message landed in this
        // session, the agent should see it. Per-thread sessions already isolate
        // threads into separate containers; shared sessions intentionally merge
        // everything. Filtering on thread_id here caused deadlocks when the
        // initial batch and follow-ups had mismatched thread_ids (e.g. a
        // host-generated welcome trigger with null thread vs a Discord DM reply).
        const newMessages = pending.filter((m) => m.kind !== 'system');
        if (newMessages.length === 0) return;

        // A user can answer as soon as the card is delivered, before the
        // provider has emitted the result that safely closes the asking turn.
        // Persist the answer immediately, but do not push it into that active
        // turn. The next poll after the result resumes it as a distinct turn.
        if (shouldDeferInteractiveResponse(newMessages, turnActive)) return;

        // Never interleave a user prompt with an unresolved provider turn.
        // Apart from preserving FIFO order, this keeps native-tool activity
        // attached to the result that decides whether recovery may rerun it.
        if (turnActive) return;

        const newIds = newMessages.map((m) => m.id);
        markProcessing(newIds);

        // Run pre-task scripts on follow-ups too — without this, a task that
        // arrives during an active query (e.g. a */10 monitoring cron) bypasses
        // its script gate and always wakes the agent, defeating the gate.
        // Mirrors the initial-batch hook above.
        let keep = newMessages;
        let skipped: string[] = [];
        // MODULE-HOOK:scheduling-pre-task-followup:start
        const { applyPreTaskScripts } = await import('./scheduling/task-script.js');
        const preTask = await applyPreTaskScripts(newMessages);
        keep = preTask.keep;
        skipped = preTask.skipped;
        if (skipped.length > 0) {
          markCompleted(skipped);
          log(`Pre-task script skipped ${skipped.length} follow-up task(s): ${skipped.join(', ')}`);
        }
        // MODULE-HOOK:scheduling-pre-task-followup:end

        if (keep.length === 0) return;
        // Re-check done — the outer query may have finished while the script
        // was awaited. Pushing into a closed stream is wasted work; the
        // claimed messages get released by the host's processing-claim sweep.
        if (done) return;

        const keptIds = keep.map((m) => m.id);
        let prompt = appendThreadTitleRequest(formatMessages(keep), keep);
        const rawFollowUpFiles = extractFileAttachments(keep);
        const { prompt: resolvedFollowUp, files: followUpFiles } = await transcribeAudioFiles(rawFollowUpFiles, prompt);
        prompt = resolvedFollowUp;
        log(`Pushing ${keep.length} follow-up message(s) into active query`);
        // Reset the per-turn delivery/notice flags for the new turn. On a
        // long-lived provider (OpenCode) the query stays open across turns, so
        // these query-scoped flags would otherwise stay set from an earlier
        // turn that DID deliver. That stickiness silently breaks the empty-turn
        // safety net: `sentAny` staying true skips both the in-loop
        // `query.end()` (below) and the post-stream "finished without producing
        // a response" notice, so a later turn that strips to empty (e.g. a
        // reasoning model emitting a mangled/unclosed <think> wrapper) leaves
        // the user with total silence. Reset all three so the notices key off
        // THIS turn's delivery, not the whole warm query's history. The
        // malformed-tool retry state resets below only at a real idle-to-active
        // turn boundary; concurrent arrivals are deferred while it is in flight.
        nudgedForDelivery = false;
        nudgedForPrematureCompletion = false;
        prematureCompletionBatchIds = [];
        toolActivityThisTurn = false;
        substantiveToolActivityThisTurn = false;
        sentAny = false;
        emptyResultSeen = false;
        silenceConfirmed = false;
        if (promptTracker) promptTracker.latest = prompt;
        activeTurnRouting = extractRouting(keep);
        if (promptTracker) promptTracker.routing = activeTurnRouting;
        // If the previous result already completed, this push starts a new
        // turn immediately. Clear its trace before the provider can emit the
        // first event. When a follow-up was queued during an active turn, the
        // result handler below performs this reset at the precise boundary.
        if (!turnActive) {
          resetActivityForNextTurn();
          resetMalformedToolRecovery();
        }
        turnActive = true;
        turnStartTime = Date.now();
        try { clearTurnEnded(); } catch { /* best-effort */ }
        setCurrentInReplyTo(activeTurnRouting.inReplyTo);
        query.push(prompt, followUpFiles.length > 0 ? followUpFiles : undefined);
        archivePrompts.push(prompt);
        // Enqueue this push as its own batch. We do NOT markCompleted here —
        // that happens when the corresponding `result` event drains the
        // queue. Marking at push time loses messages whose prompts the
        // provider collapsed into a single turn (no separate result fires).
        turnBatchQueue.push({ ids: keptIds, routing: activeTurnRouting });
      } catch (err) {
        // Without this catch the rejection escapes the void IIFE and Node
        // terminates the container on unhandled-rejection. The initial-batch
        // path is wrapped by processQuery's outer try/catch; the follow-up
        // path is not, so it needs its own.
        const errMsg = err instanceof Error ? err.message : String(err);
        log(`Follow-up poll error: ${errMsg}`);

        // Session DB gone — the host deleted the thread (e.g. user clicked
        // the trash icon) and removed the on-disk session dir. Without this
        // bail, we'd spam `unable to open database file` at the poll rate
        // forever until host-sweep's heartbeat-staleness rule eventually
        // notices. Exit immediately so the container is torn down.
        if (isMissingDbError(errMsg)) {
          log('Follow-up poll: inbound.db is gone — session was deleted by host. Exiting.');
          done = true;
          clearInterval(pollHandle);
          setTimeout(() => process.exit(0), 100);
          return;
        }

        // Detect SQLite cross-mount corruption (Docker Desktop macOS virtiofs /
        // gRPC-FUSE coherency bug — the kernel page cache for the inbound.db
        // bind mount can latch a torn snapshot mid-host-write, after which
        // every fresh openInboundDb() in this process sees the same broken
        // view. Reopening inside the container does NOT recover; only a fresh
        // container mount does. Exit so the host sweep respawns us.
        if (isCorruptionError(errMsg)) {
          corruptionStreak += 1;
          if (corruptionStreak >= CORRUPTION_STREAK_EXIT) {
            log(
              `Follow-up poll: ${corruptionStreak} consecutive '${errMsg}' errors — ` +
                `inbound.db page cache is poisoned. Exiting so host respawns with a fresh mount.`,
            );
            // Stop touching the heartbeat so host-sweep stale detection fires
            // promptly even if exit() races with in-flight async work.
            done = true;
            clearInterval(pollHandle);
            // Defer exit one tick so this log line flushes through Docker's
            // log driver before the process dies.
            setTimeout(() => process.exit(75), 100);
          }
        } else {
          corruptionStreak = 0;
        }
      } finally {
        pollInFlight = false;
      }
    })();
  }, ACTIVE_POLL_INTERVAL_MS);

  // Keep the heartbeat warm for as long as a turn is actually in flight.
  // The SDK can stall for 10–30s between events while Anthropic generates
  // the first token of a response; without this timer the host-side typing
  // module would mark the agent stale, drop the indicator, and never
  // re-arm it until the next inbound. Independent of `touchHeartbeat()`
  // on each event — that path still runs and stays the source of truth
  // when events are flowing.
  //
  // `turnActive` is true between turn start (initial entry into the
  // for-await + every follow-up push) and the terminating `result` /
  // `error` event. When false, we deliberately let the heartbeat go
  // stale so the host marks us idle and clears the typing indicator —
  // matching the behavior between processQuery calls (the outer poll
  // loop doesn't touch the heartbeat either).
  let turnActive = true;
  let turnStartTime = Date.now();
  const beginCorrectiveTurn = (activityText: string): void => {
    try {
      appendActivity({
        kind: 'notification',
        id: `nudge:${generateId()}`,
        text: activityText,
      });
    } catch { /* best-effort */ }
    turnActive = true;
    try { clearTurnEnded(); } catch { /* best-effort */ }
  };
  // Push the recovery nudge: a self-correction retry within the same warm
  // query. Used for both failure shapes — bare unwrapped text and a reply
  // swallowed by reasoning that normalized to empty. The nudge offers an
  // explicit escape hatch (re-send wrapped, OR emit <internal> to confirm
  // intentional silence) so a genuinely silent turn is never prodded into
  // fabricating a reply. One-shot: callers gate on `!nudgedForDelivery`.
  const pushDeliveryNudge = (failedRouting: RoutingContext): void => {
    nudgedForDelivery = true;
    deliveryErrorRouting = failedRouting;
    log('Recovery nudge: turn delivered nothing — asking the agent to re-send it wrapped');
    // Surface the recovery in the web-UI activity trace. The buffer carries
    // across the nudge→retry boundary (no reset without a queued user batch)
    // and flushes onto the recovered reply's row.
    beginCorrectiveTurn('Reply wasn’t formatted for delivery — asked the agent to re-send it.');
    const names = getAllDestinations().map((d) => d.name).join(', ');
    query.push(
      `<system>Your reply was not delivered. Either it was not wrapped in ` +
        `<message to="name">...</message> blocks, or it was left inside your ` +
        `reasoning. All delivered output must be wrapped: use <message to="name"> ` +
        `for content to send, or <internal> for scratchpad. ` +
        `Your destinations: ${names}. ` +
        `If you have a response, re-send it now with the correct wrapping. ` +
        `If you intentionally have nothing to send, reply with a brief ` +
        `<internal>…</internal> note explaining why (it will not be delivered).</system>`,
    );
  };
  const pushMalformedToolNudge = (failedRouting: RoutingContext): void => {
    if (malformedToolRecoveryAttempts === 0) malformedToolRecoveryHadNativeTool = false;
    malformedToolRecoveryAttempts++;
    malformedToolRecoveryMode = 'tool';
    malformedToolRecoveryRouting = failedRouting;
    log(
      `Recovery nudge: model emitted a malformed tool invocation ` +
        `(attempt ${malformedToolRecoveryAttempts}/${MAX_MALFORMED_TOOL_RECOVERY_ATTEMPTS})`,
    );
    beginCorrectiveTurn('A malformed tool call did not run - asked the agent to retry it natively.');
    query.push(
      `<system>Your previous tool invocation was malformed: it either omitted required arguments ` +
        `or printed XML-like tool-call markup as ordinary text. That tool call did NOT execute. ` +
        `Continue the original request now and invoke the required tools through the native tool ` +
        `interface with all required arguments. Do not write <tool_call>, <invoke>, or <command> ` +
        `markup yourself. After the tool work completes, send the result in a ` +
        `<message to="name">...</message> block.</system>`,
    );
  };
  const pushPostToolDeliveryNudge = (failedRouting: RoutingContext): void => {
    nudgedForDelivery = true;
    malformedToolRecoveryHadNativeTool = true;
    malformedToolRecoveryMode = 'delivery';
    malformedToolRecoveryRouting = failedRouting;
    log('Recovery nudge: malformed final output followed native tool activity - requesting delivery only');
    beginCorrectiveTurn(
      'A tool ran but its final reply was malformed - asked the agent to report the result without repeating the action.',
    );
    const names = getAllDestinations().map((d) => d.name).join(', ');
    const summarizeCall = ({ tool, detail }: { tool: string; detail?: string }): string => {
        const safeDetail = detail
          ? JSON.stringify(detail.slice(0, 240))
              .replace(/&/g, '\\u0026')
              .replace(/</g, '\\u003c')
              .replace(/>/g, '\\u003e')
          : '';
        return `- ${tool}${safeDetail ? `: ${safeDetail}` : ''}`;
    };
    const calls = [...executedToolCalls.values()];
    const completedCalls = calls
      .filter((call) => call.status === 'completed')
      .map(summarizeCall);
    const uncertainCalls = calls
      .filter((call) => call.status !== 'completed')
      .map(summarizeCall);
    const callSummary = [
      ...(completedCalls.length > 0
        ? [`Calls whose tool invocation completed (use their native results above to determine success or failure):\n${completedCalls.join('\n')}`]
        : []),
      ...(uncertainCalls.length > 0
        ? [`Calls that started but did not complete cleanly (they may still have effects):\n${uncertainCalls.join('\n')}`]
        : []),
    ].join('\n');
    const accepted = query.push(
      `<system>At least one native tool already ran in the previous turn, but the final reply ` +
        `was malformed. Here is the execution record:\n${callSummary || 'One or more native tools may have executed.'}\n` +
        `Do NOT repeat any of those calls or make equivalent requests through other tools. ` +
        `Tools are disabled for this recovery turn. Use the existing native results above and report ` +
        `the actual result in ` +
        `a <message to="name">...</message> block. Your destinations: ${names}.</system>`,
      undefined,
      { tools: 'disabled' },
    );
    if (!accepted) {
      malformedToolRecoveryMode = null;
      exhaustMalformedToolRecovery(failedRouting);
      if (!endedForCommand) {
        endedForCommand = true;
        query.end();
      }
    }
  };
  const pushPrematureCompletionNudge = (): void => {
    nudgedForPrematureCompletion = true;
    log('Recovery nudge: agent announced future work but ended the turn before using tools');
    beginCorrectiveTurn('The agent stopped after announcing work - asked it to continue the original request.');
    query.push(
      `<system>You ended the turn after announcing work that you had not performed. ` +
        `Continue the original request now. Invoke the required tools before returning a final ` +
        `<message>. Do not send another acknowledgment.</system>`,
    );
  };
  const liveHandle = setInterval(() => {
    if (!turnActive) return;
    try { touchHeartbeat(); } catch { /* best-effort */ }
  }, 2000);
  liveHandle.unref?.();

  try {
    for await (const event of query.events) {
      touchHeartbeat();
      handleEvent(event, routing);

      if (event.type === 'progress' && event.step.kind === 'tool') {
        toolActivityThisTurn = true;
        const isSubstantiveTool = event.step.tool !== 'nanoclaw_send_message' &&
          !event.step.tool.endsWith('__send_message');
        const priorCall = executedToolCalls.get(event.step.id);
        const reachedExecution = !event.step.rejectedBeforeExecution && (
          event.step.status === 'running' ||
          event.step.status === 'completed' ||
          event.step.status === 'error' ||
          priorCall !== undefined
        );
        if (isSubstantiveTool && reachedExecution) {
          substantiveToolActivityThisTurn = true;
          malformedToolRecoveryHadNativeTool = true;
          executedToolCalls.set(event.step.id, {
            tool: event.step.tool,
            ...(event.step.detail || priorCall?.detail
              ? { detail: event.step.detail ?? priorCall?.detail }
              : {}),
            status: event.step.status === 'pending' ? priorCall!.status : event.step.status,
          });
        }
      }

      if (event.type === 'init') {
        queryContinuation = event.continuation;
        // Persist immediately so a mid-turn container crash still lets the
        // next wake resume the conversation. Without this, the session id
        // was only written after the full stream completed — if the
        // container died between `init` and `result`, the SDK session was
        // effectively orphaned and the next message started a blank
        // Claude session with no prior context.
        // Skip for one-shot calls (e.g. the in-turn ack), which run in a
        // throwaway session and would otherwise clobber the rolled-back
        // continuation set by the failing turn's processQuery.
        if (persistContinuation) {
          setContinuation(providerName, event.continuation);
        }
      } else if (event.type === 'error' && !event.retryable) {
        // Capture non-retryable provider errors. Don't write to outbound
        // here — the SDK may still throw immediately after (e.g. the
        // stale-session case yields an is_error result then throws
        // "No conversation found"). If it does, the outer catch handles
        // the retry and the user never sees this transient error.
        lastProviderError = { message: event.message, classification: event.classification };
        if (promptTracker) {
          promptTracker.routing = malformedToolRecoveryRouting ?? activeTurnRouting;
        }

        // Force the stream closed so the turn ends now. Without this, the
        // SDK can keep the stream alive after a non-retryable error (e.g.
        // a 429 rate-limit) and the next user message gets pushed in,
        // transparently "recovering" — but the user never finds out their
        // original request failed. End early so the unsurfacedError path
        // notifies them; the next message starts a fresh query.
        if (!endedForCommand) {
          endedForCommand = true;
          query.end();
        }
      } else if (event.type === 'usage') {
        // Provider emits this just before `result`; stash and flush after
        // result so we can link to the last outbound row written this turn.
        // Fill in wall-clock duration when the provider doesn't supply one.
        if (!event.data.duration_ms) {
          event.data.duration_ms = Date.now() - turnStartTime;
        }
        pendingUsage = event.data;
      } else if (event.type === 'result') {
        resultSeen = true;
        const recoveryMode = malformedToolRecoveryMode;
        const isMalformedToolRecoveryResult = recoveryMode !== null;
        const isPostToolDeliveryRecovery = recoveryMode === 'delivery';
        malformedToolRecoveryMode = null;
        // Drain the OLDEST batch from the queue — one result corresponds
        // to one batch of work. When providers run separate turns per
        // pushed prompt (typical case, including OpenCode when pushes
        // are spaced out enough that the prior turn has already
        // finished), each result event drains its own batch, the reply
        // is stamped with that batch's routing, and the typing
        // indicator stays on across the gap because the queue still
        // has the next batch.
        //
        // When a provider really does collapse multiple queued pushes
        // into a single assistant response (one result event for two
        // pushed prompts), the leftover batch stays in the queue and
        // gets drained by the stream-end finally block below.
        let resultRouting = isMalformedToolRecoveryResult && malformedToolRecoveryRouting
          ? malformedToolRecoveryRouting
          : routing;
        const drainedIds: string[] = [];
        if (!isMalformedToolRecoveryResult && turnBatchQueue.length > 0) {
          const head = turnBatchQueue.shift()!;
          drainedIds.push(...head.ids);
          resultRouting = head.routing;
        }
        // Only end the turn (stop warming the heartbeat, mark
        // turn_ended_at so the host clears the typing indicator) when
        // no more queued batches remain. If there's still pending
        // work, the provider is about to start another turn for it
        // and the indicator must stay lit across the gap.
        if (turnBatchQueue.length === 0) {
          turnActive = false;
          try { setTurnEnded(); } catch { /* best-effort */ }
        }
        // Update MCP send_message routing for any subsequent turn the
        // provider may run within this query (e.g. on the nudge push
        // below, or a still-queued follow-up that arrived in the gap).
        setCurrentInReplyTo(resultRouting.inReplyTo);
        if (event.text) {
          const mcpWroteReply = countTurnContentMessages(outboundMaxAtTurnStart) > 0;
          const wasRecoveringPrematureCompletion = prematureCompletionBatchIds.length > 0;
          const prematureCompletion =
            !mcpWroteReply && !toolActivityThisTurn &&
            event.finishReason === 'stop' && event.recoveredFromUnclosedThink === true &&
            isFutureWorkAnnouncement(event.text);
          if (prematureCompletion && nudgedForPrematureCompletion) {
            if (prematureCompletionBatchIds.length > 0 || drainedIds.length > 0) {
              markCompleted([...prematureCompletionBatchIds, ...drainedIds]);
              prematureCompletionBatchIds = [];
            }
            writeMessageOut({
              id: generateId(),
              kind: 'chat',
              platform_id: resultRouting.platformId,
              channel_type: resultRouting.channelType,
              thread_id: resultRouting.threadId,
              content: JSON.stringify({
                text: 'The agent stopped after announcing work twice without performing it. Please retry or use another model.',
              }),
            });
            sentAny = true;
            notifyExchangeComplete(onExchangeComplete, {
              prompt: archivePrompts[0] ?? initialPrompt,
              result: event.text,
              continuation: queryContinuation ?? priorContinuation,
              status: 'error',
            });
            archivePrompts.shift();
            if (!endedForCommand) {
              endedForCommand = true;
              query.end();
            }
          } else {
            if (prematureCompletion) {
              prematureCompletionBatchIds.push(...drainedIds);
            } else if (prematureCompletionBatchIds.length > 0 || drainedIds.length > 0) {
              markCompleted([...prematureCompletionBatchIds, ...drainedIds]);
              prematureCompletionBatchIds = [];
            }
            const wasRecoveringDelivery = nudgedForDelivery;
            const { sent, hasUnwrapped, internalCount } = dispatchResultText(event.text, resultRouting);
            // The first premature announcement is deliberately delivered as a
            // progress update, but it does not satisfy the original request.
            if (sent > 0 && !prematureCompletion) sentAny = true;
            // A post-nudge retry that delivers nothing but writes an <internal>
            // note is the model taking the escape hatch — confirming it meant to
            // stay silent. Treat as intentional silence, not a delivery failure.
            if (nudgedForDelivery && sent === 0 && internalCount > 0) silenceConfirmed = true;
            if (isPostToolDeliveryRecovery && !mcpWroteReply && sent === 0) {
              silenceConfirmed = false;
              exhaustMalformedToolRecovery(resultRouting);
              if (turnBatchQueue.length === 0 && !endedForCommand) {
                endedForCommand = true;
                query.end();
              }
            }
            if (sent > 0 || mcpWroteReply) {
              resetMalformedToolRecovery();
            }
            const willRetryWrapping =
              !mcpWroteReply && hasUnwrapped &&
              !malformedToolRecoveryHadNativeTool &&
              !nudgedForDelivery && !nudgedForPrematureCompletion;
            const willRecoverPostToolDelivery =
              !mcpWroteReply && hasUnwrapped && malformedToolRecoveryHadNativeTool &&
              !nudgedForDelivery && !nudgedForPrematureCompletion;
            notifyExchangeComplete(onExchangeComplete, {
              prompt: archivePrompts[0] ?? initialPrompt,
              result: event.text,
              continuation: queryContinuation ?? priorContinuation,
              status: (prematureCompletion || (!mcpWroteReply && hasUnwrapped)) ? 'undelivered' : 'completed',
            });
            if (mcpWroteReply) {
              sentAny = true;
            } else if (prematureCompletion) {
              pushPrematureCompletionNudge();
            } else if (willRecoverPostToolDelivery) {
              pushPostToolDeliveryNudge(resultRouting);
            } else if (willRetryWrapping) {
              log(`WARNING: agent output had no <message to="..."> blocks — nothing was sent`);
              pushDeliveryNudge(resultRouting);
            } else if (sent === 0 && internalCount > 0 && !wasRecoveringDelivery) {
              emptyResultSeen = true;
              if (turnBatchQueue.length === 0 && !endedForCommand) {
                endedForCommand = true;
                query.end();
              }
            }
            // Recovery retries answer the SAME user prompt — keep it queued so
            // the retry archives against it, not the nudge text.
            if (!willRetryWrapping && !willRecoverPostToolDelivery && !prematureCompletion) {
              archivePrompts.shift();
            }
            if (
              wasRecoveringDelivery && !mcpWroteReply && sent === 0 && internalCount === 0 &&
              turnBatchQueue.length === 0 && !endedForCommand
            ) {
              endedForCommand = true;
              query.end();
            }
            if (wasRecoveringPrematureCompletion && !mcpWroteReply && sent === 0 && !endedForCommand) {
              emptyResultSeen = true;
              endedForCommand = true;
              query.end();
            }
          }
        } else {
          // A result event with no final text. Two sub-cases:
          //  (a) `strippedToEmpty` — the model produced raw text that
          //      normalized to nothing (its reply was swallowed by reasoning
          //      with no <message> wrapper). Recoverable: nudge once, exactly
          //      like bare unwrapped text above.
          //  (b) genuinely nothing — no reasoning to strip, nothing to
          //      recover. This is the shape of a legitimately silent
          //      autonomous/task turn, so it is NOT nudged; it falls through
          //      to the terminal empty-result notice.
          const mcpWroteReply = countTurnContentMessages(outboundMaxAtTurnStart) > 0;
          if (isPostToolDeliveryRecovery && !mcpWroteReply) {
            exhaustMalformedToolRecovery(resultRouting);
          }
          if (mcpWroteReply) {
            sentAny = true;
            resetMalformedToolRecovery();
          }
          const wasRecoveringPrematureCompletion = prematureCompletionBatchIds.length > 0;
          const progressOnlyCompletion =
            mcpWroteReply && !substantiveToolActivityThisTurn &&
            turnOnlySentFutureWorkAnnouncements(outboundMaxAtTurnStart);
          if (progressOnlyCompletion && !nudgedForPrematureCompletion) {
            prematureCompletionBatchIds.push(...drainedIds);
            pushPrematureCompletionNudge();
          } else if (progressOnlyCompletion) {
            if (prematureCompletionBatchIds.length > 0 || drainedIds.length > 0) {
              markCompleted([...prematureCompletionBatchIds, ...drainedIds]);
              prematureCompletionBatchIds = [];
            }
            writeMessageOut({
              id: generateId(),
              kind: 'chat',
              platform_id: resultRouting.platformId,
              channel_type: resultRouting.channelType,
              thread_id: resultRouting.threadId,
              content: JSON.stringify({
                text: 'The agent stopped after announcing work twice without performing it. Please retry or use another model.',
              }),
            });
            sentAny = true;
            if (!endedForCommand) {
              endedForCommand = true;
              query.end();
            }
          } else {
            if (prematureCompletionBatchIds.length > 0 || drainedIds.length > 0) {
              markCompleted([...prematureCompletionBatchIds, ...drainedIds]);
              prematureCompletionBatchIds = [];
            }
            const willNudge =
              !mcpWroteReply && event.strippedToEmpty === true &&
              event.malformedToolCall !== true &&
              !nudgedForDelivery && !nudgedForPrematureCompletion && !lastProviderError;
            const willRetryMalformedTool =
              !mcpWroteReply && !malformedToolRecoveryHadNativeTool &&
              event.malformedToolCall === true &&
              malformedToolRecoveryAttempts < MAX_MALFORMED_TOOL_RECOVERY_ATTEMPTS &&
              !nudgedForDelivery &&
              !nudgedForPrematureCompletion && !lastProviderError;
            const willRecoverPostToolDelivery =
              !mcpWroteReply && malformedToolRecoveryHadNativeTool &&
              event.strippedToEmpty === true && !nudgedForDelivery &&
              !nudgedForPrematureCompletion && !lastProviderError;
            if (willRetryMalformedTool) {
              pushMalformedToolNudge(resultRouting);
              // Keep the prompt queued: the retry continues the same work.
            } else if (willRecoverPostToolDelivery) {
              pushPostToolDeliveryNudge(resultRouting);
              // Keep the prompt queued: the retry only reports prior results.
            } else if (event.malformedToolCall && !mcpWroteReply) {
              exhaustMalformedToolRecovery(malformedToolRecoveryRouting ?? resultRouting);
              archivePrompts.shift();
              if (turnBatchQueue.length === 0 && !endedForCommand) {
                endedForCommand = true;
                query.end();
              }
            } else if (willNudge) {
              log('Result stripped to empty (reply swallowed by reasoning) — nudging');
              pushDeliveryNudge(resultRouting);
              // Keep the prompt queued: the retry answers the same user prompt.
            } else {
              emptyResultSeen = true;
              archivePrompts.shift();
              // Long-lived providers (OpenCode) keep the query open after a turn
              // so rapid follow-ups reuse the warm session. That's fine when a
              // reply was sent, but an empty turn sends nothing, so the query
              // would sit open and the post-stream empty-result notice (below the
              // events loop) would never run. When nothing was sent and no
              // follow-up batches are queued, end the stream now so the turn
              // completes and the notice fires. The continuation was persisted at
              // `init`, so the next message resumes the same session normally.
              if ((!sentAny || wasRecoveringPrematureCompletion) && turnBatchQueue.length === 0 && !endedForCommand) {
                endedForCommand = true;
                query.end();
              }
            }
          }
        }
        // One-shot calls (in-turn ack): end the stream immediately after
        // the first result. Without this, the query stays open waiting
        // for stream-close, and the follow-up poller pushes the next
        // user message into this throwaway session — defeating the
        // continuation rollback. The user's next turn must start a
        // fresh query against the rolled-back continuation.
        if (!persistContinuation) {
          endedForCommand = true;
          query.end();
        }
        // Flush captured usage, linking to the last outbound row written
        // this turn. If the turn produced no outbound rows (e.g. scratchpad
        // only), still record the usage with an empty message link so the
        // numbers don't disappear. Also persist the activity trace against
        // the same row so historical messages show the steps live viewers saw.
        {
          const lastOutId = (getOutboundDb()
            .prepare('SELECT id FROM messages_out WHERE seq > ? ORDER BY seq DESC LIMIT 1')
            .get(outboundMaxAtTurnStart) as { id: string } | undefined)?.id ?? '';
          if (pendingUsage) {
            try {
              writeTurnUsage(
                `tu-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
                lastOutId,
                pendingUsage,
              );
            } catch (e) {
              log(`Failed to write turn_usage: ${e instanceof Error ? e.message : String(e)}`);
            }
            pendingUsage = null;
          }
          // Persist activity lines emitted since the last flush (avoids
          // overlap when one query yields multiple results). Linked to a
          // real outbound row only — scratchpad-only turns have no bubble
          // to attach a trace to.
          if (lastOutId) {
            try {
              const buffer = getActivityBuffer();
              const fresh = buffer.slice(activityFlushedCount);
              writeTurnActivity(lastOutId, fresh, activityFlushedCount);
              activityFlushedCount = buffer.length;
            } catch (e) {
              log(`Failed to write turn_activity: ${e instanceof Error ? e.message : String(e)}`);
            }
          }
          // A queued user batch begins as soon as this result is consumed.
          // Its provider events must replace, not extend, the completed
          // turn's live snapshot. Persist first, then clear at the boundary.
          if (turnBatchQueue.length > 0) resetActivityForNextTurn();
        }
        // Reset the per-turn baseline so a follow-up push within the same
        // query starts a fresh "did MCP write anything?" window.
        outboundMaxAtTurnStart = currentOutboundMax();
        toolActivityThisTurn = false;
        substantiveToolActivityThisTurn = false;
        turnStartTime = Date.now();
      }
    }
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    notifyExchangeComplete(onExchangeComplete, {
      prompt: archivePrompts[0] ?? initialPrompt,
      result: `Error: ${errMsg}`,
      continuation: queryContinuation ?? priorContinuation,
      status: 'error',
    });
    throw err;
  } finally {
    done = true;
    clearInterval(pollHandle);
    clearInterval(liveHandle);
    // Drain any queued follow-up batches that never reached a `result`
    // event. Without this, when the SDK throws mid-turn the outer catch
    // only marks the initial batch completed (via runPollLoop's
    // `markCompleted(processingIds)`), and any messages pushed into the
    // active query during the failure window stay markProcessing'd in
    // inbound.db forever — they never re-fire and never get acknowledged.
    // markCompleted is INSERT OR REPLACE, so re-marking the initial batch
    // here is harmless.
    const orphanedIds: string[] = [];
    while (turnBatchQueue.length > 0) {
      orphanedIds.push(...turnBatchQueue.shift()!.ids);
    }
    if (orphanedIds.length > 0) {
      try { markCompleted(orphanedIds); } catch { /* best-effort */ }
      // Stream closed with leftover queued batches — the result branch
      // skipped setTurnEnded because the queue was non-empty, so do it
      // here so the host's typing module clears the indicator promptly
      // instead of waiting for the heartbeat to age out.
      try { setTurnEnded(); } catch { /* best-effort */ }
    }
    // Atomic continuation rollback. The `init` handler persisted the new
    // SDK session id immediately (for mid-turn crash recovery), but if the
    // turn never reached a `result` event — the stream errored out or the
    // SDK threw — that new id points at a half-baked transcript with no
    // completed assistant turn. Resuming from it on the next message tends
    // to drop prior context, which cascades: every subsequent turn forks
    // into a fresh session and the agent eventually has nothing to anchor
    // on. Restore the prior good id so the next turn resumes from a
    // session that actually completed at least one turn cleanly.
    if (!resultSeen && priorContinuation && queryContinuation && queryContinuation !== priorContinuation) {
      log(`Turn ended without result; restoring prior continuation ${priorContinuation} (discarding ${queryContinuation})`);
      try { setContinuation(providerName, priorContinuation); } catch { /* best-effort */ }
      queryContinuation = priorContinuation;
    }
  }

  const writeTurnNotice = (
    noticeRouting: RoutingContext,
    text: string,
    failureLabel: string,
  ): void => {
    try {
      writeMessageOut({
        id: generateId(),
        kind: 'chat',
        platform_id: noticeRouting.platformId,
        channel_type: noticeRouting.channelType,
        thread_id: noticeRouting.threadId,
        content: JSON.stringify({ text }),
      });
    } catch (e) {
      log(`Failed to write ${failureLabel}: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  // Three mutually-exclusive terminal outcomes for a turn that delivered
  // nothing (all gated on `!sentAny && !lastProviderError`). Ordered by
  // specificity — the first match wins:
  //
  //  1. silenceConfirmed → deliver NOTHING. We nudged a turn that produced no
  //     deliverable, and the retry came back as an <internal> note: the model
  //     took the escape hatch and confirmed it meant to stay quiet. A
  //     deliberate no-op must not surface as an error.
  //
  //  2. nudgedForPrematureCompletion → explicit incomplete-work error. A
  //     progress update was delivered, but the corrective turn still failed
  //     to answer the original request.
  //
  //  3. nudgedForDelivery (and not silence-confirmed) → generic error. The
  //     model left evidence it was trying to reply — bare unwrapped text, or a
  //     reply swallowed by reasoning — we asked it to re-send wrapped, and it
  //     STILL delivered nothing. That's a genuine malfunction.
  //
  //  4. emptyResultSeen (never nudged) → "finished without producing a
  //     response". The turn produced no deliverable response: no bare reply,
  //     no reasoning that stripped away, and at most an internal scratchpad.
  //     We deliberately do not nudge this path.
  if (!sentAny && silenceConfirmed && !lastProviderError) {
    log('Turn confirmed intentional silence after nudge — delivering nothing');
  } else if (!sentAny && nudgedForPrematureCompletion && !lastProviderError) {
    log('Premature-completion recovery produced no answer — surfacing explicit error');
    writeTurnNotice(
      routing,
      'The agent stopped after announcing work without completing it. Please retry or use another model.',
      'premature-completion error',
    );
  } else if (!sentAny && malformedToolRecoveryExhausted && !lastProviderError) {
    log('Malformed tool-call recovery exhausted — surfacing specific error');
    writeTurnNotice(
      malformedToolErrorRouting,
      malformedToolRecoveryHadNativeTool
        ? '⚠️ A tool ran, but the model repeatedly failed to format its final reply. The action was not retried. Ask the agent to report the existing result or switch models.'
        : '⚠️ The model repeatedly produced malformed tool calls, so no tool was executed. Retry the task or switch to a model with reliable native tool calling.',
      'malformed-tool error',
    );
  } else if (!sentAny && nudgedForDelivery && !lastProviderError) {
    log('Turn produced no deliverable output after recovery nudge — surfacing generic error');
    writeTurnNotice(
      deliveryErrorRouting,
      '⚠️ Something went wrong producing a reply. Please try again.',
      'generic delivery error',
    );
  }

  // Stream completed cleanly with a `result` event, but the model produced no
  // deliverable response — and reported no error, and there was nothing to
  // recover (so we never nudged). Tell the user plainly so a silent turn
  // doesn't look like the agent is still working or died.
  else if (!sentAny && emptyResultSeen && !lastProviderError) {
    log('Turn completed with an empty result and no error — notifying user');
    writeTurnNotice(
      routing,
      '⚠️ The agent finished without producing a response, and without reporting an error. Please try again.',
      'empty-result notice',
    );
  }

  return {
    continuation: queryContinuation,
    // Only surface a provider error if the stream completed cleanly AND
    // the turn produced nothing deliverable. If the SDK threw, that path
    // takes over (with stale-session retry); if a message did get sent,
    // a trailing error is best left in the logs.
    unsurfacedError: !sentAny && lastProviderError
      ? { ...lastProviderError, routing: promptTracker?.routing ?? activeTurnRouting }
      : undefined,
  };
}

function notifyExchangeComplete(
  hook: ((exchange: ProviderExchange) => void) | undefined,
  exchange: ProviderExchange,
): void {
  if (!hook) return;
  try {
    hook(exchange);
  } catch (err) {
    log(`onExchangeComplete failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function handleEvent(event: ProviderEvent, _routing: RoutingContext): void {
  switch (event.type) {
    case 'init':
      log(`Session: ${event.continuation}`);
      break;
    case 'result':
      log(`Result: ${event.text ? event.text.slice(0, 200) : '(empty)'}`);
      // setTurnEnded is intentionally NOT called here — the caller (result
      // branch in processQuery) decides whether the turn is truly done
      // (queue empty) or another turn for a queued push is about to start.
      break;
    case 'error':
      log(
        `Error: ${event.message} (retryable: ${event.retryable}${event.classification ? `, ${event.classification}` : ''})`,
      );
      try { setTurnEnded(); } catch { /* best-effort */ }
      break;
    case 'progress': {
      const s = event.step;
      const label = s.kind === 'tool' ? s.tool : 'text' in s ? s.text : '';
      log(`Progress: ${s.kind}${label ? ` ${label}` : ''}`);
      try { appendActivity(s); } catch { /* best-effort */ }
      break;
    }
  }
}

/**
 * Parse the agent's final text for <message to="name">...</message> blocks
 * and dispatch each one to its resolved destination. Text outside of blocks
 * (including <internal>...</internal>) is scratchpad — logged but not sent.
 *
 * The agent must always wrap output in <message to="name">...</message>
 * blocks, even with a single destination. Bare text is scratchpad only.
 */
function dispatchResultText(
  text: string,
  routing: RoutingContext,
): { sent: number; hasUnwrapped: boolean; internalCount: number } {
  const parsed = parseAssistantOutput(text);
  if (parsed.diagnostics.length > 0) {
    log(`Output recovery: ${[...new Set(parsed.diagnostics)].join(', ')}`);
  }

  // Internal blocks are operator-visible trace entries, never channel
  // deliveries. Emit one identified step per block so repeated blocks remain
  // distinct and the host can reduce the trace normally.
  for (let i = 0; i < parsed.internal.length; i++) {
    try {
      appendActivity({
        kind: 'internal',
        id: `internal:${generateId()}:${i}`,
        text: parsed.internal[i],
      });
    } catch { /* best-effort */ }
  }

  let sent = 0;
  const scratchpadParts: string[] = parsed.unwrapped ? [parsed.unwrapped] : [];

  for (const delivery of parsed.deliveries) {
    const toName = delivery.to;
    const body = delivery.body;

    // Weak reasoning models (e.g. minimax-m3) sometimes emit stray empty
    // <message to="..."></message> wrappers. Delivering them writes blank
    // {"text":""} chat rows that render as empty bubbles in the UI. Skip
    // them (mirrors the empty-text guard in the send_message MCP tool).
    if (!body) {
      log(`Empty <message to="${toName}"> block, dropping`);
      continue;
    }

    const dest = findByName(toName);
    if (!dest) {
      log(`Unknown destination in <message to="${toName}">, dropping block`);
      scratchpadParts.push(`[dropped: unknown destination "${toName}"] ${body}`);
      continue;
    }
    sendToDestination(dest, body, routing);
    sent++;
  }

  const scratchpad = scratchpadParts.join('').trim();

  if (scratchpad) {
    log(`[scratchpad] ${scratchpad.slice(0, 500)}${scratchpad.length > 500 ? '…' : ''}`);
  }

  const hasUnwrapped = sent === 0 && !!scratchpad;
  return { sent, hasUnwrapped, internalCount: parsed.internal.length };
}

/**
 * Identify a short delivery whose only purpose is to announce tool work that
 * has not happened yet. Callers also require OpenCode's malformed-output and
 * no-tool signals; this text check is intentionally only one part of the guard.
 */
export function isFutureWorkAnnouncement(text: string): boolean {
  const parsed = parseAssistantOutput(text);
  if (parsed.deliveries.length !== 1 || parsed.internal.length > 0 || parsed.unwrapped) return false;
  return isFutureWorkMessage(parsed.deliveries[0].body);
}

function isFutureWorkMessage(body: string): boolean {
  if (!body || body.length > 240) return false;
  const planningLead = /\b(?:understood|on it|let me|i(?:'ll| will| need to| am going to| am about to))\b/i;
  const toolWork = /\b(?:search(?:ing)?|research(?:ing)?|look(?:ing)?\s+(?:into|up)|investigat(?:e|ing)|check(?:ing)?|dig(?:ging)?|review(?:ing)?|inspect(?:ing)?|test(?:ing)?|work(?:ing)?\s+on|start(?:ing)?)\b/i;
  return planningLead.test(body) && toolWork.test(body);
}

function sendToDestination(dest: DestinationEntry, body: string, routing: RoutingContext): void {
  const platformId = dest.type === 'channel' ? dest.platformId! : dest.agentGroupId!;
  const channelType = dest.type === 'channel' ? dest.channelType! : 'agent';
  // Same-channel reply: thread under the exact message the agent is
  // responding to. Cross-channel (agent-shared sessions, broadcasts):
  // look up that channel's most recent inbound for thread_id. The
  // trigger's in_reply_to doesn't apply across channels, so leave it
  // null in that case rather than pinning the reply to an unrelated
  // message in the other channel.
  let threadId: string | null;
  let inReplyTo: string | null;
  if (channelType === routing.channelType && platformId === routing.platformId) {
    threadId = routing.threadId;
    inReplyTo = routing.inReplyTo;
  } else {
    const destRouting = resolveDestinationThread(channelType, platformId);
    threadId = destRouting?.threadId ?? null;
    inReplyTo = destRouting?.inReplyTo ?? null;
  }
  writeMessageOut({
    id: generateId(),
    in_reply_to: inReplyTo,
    kind: 'chat',
    platform_id: platformId,
    channel_type: channelType,
    thread_id: threadId,
    content: JSON.stringify({ text: body, delivery_origin: 'response' }),
  });
}

/**
 * Find the thread_id and message id from the most recent inbound message
 * matching the given channel+platform. Returns null if no match found.
 */
function resolveDestinationThread(
  channelType: string,
  platformId: string,
): { threadId: string | null; inReplyTo: string | null } | null {
  try {
    const db = getInboundDb();
    const row = db
      .prepare(
        `SELECT thread_id, id FROM messages_in
         WHERE channel_type = ? AND platform_id = ?
         ORDER BY seq DESC LIMIT 1`,
      )
      .get(channelType, platformId) as { thread_id: string | null; id: string } | undefined;
    if (row) return { threadId: row.thread_id, inReplyTo: row.id };
  } catch (err) {
    log(`resolveDestinationThread error: ${err instanceof Error ? err.message : String(err)}`);
  }
  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
