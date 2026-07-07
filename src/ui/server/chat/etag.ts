/**
 * File version tokens (ETags) for optimistic-concurrency on the file API.
 *
 * A strong validator derived from the file's size and mtime. Read/meta
 * endpoints expose it; the `write` and `upload` (overwrite) endpoints accept
 * it as an `If-Match` precondition so a client can only overwrite the exact
 * version it last read. Any intervening change (agent, another admin, a
 * concurrent tab) shifts the ETag and the write is rejected with 412.
 *
 * Format: a quoted 16-hex-char sha256 prefix over `<size>:<mtimeMs>`. Quoted,
 * no `W/` prefix — a strong validator per RFC 7232.
 */
import crypto from 'crypto';
import type fs from 'fs';

/** Compute the strong ETag for a stat'd file. */
export function fileEtag(stat: Pick<fs.Stats, 'size' | 'mtimeMs'>): string {
  const h = crypto
    .createHash('sha256')
    .update(`${stat.size}:${Math.floor(stat.mtimeMs)}`)
    .digest('hex')
    .slice(0, 16);
  return `"${h}"`;
}

/**
 * Parse an `If-Match` header value into the list of ETags it carries.
 * Supports a single tag, a comma-separated list, and `*` (any).
 * Returns `'*'` for the wildcard, or an array of quoted tags.
 */
export function parseIfMatch(header: string | string[] | undefined): '*' | string[] | null {
  if (header == null) return null;
  const raw = Array.isArray(header) ? header.join(',') : header;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (trimmed === '*') return '*';
  return trimmed
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Strip an optional `W/` weak-validator prefix from an ETag.
 *
 * Our validators are always strong (see `fileEtag`), but a reverse proxy that
 * compresses responses may downgrade the `ETag` it forwards to the weak form
 * (`W/"…"`) per RFC 7232 §2.1. A browser then echoes that weak value back in
 * `If-Match`, so we must compare ignoring the prefix or every write behind such
 * a proxy fails with a spurious 412.
 */
function stripWeak(tag: string): string {
  return tag.startsWith('W/') ? tag.slice(2) : tag;
}

/**
 * Evaluate an `If-Match` precondition against the current ETag.
 * - no header → not requested (caller decides default behavior)
 * - `*` → matches iff the resource exists (current non-null)
 * - list → matches iff one entry equals the current ETag
 *
 * Comparison ignores the `W/` weak prefix on either side (see `stripWeak`).
 */
export function ifMatchSatisfied(header: string | string[] | undefined, current: string | null): boolean | null {
  const parsed = parseIfMatch(header);
  if (parsed == null) return null; // no precondition supplied
  if (parsed === '*') return current != null;
  if (current == null) return false;
  const cur = stripWeak(current);
  return parsed.some((tag) => stripWeak(tag) === cur);
}
