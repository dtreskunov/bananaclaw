/**
 * Reading and rewinding fx's on-disk session state.
 *
 * fx has no fork/branch/rewind call — its ACP surface is new/load/prompt/
 * resume/remove and nothing else — so branching has to go through the files.
 * That is workable because of how `openWritableSession` treats them
 * (src/core/session/session_log.zig, storage_format `event_log_v1`):
 *
 *   - `events.jsonl` is the authority, append-only, one JSON event per line.
 *   - `commit.<log_generation>.json` is the only durable boundary. On open fx
 *     reads it, and **truncates the log back down to it** if the log is longer.
 *   - `session.json` and `checkpoint.json` are caches. Their validity is keyed
 *     on a fingerprint over the log's device+inode+mtime, so after any copy
 *     they are stale by construction and fx rebuilds them by replaying the log.
 *
 * So a branch is: copy the session directory (done host-side, before the
 * container starts), then lower the watermark to the turn being branched at.
 * fx does the truncation and the reprojection itself on the next `session/load`.
 *
 * This is fx's private format, so every entry point validates the pinned
 * schema versions and declines rather than writing anything it does not
 * recognise. The caller then falls back to a plain-text history digest.
 */
import fs from 'fs';
import path from 'path';

/** fx's commit watermark — the six fields it accepts, exactly. */
export interface FxCommitPosition {
  schema_version: number;
  session_id: string;
  log_generation: string;
  through_seq: number;
  through_event_id: string;
  through_event_log_bytes: number;
}

const EVENTS_FILE = 'events.jsonl';
/** In-flight commit/authority swaps. Present only if fx died mid-write. */
const INTENT_FILES = ['commit.pending.json', 'authority.pending.json'];
/** `schema_version` fx writes into, and requires from, the watermark. */
const WATERMARK_SCHEMA_VERSION = 1;
const HEX_ID_RE = /^[0-9a-f]{32}$/;
/** The first event line is a `session_started` record; ~1 KB in practice. */
const FIRST_EVENT_MAX_BYTES = 64 * 1024;

export function fxSessionDir(stateRoot: string, sessionId: string): string {
  return path.join(stateRoot, 'sessions', sessionId);
}

function isCommitPosition(value: unknown): value is FxCommitPosition {
  const p = value as Partial<FxCommitPosition> | null;
  return (
    !!p &&
    p.schema_version === WATERMARK_SCHEMA_VERSION &&
    typeof p.session_id === 'string' &&
    p.session_id.length > 0 &&
    typeof p.log_generation === 'string' &&
    HEX_ID_RE.test(p.log_generation) &&
    typeof p.through_event_id === 'string' &&
    HEX_ID_RE.test(p.through_event_id) &&
    typeof p.through_seq === 'number' &&
    Number.isSafeInteger(p.through_seq) &&
    p.through_seq >= 0 &&
    typeof p.through_event_log_bytes === 'number' &&
    Number.isSafeInteger(p.through_event_log_bytes) &&
    p.through_event_log_bytes >= 0
  );
}

/**
 * The watermark filename carries the log generation, and fx resolves it from
 * the log's *first* event rather than by scanning the directory — generations
 * are random 128-bit ids, so there is no "latest" to pick.
 *
 * Compaction rewrites the log under a fresh generation, so a change in this
 * value across a turn is also how a caller detects that fx compacted.
 */
export function readFxLogGeneration(sessionDir: string): string | null {
  let fd: number | undefined;
  try {
    fd = fs.openSync(path.join(sessionDir, EVENTS_FILE), 'r');
    const buf = Buffer.alloc(FIRST_EVENT_MAX_BYTES);
    fs.readSync(fd, buf, 0, buf.length, 0);
    const nl = buf.indexOf(0x0a);
    if (nl < 0) return null;
    const first = JSON.parse(buf.toString('utf8', 0, nl)) as { log_generation?: unknown };
    return typeof first.log_generation === 'string' && HEX_ID_RE.test(first.log_generation)
      ? first.log_generation
      : null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function watermarkPath(sessionDir: string, generation: string): string {
  return path.join(sessionDir, `commit.${generation}.json`);
}

/** Byte-for-byte the shape fx's own encoder emits: six fields, no newline. */
function encodeWatermark(p: FxCommitPosition): string {
  return JSON.stringify({
    schema_version: p.schema_version,
    session_id: p.session_id,
    log_generation: p.log_generation,
    through_seq: p.through_seq,
    through_event_id: p.through_event_id,
    through_event_log_bytes: p.through_event_log_bytes,
  });
}

/**
 * The session's current commit watermark, or null if it cannot be read in a
 * form we would be willing to write back later.
 */
export function readFxCommitPosition(sessionDir: string): FxCommitPosition | null {
  const generation = readFxLogGeneration(sessionDir);
  if (!generation) return null;
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(watermarkPath(sessionDir, generation), 'utf8'));
    if (!isCommitPosition(parsed) || parsed.log_generation !== generation) return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Point the watermark at an earlier turn. Returns false when the snapshot
 * cannot be branched, which is a normal outcome and never an error:
 *
 *  - **A pending intent file exists.** `openWritableSession` resolves the
 *    intent in preference to the watermark, so our edit would be ignored and
 *    the session would silently open at the wrong turn.
 *  - **The log generation moved.** Compaction rewrites the log under a fresh
 *    generation (at 4096 frames or 128 MB of growth), which invalidates every
 *    earlier seq and byte offset — including the one we captured.
 *  - **The log is shorter than the target.** fx rejects that outright, so
 *    declining here turns a dead session into a digest.
 */
export function rewindFxCommitPosition(sessionDir: string, position: FxCommitPosition): boolean {
  if (!isCommitPosition(position)) return false;

  const current = readFxCommitPosition(sessionDir);
  if (!current) return false;
  if (current.log_generation !== position.log_generation) return false;
  if (current.session_id !== position.session_id) return false;
  if (INTENT_FILES.some((f) => fs.existsSync(path.join(sessionDir, f)))) return false;

  try {
    if (fs.statSync(path.join(sessionDir, EVENTS_FILE)).size < position.through_event_log_bytes) {
      return false;
    }
  } catch {
    return false;
  }

  // Named so it matches none of fx's own file patterns, and renamed into place
  // so a crash mid-write can never leave a half-written watermark behind.
  const target = watermarkPath(sessionDir, position.log_generation);
  const tmp = `${target}.nanoclaw-tmp`;
  try {
    fs.writeFileSync(tmp, encodeWatermark(position));
    fs.renameSync(tmp, target);
    return true;
  } catch {
    fs.rmSync(tmp, { force: true });
    return false;
  }
}
