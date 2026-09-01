/**
 * Persistent key/value state for the container. Lives in runner-state.db and
 * is projected to the host-owned outbound.db over the session link.
 *
 * Primary use: remember each provider's opaque continuation id so the
 * agent's conversation resumes across container restarts. Keyed per
 * provider because continuations are provider-private — a Claude
 * conversation id means nothing to Codex and vice versa. Switching
 * providers is therefore lossless: each provider's last thread stays
 * on file and resumes cleanly if the user flips back.
 */
import { getOutboundDb } from './connection.js';

const MAX_STATE_CHARS = 1024 * 1024;

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
  if (key.length === 0 || key.length > 256 || value.length === 0 || value.length > MAX_STATE_CHARS) {
    throw new Error('session state exceeds durable link limits');
  }
  getOutboundDb()
    .prepare('INSERT OR REPLACE INTO session_state (key, value, updated_at) VALUES (?, ?, ?)')
    .run(key, value, new Date().toISOString());
}

function deleteValue(key: string): void {
  getOutboundDb().prepare('DELETE FROM session_state WHERE key = ?').run(key);
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

const FORK_ORIGIN_KEY = 'fork_origin_absorbed';

/**
 * Whether this session has already absorbed its `fork_origin` row.
 *
 * The row lives in inbound.db, which the container may only read, so
 * "already handled" has to be recorded on the outbound side. Without this
 * flag every container restart would re-inject the inherited-history digest
 * — the agent would be told its backstory again on top of a session that
 * already contains it.
 */
export function isForkOriginAbsorbed(): boolean {
  return getValue(FORK_ORIGIN_KEY) !== undefined;
}

export function markForkOriginAbsorbed(tier: 'native' | 'digest'): void {
  setValue(FORK_ORIGIN_KEY, tier);
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

import type { ActivityStep, TurnUsage } from '../providers/types.js';
import {
  clearActivitySignal,
  clearUsageSignal,
  emitActivitySignal,
  emitUsageSignal,
  endTurnSignal,
  resumeTurnSignal,
} from '../session-link.js';

/** One step of a turn's activity trace: an emit-time timestamp (epoch ms as
 *  a string) plus a JSON-encoded {@link ActivityStep} in `text`. Older rows
 *  (persisted before the structured refactor) hold a plain human string; the
 *  UI parses non-JSON `text` as a legacy line. */
export interface ActivityLine {
  ts: string;
  text: string;
}

// Generous per-line hard cap on the primary detail. We store the *whole*
// structured step (no source-side human formatting); the web UI presents and
// truncates for display via CSS. This cap only guards against a pathological
// multi-KB command/argument blob.
const ACTIVITY_MAX_CHARS = 2000;

/** Append one structured step to the per-turn activity trace. The host
 *  forwards the full ordered list to the web UI (and derives the single
 *  latest typing hint from the last line), so the user can see every tool
 *  call / progress step as it happens. Best-effort — callers should
 *  swallow errors.
 *
 *  The step is JSON-encoded into the line's `text`; because JSON escapes
 *  newlines, the `<ts>\t<json>\n` file line format stays intact even when a
 *  tool's `detail` (e.g. a multi-line bash command) contains newlines.
 *
 *  Sent over the per-session link for live display and also buffered in
 *  memory so the poll-loop can persist the whole trace to `turn_activity`
 *  at turn end. */
// JSON of the last step appended this turn, for consecutive-dedup. Providers
// re-emit the same step across a tool's running/completed phases; collapsing
// adjacent duplicates keeps the trace readable without dropping genuinely
// distinct steps.
let _lastActivity = '';
// In-memory buffer of this turn's activity lines, snapshotted into
// turn_activity at turn end. Reset by clearActivity().
let _activityBuffer: ActivityLine[] = [];

export function appendActivity(step: ActivityStep): void {
  if (!step || !step.kind) return;
  const s = truncateActivityStep(step);
  const text = JSON.stringify(s);
  if (text === _lastActivity) return;
  _lastActivity = text;
  const ts = String(Date.now());
  _activityBuffer.push({ ts, text });
  emitActivitySignal(s);
}

/** Cap user/model/provider text fields before they leave the container. */
export function truncateActivityStep(step: ActivityStep): ActivityStep {
  let s = step;
  if (s.kind === 'tool' && typeof s.detail === 'string' && s.detail.length > ACTIVITY_MAX_CHARS) {
    s = { ...s, detail: s.detail.slice(0, ACTIVITY_MAX_CHARS - 1) + '…' };
  }
  if ('text' in s && typeof s.text === 'string') {
    if (s.text.length > ACTIVITY_MAX_CHARS) {
      s = { ...s, text: s.text.slice(0, ACTIVITY_MAX_CHARS - 1) + '…' };
    }
  }
  if ('error' in s && typeof s.error === 'string' && s.error.length > ACTIVITY_MAX_CHARS) {
    s = { ...s, error: s.error.slice(0, ACTIVITY_MAX_CHARS - 1) + '…' };
  }
  return s;
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
  clearActivitySignal();
}

export function writeUsageProgress(usage: TurnUsage): void {
  emitUsageSignal(usage);
}

export function clearUsageProgress(): void {
  clearUsageSignal();
}

/** Mark that the SDK turn just ended (result/error event). The host
 *  typing module clears the typing indicator immediately when this is
 *  set, so an agent that delivered a follow-up question and is now
 *  waiting for the user doesn't leave the dots spinning. Cleared on
 *  the next turn start.
 *
 *  Sent over the per-session link rather than persisted independently. */
export function setTurnEnded(): void {
  endTurnSignal();
}

export function clearTurnEnded(): void {
  resumeTurnSignal();
}
