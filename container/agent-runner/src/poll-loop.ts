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
  stripInternalTags,
  extractInternalTags,
  type RoutingContext,
} from './formatter.js';
import { isUploadTraceCommand, uploadTrace } from './upload-trace.js';
import { isAudioMime, transcribeAudio } from './transcribe.js';
import { getConfig } from './config.js';
import { startTurnWatchdog } from './turn-watchdog.js';
import type { AgentProvider, AgentQuery, FileAttachment, ProviderEvent, ProviderExchange } from './providers/types.js';

const POLL_INTERVAL_MS = 1000;
const ACTIVE_POLL_INTERVAL_MS = 500;

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
    const promptTracker = { latest: prompt };
    // Stale-session retry: if the first attempt fails because the stored
    // continuation is unusable (Claude Code returns "No conversation found
    // with session ID …" when the server-side session has expired or the
    // local transcript is gone), clear the continuation and retry once
    // with a fresh session — silently, so the user never sees the error.
    let attempt = 0;
    const rawFiles = extractFileAttachments(keep);
    const { prompt: resolvedPrompt, files } = await transcribeAudioFiles(rawFiles, prompt);
    prompt = resolvedPrompt;
    // Long-turn feedback: a turn can run for minutes. The ephemeral typing
    // indicator is not persisted, so a user who reloads/reconnects sees only
    // their message until the final answer lands — indistinguishable from a
    // dead agent. The watchdog emits a durable "still working…" chat message
    // if the turn stays silent past its threshold. Only for channel-bound
    // turns; system/a2a turns without a channel target get nothing.
    const watchdog =
      routing.channelType && routing.platformId ? startTurnWatchdog(routing) : null;
    try {
      while (true) {
        const query = config.provider.query({
          prompt,
          continuation,
          cwd: config.cwd,
          files: files.length > 0 ? files : undefined,
          systemContext: config.systemContext,
        });
        try {
          const result = await processQuery(
            query,
            routing,
            processingIds,
            config.providerName,
            continuation,
            true,
            promptTracker,
            config.provider.onExchangeComplete?.bind(config.provider),
            prompt,
          );
          if (result.continuation && result.continuation !== continuation) {
            continuation = result.continuation;
            setContinuation(config.providerName, continuation);
          }
          if (result.unsurfacedError) {
            const tag = result.unsurfacedError.classification
              ? ` [${result.unsurfacedError.classification}]`
              : '';
            writeMessageOut({
              id: generateId(),
              kind: 'chat',
              platform_id: routing.platformId,
              channel_type: routing.channelType,
              thread_id: routing.threadId,
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
          const ack = await tryAcknowledgeFailure(config, routing, errMsg, undefined);
          if (!ack.delivered) {
            writeMessageOut({
              id: generateId(),
              kind: 'chat',
              platform_id: routing.platformId,
              channel_type: routing.channelType,
              thread_id: routing.threadId,
              content: JSON.stringify({ text: friendlyProviderErrorFallback(errMsg) }),
            });
          }
          break;
        }
      }
    } finally {
      watchdog?.stop();
      clearCurrentInReplyTo();
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
  unsurfacedError?: { message: string; classification?: string };
}

async function processQuery(
  query: AgentQuery,
  routing: RoutingContext,
  initialBatchIds: string[],
  providerName: string,
  priorContinuation: string | undefined,
  persistContinuation = true,
  promptTracker?: { latest: string },
  onExchangeComplete?: (exchange: ProviderExchange) => void,
  initialPrompt = '',
): Promise<QueryResult> {
  let queryContinuation: string | undefined;
  let resultSeen = false;
  let done = false;
  let unwrappedNudged = false;
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
  // re-persist earlier lines. Reset implicitly by clearActivity() above.
  let activityFlushedCount = 0;

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
      if (r.kind === 'internal') continue;
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

        // Skip system messages (MCP tool responses).
        // Thread routing is the router's concern — if a message landed in this
        // session, the agent should see it. Per-thread sessions already isolate
        // threads into separate containers; shared sessions intentionally merge
        // everything. Filtering on thread_id here caused deadlocks when the
        // initial batch and follow-ups had mismatched thread_ids (e.g. a
        // host-generated welcome trigger with null thread vs a Discord DM reply).
        const newMessages = pending.filter((m) => m.kind !== 'system');
        if (newMessages.length === 0) return;

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
        let prompt = formatMessages(keep);
        const rawFollowUpFiles = extractFileAttachments(keep);
        const { prompt: resolvedFollowUp, files: followUpFiles } = await transcribeAudioFiles(rawFollowUpFiles, prompt);
        prompt = resolvedFollowUp;
        log(`Pushing ${keep.length} follow-up message(s) into active query`);
        unwrappedNudged = false;
        if (promptTracker) promptTracker.latest = prompt;
        turnActive = true;
        turnStartTime = Date.now();
        try { clearTurnEnded(); } catch { /* best-effort */ }
        query.push(prompt, followUpFiles.length > 0 ? followUpFiles : undefined);
        archivePrompts.push(prompt);
        // Enqueue this push as its own batch. We do NOT markCompleted here —
        // that happens when the corresponding `result` event drains the
        // queue. Marking at push time loses messages whose prompts the
        // provider collapsed into a single turn (no separate result fires).
        // setCurrentInReplyTo is deliberately NOT updated here: in-flight
        // MCP `send_message` calls from the still-running prior turn must
        // continue to thread under that turn's batch, not jump ahead to
        // this newly-queued one. The result handler advances setCurrent
        // when this batch's turn actually begins.
        turnBatchQueue.push({ ids: keptIds, routing: extractRouting(keep) });
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
  const liveHandle = setInterval(() => {
    if (!turnActive) return;
    try { touchHeartbeat(); } catch { /* best-effort */ }
  }, 2000);
  liveHandle.unref?.();

  try {
    for await (const event of query.events) {
      handleEvent(event, routing);
      touchHeartbeat();

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
        let resultRouting = routing;
        const drainedIds: string[] = [];
        if (turnBatchQueue.length > 0) {
          const head = turnBatchQueue.shift()!;
          drainedIds.push(...head.ids);
          resultRouting = head.routing;
        }
        if (drainedIds.length > 0) markCompleted(drainedIds);
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
          const { sent, hasUnwrapped } = dispatchResultText(event.text, resultRouting);
          if (sent > 0) sentAny = true;
          const willRetryWrapping = !mcpWroteReply && hasUnwrapped && !unwrappedNudged;
          notifyExchangeComplete(onExchangeComplete, {
            prompt: archivePrompts[0] ?? initialPrompt,
            result: event.text,
            continuation: queryContinuation ?? priorContinuation,
            status: (!mcpWroteReply && hasUnwrapped) ? 'undelivered' : 'completed',
          });
          if (mcpWroteReply) {
            sentAny = true;
          } else if (willRetryWrapping) {
            unwrappedNudged = true;
            log(`WARNING: agent output had no <message to="..."> blocks — nothing was sent`);
            const destinations = getAllDestinations();
            const names = destinations.map((d) => d.name).join(', ');
            turnActive = true;
            try { clearTurnEnded(); } catch { /* best-effort */ }
            query.push(
              `<system>Your response was not delivered — it was not wrapped in <message to="name">...</message> blocks. ` +
                `All output must be wrapped: use <message to="name"> for content to send, or <internal> for scratchpad. ` +
                `Your destinations: ${names}. ` +
                `Please re-send your response with the correct wrapping.</system>`,
            );
          }
          // The wrapping-retry result answers the SAME user prompt — keep it
          // queued so the retry archives against it, not the nudge text.
          if (!willRetryWrapping) archivePrompts.shift();
        } else {
          archivePrompts.shift();
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
        }
        // Reset the per-turn baseline so a follow-up push within the same
        // query starts a fresh "did MCP write anything?" window.
        outboundMaxAtTurnStart = currentOutboundMax();
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

  // Stream completed cleanly, no provider error, but the agent emitted text
  // we couldn't deliver — typically a malformed `<message>` wrap (missing
  // closing tag, wrong destination, or pure scratchpad even after the nudge).
  // Without this the user just sees nothing on a turn the agent thought it
  // had answered. Surface a generic error so the conversation doesn't stall.
  if (!sentAny && unwrappedNudged && !lastProviderError) {
    log('Turn produced no deliverable output after wrap nudge — surfacing generic error');
    try {
      writeMessageOut({
        id: generateId(),
        kind: 'chat',
        platform_id: routing.platformId,
        channel_type: routing.channelType,
        thread_id: routing.threadId,
        content: JSON.stringify({
          text: "⚠️ Something went wrong producing a reply. Please try again.",
        }),
      });
    } catch (e) {
      log(`Failed to write generic delivery error: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  return {
    continuation: queryContinuation,
    // Only surface a provider error if the stream completed cleanly AND
    // the turn produced nothing deliverable. If the SDK threw, that path
    // takes over (with stale-session retry); if a message did get sent,
    // a trailing error is best left in the logs.
    unsurfacedError: !sentAny && lastProviderError ? lastProviderError : undefined,
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
      log(`Progress: ${s.kind}${s.tool ? ` ${s.tool}` : ''}${s.text ? ` ${s.text}` : ''}`);
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
function dispatchResultText(text: string, routing: RoutingContext): { sent: number; hasUnwrapped: boolean } {
  const MESSAGE_RE = /<message\s+to="([^"]+)"\s*>([\s\S]*?)<\/message>/g;

  // Surface <internal>...</internal> reasoning to the web UI as a separate
  // messages_out row, BEFORE dispatching <message> blocks so the internal
  // bubble sequences ahead of the response in the UI's seq-ordered view.
  const internalText = extractInternalTags(text);
  if (internalText && routing.channelType === 'web' && routing.platformId) {
    writeMessageOut({
      id: generateId(),
      in_reply_to: routing.inReplyTo,
      kind: 'internal',
      platform_id: routing.platformId,
      channel_type: routing.channelType,
      thread_id: routing.threadId,
      content: JSON.stringify({ text: internalText }),
    });
  }

  let match: RegExpExecArray | null;
  let sent = 0;
  let lastIndex = 0;
  const scratchpadParts: string[] = [];

  while ((match = MESSAGE_RE.exec(text)) !== null) {
    if (match.index > lastIndex) {
      scratchpadParts.push(text.slice(lastIndex, match.index));
    }
    const toName = match[1];
    const body = match[2].trim();
    lastIndex = MESSAGE_RE.lastIndex;

    const dest = findByName(toName);
    if (!dest) {
      log(`Unknown destination in <message to="${toName}">, dropping block`);
      scratchpadParts.push(`[dropped: unknown destination "${toName}"] ${body}`);
      continue;
    }
    sendToDestination(dest, body, routing);
    sent++;
  }
  if (lastIndex < text.length) {
    scratchpadParts.push(text.slice(lastIndex));
  }

  const rawScratchpad = scratchpadParts.join('');
  const scratchpad = stripInternalTags(rawScratchpad);

  if (scratchpad) {
    log(`[scratchpad] ${scratchpad.slice(0, 500)}${scratchpad.length > 500 ? '…' : ''}`);
  }

  const hasUnwrapped = sent === 0 && !!scratchpad;
  return { sent, hasUnwrapped };
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
    content: JSON.stringify({ text: body }),
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
