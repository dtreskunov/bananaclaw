/**
 * Delivery recovery for one query: decides, at each provider `result`, whether
 * the turn delivered a reply, and if not which corrective retry (if any) to
 * push into the same warm query. Also picks the terminal notice for a turn
 * that ends having delivered nothing.
 *
 * Three retry shapes, each bounded:
 *  - delivery nudge: bare unwrapped text, or a reply swallowed by reasoning.
 *    One-shot; offers an <internal> escape hatch for intentional silence.
 *  - malformed-tool nudge: a tool call that never executed. Retries the work.
 *  - post-tool report: a native tool already ran but the final reply was
 *    lost. Tools are disabled so the retry can only report, never repeat.
 */
import { findByRouting, getAllDestinations } from '../destinations.js';
import { getOutboundDb } from '../db/connection.js';
import type { RoutingContext } from '../formatter.js';
import type { AgentQuery, ProviderExchange } from '../providers/types.js';
import type { ToolStep } from './runaway-guard.js';

const MAX_MALFORMED_TOOL_RECOVERY_ATTEMPTS = 2;
const MAX_POST_TOOL_DELIVERY_RECOVERY_ATTEMPTS = 2;

export type SuggestedAction = 'continue' | 'retry' | 'report';

function log(msg: string): void {
  console.error(`[poll-loop] ${msg}`);
}

/** What recovery needs from the query core. */
export interface RecoveryPort {
  query: AgentQuery;
  /** End the stream once; a no-op if it was already ended. */
  endStream(): void;
  /** Re-open the turn for a corrective retry and note it in the activity trace. */
  beginCorrectiveTurn(activityText: string): void;
  /** True when no pushed batch is still waiting for its result. */
  queueEmpty(): boolean;
  dispatch(
    text: string,
    routing: RoutingContext,
    deliverUnwrappedToCurrentRoute: boolean,
    duplicateSince: number,
    replyOnly: boolean,
  ): { sent: number; hasUnwrapped: boolean; internalCount: number };
  exchangeComplete(result: string | null, status: ProviderExchange['status']): void;
}

export interface ResultInput {
  text: string | null;
  strippedToEmpty?: boolean;
  malformedToolCall?: boolean;
  routing: RoutingContext;
  /** Outbound seq at turn start: rows after it were written this turn. */
  since: number;
  turnId: string;
  providerFailed: boolean;
}

export interface TerminalNotice {
  routing: RoutingContext;
  text: string;
  label: string;
  action: SuggestedAction;
}

type ExecutedCall = {
  tool: string;
  detail?: string;
  status: 'running' | 'completed' | 'error' | 'interrupted' | 'unknown';
};

/**
 * Count outbound rows written this turn that represent a real user-facing
 * reply (text, file, or any non-operation chat content) vs operation-only
 * rows (reactions, edits) and web-only internal-thought rows.
 *
 * A reaction or edit is NOT a substitute for answering the user; if the
 * agent only reacts and then leaves its final-result text unwrapped, the
 * nudge path must still fire so the answer isn't silently dropped.
 */
export function countTurnContentMessages(since: number, turnId: string, replyRoute?: RoutingContext): number {
  const rows = getOutboundDb()
    .prepare(
      'SELECT kind, content, channel_type, platform_id, thread_id FROM messages_out WHERE seq > ? AND turn_id = ?',
    )
    .all(since, turnId) as {
    kind: string;
    content: string;
    channel_type: string | null;
    platform_id: string | null;
    thread_id: string | null;
  }[];
  let n = 0;
  for (const r of rows) {
    if (
      replyRoute &&
      (r.channel_type !== replyRoute.channelType ||
        r.platform_id !== replyRoute.platformId ||
        r.thread_id !== replyRoute.threadId)
    )
      continue;
    // kind='internal' is the web thought-bubble surfaced by dispatchResultText
    // from <internal>...</internal> blocks — not a reply.
    if (r.kind === 'internal' || r.kind === 'system') continue;
    // chat-kind rows can carry either content (text/markdown/files) or a
    // bare operation (reaction/edit). Only the former counts as a reply.
    if (r.kind === 'chat' && isOperationOnly(r.content)) continue;
    n++;
  }
  return n;
}

function isOperationOnly(content: string): boolean {
  type ContentShape = { operation?: unknown; text?: unknown; markdown?: unknown; files?: unknown };
  let parsed: ContentShape | null = null;
  try {
    parsed = JSON.parse(content) as ContentShape;
  } catch {
    parsed = null;
  }
  return Boolean(parsed && parsed.operation && !parsed.text && !parsed.markdown && !parsed.files);
}

function summarizeCall({ tool, detail }: { tool: string; detail?: string }): string {
  const safeDetail = detail
    ? JSON.stringify(detail.slice(0, 240)).replace(/&/g, '\\u0026').replace(/</g, '\\u003c').replace(/>/g, '\\u003e')
    : '';
  return `- ${tool}${safeDetail ? `: ${safeDetail}` : ''}`;
}

export class DeliveryRecovery {
  /** Something user-visible was delivered this turn. */
  sentAny = false;
  /**
   * The post-nudge retry came back as an `<internal>` note: the model
   * confirmed, via the nudge's escape hatch, that it meant to stay silent.
   * Suppresses every terminal notice — a deliberate no-op is not an error.
   */
  silenceConfirmed = false;
  /**
   * A result had no deliverable response and was not nudged — genuinely
   * empty text or an initial all-<internal> scratchpad. Distinct from a
   * swallowed reply (nudged) and a post-nudge <internal> (confirmed silence).
   */
  emptyResultSeen = false;
  /**
   * The one-shot delivery nudge was pushed this turn. Covers both failure
   * shapes: bare top-level text the model forgot to wrap, and a reply buried
   * in reasoning that normalized to empty. If the retry still delivers
   * nothing we surface a generic error rather than nudging again.
   */
  private nudged = false;
  private deliveryErrorRouting: RoutingContext;
  private malformedAttempts = 0;
  private malformedExhausted = false;
  private malformedErrorRouting: RoutingContext;
  private mode: 'tool' | 'delivery' | null = null;
  private retryRouting: RoutingContext | null = null;
  private hadNativeTool = false;
  private postToolAttempts = 0;
  private recoveringOffRouteReply = false;
  private readonly executedToolCalls = new Map<string, ExecutedCall>();

  constructor(
    private readonly port: RecoveryPort,
    routing: RoutingContext,
  ) {
    this.deliveryErrorRouting = routing;
    this.malformedErrorRouting = routing;
  }

  /** Where a corrective retry in flight replies, if one is. */
  get pendingRetryRouting(): RoutingContext | null {
    return this.retryRouting;
  }

  /**
   * Reset the per-turn delivery flags when a new input is pushed. On a
   * long-lived provider (OpenCode) the query stays open across turns, so
   * these would otherwise stay set from an earlier turn that DID deliver —
   * silently breaking the empty-turn safety net for later turns.
   */
  resetDeliveryFlags(): void {
    this.nudged = false;
    this.sentAny = false;
    this.emptyResultSeen = false;
    this.silenceConfirmed = false;
  }

  /** Reset retry budgets. Only at a real idle-to-active turn boundary. */
  resetToolRecovery(): void {
    this.malformedAttempts = 0;
    this.malformedExhausted = false;
    this.retryRouting = null;
    this.hadNativeTool = false;
    this.postToolAttempts = 0;
    this.recoveringOffRouteReply = false;
    this.executedToolCalls.clear();
  }

  /** Record a native tool call that reached execution; `send_message` is not substantive work. */
  onToolProgress(step: ToolStep): void {
    if (step.tool.endsWith('send_message')) return;
    const priorCall = this.executedToolCalls.get(step.id);
    const reachedExecution =
      !step.rejectedBeforeExecution &&
      (step.status === 'running' ||
        step.status === 'completed' ||
        step.status === 'error' ||
        step.status === 'interrupted' ||
        step.status === 'unknown' ||
        priorCall !== undefined);
    if (!reachedExecution) return;
    this.hadNativeTool = true;
    this.executedToolCalls.set(step.id, {
      tool: step.tool,
      ...(step.detail || priorCall?.detail ? { detail: step.detail ?? priorCall?.detail } : {}),
      status: step.status === 'pending' ? priorCall!.status : step.status,
    });
  }

  /**
   * Called as a result arrives. A result answering a corrective retry
   * replies where the retried turn did and does not drain a queued batch.
   */
  beginResult(): { isRetry: boolean; routing: RoutingContext | null } {
    const isRetry = this.mode !== null;
    const routing = isRetry ? this.retryRouting : null;
    return { isRetry, routing };
  }

  /**
   * Decide what the result delivered and push a corrective retry if needed.
   * Returns true when the result answered the prompt at the head of the
   * archive queue; false when a retry will answer the same prompt again.
   */
  onResult(input: ResultInput): boolean {
    const reportOnly = this.mode === 'delivery';
    this.mode = null;
    return input.text ? this.onTextResult(input, input.text, reportOnly) : this.onEmptyResult(input, reportOnly);
  }

  private measureMcpReply(input: ResultInput, needsRouteCheck: boolean) {
    const mcpWroteContent = countTurnContentMessages(input.since, input.turnId) > 0;
    // Off-route sends are completed actions, not delivery of an unwrapped
    // answer to this conversation. Recover only the report, never the action.
    const mcpWroteReply =
      mcpWroteContent && (!needsRouteCheck || countTurnContentMessages(input.since, input.turnId, input.routing) > 0);
    return { mcpWroteContent, mcpWroteReply, needsPostToolReport: this.hadNativeTool || mcpWroteContent };
  }

  /** Dispatch the final text and measure what the turn delivered through any door. */
  private deliverText(input: ResultInput, text: string, reportOnly: boolean) {
    // Measured before dispatch: only MCP writes count as prior content.
    const mcpWroteContent = countTurnContentMessages(input.since, input.turnId) > 0;
    const dispatched = this.port.dispatch(text, input.routing, reportOnly, input.since, this.recoveringOffRouteReply);
    const mcpWroteReply =
      mcpWroteContent &&
      (!dispatched.hasUnwrapped || countTurnContentMessages(input.since, input.turnId, input.routing) > 0);
    return {
      ...dispatched,
      mcpWroteContent,
      mcpWroteReply,
      needsPostToolReport: this.hadNativeTool || mcpWroteContent,
    };
  }

  /** Another tools-disabled report attempt, or exhaustion once the budget is spent. */
  private retryReport(routing: RoutingContext, endOnExhaust: boolean): boolean {
    if (this.postToolAttempts < MAX_POST_TOOL_DELIVERY_RECOVERY_ATTEMPTS)
      return this.pushPostToolDeliveryNudge(routing);
    this.exhaust(routing);
    if (endOnExhaust && this.port.queueEmpty()) this.port.endStream();
    return false;
  }

  /**
   * Record what a text result delivered. Returns true when a report-only
   * retry that delivered nothing was followed by another report attempt.
   */
  private recordTextDelivery(
    delivery: { sent: number; internalCount: number; mcpWroteReply: boolean },
    routing: RoutingContext,
    reportOnly: boolean,
  ): boolean {
    const { sent, internalCount, mcpWroteReply } = delivery;
    if (sent > 0) this.sentAny = true;
    // A post-nudge retry that delivers nothing but writes an <internal>
    // note is the model taking the escape hatch — confirming it meant to
    // stay silent. Treat as intentional silence, not a delivery failure.
    if (this.nudged && sent === 0 && internalCount > 0) this.silenceConfirmed = true;
    let continuedReport = false;
    if (reportOnly && !mcpWroteReply && sent === 0) {
      this.silenceConfirmed = false;
      continuedReport = this.retryReport(routing, true);
    }
    if (sent > 0 || mcpWroteReply) this.resetToolRecovery();
    return continuedReport;
  }

  private onTextResult(input: ResultInput, text: string, reportOnly: boolean): boolean {
    const { routing } = input;
    const wasRecoveringDelivery = this.nudged;
    const delivery = this.deliverText(input, text, reportOnly);
    const { sent, hasUnwrapped, internalCount, mcpWroteContent, mcpWroteReply, needsPostToolReport } = delivery;
    const continuedReport = this.recordTextDelivery(delivery, routing, reportOnly);
    const undelivered = !mcpWroteReply && hasUnwrapped && !this.nudged;
    const willRetryWrapping = undelivered && !needsPostToolReport;
    const willRecoverPostTool = undelivered && needsPostToolReport;
    this.port.exchangeComplete(text, !mcpWroteReply && hasUnwrapped ? 'undelivered' : 'completed');
    if (mcpWroteReply) {
      this.sentAny = true;
    } else if (willRecoverPostTool) {
      this.pushPostToolDeliveryNudge(routing, mcpWroteContent);
    } else if (willRetryWrapping) {
      log(`WARNING: agent output had no <message to="..."> blocks — nothing was sent`);
      this.pushDeliveryNudge(routing);
    } else if (sent === 0 && internalCount > 0 && !wasRecoveringDelivery) {
      this.emptyResultSeen = true;
      if (this.port.queueEmpty()) this.port.endStream();
    }
    // A delivery retry that produced nothing at all ends the query so the
    // terminal notice fires.
    const retryDeliveredNothing = wasRecoveringDelivery && !mcpWroteReply && sent === 0 && internalCount === 0;
    if (retryDeliveredNothing && !continuedReport && this.port.queueEmpty()) this.port.endStream();
    // Recovery retries answer the SAME user prompt — keep it queued so
    // the retry archives against it, not the nudge text.
    return !willRetryWrapping && !willRecoverPostTool && !continuedReport;
  }

  /**
   * A result with no final text. Either `strippedToEmpty` — the reply was
   * swallowed by reasoning with no <message> wrapper, recoverable exactly
   * like bare unwrapped text — or genuinely nothing: the shape of a
   * legitimately silent autonomous turn, which is not nudged and falls
   * through to the terminal empty-result notice.
   */
  private onEmptyResult(input: ResultInput, reportOnly: boolean): boolean {
    const { routing, providerFailed } = input;
    const stripped = input.strippedToEmpty === true;
    const malformed = input.malformedToolCall === true;
    const { mcpWroteContent, mcpWroteReply, needsPostToolReport } = this.measureMcpReply(input, stripped);
    const continuedReport = reportOnly && !mcpWroteReply && this.retryReport(routing, false);
    if (mcpWroteReply) {
      this.sentAny = true;
      this.resetToolRecovery();
    }
    const canRetry = !mcpWroteReply && !this.nudged && !providerFailed;
    if (continuedReport) {
      // Another tools-disabled attempt to report the existing result,
      // never permission to resume work.
      return false;
    }
    if (
      canRetry &&
      !needsPostToolReport &&
      malformed &&
      this.malformedAttempts < MAX_MALFORMED_TOOL_RECOVERY_ATTEMPTS
    ) {
      this.pushMalformedToolNudge(routing);
      return false;
    }
    if (canRetry && needsPostToolReport && stripped) {
      this.pushPostToolDeliveryNudge(routing, mcpWroteContent);
      return false;
    }
    if (malformed && !mcpWroteReply) {
      this.exhaust(this.retryRouting ?? routing);
      if (this.port.queueEmpty()) this.port.endStream();
      return true;
    }
    if (canRetry && !needsPostToolReport && stripped) {
      log('Result stripped to empty (reply swallowed by reasoning) — nudging');
      this.pushDeliveryNudge(routing);
      return false;
    }
    if (mcpWroteReply) this.port.exchangeComplete(null, 'completed');
    else this.emptyResultSeen = true;
    // Long-lived providers (OpenCode) keep the query open after a turn so
    // rapid follow-ups reuse the warm session. An empty turn sends nothing,
    // so the query would sit open and the post-stream empty-result notice
    // would never run. End the stream so the turn completes and the notice
    // fires; the continuation was persisted at `init`, so the next message
    // resumes the same session normally.
    if (!this.sentAny && this.port.queueEmpty()) this.port.endStream();
    return true;
  }

  /**
   * The notice for a turn that ends having delivered nothing, first match
   * wins: confirmed silence (none), runaway abort, exhausted malformed-tool
   * recovery, a failed delivery nudge, then a plain empty result. Provider
   * errors are surfaced by the caller instead.
   */
  terminalNotice(
    routing: RoutingContext,
    providerFailed: boolean,
    runawayReason: string | null,
  ): TerminalNotice | null {
    if (this.sentAny) return null;
    const action: SuggestedAction = this.hadNativeTool ? 'report' : 'retry';
    if (this.silenceConfirmed && !providerFailed) {
      log('Turn confirmed intentional silence after nudge — delivering nothing');
      return null;
    }
    if (runawayReason) {
      // The runaway guard aborts the stream, so no `result` event ever
      // arrives. Without a notice the thread just looks stuck.
      log(`Turn aborted as runaway (${runawayReason}) — notifying user`);
      return {
        routing,
        text: `⚠️ The agent got stuck in a loop (${runawayReason}) and the turn was stopped before it could reply. Retry, or switch to a stronger model if it keeps happening.`,
        label: 'runaway-abort notice',
        action: 'retry',
      };
    }
    if (providerFailed) return null;
    if (this.malformedExhausted) {
      log('Malformed tool-call recovery exhausted — surfacing specific error');
      return {
        routing: this.malformedErrorRouting,
        text: this.hadNativeTool
          ? '⚠️ A tool ran, but the model repeatedly failed to format its final reply. The action was not retried. Ask the agent to report the existing result or switch models.'
          : '⚠️ The model repeatedly produced malformed tool calls, so no tool was executed. Retry the task or switch to a model with reliable native tool calling.',
        label: 'malformed-tool error',
        action,
      };
    }
    if (this.nudged) {
      // The model left evidence it was trying to reply, was asked to re-send
      // it wrapped, and STILL delivered nothing: a genuine malfunction.
      log('Turn produced no deliverable output after recovery nudge — surfacing generic error');
      return {
        routing: this.deliveryErrorRouting,
        text: '⚠️ Something went wrong producing a reply. Please try again.',
        label: 'generic delivery error',
        action,
      };
    }
    if (this.emptyResultSeen) {
      log('Turn completed with an empty result and no error — notifying user');
      return {
        routing,
        text: '⚠️ The agent finished without producing a response, and without reporting an error. Please try again.',
        label: 'empty-result notice',
        action,
      };
    }
    return null;
  }

  private exhaust(failedRouting: RoutingContext): void {
    this.malformedExhausted = true;
    this.malformedErrorRouting = failedRouting;
  }

  /**
   * One-shot self-correction retry for both delivery failure shapes. The
   * nudge offers an explicit escape hatch (re-send wrapped, OR emit
   * <internal> to confirm intentional silence) so a genuinely silent turn is
   * never prodded into fabricating a reply.
   */
  private pushDeliveryNudge(failedRouting: RoutingContext): void {
    this.nudged = true;
    this.deliveryErrorRouting = failedRouting;
    log('Recovery nudge: turn delivered nothing — asking the agent to re-send it wrapped');
    // The activity buffer carries across the nudge→retry boundary and
    // flushes onto the recovered reply's row.
    this.port.beginCorrectiveTurn('Reply wasn’t formatted for delivery — asked the agent to re-send it.');
    const names = getAllDestinations()
      .map((d) => d.name)
      .join(', ');
    this.port.query.push(
      `<system>Your reply was not delivered. Either it was not wrapped in ` +
        `<message to="name">...</message> blocks, or it was left inside your ` +
        `reasoning. All delivered output must be wrapped: use <message to="name"> ` +
        `for content to send, or <internal> for scratchpad. ` +
        `Your destinations: ${names}. ` +
        `If you have a response, re-send it now with the correct wrapping. ` +
        `If you intentionally have nothing to send, reply with a brief ` +
        `<internal>…</internal> note explaining why (it will not be delivered).</system>`,
    );
  }

  private pushMalformedToolNudge(failedRouting: RoutingContext): void {
    if (this.malformedAttempts === 0) this.hadNativeTool = false;
    this.malformedAttempts++;
    this.mode = 'tool';
    this.retryRouting = failedRouting;
    log(
      `Recovery nudge: model emitted a malformed tool invocation ` +
        `(attempt ${this.malformedAttempts}/${MAX_MALFORMED_TOOL_RECOVERY_ATTEMPTS})`,
    );
    this.port.beginCorrectiveTurn('A malformed tool call did not run - asked the agent to retry it natively.');
    this.port.query.push(
      `<system>Your previous tool invocation was malformed: it either omitted required arguments ` +
        `or printed XML-like tool-call markup as ordinary text. That tool call did NOT execute. ` +
        `Continue the original request now and invoke the required tools through the native tool ` +
        `interface with all required arguments. Do not write <tool_call>, <invoke>, or <command> ` +
        `markup yourself. After the tool work completes, send the result in a ` +
        `<message to="name">...</message> block.</system>`,
    );
  }

  private pushPostToolDeliveryNudge(failedRouting: RoutingContext, replyOnly = false): boolean {
    this.recoveringOffRouteReply ||= replyOnly;
    this.postToolAttempts++;
    this.nudged = true;
    this.hadNativeTool = true;
    this.mode = 'delivery';
    this.retryRouting = failedRouting;
    log(
      `Recovery nudge: undelivered final output followed native tool activity - requesting delivery only ` +
        `(attempt ${this.postToolAttempts}/${MAX_POST_TOOL_DELIVERY_RECOVERY_ATTEMPTS})`,
    );
    this.port.beginCorrectiveTurn(
      'A tool ran but its final reply was malformed - asked the agent to report the result without repeating the action.',
    );
    const accepted = this.port.query.push(this.postToolDeliveryPrompt(failedRouting), undefined, { tools: 'disabled' });
    if (!accepted) {
      this.mode = null;
      this.exhaust(failedRouting);
      this.port.endStream();
      return false;
    }
    return true;
  }

  private postToolDeliveryPrompt(failedRouting: RoutingContext): string {
    const names = getAllDestinations()
      .map((d) => d.name)
      .join(', ');
    const replyDestination = findByRouting(failedRouting.channelType, failedRouting.platformId);
    const replyInstruction = replyDestination
      ? `Report to <message to="${replyDestination.name}"> in the originating conversation. ` +
        `Messages already sent to other destinations are not a reply here. `
      : '';
    const calls = [...this.executedToolCalls.values()];
    const completedCalls = calls.filter((call) => call.status === 'completed').map(summarizeCall);
    const uncertainCalls = calls.filter((call) => call.status !== 'completed').map(summarizeCall);
    const callSummary = [
      ...(completedCalls.length > 0
        ? [
            `Calls whose tool invocation completed (use their native results above to determine success or failure):\n${completedCalls.join('\n')}`,
          ]
        : []),
      ...(uncertainCalls.length > 0
        ? [
            `Calls that started but did not complete cleanly (they may still have effects):\n${uncertainCalls.join('\n')}`,
          ]
        : []),
    ].join('\n');
    const retryInstruction =
      this.postToolAttempts > 1
        ? `Your previous reporting-only response incorrectly tried to use another tool. ` +
          `Do not continue, inspect, search, verify, or perform more work. Report only what the ` +
          `completed calls already established and what remains unfinished. Output exactly one ` +
          `<message to="name">...</message> block and no other text. `
        : '';
    return (
      `<system>At least one native tool already ran in the previous turn, but the final reply ` +
      `was not delivered. Here is the execution record:\n${callSummary || 'One or more native tools may have executed.'}\n` +
      `Do NOT repeat any of those calls or make equivalent requests through other tools. ` +
      `Tools are disabled for this recovery turn. ${retryInstruction}Use the existing native results above and report ` +
      `the actual result in ` +
      `a <message to="name">...</message> block. ${replyInstruction}Your destinations: ${names}.</system>`
    );
  }
}
