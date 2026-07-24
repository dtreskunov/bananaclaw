import crypto from 'crypto';

import { getDb } from '../../db/connection.js';
import { hashToken, lookupSessionByHash } from './db.js';

const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const IDLE_TTL_MS = 30 * 60 * 1000;

interface PrivateWebRow {
  id: string;
  handoff_token_hash: string;
  secure_token_hash: string | null;
  parent_ui_session_hash: string;
  user_id: string;
  agent_group_id: string;
  created_at: string;
  expires_at: string;
  last_used: string | null;
  redeemed_at: string | null;
}

export interface PrivateWebSession {
  id: string;
  parentSessionHash: string;
  userId: string;
  agentGroupId: string;
  expiresAt: string;
  lastUsed: string | null;
}

function toSession(row: PrivateWebRow): PrivateWebSession {
  return {
    id: row.id,
    parentSessionHash: row.parent_ui_session_hash,
    userId: row.user_id,
    agentGroupId: row.agent_group_id,
    expiresAt: row.expires_at,
    lastUsed: row.last_used,
  };
}

function isLive(row: PrivateWebRow, now: number): boolean {
  if (new Date(row.expires_at).getTime() <= now) return false;
  const lastActivity = new Date(row.last_used || row.created_at).getTime();
  return lastActivity + IDLE_TTL_MS > now;
}

export function createPrivateWebSession(args: { parentSessionHash: string; userId: string; agentGroupId: string }): {
  id: string;
  handoffToken: string;
  expiresAt: string;
} {
  const id = crypto.randomBytes(24).toString('hex');
  const handoffToken = crypto.randomBytes(32).toString('base64url');
  const now = new Date();
  const expiresAt = new Date(now.getTime() + SESSION_TTL_MS).toISOString();
  getDb()
    .prepare(
      `INSERT INTO ui_private_web_sessions
         (id, handoff_token_hash, parent_ui_session_hash, user_id, agent_group_id, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      hashToken(handoffToken),
      args.parentSessionHash,
      args.userId,
      args.agentGroupId,
      now.toISOString(),
      expiresAt,
    );
  return { id, handoffToken, expiresAt };
}

export function inspectPrivateWebHandoff(id: string, handoffToken: string): PrivateWebSession | null {
  const row = getDb()
    .prepare('SELECT * FROM ui_private_web_sessions WHERE id = ? AND handoff_token_hash = ?')
    .get(id, hashToken(handoffToken)) as PrivateWebRow | undefined;
  if (!row || row.redeemed_at || !isLive(row, Date.now())) return null;
  if (!lookupSessionByHash(row.parent_ui_session_hash)) return null;
  return toSession(row);
}

export function redeemPrivateWebHandoff(
  id: string,
  handoffToken: string,
): { session: PrivateWebSession; secureToken: string } | null {
  const inspected = inspectPrivateWebHandoff(id, handoffToken);
  if (!inspected) return null;
  const secureToken = crypto.randomBytes(32).toString('base64url');
  const now = new Date().toISOString();
  const result = getDb()
    .prepare(
      `UPDATE ui_private_web_sessions
          SET secure_token_hash = ?, redeemed_at = ?, last_used = ?
        WHERE id = ? AND handoff_token_hash = ? AND redeemed_at IS NULL`,
    )
    .run(hashToken(secureToken), now, now, id, hashToken(handoffToken));
  if (result.changes !== 1) return null;
  return { session: { ...inspected, lastUsed: now }, secureToken };
}

export function lookupPrivateWebSession(id: string, secureToken: string): PrivateWebSession | null {
  const row = getDb()
    .prepare('SELECT * FROM ui_private_web_sessions WHERE id = ? AND secure_token_hash = ?')
    .get(id, hashToken(secureToken)) as PrivateWebRow | undefined;
  if (!row || !row.redeemed_at || !isLive(row, Date.now())) return null;
  const parent = lookupSessionByHash(row.parent_ui_session_hash);
  if (!parent || parent.userId !== row.user_id) return null;
  const now = new Date().toISOString();
  getDb().prepare('UPDATE ui_private_web_sessions SET last_used = ? WHERE id = ?').run(now, id);
  return { ...toSession(row), lastUsed: now };
}

export function purgeExpiredPrivateWebSessions(): void {
  const now = new Date().toISOString();
  getDb().prepare('DELETE FROM ui_private_web_sessions WHERE expires_at < ?').run(now);
}
