/**
 * Helpers for per-agent-group static websites.
 *
 * A group with `site_enabled` and a `site_slug` is reachable at
 * `<site_slug>.<PAGES_BASE_DOMAIN>`. The served files live in the workspace
 * folder named exactly like that FQDN: `groups/<folder>/<fqdn>/`. Everything
 * under that folder is public.
 */
import path from 'path';

import { PAGES_BASE_DOMAIN } from '../../../config.js';
import { getAgentGroupBySiteSlug } from '../../../db/agent-groups.js';
import type { AgentGroup } from '../../../types.js';

/** Whether the website feature is configured at all (base domain set). */
export function pagesEnabled(): boolean {
  return PAGES_BASE_DOMAIN.length > 0;
}

export function pagesBaseDomain(): string {
  return PAGES_BASE_DOMAIN;
}

/**
 * Turn an arbitrary group name into a DNS label: lower-case, alphanumerics
 * and hyphens only, collapsed, trimmed to 63 chars, no leading/trailing
 * hyphen. Returns '' if nothing usable remains (caller should fall back).
 */
export function sanitizeSlug(input: string): string {
  return input
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63)
    .replace(/-+$/g, '');
}

/** A valid DNS label is 1–63 chars, [a-z0-9-], no leading/trailing hyphen. */
export function isValidSlug(slug: string): boolean {
  return !slug.startsWith('secure-') && /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(slug);
}

/**
 * Allocate a unique site slug for a group, deriving from its name and
 * appending a numeric suffix if the base is taken by another group. Returns
 * null if the name yields no usable slug (caller should surface an error).
 */
export function allocateSiteSlug(group: Pick<AgentGroup, 'id' | 'name'>): string | null {
  const sanitized = sanitizeSlug(group.name);
  const base = sanitized.startsWith('secure-') ? sanitizeSlug(`site-${sanitized}`) : sanitized;
  if (!base) return null;
  const taken = (slug: string): boolean => {
    const existing = getAgentGroupBySiteSlug(slug);
    return existing !== undefined && existing.id !== group.id;
  };
  if (!taken(base)) return base;
  for (let i = 2; i < 1000; i++) {
    const candidate = sanitizeSlug(`${base}-${i}`);
    if (!taken(candidate)) return candidate;
  }
  return null;
}

/** Full public FQDN for a group, or null if the feature/slug isn't set. */
export function siteFqdn(group: Pick<AgentGroup, 'site_slug'>): string | null {
  if (!pagesEnabled() || !group.site_slug) return null;
  return `${group.site_slug}.${PAGES_BASE_DOMAIN}`;
}

/** Public site URL (`https://<fqdn>/`) for a group, or null. */
export function siteUrl(group: Pick<AgentGroup, 'site_slug'>): string | null {
  const fqdn = siteFqdn(group);
  return fqdn ? `https://${fqdn}/` : null;
}

/**
 * Resolve an incoming Host header to the agent group that should serve it,
 * or null if none applies. Only returns enabled groups. The apex domain and
 * any non-matching subdomain decline (return null) so the request falls back
 * to the normal UI mounts.
 */
export function resolveHostToGroup(hostHeader: string | undefined): { group: AgentGroup; fqdn: string } | null {
  if (!pagesEnabled() || !hostHeader) return null;
  // Strip port and lower-case.
  const host = hostHeader.split(':')[0].trim().toLowerCase();
  const suffix = `.${PAGES_BASE_DOMAIN}`;
  if (!host.endsWith(suffix)) return null;
  const label = host.slice(0, -suffix.length);
  // Must be exactly one label (no nested subdomains, no empty apex).
  if (!label || label.includes('.')) return null;
  const group = getAgentGroupBySiteSlug(label);
  if (!group || !group.site_enabled) return null;
  return { group, fqdn: host };
}

const SITE_MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.cjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.wasm': 'application/wasm',
  '.pdf': 'application/pdf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.eot': 'application/vnd.ms-fontobject',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.flac': 'audio/flac',
  '.weba': 'audio/webm',
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.ogv': 'video/ogg',
};

/**
 * Content type for a served static file. Unknown extensions fall back to
 * application/octet-stream so the browser downloads rather than guesses.
 * Served on a cookieless origin, so HTML executing scripts is expected and
 * safe — full content types (not preview-coerced text/plain) are returned.
 */
export function siteMimeFor(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  return SITE_MIME[ext] || 'application/octet-stream';
}
