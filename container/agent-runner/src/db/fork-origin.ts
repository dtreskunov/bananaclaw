/**
 * Fork origin (container side).
 *
 * When the host forks a thread it copies the parent's message history into
 * the new session's DBs and writes a single `fork_origin` row into
 * inbound.db describing where the branch came from. That row is the only
 * thing that tells the agent its visible history was inherited rather than
 * lived: the copied `messages_in` / `messages_out` rows carry no provider
 * state, so without it the agent would boot with a blank context window
 * while the user stares at a full transcript.
 *
 * Read-only, like everything else in inbound.db. Consumption is recorded in
 * outbound.db (see `markForkOriginConsumed`) because the container must
 * never write to the host's file.
 */
import { openInboundDb } from './connection.js';

export interface ForkOriginRow {
  /** Session this branch was cut from. Informational — may no longer exist. */
  parent_session_id: string;
  /**
   * The parent's provider continuation at the branch point, if it had one.
   * Only meaningful to the provider named below.
   */
  parent_continuation: string | null;
  /** Provider that owned `parent_continuation`. */
  provider: string | null;
  /**
   * Provider-private handle for the anchor turn (e.g. OpenCode's assistant
   * message id). Required for a native fork; null forces the digest path.
   */
  anchor_ref: string | null;
  /** Plain-text rendering of the inherited history. Always populated. */
  digest: string;
  created_at: string;
}

/**
 * Read the fork origin, or undefined if this session isn't a fork.
 *
 * Tolerates the table being absent: sessions created before forking existed
 * have no `fork_origin` table, and the container can't ALTER a read-only DB
 * to add one.
 */
export function getForkOrigin(): ForkOriginRow | undefined {
  const db = openInboundDb();
  try {
    return db.prepare('SELECT * FROM fork_origin WHERE id = 1').get() as ForkOriginRow | undefined;
  } catch {
    // No such table — not a fork, or an older session DB.
    return undefined;
  } finally {
    db.close();
  }
}
