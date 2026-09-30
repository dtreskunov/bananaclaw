import { randomUUID } from 'node:crypto';
import { getInboundDb, getOutboundDb } from './db/connection.js';
import { linkTurnInput, putTurn } from './db/turns.js';
import { setTurnContext, type TurnContext } from './current-batch.js';
import type { RoutingContext } from './formatter.js';

export interface TurnExecution extends TurnContext {
  routing: RoutingContext;
}

/** One logical response, independent of provider attempts and corrective prompts. */
export function beginTurn(routing: RoutingContext, ids: string[], consumed = true): TurnExecution {
  const context = {
    turnId: randomUUID(),
    inReplyTo: routing.inReplyTo,
    startedAt: new Date().toISOString(),
    routing,
  };
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
  })();
  return context;
}

export function associateInput(context: TurnContext, id: string, association: 'consumed' | 'applied' | 'reply'): void {
  linkTurnInput(getOutboundDb(), { turn_id: context.turnId, message_in_id: id, association });
}
