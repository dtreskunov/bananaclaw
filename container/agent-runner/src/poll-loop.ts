import { randomUUID } from 'node:crypto';
import { findByName, type DestinationEntry } from './destinations.js';
import {
  getPendingMessages,
  releaseProcessing,
  markCompleted,
  nextPendingDueDelayMs,
  type MessageInRow,
} from './db/messages-in.js';
import { writeMessageOut } from './db/messages-out.js';
import { markBatchPersisted } from './db/runner-state.js';
import { completeTaskAttempts, markTaskAttemptsProviderInvoked } from './db/task-attempts.js';
import { getInboundDb, getOutboundDb, clearStaleProcessingAcks } from './db/connection.js';
import {
  clearContinuation,
  clearFailedTurn,
  clearTurnEnded,
  appendActivity,
  getContinuation,
  getFailedTurn,
  isForkOriginAbsorbed,
  markForkOriginAbsorbed,
  setContinuation,
  setFailedTurn,
  setTurnEnded,
} from './db/session-state.js';
import { getForkOrigin, type ForkOriginRow } from './db/fork-origin.js';
import {
  clearCurrentInReplyTo,
  resetTurnSendTracking,
  setCurrentInReplyTo,
  setTurnContext,
  waitForTurnTools,
} from './current-batch.js';
import {
  beginTurn, associateInput, finishUsageAttempt, interruptAbandonedTurns,
  markTurnStopping, settleTurn, type TurnExecution,
} from './turn-execution.js';
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
import type { AgentProvider, AgentQuery, ProviderEvent, ProviderExchange } from './providers/types.js';
import { processPendingInputEdits, startInputProcessing, writeInputState } from './steering.js';
import { getHostEventGeneration, onTurnStop, signalTurnState, signalHeartbeat, waitForHostEvent } from './session-link.js';
import { TurnAccounting, resetLiveTurnState } from './query/accounting.js';
import { FollowUpWatcher } from './query/follow-up-watcher.js';
import { finalizeStoppedTurn, writeTurnNotice } from './query/notices.js';
import { DeliveryRecovery, type SuggestedAction } from './query/recovery.js';
import { RunawayGuard } from './query/runaway-guard.js';
import { SteeringSession } from './query/steering.js';

export function shouldDeferInteractiveResponse(messages: MessageInRow[], turnActive: boolean): boolean {
  return turnActive && messages.some((message) => message.kind === 'interactive_response');
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
  /** Called per query: parts of it go stale mid-container (e.g. "this thread has no title yet"). */
  systemContext?: () => { instructions?: string };
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
  interruptAbandonedTurns();
  // Resume the agent's prior session from a previous container run if one
  // was persisted. The continuation is opaque to the poll-loop — the
  // provider decides how to use it (Claude resumes a .jsonl transcript,
  // other providers may reload a thread ID, etc.). Keyed per-provider so
  // a Codex thread id never gets handed to Claude or vice versa.
  let continuation: string | undefined = getContinuation(config.providerName);

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

  // If this session is a fork, adopt the parent's context before the first
  // turn. Runs before any polling so the branch is never asked to answer a
  // message while still believing it has no history.
  const forkAdoption = await adoptForkOrigin(config, continuation);
  if (forkAdoption.continuation) continuation = forkAdoption.continuation;
  let pendingForkDigest = forkAdoption.digest;

  // Clear leftover 'processing' acks from a previous crashed container.
  // This lets the new container re-process those messages.
  clearStaleProcessingAcks();

  // Warm the heartbeat as soon as the runner is up. Provider boot
  // (e.g. opencode SDK cold start, OpenRouter handshake) can take
  // longer than the host typing module's grace window before
  // processQuery's liveHandle starts touching it — leaving the
  // typing indicator to flicker off mid-cold-start.
  try {
    signalHeartbeat();
  } catch {
    /* best-effort */
  }

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
    try {
      activeQuery?.abort();
    } catch {
      /* best-effort */
    }
  });

  while (true) {
    if (config.signal?.aborted) return;
    const hostGeneration = getHostEventGeneration();
    processPendingInputEdits(config.provider, getContinuation(config.providerName));
    // Skip system messages — they're responses for MCP tools (e.g., ask_user_question)
    let messages = getPendingMessages(isFirstPoll).filter((m) => m.kind !== 'system');
    isFirstPoll = false;
    pollCount++;

    const recoveryContinuation = getContinuation(config.providerName);
    if (recoveryContinuation && config.provider.appliedSteering && messages.length > 0) {
      const recovered = new Set(config.provider.appliedSteering(recoveryContinuation, messages.map((m) => m.id)));
      if (recovered.size > 0) {
        for (const messageId of recovered) writeInputState({ messageId, status: 'applied' });
        markCompleted([...recovered]);
        markBatchPersisted(getOutboundDb());
        messages = messages.filter((message) => !recovered.has(message.id));
        if (messages.length === 0) continue;
      }
    }

    // Periodic heartbeat so we know the loop is alive
    if (pollCount % 30 === 0) {
      log(`Poll heartbeat (${pollCount} iterations, ${messages.length} pending)`);
    }

    if (messages.length === 0) {
      await waitForHostEvent(hostGeneration, nextPendingDueDelayMs(), config.signal);
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
      await waitForHostEvent(hostGeneration, nextPendingDueDelayMs(), config.signal);
      continue;
    }

    // Touch the heartbeat the moment we pick up a batch — before any
    // potentially-slow provider boot inside processQuery — so the host
    // typing indicator stays lit through cold-start.
    try {
      signalHeartbeat();
    } catch {
      /* best-effort */
    }

    const ids = messages.map((m) => m.id);
    startInputProcessing(messages);

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
      markBatchPersisted(getOutboundDb());
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
      markBatchPersisted(getOutboundDb());
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

    // Inherited history from a fork, injected exactly once — on the first
    // real turn rather than at startup, because a cold container may boot,
    // find nothing to do and idle out before anyone speaks. Deferring to
    // the first prompt means the digest lands in the same turn that needs
    // it, whatever the container lifecycle did in between.
    if (pendingForkDigest) {
      prompt = pendingForkDigest + '\n\n' + prompt;
      pendingForkDigest = undefined;
      markForkOriginAbsorbed('digest');
      log('Injected forked-thread history digest into the first turn');
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
    const taskAttemptIds = keep.filter((message) => message.kind === 'task').map((message) => message.id);
    const taskAttemptIdSet = new Set(taskAttemptIds);
    const finalizedTaskAttemptIds = new Set<string>();
    markTaskAttemptsProviderInvoked(taskAttemptIds);
    let taskProviderFailed = false;
    const execution = { current: beginTurn(routing, processingIds) };
    try {
      while (true) {
        let query: AgentQuery;
        try {
          query = config.provider.query({
            prompt: promptTracker.latest,
            continuation: isTaskOnly ? undefined : continuation,
            cwd: config.cwd,
            files: extractFileAttachments(execution.current.inputIds.flatMap((id) => {
              const row = getInboundDb().prepare('SELECT * FROM messages_in WHERE id = ?').get(id) as MessageInRow | undefined;
              return row ? [row] : [];
            })),
            systemContext: config.systemContext?.(),
          });
          activeQuery = query;
          const result = await processQuery(
            query,
            execution.current.routing,
            execution.current.inputIds,
            config.providerName,
            config.provider.onExchangeComplete?.bind(config.provider),
            promptTracker.latest,
            isTaskOnly ? undefined : continuation,
            {
              provider: config.provider,
              persistContinuation: !isTaskOnly,
              promptTracker,
              onBatchComplete: (completedIds, providerFailed) => {
                const completedTaskIds = completedIds.filter((id) => taskAttemptIdSet.has(id));
                completeTaskAttempts(completedTaskIds, providerFailed);
                for (const id of completedTaskIds) finalizedTaskAttemptIds.add(id);
                markBatchPersisted(getOutboundDb());
              },
              execution,
              deferFailureSettlement: true,
            },
          );
          if (!isTaskOnly && result.continuation && result.continuation !== continuation) {
            continuation = result.continuation;
            setContinuation(config.providerName, continuation);
          }
          if (result.unsurfacedError) {
            taskProviderFailed = true;
            const errorRouting = result.unsurfacedError.routing;
            const tag = result.unsurfacedError.classification ? ` [${result.unsurfacedError.classification}]` : '';
            writeMessageOut({
              id: generateId(),
              kind: 'chat',
              platform_id: errorRouting.platformId,
              channel_type: errorRouting.channelType,
              thread_id: errorRouting.threadId,
              content: JSON.stringify({
                delivery_origin: 'response',
                text: `⚠️ Agent provider error${tag}: ${result.unsurfacedError.message}\n\nYour message was not processed.`,
              }),
            });
            log(`Surfaced provider error to user: ${result.unsurfacedError.message}`);
            await settleTurn(execution.current, 'failed');
          }
          break;
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          log(`Query error: ${errMsg}`);

          // A warm transport can fail while idle. Its previous terminal result
          // is not a failed new turn and must never replay consumed input.
          if (execution.current.settled) {
            if (config.provider.isSessionInvalid(err)) {
              continuation = undefined;
              clearContinuation(config.providerName);
            }
            break;
          }
          if (attempt === 0 && continuation && config.provider.isSessionInvalid(err)) {
            log(`Stale session detected (${continuation}) — clearing and retrying with fresh session`);
            continuation = undefined;
            clearContinuation(config.providerName);
            finishUsageAttempt(execution.current);
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
            taskProviderFailed = true;
            setFailedTurn({ prompt: promptTracker.latest, error: errMsg, recorded_at: Date.now() });
          } catch (e) {
            log(`Failed to persist failed-turn record: ${e instanceof Error ? e.message : String(e)}`);
          }
          const failureRouting = promptTracker.routing;
          execution.current.failure = true;
          finishUsageAttempt(execution.current);
          const ack = await tryAcknowledgeFailure(config, failureRouting, errMsg, undefined, execution);
          if (!ack.delivered) {
            writeMessageOut({
              id: generateId(),
              kind: 'chat',
              platform_id: failureRouting.platformId,
              channel_type: failureRouting.channelType,
              thread_id: failureRouting.threadId,
              content: JSON.stringify({ text: friendlyProviderErrorFallback(errMsg), delivery_origin: 'response' }),
            });
          }
          await settleTurn(execution.current, 'failed');
          break;
        }
      }
    } finally {
      if (!execution.current.settled) await settleTurn(execution.current, 'interrupted');
      setTurnContext(null);
      clearCurrentInReplyTo();
      activeQuery = null;
    }

    // Ensure completed even if processQuery ended without a result event
    // (e.g. stream closed unexpectedly).
    completeTaskAttempts(
      taskAttemptIds.filter((id) => !finalizedTaskAttemptIds.has(id)),
      taskProviderFailed,
    );
    markCompleted(processingIds);
    markBatchPersisted(getOutboundDb());
    log(`Completed ${ids.length} message(s)`);
  }
}

/**
 * Adopt a forked session's inherited context, once per session.
 *
 * Two tiers, in preference order:
 *
 *  - **native** — ask the provider to fork its own server-side session at
 *    the branch point. The agent wakes with the parent's real context
 *    window: full tool history, cache state, the lot. Only possible when
 *    the branch was cut from a session run by *this* provider, that
 *    session had a continuation, and we captured a provider-private
 *    handle for the anchor turn.
 *  - **digest** — hand the agent a plain-text rendering of the inherited
 *    exchange as leading context on its first turn. Lossy but universal;
 *    the only option for providers with no server-side session to fork
 *    (Claude among them, today).
 *
 * A native fork that throws or declines degrades to the digest rather than
 * failing the session: a branch that opens with imperfect memory is a far
 * better outcome than one that refuses to start.
 */
async function adoptForkOrigin(
  config: PollLoopConfig,
  continuation: string | undefined,
): Promise<{ continuation?: string; digest?: string }> {
  // A continuation already on file means this container has run turns of
  // its own; the branch point is ancient history.
  if (continuation) return {};
  if (isForkOriginAbsorbed()) return {};

  const origin = getForkOrigin();
  if (!origin) return {};

  const sameProvider = origin.provider != null && origin.provider.toLowerCase() === config.providerName.toLowerCase();

  if (sameProvider && origin.parent_continuation && origin.anchor_ref && config.provider.forkContinuation) {
    try {
      const forked = await config.provider.forkContinuation({
        continuation: origin.parent_continuation,
        anchorRef: origin.anchor_ref,
        cwd: config.cwd,
      });
      if (forked) {
        setContinuation(config.providerName, forked);
        markForkOriginAbsorbed('native');
        log(`Adopted forked session natively from ${origin.parent_session_id} (${forked})`);
        return { continuation: forked };
      }
      log('Provider declined the native fork; falling back to a history digest');
    } catch (err) {
      log(`Native fork failed (${err instanceof Error ? err.message : String(err)}); falling back to a history digest`);
    }
  } else if (origin.provider && !sameProvider) {
    log(`Fork origin was written by ${origin.provider}, running as ${config.providerName}; using a history digest`);
  }

  if (!origin.digest) return {};
  return { digest: renderForkDigest(origin) };
}

/**
 * Wrap the inherited transcript in an XML block, the same shape the
 * formatter uses for real messages.
 *
 * The framing matters as much as the content: the agent is about to read
 * an exchange it has no memory of, and the user on the other end believes
 * that conversation happened. Saying so explicitly is what stops the agent
 * from either disowning the history ("I don't recall saying that") or
 * re-answering the last question it can see.
 */
function renderForkDigest(origin: ForkOriginRow): string {
  return [
    '<forked_thread_history>',
    'This conversation is a branch of an earlier one. The exchange below already',
    'happened and is visible to the user in this thread, but it is not in your',
    'context window — you are reading it now for the first time. Treat it as your',
    'own prior conversation: do not re-answer the final message, do not greet the',
    'user as if they are new, and do not mention this notice.',
    '',
    'Files in your workspace and your group memory are shared with the original',
    'thread and reflect any work done there. Scheduled tasks did not come across.',
    '',
    origin.digest,
    '</forked_thread_history>',
  ].join('\n');
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
  execution: { current: TurnExecution },
): Promise<AcknowledgeResult> {
  const outputCount = () => (getOutboundDb().prepare("SELECT COUNT(*) AS n FROM messages_out WHERE turn_id = ? AND kind NOT IN ('system','internal')")
    .get(execution.current.turnId) as { n: number }).n;
  const priorOutputCount = outputCount();
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
      systemContext: config.systemContext?.(),
    });
    const result = await processQuery(query, routing, [], config.providerName, undefined, '', undefined, {
      provider: config.provider,
      persistContinuation: false,
      execution,
      deferFailureSettlement: true,
    });
    return { delivered: result.delivered || outputCount() > priorOutputCount };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    log(`Acknowledgment turn threw: ${errMsg}`);
    return { delivered: outputCount() > priorOutputCount };
  }
}

interface QueryResult {
  delivered: boolean;
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

/**
 * Fork-only options, kept out of the upstream-shaped positional signature so
 * `processQuery` stays mergeable. Fork logic lives in `src/query/` and is
 * reached from marked `FORK-HOOK:<name>` sites.
 */
export interface ForkQueryOptions {
  provider: AgentProvider;
  /**
   * False for one-shot calls (the in-turn ack): they run in a throwaway
   * session, must not clobber the rolled-back continuation, and end after
   * their first result.
   */
  persistContinuation?: boolean;
  promptTracker?: { latest: string; routing: RoutingContext };
  onBatchComplete?: (completedIds: string[], providerFailed: boolean) => void;
  execution?: { current: TurnExecution };
  deferFailureSettlement?: boolean;
}

/** Provider events still processed after the user stopped the turn. */
const STOPPED_TURN_EVENTS = new Set(['init', 'progress', 'usage', 'usage_call', 'checkpoint', 'steering_applied']);

export async function processQuery(
  query: AgentQuery,
  routing: RoutingContext,
  initialBatchIds: string[],
  providerName: string,
  onExchangeComplete: ((exchange: ProviderExchange) => void) | undefined,
  initialPrompt: string,
  initialContinuation: string | undefined,
  fork: ForkQueryOptions,
): Promise<QueryResult> {
  const { provider, persistContinuation = true, promptTracker, onBatchComplete, deferFailureSettlement = false } = fork;
  const execution = fork.execution ?? { current: beginTurn(routing, initialBatchIds) };
  let queryContinuation: string | undefined;
  let done = false;
  let resultSeen = false;
  let userStopped = false;
  let turnId = execution.current.turnId;
  setTurnContext(execution.current);
  let activeTurnRouting = routing;
  // Assigned from the event handler closure; the assertion keeps TypeScript
  // from narrowing it to its initial null.
  let lastProviderError = null as { message: string; classification?: string } | null;
  // A fresh batch is being processed — wipe any turn-ended marker from the
  // previous turn so the host typing module re-arms cleanly, and start a
  // fresh activity trace so the web UI shows the work for this wake.
  try {
    clearTurnEnded();
  } catch {
    /* best-effort */
  }
  resetLiveTurnState();

  // Per-push batch queue. Each push (initial + every follow-up) enqueues
  // its ids + routing. On `result` we drain the queue — only then are the
  // rows markCompleted'd. Earlier code marked follow-ups completed at push
  // time, which lost them silently when the provider collapsed multiple
  // queued prompts into one turn (OpenCode in particular) — the rows
  // looked "done" to the host but no reply was ever dispatched.
  type QueuedBatch = { ids: string[]; routing: RoutingContext };
  const turnBatchQueue: QueuedBatch[] = [{ ids: [...initialBatchIds], routing }];
  const consumedIds = new Set(initialBatchIds);

  // Snapshot the outbound seq so the result handler can detect whether MCP
  // tools wrote anything this turn. Without this, an agent that calls
  // send_file / send_message and then returns a chatty final-text gets
  // a duplicate delivery via the <message>-wrap nudge path.
  const currentOutboundMax = (): number =>
    (getOutboundDb().prepare('SELECT COALESCE(MAX(seq), 0) AS m FROM messages_out').get() as { m: number }).m;
  let outboundMaxAtTurnStart = currentOutboundMax();

  // Prompt queue for the exchange hook — each result event consumes the
  // oldest unanswered prompt, except a wrapping-retry result, which answers
  // the same prompt again. Unused (and unmaintained) when the provider
  // doesn't implement `onExchangeComplete`.
  const archivePrompts: string[] = [initialPrompt];

  // `turnActive` is true between turn start (initial entry into the
  // for-await + every follow-up push) and the terminating `result` /
  // `error` event. While true, the liveness timer below keeps the heartbeat
  // warm; when false it goes stale so the host marks us idle.
  let turnActive = true;
  const endStream = (): void => {
    if (endedForCommand) return;
    endedForCommand = true;
    query.end();
  };

  // FORK-HOOK:state
  const accounting = new TurnAccounting(execution);
  const runaway = new RunawayGuard();
  const steering = new SteeringSession(provider, query, persistContinuation);
  const recovery = new DeliveryRecovery(
    {
      query,
      endStream,
      queueEmpty: () => turnBatchQueue.length === 0,
      beginCorrectiveTurn: (activityText) => {
        appendActivity({ kind: 'notification', id: `nudge:${generateId()}`, text: activityText });
        turnActive = true;
        try {
          clearTurnEnded();
        } catch {
          /* best-effort */
        }
      },
      dispatch: (text, replyRouting, deliverUnwrapped, since, replyOnly) =>
        dispatchResultText(text, replyRouting, deliverUnwrapped, since, undefined, replyOnly),
      exchangeComplete: (result, status) =>
        notifyExchangeComplete(onExchangeComplete, {
          prompt: archivePrompts[0] ?? initialPrompt,
          result,
          continuation: queryContinuation ?? initialContinuation,
          status,
        }),
    },
    routing,
  );
  const publishTurn = (): void => steering.publishTurn(turnId, userStopped, activeTurnRouting);

  // Concurrent polling: push follow-ups into the active query as they arrive.
  // We do NOT force-end the stream on silence — keeping the query open avoids
  // re-spawning the SDK subprocess (~few seconds) and re-loading the .jsonl
  // transcript on every turn. The Anthropic prompt cache is server-side with
  // a 5-min TTL keyed on prefix hash, so stream lifecycle does NOT affect
  // cache lifetime — close+reopen within 5 min still gets cache hits.
  // Stream liveness is decided host-side via session-link signals + processing
  // claim age (see src/host-sweep.ts); if something is truly stuck, the host
  // will kill the container and messages get reset to pending.
  let endedForCommand = false;
  let resultFinishing = false;
  const pollForFollowUps = async (): Promise<void> => {
    processPendingInputEdits(provider, getContinuation(providerName), { query, steeringInputs: steering.inputs });
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
    // cutting it off.
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
    if (turnActive) {
      // FORK-HOOK:steering
      steering.offer(activeTurnRouting, turnId);
      return;
    }
    if (newMessages.length === 0) return;

    // A user can answer as soon as the card is delivered, before the
    // provider has emitted the result that safely closes the asking turn.
    // Persist the answer immediately, but do not push it into that active
    // turn. The next poll after the result resumes it as a distinct turn.
    if (shouldDeferInteractiveResponse(newMessages, turnActive)) return;

    // All providers wait for the prior result boundary; push acceptance
    // alone must never promote input while the preceding turn is active.
    startInputProcessing(newMessages);

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
    if (done || userStopped) {
      releaseProcessing(keep.map((message) => message.id));
      return;
    }

    const keptIds = keep.map((m) => m.id);
    const prompt = formatMessages(keep);
    const followUpFiles = extractFileAttachments(keep);
    log(`Pushing ${keep.length} follow-up message(s) into active query`);
    // FORK-HOOK:turn-start — per-turn flags key off THIS turn's delivery,
    // not the whole warm query's history.
    recovery.resetDeliveryFlags();
    resultSeen = false;
    lastProviderError = null;
    if (promptTracker) promptTracker.latest = prompt;
    activeTurnRouting = extractRouting(keep);
    if (promptTracker) promptTracker.routing = activeTurnRouting;
    // If the previous result already completed, this push starts a new
    // turn immediately. Clear its trace before the provider emits the
    // first event. When a follow-up was queued during an active turn, the
    // result handler below performs this reset at the precise boundary.
    // Retry budgets reset only at a real idle-to-active boundary.
    if (!turnActive) {
      resetLiveTurnState();
      recovery.resetToolRecovery();
    }
    turnActive = true;
    execution.current = beginTurn(activeTurnRouting, keptIds, false);
    runaway.reset();
    turnId = execution.current.turnId;
    publishTurn();
    try {
      clearTurnEnded();
    } catch {
      /* best-effort */
    }
    setCurrentInReplyTo(activeTurnRouting.inReplyTo);
    if (!query.push(prompt, followUpFiles.length > 0 ? followUpFiles : undefined)) {
      await settleTurn(execution.current, 'interrupted');
      releaseProcessing(keptIds);
      turnActive = false;
      signalTurnState(null);
      endedForCommand = true;
      query.end();
      return;
    }
    consumedIds.clear();
    for (const id of keptIds) {
      consumedIds.add(id);
      associateInput(execution.current, id, 'consumed');
    }
    archivePrompts.push(prompt);
    // Enqueue this push as its own batch. We do NOT markCompleted here —
    // that happens when the corresponding `result` event drains the
    // queue. Marking at push time loses messages whose prompts the
    // provider collapsed into a single turn (no separate result fires).
    turnBatchQueue.push({ ids: keptIds, routing: activeTurnRouting });
  };
  // FORK-HOOK:follow-ups — woken by host events over the session link and
  // by due scheduled rows, instead of upstream's fixed-interval poll.
  const watcher = new FollowUpWatcher({
    poll: pollForFollowUps,
    closed: () => done || userStopped || endedForCommand,
    finishingResult: () => resultFinishing,
    onFatal: () => {
      done = true;
    },
  });
  watcher.start();

  const unsubscribeStop = onTurnStop((requestedId) => {
    if (requestedId !== turnId || !turnActive || userStopped || done) return;
    userStopped = true;
    markTurnStopping(execution.current);
    watcher.stop();
    // A crash while the provider is settling must not replay cancelled input.
    // Ordinary queued messages have not been claimed and are not in this list.
    markCompleted([...consumedIds]);
    publishTurn();
    query.abort('user');
  });
  publishTurn();

  // Keep the heartbeat warm for as long as a turn is actually in flight.
  // The SDK can stall for 10–30s between events while Anthropic generates
  // the first token of a response; without this timer the host-side typing
  // module would mark the agent stale, drop the indicator, and never
  // re-arm it until the next inbound.
  const liveHandle = setInterval(() => {
    if (!turnActive) return;
    try {
      signalHeartbeat();
    } catch {
      /* best-effort */
    }
  }, 2000);
  liveHandle.unref?.();

  resetTurnSendTracking();

  const abortRunaway = (reason: string | null): void => {
    if (!reason || endedForCommand) return;
    log(`Runaway turn: ${reason} — aborting stream`);
    runaway.abortReason = reason;
    endedForCommand = true;
    query.abort();
  };
  // Provider events only the fork acts on; upstream ignores them.
  const handleForkEvent = (event: ProviderEvent): void => {
    switch (event.type) {
      case 'steering_applied': {
        const guidance = steering.apply(event.id, execution.current, userStopped);
        turnBatchQueue[0]?.ids.push(event.id);
        consumedIds.add(event.id);
        archivePrompts[0] = `${archivePrompts[0] ?? initialPrompt}\n\n${guidance}`;
        if (promptTracker) promptTracker.latest += `\n\n${guidance}`;
        queueMicrotask(() => watcher.wake());
        break;
      }
      case 'progress':
        if (event.step.kind !== 'tool') break;
        abortRunaway(runaway.onToolProgress(event.step, event.toolInputFingerprint));
        recovery.onToolProgress(event.step);
        break;
      case 'assistant_message':
        abortRunaway(runaway.onAssistantMessage());
        break;
      case 'error':
        if (event.retryable) break;
        // Capture non-retryable provider errors. Don't write to outbound
        // here — the SDK may still throw immediately after (e.g. the
        // stale-session case yields an is_error result then throws
        // "No conversation found"). If it does, the outer catch handles
        // the retry and the user never sees this transient error.
        lastProviderError = { message: event.message, classification: event.classification };
        if (promptTracker) promptTracker.routing = recovery.pendingRetryRouting ?? activeTurnRouting;
        // Force the stream closed so the turn ends now. Without this, the
        // SDK can keep the stream alive after a non-retryable error (e.g.
        // a 429 rate-limit) and the next user message gets pushed in,
        // transparently "recovering" — but the user never finds out their
        // original request failed. End early so the unsurfacedError path
        // notifies them; the next message starts a fresh query.
        endStream();
        break;
      case 'usage':
        accounting.onUsage(event.data);
        break;
      case 'usage_call':
        accounting.onUsageCall(event.data);
        break;
      case 'checkpoint':
        accounting.checkpoint = event.ref;
        break;
    }
  };
  // Settle the turn once its last queued batch is answered and wake the
  // watcher so input that waited for this boundary starts the next turn.
  const settleAtBoundary = async (): Promise<void> => {
    if (!turnActive && (recovery.sentAny || recovery.silenceConfirmed)) {
      if (!execution.current.failure) {
        await settleTurn(execution.current, lastProviderError ? 'failed' : recovery.sentAny ? 'replied' : 'silent');
      }
      if (recovery.silenceConfirmed) {
        endedForCommand = true;
        query.end();
      }
      onBatchComplete?.([...consumedIds], lastProviderError !== null);
    }
    // Reset the per-turn baseline so a follow-up push within the same
    // query starts a fresh "did MCP write anything?" window.
    outboundMaxAtTurnStart = currentOutboundMax();
    resultFinishing = false;
    if (!turnActive && execution.current.settled) {
      markCompleted([...consumedIds]);
      signalTurnState(null);
      queueMicrotask(() => watcher.wake());
    }
  };

  try {
    for await (const event of query.events) {
      signalHeartbeat();
      if (userStopped && !STOPPED_TURN_EVENTS.has(event.type)) continue;
      handleEvent(event, routing);
      // FORK-HOOK:event
      handleForkEvent(event);

      if (event.type === 'init') {
        queryContinuation = event.continuation;
        // Persist immediately so a mid-turn container crash still lets the
        // next wake resume the conversation. Without this, the session id
        // was only written after the full stream completed — if the
        // container died between `init` and `result`, the SDK session was
        // effectively orphaned and the next message started a blank
        // Claude session with no prior context.
        if (persistContinuation) {
          setContinuation(providerName, event.continuation);
        }
      } else if (event.type === 'result') {
        resultFinishing = true;
        await waitForTurnTools(execution.current);
        if (userStopped) continue;
        steering.releaseUnapplied();
        resultSeen = true;
        // FORK-HOOK:recovery — a corrective retry's result answers the
        // retried turn: it keeps that turn's route and drains no batch.
        const retry = recovery.beginResult();
        // Drain the OLDEST batch from the queue — one result corresponds
        // to one batch of work. When providers run separate turns per
        // pushed prompt, each result event drains its own batch, the reply
        // is stamped with that batch's routing, and the typing indicator
        // stays on across the gap because the queue still has the next
        // batch. When a provider collapses multiple queued pushes into a
        // single response, the leftover batch stays in the queue and gets
        // drained by the stream-end finally block below.
        let resultRouting = retry.routing ?? activeTurnRouting;
        const drainedIds: string[] = [];
        if (!retry.isRetry && turnBatchQueue.length > 0) {
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
          try {
            setTurnEnded();
          } catch {
            /* best-effort */
          }
        }
        // Update MCP send_message routing for any subsequent turn the
        // provider may run within this query (e.g. on the nudge push
        // below, or a still-queued follow-up that arrived in the gap).
        setCurrentInReplyTo(resultRouting.inReplyTo);
        if (drainedIds.length > 0) markCompleted(drainedIds);
        const answered = recovery.onResult({
          text: event.text,
          strippedToEmpty: event.strippedToEmpty,
          malformedToolCall: event.malformedToolCall,
          routing: resultRouting,
          since: outboundMaxAtTurnStart,
          turnId,
          providerFailed: lastProviderError !== null,
        });
        // Each result consumes one input; recovery retries answer the same
        // user prompt again, so it stays queued for them.
        if (answered) {
          archivePrompts.shift();
        }
        // One-shot calls (in-turn ack): end the stream immediately after
        // the first result, so the follow-up poller never pushes the next
        // user message into this throwaway session.
        if (!persistContinuation) {
          endedForCommand = true;
          query.end();
        }
        // FORK-HOOK:boundary
        await accounting.flushAtResult({
          provider,
          providerName,
          continuation: queryContinuation ?? initialContinuation,
          since: outboundMaxAtTurnStart,
          turnId,
        });
        // A queued user batch begins as soon as this result is consumed.
        // Its provider events must replace, not extend, the completed
        // turn's live snapshot. Persist first, then clear at the boundary.
        if (turnBatchQueue.length > 0) resetLiveTurnState();
        await settleAtBoundary();
      }
    }
  } catch (err) {
    if (!userStopped) {
      const errMsg = err instanceof Error ? err.message : String(err);
      notifyExchangeComplete(onExchangeComplete, {
        prompt: archivePrompts[0] ?? initialPrompt,
        result: `Error: ${errMsg}`,
        continuation: queryContinuation ?? initialContinuation,
        status: 'error',
      });
      throw err;
    }
  } finally {
    done = true;
    steering.releaseUnapplied();
    unsubscribeStop();
    watcher.stop();
    clearInterval(liveHandle);
    completeOrphanedBatches(consumedIds, turnBatchQueue);
    // Atomic continuation rollback. The `init` handler persisted the new
    // SDK session id immediately (for mid-turn crash recovery), but if the
    // turn never reached a `result` event — the stream errored out or the
    // SDK threw — that new id points at a half-baked transcript with no
    // completed assistant turn. Resuming from it on the next message tends
    // to drop prior context, which cascades: every subsequent turn forks
    // into a fresh session and the agent eventually has nothing to anchor
    // on. Restore the prior good id so the next turn resumes from a
    // session that actually completed at least one turn cleanly.
    if (
      !userStopped &&
      !resultSeen &&
      initialContinuation &&
      queryContinuation &&
      queryContinuation !== initialContinuation
    ) {
      log(
        `Turn ended without result; restoring prior continuation ${initialContinuation} (discarding ${queryContinuation})`,
      );
      try {
        setContinuation(providerName, initialContinuation);
      } catch {
        /* best-effort */
      }
      queryContinuation = initialContinuation;
    }
    if (userStopped) {
      // FORK-HOOK:stop
      await finalizeStoppedTurn({
        execution: execution.current,
        routing: activeTurnRouting,
        providerName,
        continuation: queryContinuation ?? initialContinuation,
        checkpoint: accounting.checkpoint,
      });
    }
    if (execution.current.settled) signalTurnState(null);
  }

  if (userStopped) return { continuation: queryContinuation ?? initialContinuation, delivered: true };

  // FORK-HOOK:finish — a turn that delivered nothing gets one notice saying why.
  const notice = recovery.terminalNotice(routing, lastProviderError !== null, runaway.abortReason);
  if (notice) await writeTurnNotice(execution.current, notice);

  if (!execution.current.settled && !lastProviderError && !execution.current.failure) {
    await settleTurn(execution.current, recovery.silenceConfirmed || resultSeen ? 'silent' : 'interrupted');
  } else if (!execution.current.settled && !deferFailureSettlement) {
    await settleTurn(execution.current, 'failed');
  }
  if (execution.current.settled) signalTurnState(null);
  return {
    delivered: recovery.sentAny,
    continuation: queryContinuation,
    // Only surface a provider error if the stream completed cleanly AND
    // the turn produced nothing deliverable. If the SDK threw, that path
    // takes over (with stale-session retry); if a message did get sent,
    // a trailing error is best left in the logs.
    unsurfacedError:
      !recovery.sentAny && lastProviderError
        ? { ...lastProviderError, routing: promptTracker?.routing ?? activeTurnRouting }
        : undefined,
  };
}

/**
 * Drain any queued follow-up batches that never reached a `result` event.
 * Without this, when the SDK throws mid-turn, messages pushed into the
 * active query during the failure window stay markProcessing'd in
 * inbound.db forever — they never re-fire and never get acknowledged.
 * markCompleted is INSERT OR REPLACE, so re-marking the initial batch is
 * harmless.
 */
function completeOrphanedBatches(consumedIds: Set<string>, queue: { ids: string[] }[]): void {
  const orphanedIds: string[] = [...consumedIds];
  while (queue.length > 0) {
    orphanedIds.push(...queue.shift()!.ids);
  }
  if (orphanedIds.length === 0) return;
  try {
    markCompleted(orphanedIds);
  } catch {
    /* best-effort */
  }
  // Stream closed with leftover queued batches — the result branch skipped
  // setTurnEnded because the queue was non-empty, so do it here so the
  // host's typing module clears the indicator promptly instead of waiting
  // for the heartbeat to age out.
  try {
    setTurnEnded();
  } catch {
    /* best-effort */
  }
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
      try {
        setTurnEnded();
      } catch {
        /* best-effort */
      }
      break;
    case 'progress': {
      const s = event.step;
      const label = s.kind === 'tool' ? s.tool : 'text' in s ? s.text : '';
      log(`Progress: ${s.kind}${label ? ` ${label}` : ''}`);
      appendActivity(s);
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
  deliverUnwrappedToCurrentRoute = false,
  duplicateSince?: number,
  suggestedAction?: SuggestedAction,
  replyOnly = false,
): { sent: number; hasUnwrapped: boolean; internalCount: number } {
  const parsed = parseAssistantOutput(text);
  if (parsed.diagnostics.length > 0) {
    log(`Output recovery: ${[...new Set(parsed.diagnostics)].join(', ')}`);
  }

  // Internal blocks are operator-visible trace entries, never channel
  // deliveries. Emit one identified step per block so repeated blocks remain
  // distinct and the host can reduce the trace normally.
  for (let i = 0; i < parsed.internal.length; i++) {
    appendActivity({
      kind: 'internal',
      id: `internal:${generateId()}:${i}`,
      text: parsed.internal[i],
    });
  }

  let sent = 0;
  const canDeliverUnwrapped = deliverUnwrappedToCurrentRoute && parsed.deliveries.length === 0 && !!parsed.unwrapped;
  const scratchpadParts: string[] = parsed.unwrapped && !canDeliverUnwrapped ? [parsed.unwrapped] : [];

  if (canDeliverUnwrapped) {
    writeMessageOut({
      id: generateId(),
      in_reply_to: routing.inReplyTo,
      kind: 'chat',
      platform_id: routing.platformId,
      channel_type: routing.channelType,
      thread_id: routing.threadId,
      content: JSON.stringify({
        text: parsed.unwrapped,
        delivery_origin: 'response',
        ...(suggestedAction ? { suggested_action: suggestedAction } : {}),
      }),
    });
    sent++;
  }

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
    if (replyOnly) {
      const resolved = resolveDeliveryRouting(dest, routing);
      if (
        resolved.channelType !== routing.channelType ||
        resolved.platformId !== routing.platformId ||
        resolved.threadId !== routing.threadId
      ) {
        log(`Reporting-only recovery cannot send to "${toName}" outside the originating conversation, dropping block`);
        continue;
      }
    }
    if (duplicateSince !== undefined && isDuplicateSendMessage(dest, body, routing, duplicateSince)) {
      log(`Duplicate final response to "${toName}" already sent via send_message, dropping block`);
      continue;
    }
    sendToDestination(dest, body, routing, suggestedAction);
    sent++;
  }

  const scratchpad = scratchpadParts.join('').trim();

  if (scratchpad) {
    log(`[scratchpad] ${scratchpad.slice(0, 500)}${scratchpad.length > 500 ? '…' : ''}`);
  }

  const hasUnwrapped = sent === 0 && !!scratchpad;
  return { sent, hasUnwrapped, internalCount: parsed.internal.length };
}

function normalizeDeliveryText(text: string): string {
  return text
    .replace(/\[([^\]]+)]\([^)]+\)/g, '$1')
    .replace(/[*`~]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function resolveDeliveryRouting(
  dest: DestinationEntry,
  routing: RoutingContext,
): { platformId: string; channelType: string; threadId: string | null; inReplyTo: string | null } {
  const platformId = dest.type === 'channel' ? dest.platformId! : dest.agentGroupId!;
  const channelType = dest.type === 'channel' ? dest.channelType! : 'agent';
  if (channelType === routing.channelType && platformId === routing.platformId) {
    return { platformId, channelType, threadId: routing.threadId, inReplyTo: routing.inReplyTo };
  }
  const destRouting = resolveDestinationThread(channelType, platformId);
  return {
    platformId,
    channelType,
    threadId: destRouting?.threadId ?? null,
    inReplyTo: destRouting?.inReplyTo ?? null,
  };
}

function isDuplicateSendMessage(dest: DestinationEntry, body: string, routing: RoutingContext, since: number): boolean {
  const resolved = resolveDeliveryRouting(dest, routing);
  const rows = getOutboundDb()
    .prepare(
      `SELECT platform_id, channel_type, thread_id, content
       FROM messages_out
       WHERE seq > ? AND kind = 'chat'`,
    )
    .all(since) as Array<{
    platform_id: string | null;
    channel_type: string | null;
    thread_id: string | null;
    content: string;
  }>;
  const normalizedBody = normalizeDeliveryText(body);
  return rows.some((row) => {
    if (
      row.platform_id !== resolved.platformId ||
      row.channel_type !== resolved.channelType ||
      row.thread_id !== resolved.threadId
    )
      return false;
    try {
      const content = JSON.parse(row.content) as { text?: unknown; delivery_origin?: unknown };
      return (
        content.delivery_origin === 'send_message' &&
        typeof content.text === 'string' &&
        normalizeDeliveryText(content.text) === normalizedBody
      );
    } catch {
      return false;
    }
  });
}

function sendToDestination(
  dest: DestinationEntry,
  body: string,
  routing: RoutingContext,
  suggestedAction?: SuggestedAction,
): void {
  // Same-channel reply: thread under the exact message the agent is
  // responding to. Cross-channel (agent-shared sessions, broadcasts):
  // look up that channel's most recent inbound for thread_id. The
  // trigger's in_reply_to doesn't apply across channels, so leave it
  // null in that case rather than pinning the reply to an unrelated
  // message in the other channel.
  const { platformId, channelType, threadId, inReplyTo } = resolveDeliveryRouting(dest, routing);
  writeMessageOut({
    id: generateId(),
    in_reply_to: inReplyTo,
    kind: 'chat',
    platform_id: platformId,
    channel_type: channelType,
    thread_id: threadId,
    content: JSON.stringify({
      text: body,
      delivery_origin: 'response',
      ...(suggestedAction ? { suggested_action: suggestedAction } : {}),
    }),
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
