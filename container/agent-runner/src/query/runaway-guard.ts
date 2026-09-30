/**
 * Per-turn backstops for a model that has collapsed into a loop. Each check
 * returns the reason to abort the turn, or null. The caller owns the abort.
 */
import { getDuplicateSendCount } from '../current-batch.js';
import type { ActivityStep } from '../providers/types.js';

/**
 * Abort the turn after this many refused duplicate `send_message` calls.
 * Refusing the write already spares the user the flood; aborting also stops
 * the token burn, since a model looping this way never emits a `stop` finish
 * and OpenCode's prompt loop would otherwise step forever.
 */
const MAX_DUPLICATE_SENDS_PER_TURN = 3;
/**
 * Backstops for the same failure mode with a different tool. A model that has
 * collapsed into repeating one step verbatim keeps finishing as `tool-calls`,
 * so nothing in the provider loop ever terminates the turn. Both bounds sit
 * far above healthy agentic work (observed good turns peak around 70 steps).
 */
const MAX_IDENTICAL_TOOL_STREAK = 8;
const MAX_TOOL_CALLS_PER_TURN = 250;
/**
 * Backstop for the same failure mode expressed as text alone. A model can
 * collapse into re-emitting its final answer over and over — each step a
 * clean `stop`, no tool call anywhere — which both bounds above are blind to,
 * so the turn runs until someone notices. Healthy turns close after at most
 * one consecutive text-only step (the reply itself).
 */
const MAX_CONSECUTIVE_TEXT_STEPS = 6;

export type ToolStep = Extract<ActivityStep, { kind: 'tool' }>;

export class RunawayGuard {
  private readonly countedToolCallIds = new Set<string>();
  private lastToolSignature: string | null = null;
  private identicalToolStreak = 0;
  private consecutiveTextSteps = 0;
  /** Set once the turn was aborted as a runaway; selects the terminal notice. */
  abortReason: string | null = null;

  reset(): void {
    this.countedToolCallIds.clear();
    this.identicalToolStreak = 0;
    this.lastToolSignature = null;
    this.consecutiveTextSteps = 0;
  }

  onToolProgress(step: ToolStep, toolInputFingerprint: string | undefined): string | null {
    // Display detail intentionally omits arbitrary MCP arguments. Providers
    // supply a private fingerprint once complete arguments are available.
    // A terminal event without one still counts as a tool call, but it
    // breaks the identical-call streak rather than assuming empty input.
    const callResolved = toolInputFingerprint !== undefined || !['pending', 'running'].includes(step.status);
    if (callResolved && !this.countedToolCallIds.has(step.id)) {
      this.countedToolCallIds.add(step.id);
      this.consecutiveTextSteps = 0;
      if (toolInputFingerprint !== undefined) {
        const signature = `${step.tool}\u0000${toolInputFingerprint}`;
        this.identicalToolStreak = signature === this.lastToolSignature ? this.identicalToolStreak + 1 : 1;
        this.lastToolSignature = signature;
      } else {
        this.identicalToolStreak = 0;
        this.lastToolSignature = null;
      }
    }
    if (getDuplicateSendCount() >= MAX_DUPLICATE_SENDS_PER_TURN) {
      return `${getDuplicateSendCount()} duplicate send_message calls`;
    }
    if (this.identicalToolStreak >= MAX_IDENTICAL_TOOL_STREAK) {
      return `${this.identicalToolStreak} identical consecutive "${step.tool}" calls`;
    }
    if (this.countedToolCallIds.size > MAX_TOOL_CALLS_PER_TURN) return `${this.countedToolCallIds.size} tool calls`;
    return null;
  }

  onAssistantMessage(): string | null {
    this.consecutiveTextSteps++;
    return this.consecutiveTextSteps >= MAX_CONSECUTIVE_TEXT_STEPS
      ? `${this.consecutiveTextSteps} replies in a row with no tool call`
      : null;
  }
}
