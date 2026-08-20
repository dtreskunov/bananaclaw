/**
 * Snapshot an fx session's state into a forked session.
 *
 * fx keeps conversations as files under $HOME/.fx, and every nanoclaw session
 * mounts a private host directory over that path. A fork therefore starts with
 * an empty fx state directory, and the container has nothing to branch from
 * unless the parent's files are physically present in the copy.
 *
 * Unlike the OpenCode snapshot this is a plain recursive copy, and it is safe
 * even while the parent is mid-turn: fx's event log is append-only and its
 * commit watermark is the only durable boundary, so a torn tail is discarded
 * the next time the session is opened. The container then rewinds that
 * watermark to the branch point (see fx-session-store.ts in the agent-runner).
 *
 * Size-guarded because it is a real duplication — the log carries every tool
 * result verbatim — so an unbounded copy would let a few branches of a busy
 * thread fill the host's disk. Over the limit we decline and the caller falls
 * back to replaying a plain-text digest: a worse branch, but a branch.
 */
import fs from 'fs';
import path from 'path';

import { log } from '../log.js';

/** Ceiling on the parent state we'll duplicate, overridable per install. */
const DEFAULT_MAX_STATE_BYTES = 100 * 1024 * 1024;

function maxStateBytes(): number {
  const raw = Number(process.env.FX_FORK_MAX_STATE_BYTES);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_MAX_STATE_BYTES;
}

/** Total size of `dir`, abandoned as soon as it is known to exceed `limit`. */
function dirSize(dir: string, limit: number): number {
  let total = 0;
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop()!;
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile()) total += fs.statSync(full).size;
      if (total > limit) return total;
    }
  }
  return total;
}

/**
 * Copy the parent session's fx state into `newSessionDir`. Returns false when
 * the fork must fall back to the digest — nothing to copy, too large, or the
 * copy failed.
 */
export function cloneFxSessionState(parentSessionDir: string, newSessionDir: string): boolean {
  const src = path.join(parentSessionDir, 'fx-state');
  if (!fs.existsSync(path.join(src, 'sessions'))) return false;

  const dst = path.join(newSessionDir, 'fx-state');
  try {
    const limit = maxStateBytes();
    const size = dirSize(src, limit);
    if (size > limit) {
      log.warn('Fork: fx session state over the snapshot limit; using a history digest', { src, size, limit });
      return false;
    }
    fs.rmSync(dst, { recursive: true, force: true });
    fs.cpSync(src, dst, {
      recursive: true,
      filter: (s) => !fs.lstatSync(s).isSymbolicLink(),
    });
    log.info('Fork: snapshotted fx session state', { bytes: size, dst });
    return true;
    // eslint-disable-next-line no-catch-all/no-catch-all -- any failure here means "no native fork", never a failed fork
  } catch (err) {
    log.warn('Fork: failed to snapshot fx session state', { src, err });
    fs.rmSync(dst, { recursive: true, force: true });
    return false;
  }
}
