/**
 * Persistent key/value state for the container. Lives in outbound.db
 * (container-owned, already scoped per channel/thread).
 *
 * Primary use: remember each provider's opaque continuation id so the
 * agent's conversation resumes across container restarts. Keyed per
 * provider because continuations are provider-private — a Claude
 * conversation id means nothing to Codex and vice versa. Switching
 * providers is therefore lossless: each provider's last thread stays
 * on file and resumes cleanly if the user flips back.
 */
import { getOutboundDb } from './connection.js';

const LEGACY_KEY = 'sdk_session_id';

function continuationKey(providerName: string): string {
  return `continuation:${providerName.toLowerCase()}`;
}

function getValue(key: string): string | undefined {
  const row = getOutboundDb()
    .prepare('SELECT value FROM session_state WHERE key = ?')
    .get(key) as { value: string } | undefined;
  return row?.value;
}

function setValue(key: string, value: string): void {
  getOutboundDb()
    .prepare('INSERT OR REPLACE INTO session_state (key, value, updated_at) VALUES (?, ?, ?)')
    .run(key, value, new Date().toISOString());
}

function deleteValue(key: string): void {
  getOutboundDb().prepare('DELETE FROM session_state WHERE key = ?').run(key);
}

/**
 * One-time migration of the pre-per-provider continuation row.
 *
 * Before this was keyed per provider, continuations lived under the
 * single key `sdk_session_id`. On container start, if that legacy row
 * exists and the current provider has no continuation of its own, adopt
 * the legacy value into the current provider's slot (best-guess — the
 * legacy row was written by whatever provider ran last). The legacy row
 * is always deleted so future provider flips never re-read a stale id
 * through the wrong lens.
 *
 * Returns the continuation the caller should use at startup (either the
 * current provider's existing value, the adopted legacy value, or
 * undefined).
 */
export function migrateLegacyContinuation(providerName: string): string | undefined {
  const legacy = getValue(LEGACY_KEY);
  const currentKey = continuationKey(providerName);
  const current = getValue(currentKey);

  if (legacy === undefined) return current;

  // Always drop the legacy row so no future provider reads it.
  deleteValue(LEGACY_KEY);

  // Prefer the current provider's own slot if one already exists.
  if (current !== undefined) return current;

  setValue(currentKey, legacy);
  return legacy;
}

export function getContinuation(providerName: string): string | undefined {
  return getValue(continuationKey(providerName));
}

export function setContinuation(providerName: string, id: string): void {
  setValue(continuationKey(providerName), id);
}

export function clearContinuation(providerName: string): void {
  deleteValue(continuationKey(providerName));
}

const FAILED_TURN_KEY = 'failed_turn';

export interface FailedTurnRecord {
  /** The prompt that was sent to the provider on the failed turn. Used to
   *  reconstruct what the user asked when we replay context on the next
   *  turn — the inbound row has been markCompleted'd by then. */
  prompt: string;
  /** The error message we surfaced to the user. The next turn tells the
   *  agent about it so it can acknowledge the failure rather than acting
   *  as if the previous message never happened. */
  error: string;
  /** Wall-clock when we recorded the failure. Lets the next turn render a
   *  rough "a few seconds ago" hint if desired. */
  recorded_at: number;
}

/** Persist a failed-turn record. Called when a turn surfaces an error to
 *  the user (either via the unsurfacedError path or by throwing after
 *  stale-session retry is exhausted). Read once on the next turn so the
 *  agent has visibility into what was lost.
 *
 *  Pairs with the continuation rollback in processQuery: when we revert
 *  to the prior good session id, the resumed transcript has no record of
 *  the failed message or its error. This row carries that context across
 *  turns instead. */
export function setFailedTurn(record: FailedTurnRecord): void {
  setValue(FAILED_TURN_KEY, JSON.stringify(record));
}

export function getFailedTurn(): FailedTurnRecord | undefined {
  const raw = getValue(FAILED_TURN_KEY);
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as FailedTurnRecord;
  } catch {
    return undefined;
  }
}

export function clearFailedTurn(): void {
  deleteValue(FAILED_TURN_KEY);
}

import { appendActivityFile, clearActivityFile, writeTurnEndedFile, clearTurnEndedFile } from './connection.js';

/** One step of a turn's activity trace: an emit-time timestamp (epoch ms as
 *  a string) plus the whole progress text. */
export interface ActivityLine {
  ts: string;
  text: string;
}

// Generous per-line hard cap. We store the *whole* harness progress message
// (no source-side clipping); the web UI truncates for display via CSS. This
// cap only guards against a pathological multi-KB command/argument blob.
const ACTIVITY_MAX_CHARS = 2000;

/** Append one progress line to the per-turn activity trace. The host
 *  forwards the full ordered list to the web UI (and derives the single
 *  latest typing hint from the last line), so the user can see every tool
 *  call / progress step as it happens. Best-effort — callers should
 *  swallow errors.
 *
 *  Written to an append-only file (not outbound.db) to avoid write
 *  contention between the poll-loop process and the nanoclaw MCP server
 *  subprocess — both share outbound.db with journal_mode=DELETE (exclusive
 *  locks). Also buffered in memory so the poll-loop can persist the whole
 *  trace to `turn_activity` at turn end. */
// Last line appended to the activity trace this turn, for consecutive-dedup.
// Providers re-emit the same hint across a tool's running/completed phases;
// collapsing adjacent duplicates keeps the trace readable without dropping
// genuinely distinct steps.
let _lastActivity = '';
// In-memory buffer of this turn's activity lines, snapshotted into
// turn_activity at turn end. Reset by clearActivity().
let _activityBuffer: ActivityLine[] = [];

export function appendActivity(text: string): void {
  let line = (text ?? '').replace(/\r?\n/g, ' ').trim();
  if (!line || line === _lastActivity) return;
  if (line.length > ACTIVITY_MAX_CHARS) line = line.slice(0, ACTIVITY_MAX_CHARS - 1) + '…';
  _lastActivity = line;
  const ts = String(Date.now());
  _activityBuffer.push({ ts, text: line });
  appendActivityFile(`${ts}\t${line}`);
}

/** The activity lines buffered so far this turn (in append order). */
export function getActivityBuffer(): ActivityLine[] {
  return _activityBuffer;
}

/** Clear the activity trace. Called at turn start so each turn shows a
 *  fresh trace rather than accumulating across turns. */
export function clearActivity(): void {
  _lastActivity = '';
  _activityBuffer = [];
  clearActivityFile();
}

/** Mark that the SDK turn just ended (result/error event). The host
 *  typing module clears the typing indicator immediately when this is
 *  set, so an agent that delivered a follow-up question and is now
 *  waiting for the user doesn't leave the dots spinning. Cleared on
 *  the next turn start.
 *
 *  Written to a file (not outbound.db) — same rationale as setProgress. */
export function setTurnEnded(): void {
  writeTurnEndedFile(String(Date.now()));
}

export function clearTurnEnded(): void {
  clearTurnEndedFile();
}
