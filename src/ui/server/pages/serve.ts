/**
 * Per-agent-group static website serving.
 *
 * Registered as a host handler on the shared HTTP server. When the request's
 * Host header maps to an enabled group's site FQDN, files are served from
 * `groups/<folder>/<fqdn>/` fully public. Otherwise the handler declines so
 * the request falls through to the normal UI mounts.
 */
import http from 'http';
import path from 'path';

import { GROUPS_DIR } from '../../../config.js';
import { log } from '../../../log.js';
import { registerHostHandler } from '../../../webhook-server.js';
import { pagesEnabled, resolveHostToGroup } from './site.js';
import { serveWebRoot } from './web-root.js';

// Mirror the chat file route's ceiling so a runaway file can't be streamed
// unbounded over the public origin.
const MAX_SITE_BYTES = 100 * 1024 * 1024; // 100 MB

/**
 * Host handler: returns true if it handled (served or rejected) a request
 * destined for a group website, false to decline.
 */
export function handlePagesRequest(req: http.IncomingMessage, res: http.ServerResponse): boolean {
  if (!pagesEnabled()) return false;
  const match = resolveHostToGroup(req.headers.host);
  if (!match) return false;

  const { group, fqdn } = match;
  serveWebRoot(req, res, {
    filesystemRoot: path.resolve(GROUPS_DIR, group.folder, fqdn),
    cacheControl: 'public, max-age=60',
    maxFileBytes: MAX_SITE_BYTES,
    capabilities: new Set(['read']),
  });
  return true;
}

let registered = false;

/** Idempotently register the website host handler on the shared server. */
export function registerPagesHostHandler(): void {
  if (registered) return;
  if (!pagesEnabled()) {
    log.info('Static website feature disabled (set PAGES_BASE_DOMAIN to enable)');
    return;
  }
  registerHostHandler(handlePagesRequest);
  registered = true;
  log.info('Static website host handler registered');
}
