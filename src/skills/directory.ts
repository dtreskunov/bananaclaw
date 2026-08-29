/**
 * skills.sh — the public Agent Skills directory. Used for two things only:
 * finding skills, and reading third-party security audits of them.
 *
 * We never install from here. skills.sh is a *directory*; git stays the source
 * of truth, so an install still goes through the catalog clone in
 * `marketplace.ts` and keeps its repo/ref/commit/digest provenance. A search
 * hit contributes exactly one fact: the GitHub `owner/repo` to add as a catalog.
 *
 * Auth: the documented `/api/v1/*` endpoints want a Vercel OIDC bearer token,
 * which a self-hosted install has no ambient way to mint. We use it when the
 * operator supplies one and otherwise fall back to the site's own unversioned
 * `/api/search`, which answers unauthenticated but reports itself as "legacy" —
 * so treat every response here as best-effort and never let a failure block an
 * install the operator already chose.
 */
import { readEnvFile } from '../env.js';
import { log } from '../log.js';

const BASE_URL = 'https://skills.sh';
const REQUEST_TIMEOUT_MS = 10_000;
const SEARCH_TTL_MS = 5 * 60 * 1000;
const AUDIT_TTL_MS = 30 * 60 * 1000;
const MAX_RESULTS = 60;

export interface DirectorySkill {
  /** `<source>/<slug>` — the id skills.sh uses for detail and audit lookups. */
  id: string;
  slug: string;
  name: string;
  /** GitHub `owner/repo`, which is what our catalog installer consumes. */
  source: string;
  installs: number | null;
  url: string | null;
}

export interface DirectorySearchResult {
  query: string;
  /** "fuzzy" for single-word queries, "semantic" for multi-word. */
  searchType: string | null;
  /** Whether the documented v1 endpoint answered, vs. the legacy fallback. */
  authenticated: boolean;
  skills: DirectorySkill[];
}

export interface AuditEntry {
  provider: string;
  slug: string;
  /** Normalized verdict: "pass" | "warn" | "fail". */
  status: string;
  summary: string;
  auditedAt: string | null;
  riskLevel: string | null;
  categories: string[];
}

export class DirectoryError extends Error {}

/** Risk labels we refuse to install past without an explicit acknowledgement. */
const BLOCKING_RISK_LEVELS = new Set(['HIGH', 'CRITICAL']);

export function auditIsBlocking(audits: AuditEntry[]): boolean {
  return audits.some(
    (audit) => audit.status === 'fail' || BLOCKING_RISK_LEVELS.has((audit.riskLevel ?? '').toUpperCase()),
  );
}

function directoryToken(): string | undefined {
  const names = ['SKILLS_SH_TOKEN', 'VERCEL_OIDC_TOKEN'];
  const fileEnv = readEnvFile(names);
  for (const name of names) {
    const value = process.env[name] ?? fileEnv[name];
    if (value && value.trim() !== '') return value.trim();
  }
  return undefined;
}

interface CacheEntry<T> {
  at: number;
  value: T;
}

const searchCache = new Map<string, CacheEntry<DirectorySearchResult>>();
const auditCache = new Map<string, CacheEntry<AuditEntry[] | null>>();

function cached<T>(store: Map<string, CacheEntry<T>>, key: string, ttl: number): T | undefined {
  const hit = store.get(key);
  if (!hit) return undefined;
  if (Date.now() - hit.at > ttl) {
    store.delete(key);
    return undefined;
  }
  return hit.value;
}

async function getJson(path: string, token: string | undefined): Promise<{ status: number; body: unknown }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(`${BASE_URL}${path}`, {
      signal: controller.signal,
      headers: {
        accept: 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
    });
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    return { status: res.status, body };
  } finally {
    clearTimeout(timer);
  }
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

/**
 * Both endpoints return the same skill concept under different key names —
 * v1 uses `slug`/`url`, the legacy one uses `skillId` and omits the url.
 */
function normalizeSkill(raw: unknown): DirectorySkill | null {
  if (!raw || typeof raw !== 'object') return null;
  const item = raw as Record<string, unknown>;
  const source = str(item.source);
  const slug = str(item.slug) ?? str(item.skillId);
  if (!source || !slug) return null;
  return {
    id: str(item.id) ?? `${source}/${slug}`,
    slug,
    name: str(item.name) ?? slug,
    source,
    installs: typeof item.installs === 'number' ? item.installs : null,
    url: str(item.url),
  };
}

function normalizeSkills(list: unknown): DirectorySkill[] {
  if (!Array.isArray(list)) return [];
  const out: DirectorySkill[] = [];
  for (const raw of list) {
    const skill = normalizeSkill(raw);
    if (skill) out.push(skill);
    if (out.length >= MAX_RESULTS) break;
  }
  return out;
}

/**
 * Search the directory. Prefers the documented v1 endpoint when a token is
 * configured and silently falls back to the legacy one on 401/404 so a stale
 * or missing token degrades instead of breaking discovery.
 */
export async function searchDirectory(query: string): Promise<DirectorySearchResult> {
  const q = query.trim();
  if (q.length < 2) throw new DirectoryError('search query must be at least 2 characters');

  const hit = cached(searchCache, q.toLowerCase(), SEARCH_TTL_MS);
  if (hit) return hit;

  const token = directoryToken();
  const encoded = encodeURIComponent(q);
  let result: DirectorySearchResult | null = null;

  if (token) {
    try {
      const res = await getJson(`/api/v1/skills/search?q=${encoded}&limit=${MAX_RESULTS}`, token);
      if (res.status === 200 && res.body && typeof res.body === 'object') {
        const body = res.body as Record<string, unknown>;
        result = {
          query: q,
          searchType: str(body.searchType),
          authenticated: true,
          skills: normalizeSkills(body.data),
        };
      } else if (res.status !== 401 && res.status !== 404) {
        throw new DirectoryError(`skills.sh returned ${res.status}`);
      }
    } catch (err) {
      if (err instanceof DirectoryError) throw err;
      log.warn('skills.sh v1 search failed; falling back to the legacy endpoint', { err });
    }
  }

  if (!result) {
    const res = await getJson(`/api/search?q=${encoded}`, undefined);
    if (res.status !== 200 || !res.body || typeof res.body !== 'object') {
      throw new DirectoryError(`skills.sh search unavailable (HTTP ${res.status})`);
    }
    const body = res.body as Record<string, unknown>;
    result = {
      query: q,
      searchType: str(body.searchType),
      authenticated: false,
      skills: normalizeSkills(body.skills),
    };
  }

  searchCache.set(q.toLowerCase(), { at: Date.now(), value: result });
  return result;
}

function normalizeAudits(list: unknown): AuditEntry[] {
  if (!Array.isArray(list)) return [];
  const out: AuditEntry[] = [];
  for (const raw of list) {
    if (!raw || typeof raw !== 'object') continue;
    const item = raw as Record<string, unknown>;
    const provider = str(item.provider);
    if (!provider) continue;
    out.push({
      provider,
      slug: str(item.slug) ?? provider.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
      status: (str(item.status) ?? 'unknown').toLowerCase(),
      summary: str(item.summary) ?? '',
      auditedAt: str(item.auditedAt),
      riskLevel: str(item.riskLevel),
      categories: Array.isArray(item.categories)
        ? item.categories.filter((c): c is string => typeof c === 'string')
        : [],
    });
  }
  return out;
}

/**
 * Third-party security audits for one skill. Returns null when nobody has
 * audited it (404) or the directory is unreachable — callers must treat null
 * as "unknown", never as "safe" and never as a hard failure.
 */
export async function fetchAudits(source: string, slug: string): Promise<AuditEntry[] | null> {
  const id = `${source}/${slug}`;
  const hit = cached(auditCache, id, AUDIT_TTL_MS);
  if (hit !== undefined) return hit;

  let audits: AuditEntry[] | null = null;
  try {
    const path = `/api/v1/skills/audit/${id.split('/').map(encodeURIComponent).join('/')}`;
    const res = await getJson(path, directoryToken());
    if (res.status === 200 && res.body && typeof res.body === 'object') {
      audits = normalizeAudits((res.body as Record<string, unknown>).audits);
    }
  } catch (err) {
    log.warn('skills.sh audit lookup failed', { id, err });
  }

  auditCache.set(id, { at: Date.now(), value: audits });
  return audits;
}
