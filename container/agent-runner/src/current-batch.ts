/**
 * Per-batch context the poll loop publishes for downstream consumers
 * (MCP tools, etc.) that don't sit on the poll-loop's call stack.
 *
 * Today the only field is `inReplyTo` — the id of the first inbound
 * message in the batch the agent is currently processing. MCP tools like
 * `send_message` and `send_file` read this and stamp it onto the outbound
 * row so the host's a2a return-path routing can correlate replies back to
 * the originating session.
 *
 * This is module-level state on purpose: the agent-runner is single-process
 * and processes one batch at a time. Poll-loop calls `setCurrentInReplyTo`
 * before invoking the provider and `clearCurrentInReplyTo` after the batch
 * completes (or errors out).
 */
let currentInReplyTo: string | null = null;

export function setCurrentInReplyTo(id: string | null): void {
  currentInReplyTo = id;
}

export function clearCurrentInReplyTo(): void {
  currentInReplyTo = null;
  resetTurnSendTracking();
}

export function getCurrentInReplyTo(): string | null {
  return currentInReplyTo;
}

/**
 * Per-turn duplicate-send tracking.
 *
 * OpenCode's prompt loop keeps stepping for as long as the assistant ends
 * its step with a tool call. A model stuck in a broken output mode can
 * therefore call `send_message` with the same text forever: every step
 * finishes as `tool-calls`, nothing ever finishes as `stop`, and the turn
 * never ends. Observed in the wild at 288 steps / ~200 delivered duplicates
 * before the container was killed by hand.
 *
 * Re-sending the identical text to the identical destination inside one turn
 * is never intentional, so it is the safe signal to cut on. Keyed by
 * destination so a genuine fan-out ("Done." to two channels) still works.
 */
const sentThisTurn = new Set<string>();
let duplicateSends = 0;

export function resetTurnSendTracking(): void {
  sentThisTurn.clear();
  duplicateSends = 0;
}

/** Returns false when this exact (destination, text) pair was already sent this turn. */
export function noteSendMessage(destination: string, text: string): boolean {
  const key = `${destination}\u0000${text}`;
  if (sentThisTurn.has(key)) {
    duplicateSends++;
    return false;
  }
  sentThisTurn.add(key);
  return true;
}

export function getDuplicateSendCount(): number {
  return duplicateSends;
}

