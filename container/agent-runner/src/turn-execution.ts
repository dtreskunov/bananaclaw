import { randomUUID } from 'node:crypto';
import { getInboundDb, getOutboundDb } from './db/connection.js';
import { getTurn, linkTurnInput, putTurn, type TurnOutcome, type TurnRow } from './db/turns.js';
import { setTurnContext, waitForTurnTools, type TurnContext } from './current-batch.js';
import type { RoutingContext } from './formatter.js';
import type { CallUsage, TurnUsage, TurnUsageAdvisory } from './providers/types.js';
import { accumulateCallUsage, transitionUsageAdvisory } from './providers/usage.js';
import { writeTurnUsage } from './db/turn-usage.js';
import type { Database } from 'bun:sqlite';
import { allocateTimelinePosition } from './db/timeline.js';
import { toEpoch, decodeTimeRows } from './db/time.js';

export interface TurnExecution extends TurnContext {
  routing: RoutingContext;
  /** Every reported model call of the turn, keyed by call id. */
  calls: Map<string, CallUsage>;
  usage: Readonly<TurnUsage> | null;
  /** Calls reported since the provider's last result. */
  unreported: boolean;
  /** A provider attempt failed with unreported calls, so an in-flight call may be missing. */
  incomplete: boolean;
  limits: Pick<TurnUsage, 'context_window' | 'max_output_tokens'>;
  usageId: string;
  inputIds: string[];
  settled: boolean;
  /** The turn's first model call could start (its marker step was written). */
  modelReady?: boolean;
  endedAt?: string;
  failure?: boolean;
  usageAdvisory?: TurnUsageAdvisory;
  thinkingLevel?: string;
}

/** One logical response, independent of provider attempts and corrective prompts. */
export function beginTurn(routing: RoutingContext, ids: string[], consumed = true): TurnExecution {
  const context: TurnExecution = {
    turnId: randomUUID(),
    inReplyTo: routing.inReplyTo,
    startedAt: new Date().toISOString(),
    routing,
    calls: new Map(),
    usage: null,
    unreported: false,
    incomplete: false,
    limits: {},
    usageId: '',
    inputIds: [],
    settled: false,
  };
  context.usageId = `tu-${context.turnId}`;
  const origin = routing.inReplyTo
    ? getInboundDb().prepare('SELECT source_session_id FROM messages_in WHERE id = ?').get(routing.inReplyTo) as
      { source_session_id: string | null } | undefined
    : undefined;
  getOutboundDb().transaction(() => {
    putTurn(getOutboundDb(), {
      id: context.turnId,
      origin_channel_type: routing.channelType,
      origin_platform_id: routing.platformId,
      origin_thread_id: routing.threadId,
      origin_source_session_id: origin?.source_session_id ?? null,
      started_at: context.startedAt,
      ended_at: null,
      phase: 'running',
      outcome: 'pending',
      provenance: 'native',
      imported_from_session_id: null,
      imported_from_turn_id: null,
    });
    if (consumed) for (const id of ids) associateInput(context, id, 'consumed');
    setTurnContext(context);
    persistTurnMetadata(context, false);
  })();
  return context;
}

export function turnDuration(context: TurnContext): number {
  const end = 'endedAt' in context && typeof context.endedAt === 'string' ? Date.parse(context.endedAt) : Date.now();
  return Math.max(0, end - Date.parse(context.startedAt));
}

export function turnUsage(context: TurnExecution): Readonly<TurnUsage> | null {
  return context.usage;
}

/** Record one model call; returns false when it replaced an earlier report of the same call. */
export function recordCallUsage(context: TurnExecution, data: CallUsage): boolean {
  const id = data.id ?? randomUUID();
  const added = !context.calls.has(id);
  context.calls.set(id, data);
  let usage: TurnUsage | null = null;
  for (const { id: _id, ...call } of context.calls.values())
    usage = accumulateCallUsage(usage, call);
  if (usage) {
    usage.context_window ??= context.limits.context_window;
    usage.max_output_tokens ??= context.limits.max_output_tokens;
  }
  context.usage = usage;
  context.unreported = true;
  persistTurnUsage(context);
  persistTurnMetadata(context, false);
  return added;
}

/** The provider reached a result: every call of the attempt has been reported. */
export function completeUsageAttempt(context: TurnExecution, limits: TurnExecution['limits'] = {}): void {
  context.unreported = false;
  context.limits = {
    context_window: limits.context_window ?? context.limits.context_window,
    max_output_tokens: limits.max_output_tokens ?? context.limits.max_output_tokens,
  };
  if (context.usage) {
    context.usage = {
      ...context.usage,
      context_window: context.usage.context_window ?? context.limits.context_window,
      max_output_tokens: context.usage.max_output_tokens ?? context.limits.max_output_tokens,
    };
  }
  persistTurnUsage(context);
  persistTurnMetadata(context, false);
}

/** A failed provider attempt keeps its billed calls but may have lost an in-flight one. */
export function finishUsageAttempt(context: TurnExecution): void {
  context.incomplete ||= context.unreported;
  context.unreported = false;
}

function persistTurnUsage(context: TurnExecution): void {
  if (!context.usage) return;
  const output = getOutboundDb().prepare('SELECT id FROM messages_out WHERE turn_id = ? ORDER BY seq DESC LIMIT 1')
    .get(context.turnId) as { id: string } | undefined;
  writeTurnUsage(context.usageId, output?.id ?? null,
    { ...context.usage, duration_ms: turnDuration(context) }, context.turnId);
}

export function persistTurnMetadata(context: TurnExecution, final: boolean): void {
  const db = getOutboundDb();
  const usage = turnUsage(context);
  const durationMs = turnDuration(context);
  if (final) {
    const output = db.prepare('SELECT id FROM messages_out WHERE turn_id = ? ORDER BY seq DESC LIMIT 1')
      .get(context.turnId) as { id: string } | undefined;
    if (output) db.prepare('UPDATE turn_activity SET message_out_id = ? WHERE turn_id = ? AND message_out_id IS NOT ?')
      .run(output.id, context.turnId, output.id);
  }
  const metadata = {
    turnId: context.turnId,
    durationMs,
    model: usage?.model ?? null,
    usageId: usage ? context.usageId : null,
    usageAdvisory: context.usageAdvisory ?? null,
    thinkingLevel: context.thinkingLevel,
    status: final
      ? usage ? (context.incomplete || context.unreported ? 'partial' : 'final') : 'unavailable'
      : usage ? 'partial' : 'provisional',
    final,
  };
  db.prepare(`INSERT INTO session_state (key, value, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`)
    .run(`turn-metadata:${context.turnId}`, JSON.stringify(metadata), Date.now());
}

export function markTurnStopping(context: TurnExecution): void {
  const row = getTurn(getOutboundDb(), context.turnId)!;
  if (row.phase === 'running') putTurn(getOutboundDb(), { ...row, phase: 'stopping' });
}

function finishTurnActivity(db: Database, turnId: string, outcome: TurnOutcome, endedAt: string): void {
  const steps = new Map<string, Record<string, unknown>>();
  for (const row of db.prepare('SELECT text FROM turn_activity WHERE turn_id = ? ORDER BY ordinal').all(turnId) as { text: string }[]) {
    let step: Record<string, unknown>;
    try { step = JSON.parse(row.text); }
    catch (error) { if (error instanceof SyntaxError) continue; throw error; }
    if (['tool', 'compaction'].includes(String(step?.kind)) && typeof step.id === 'string') steps.set(step.id, step);
  }
  for (const step of steps.values()) {
    if (!['running', 'pending'].includes(String(step.status))) continue;
    const status = ['stopped', 'interrupted', 'failed'].includes(outcome) ? 'interrupted' : 'unknown';
    db.prepare(`INSERT INTO turn_activity (turn_id, message_out_id, ordinal, ts, text, timeline_position)
      SELECT ?, NULL, COALESCE(MAX(ordinal), -1) + 1, ?, ?, ? FROM turn_activity WHERE turn_id = ?`)
      .run(turnId, Date.parse(endedAt), JSON.stringify({
        ...step, status, error: 'Turn ended without a confirmed tool result; external side effects may have occurred.',
      }), allocateTimelinePosition(db), turnId);
  }
}

/** The settled turn mutation is the ordered identity-bearing delivery barrier. */
export async function settleTurn(context: TurnExecution, outcome: Exclude<TurnOutcome, 'pending'>): Promise<void> {
  if (context.settled) return;
  const db = getOutboundDb();
  await waitForTurnTools(context);
  if (context.settled) return;
  context.endedAt ??= new Date().toISOString();
  db.transaction(() => {
    const row = getTurn(db, context.turnId)!;
    putTurn(db, { ...row, phase: 'settling' });
    context.usageAdvisory = transitionUsageAdvisory(context.usageAdvisory, 'skipped', Date.parse(context.endedAt!));
    finishTurnActivity(db, context.turnId, context.failure ? 'failed' : outcome, context.endedAt!);
    persistTurnUsage(context);
    persistTurnMetadata(context, true);
    putTurn(db, {
      ...row, phase: 'settled', outcome: context.failure ? 'failed' : outcome,
      ended_at: context.endedAt!,
    });
  })();
  context.settled = true;
}

/** Replacement runner, not a socket disconnect, confirms prior execution ended. */
export function interruptAbandonedTurns(): void {
  const db = getOutboundDb();
  db.transaction(() => {
    const rows = decodeTimeRows<TurnRow>(db.prepare("SELECT * FROM turns WHERE phase != 'settled'").all(), ['started_at', 'ended_at']);
    for (const row of rows) {
      const endedAt = new Date().toISOString();
      const key = `turn-metadata:${row.id}`;
      const previous = db.prepare('SELECT value FROM session_state WHERE key = ?').get(key) as { value: string } | undefined;
      const metadata = previous ? JSON.parse(previous.value) : {};
      finishTurnActivity(db, row.id, 'interrupted', endedAt);
      db.prepare(`INSERT INTO session_state (key, value, updated_at) VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`)
        .run(key, JSON.stringify({
          turnId: row.id, durationMs: metadata.durationMs ?? null,
          model: metadata.model ?? null, usageId: metadata.usageId ?? null,
          usageAdvisory: transitionUsageAdvisory(metadata.usageAdvisory ?? undefined, 'skipped', toEpoch(endedAt)) ?? null,
          status: metadata.usageId ? 'partial' : 'unavailable', final: true,
        }), toEpoch(endedAt));
      putTurn(db, { ...row, phase: 'settled', outcome: 'interrupted', ended_at: endedAt });
    }
    setTurnContext(null);
  })();
}

export function associateInput(context: TurnContext, id: string, association: 'consumed' | 'applied' | 'reply'): void {
  linkTurnInput(getOutboundDb(), { turn_id: context.turnId, message_in_id: id, association });
  if ('inputIds' in context && Array.isArray(context.inputIds) && !context.inputIds.includes(id)) context.inputIds.push(id);
}
