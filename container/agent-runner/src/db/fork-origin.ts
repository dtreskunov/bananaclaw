/**
 * Fork origin (container side).
 *
 * The host projects inherited history and fork metadata into runner-state.db.
 * Provider continuation and digest fields distinguish inherited context from
 * messages the new session actually processed.
 */
import { getInboundDb } from './connection.js';

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
 */
export function getForkOrigin(): ForkOriginRow | undefined {
  const db = getInboundDb();

  return db.prepare('SELECT * FROM fork_origin WHERE id = 1').get() as ForkOriginRow | undefined;
}
