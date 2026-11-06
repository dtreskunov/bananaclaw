/**
 * OIDC link CRUD. Each row binds an OIDC subject (provider + sub) to one
 * of our users. PK is (provider, sub) — the sub claim is the stable
 * per-account identifier; email is denormalized for audit and fallback
 * lookup but is NOT the matching key.
 */
import { getDb } from '../../../db/connection.js';

export interface OidcLink {
  provider: string;
  sub: string;
  user_id: string;
  email: string | null;
  claims_json: string | null;
  linked_at: number;
  last_seen_at: number | null;
}

export function getOidcLink(provider: string, sub: string): OidcLink | undefined {
  return getDb().prepare('SELECT * FROM oidc_links WHERE provider = ? AND sub = ?').get(provider, sub) as
    | OidcLink
    | undefined;
}

export function getOidcLinksForUser(userId: string): OidcLink[] {
  return getDb().prepare('SELECT * FROM oidc_links WHERE user_id = ? ORDER BY linked_at').all(userId) as OidcLink[];
}

export function insertOidcLink(args: {
  provider: string;
  sub: string;
  user_id: string;
  email: string | null;
  claims: Record<string, unknown> | null;
}): void {
  getDb()
    .prepare(
      `INSERT INTO oidc_links (provider, sub, user_id, email, claims_json, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      args.provider,
      args.sub,
      args.user_id,
      args.email,
      args.claims ? JSON.stringify(args.claims) : null,
      Date.now(),
    );
}

export function touchOidcLink(provider: string, sub: string, claims: Record<string, unknown> | null): void {
  getDb()
    .prepare(
      `UPDATE oidc_links
       SET last_seen_at = ?,
           claims_json = COALESCE(?, claims_json)
       WHERE provider = ? AND sub = ?`,
    )
    .run(Date.now(), claims ? JSON.stringify(claims) : null, provider, sub);
}
