/**
 * Per-batch context the poll loop publishes for downstream consumers
 * (MCP tools, etc.) that don't sit on the poll-loop's call stack.
 *
 * `inReplyTo` is the id of the last inbound
 * message in the batch the agent is currently processing. MCP tools like
 * `send_message` and `send_file` read this and stamp it onto the outbound
 * row so the host's a2a return-path routing can correlate replies back to
 * the originating session.
 *
 * The runner keeps an in-process reply context. Poll-loop calls `setCurrentInReplyTo`
 * before invoking the provider and `clearCurrentInReplyTo` after the batch
 * completes (or errors out).
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import type { Database } from 'bun:sqlite';
import { getOutboundDb } from './db/connection.js';

export interface TurnContext {
  turnId: string;
  inReplyTo: string | null;
  startedAt: string;
}

const captured = new AsyncLocalStorage<TurnContext | null>();
let currentInReplyTo: string | null = null;
const CONTEXT_KEY = 'runner:turn-context';

/** DB-backed handoff also reaches the provider's external MCP sidecar. */
export function setTurnContext(context: TurnContext | null): void {
  getOutboundDb().prepare(
    `INSERT INTO session_state (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`,
  ).run(CONTEXT_KEY, JSON.stringify(context), new Date().toISOString());
  currentInReplyTo = context?.inReplyTo ?? null;
}

export function getTurnContext(): TurnContext | null {
  const local = captured.getStore();
  if (local !== undefined) return local;
  return readTurnContext(getOutboundDb());
}

export function readTurnContext(db: Database): TurnContext | null {
  const row = db.prepare('SELECT value FROM session_state WHERE key = ?')
    .get(CONTEXT_KEY) as { value: string } | undefined;
  return row ? JSON.parse(row.value) as TurnContext | null : null;
}

/** Capture before a tool's first await; never look up a successor on completion. */
export function withTurnContext<T>(context: TurnContext | null, run: () => T): T {
  return captured.run(context ? { ...context } : null, run);
}

export function setCurrentInReplyTo(id: string | null): void {
  currentInReplyTo = id;
}

export function clearCurrentInReplyTo(): void {
  currentInReplyTo = null;
  resetTurnSendTracking();
}

export function getCurrentInReplyTo(): string | null {
  return captured.getStore() !== undefined
    ? captured.getStore()?.inReplyTo ?? null
    : getTurnContext()?.inReplyTo ?? currentInReplyTo;
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
  const context = getTurnContext();
  if (context) {
    const db = getOutboundDb();
    return db.transaction(() => {
      const key = `runner:sends:${context.turnId}`;
      const row = db.prepare('SELECT value FROM session_state WHERE key = ?').get(key) as { value: string } | undefined;
      const state: { sent: string[]; duplicates: number } = row ? JSON.parse(row.value) : { sent: [], duplicates: 0 };
      const digest = createHash('sha256').update(`${destination}\u0000${text}`).digest('hex');
      const duplicate = state.sent.includes(digest);
      if (duplicate) state.duplicates++;
      else state.sent.push(digest);
      db.prepare(`INSERT INTO session_state (key, value, updated_at) VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`)
        .run(key, JSON.stringify(state), new Date().toISOString());
      return !duplicate;
    })();
  }
  const key = `${destination}\u0000${text}`;
  if (sentThisTurn.has(key)) {
    duplicateSends++;
    return false;
  }
  sentThisTurn.add(key);
  return true;
}

export function getDuplicateSendCount(): number {
  const context = getTurnContext();
  if (context) {
    const row = getOutboundDb().prepare('SELECT value FROM session_state WHERE key = ?')
      .get(`runner:sends:${context.turnId}`) as { value: string } | undefined;
    return row ? JSON.parse(row.value).duplicates : 0;
  }
  return duplicateSends;
}
