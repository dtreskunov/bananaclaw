/**
 * Per-turn branch points: the provider-private handle for the turn that
 * produced a given outbound row, plus the continuation it belonged to.
 *
 * Written to `turn_checkpoints` in outbound.db by the poll-loop after each
 * provider result. Read by the *host* when forking a thread, to tell the
 * new session's provider exactly where to cut the parent session. Without a
 * row here a fork can only replay a plain-text digest, so the cost of
 * writing one is paid on every turn to keep every message forkable.
 *
 * The continuation is stored alongside the ref because a session's
 * continuation can be rotated or cleared (/clear, cold-resume rotation),
 * which orphans every ref minted under the old one. Matching on both is what
 * stops a fork from anchoring into a session that no longer exists.
 */
import { getOutboundDb } from './connection.js';

export function writeTurnCheckpoint(
  messageOutId: string,
  provider: string,
  continuation: string,
  providerTurnRef: string,
): void {
  getOutboundDb()
    .prepare(
      `INSERT OR REPLACE INTO turn_checkpoints
         (message_out_id, provider, continuation, provider_turn_ref, created_at)
       VALUES ($message_out_id, $provider, $continuation, $provider_turn_ref, datetime('now'))`,
    )
    .run({
      $message_out_id: messageOutId,
      $provider: provider,
      $continuation: continuation,
      $provider_turn_ref: providerTurnRef,
    });
}
