/**
 * Cross-origin access control for the file API.
 *
 * A group's public static site is served from its own Pages subdomain
 * (`https://<slug>.<pages-domain>`), a *different origin* from the apex UI
 * that hosts the file API (`https://<apex>/ui/chat/api/...`). They are
 * same-site (shared registrable domain), so the `ui_session` cookie is still
 * sent with `SameSite=Lax`, but the browser blocks the response unless we
 * emit CORS headers.
 *
 * Policy: a page may read/write the files of *its own* group only. The
 * allowed origin is derived from the group id embedded in the request path,
 * so a page on group A's subdomain can never obtain CORS approval for group
 * B's file API — the reflected origin would never match. Credentials are
 * allowed (the write op still enforces admin over the group server-side), and
 * `ETag` is exposed so the optimistic-concurrency flow can read it
 * cross-origin.
 *
 * Only the file read/write endpoints are eligible — chat, admin, approvals,
 * zip, and share-token are deliberately excluded so agent-authored page JS
 * cannot reach them cross-origin.
 */

/** File-API sub-resources eligible for cross-origin access. */
const CORS_FILE_API_RE =
  /^\/api\/groups\/([^/]+)\/(?:files(?:\/.*)?|dirs(?:\/.*)?|write|upload|mkdir|touch|rename|delete)$/;

export interface CorsDecision {
  /** Headers to set on the response (empty when the origin isn't allowed). */
  headers: Record<string, string>;
  /**
   * Present when the request is a preflight that must be answered here
   * (before auth, which a preflight cannot satisfy — it carries no cookie).
   */
  preflight?: { status: number };
}

/**
 * Decide the CORS treatment for a file-API request. Returns null when the
 * path is not a CORS-eligible file endpoint (caller proceeds normally).
 *
 * `resolveAllowedOrigin` maps a group id to the single origin permitted to
 * make cross-origin requests to that group's files (its Pages site origin),
 * or null when the group has no eligible site.
 */
export function decideFileApiCors(
  pathname: string,
  method: string,
  origin: string | undefined,
  resolveAllowedOrigin: (groupId: string) => string | null,
): CorsDecision | null {
  const m = CORS_FILE_API_RE.exec(pathname);
  if (!m) return null;

  const allowed = resolveAllowedOrigin(m[1]);
  const originAllowed = Boolean(origin) && allowed !== null && origin === allowed;

  const headers: Record<string, string> = {};
  if (originAllowed) {
    headers['Access-Control-Allow-Origin'] = origin as string;
    headers['Access-Control-Allow-Credentials'] = 'true';
    headers['Access-Control-Expose-Headers'] = 'ETag';
    headers['Vary'] = 'Origin';
  }

  if (method === 'OPTIONS') {
    if (originAllowed) {
      headers['Access-Control-Allow-Methods'] = 'GET, HEAD, POST, OPTIONS';
      headers['Access-Control-Allow-Headers'] = 'Content-Type, If-Match';
      headers['Access-Control-Max-Age'] = '600';
      return { headers, preflight: { status: 204 } };
    }
    // Preflight from a disallowed origin: fail it (no CORS headers) so the
    // browser blocks the actual request.
    return { headers, preflight: { status: 403 } };
  }

  return { headers };
}
