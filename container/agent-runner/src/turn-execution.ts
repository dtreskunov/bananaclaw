import { randomUUID } from 'node:crypto';
import { getInboundDb, getOutboundDb } from './db/connection.js';
import { getTurn, linkTurnInput, putTurn, type TurnOutcome, type TurnRow } from './db/turns.js';
import { setTurnContext, waitForTurnTools, type TurnContext } from './current-batch.js';
import type { RoutingContext } from './formatter.js';
import type { CallUsage, TurnUsage } from './providers/types.js';
import { accumulateCallUsage, accumulateTurnUsage } from './providers/usage.js';
import { writeTurnUsage } from './db/turn-usage.js';
import type { Database } from 'bun:sqlite';

export interface TurnExecution extends TurnContext {
  routing: RoutingContext;
  reportedUsage: TurnUsage | null;
  callUsage: TurnUsage | null;
  partialUsage: TurnUsage | null;
  usageId: string;
  inputIds: string[];
  settled: boolean;
  endedAt?: string;
  failure?: boolean;
}

/** One logical response, independent of provider attempts and corrective prompts. */
export function beginTurn(routing: RoutingContext, ids: string[], consumed = true): TurnExecution {
  const context: TurnExecution = {
    turnId: randomUUID(),
    inReplyTo: routing.inReplyTo,
    startedAt: new Date().toISOString(),
    routing,
    reportedUsage: null,
    callUsage: null,
    partialUsage: null,
    usageId: '',
    inputIds: [],
    settled: false,
  };
  context.usageId = `tu-${context.turnId}`;
  const origin = ids.length
    ? getInboundDb().prepare('SELECT source_session_id FROM messages_in WHERE id = ?').get(ids[ids.length - 1]) as
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

function sum(a: TurnUsage | null, b: TurnUsage | null): TurnUsage | null {
  return b ? accumulateTurnUsage(a, b) : a;
}

export function turnUsage(context: TurnExecution): TurnUsage | null {
  return sum(sum(context.partialUsage, context.reportedUsage), context.callUsage);
}

export function recordTurnUsage(context: TurnExecution, data: TurnUsage | CallUsage, complete: boolean): void {
  if (complete) {
    context.reportedUsage = accumulateTurnUsage(context.reportedUsage, data);
    context.callUsage = null;
  } else {
    context.callUsage = accumulateCallUsage(context.callUsage, data);
  }
  persistTurnMetadata(context, false);
}

/**
 * Settled usage from a runner-side model call outside the provider's stream
 * (the delivery turn). Adds billing only: duration, model limits and context
 * size stay the provider's, and it never counts as an in-flight partial call.
 */
export function recordRunnerCallUsage(context: TurnExecution, data: CallUsage): void {
  const prior = context.reportedUsage;
  context.reportedUsage = prior
    ? {
        ...prior,
        cost_usd: prior.cost_usd + data.cost_usd,
        input_tokens: prior.input_tokens + data.input_tokens,
        output_tokens: prior.output_tokens + data.output_tokens,
        cache_read_tokens: prior.cache_read_tokens + data.cache_read_tokens,
        cache_write_tokens: prior.cache_write_tokens + data.cache_write_tokens,
        reasoning_tokens: (prior.reasoning_tokens ?? 0) + (data.reasoning_tokens ?? 0) || prior.reasoning_tokens,
      }
    : { ...data, context_tokens: undefined };
  persistTurnMetadata(context, false);
}

/** Preserve billed partial calls when a failed provider attempt is retried. */
export function finishUsageAttempt(context: TurnExecution): void {
  context.partialUsage = sum(context.partialUsage, context.callUsage);
  context.callUsage = null;
}

export function persistTurnMetadata(context: TurnExecution, final: boolean): void {
  const db = getOutboundDb();
  const usage = turnUsage(context);
  const durationMs = turnDuration(context);
  const output = db.prepare('SELECT id FROM messages_out WHERE turn_id = ? ORDER BY seq DESC LIMIT 1')
    .get(context.turnId) as { id: string } | undefined;
  if (final && output) {
    db.prepare('UPDATE turn_activity SET message_out_id = ? WHERE turn_id = ? AND message_out_id IS NOT ?')
      .run(output.id, context.turnId, output.id);
  }
  if (usage) writeTurnUsage(context.usageId, output?.id ?? null, { ...usage, duration_ms: durationMs }, context.turnId);
  const metadata = {
    turnId: context.turnId,
    durationMs,
    model: usage?.model ?? null,
    usageId: usage ? context.usageId : null,
    status: final
      ? usage ? (context.partialUsage || context.callUsage ? 'partial' : 'final') : 'unavailable'
      : usage ? 'partial' : 'provisional',
    final,
  };
  db.prepare(`INSERT INTO session_state (key, value, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`)
    .run(`turn-metadata:${context.turnId}`, JSON.stringify(metadata), new Date().toISOString());
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
    if (step?.kind === 'tool' && typeof step.id === 'string') steps.set(step.id, step);
  }
  for (const step of steps.values()) {
    if (!['running', 'pending'].includes(String(step.status))) continue;
    const status = ['stopped', 'interrupted', 'failed'].includes(outcome) ? 'interrupted' : 'unknown';
    db.prepare(`INSERT INTO turn_activity (turn_id, message_out_id, ordinal, ts, text)
      SELECT ?, NULL, COALESCE(MAX(ordinal), -1) + 1, ?, ? FROM turn_activity WHERE turn_id = ?`)
      .run(turnId, String(Date.parse(endedAt)), JSON.stringify({
        ...step, status, error: 'Turn ended without a confirmed tool result; external side effects may have occurred.',
      }), turnId);
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
    finishTurnActivity(db, context.turnId, context.failure ? 'failed' : outcome, context.endedAt!);
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
    const rows = db.prepare("SELECT * FROM turns WHERE phase != 'settled'").all() as TurnRow[];
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
          status: metadata.usageId ? 'partial' : 'unavailable', final: true,
        }), endedAt);
      putTurn(db, { ...row, phase: 'settled', outcome: 'interrupted', ended_at: endedAt });
    }
    setTurnContext(null);
  })();
}

export function associateInput(context: TurnContext, id: string, association: 'consumed' | 'applied' | 'reply'): void {
  linkTurnInput(getOutboundDb(), { turn_id: context.turnId, message_in_id: id, association });
  if ('inputIds' in context && Array.isArray(context.inputIds) && !context.inputIds.includes(id)) context.inputIds.push(id);
}
