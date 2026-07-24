/**
 * Identity claim — moves a verified (channel, handle) identity to a
 * different user, optionally merging the donor user's other state when
 * the donor would otherwise be left unreachable.
 *
 * Trigger: deep-link confirmation. The requester has proved control of
 * the channel (they /start'd the bot from that chat), so we trust them
 * to take ownership of that channel identity over any previous owner.
 *
 * Two paths:
 *
 *   transfer — donor has other identities or oidc_links. We only move
 *              the one identity row. Donor keeps everything else.
 *
 *   merge    — donor would be left with no way to sign in (no
 *              identities AND no oidc_links). We move its roles,
 *              memberships, sessions, etc. onto the target and delete
 *              the donor row. This avoids creating orphan users that
 *              can never log in but still hold roles.
 *
 * Self-claim (target already owns the identity) returns 'noop'.
 */
import { getDb } from '../../db/connection.js';
import { log } from '../../log.js';

export type ClaimOutcome = 'noop' | 'transferred' | 'merged';

export interface ClaimResult {
  outcome: ClaimOutcome;
  donorUserId: string | null;
  /** True iff donor was deleted as part of a merge. */
  donorDeleted: boolean;
}

export function claimIdentity(args: { targetUserId: string; channel: string; handle: string }): ClaimResult {
  const { targetUserId, channel, handle } = args;
  const db = getDb();

  const existing = db
    .prepare('SELECT user_id FROM identities WHERE channel = ? AND handle = ?')
    .get(channel, handle) as { user_id: string } | undefined;

  if (existing && existing.user_id === targetUserId) {
    return { outcome: 'noop', donorUserId: existing.user_id, donorDeleted: false };
  }

  return db.transaction((): ClaimResult => {
    if (!existing) {
      // Fresh insert.
      db.prepare(
        `INSERT INTO identities (user_id, channel, handle, verified_at, primary_for_channel)
         VALUES (?, ?, ?, datetime('now'), 0)`,
      ).run(targetUserId, channel, handle);
      return { outcome: 'transferred', donorUserId: null, donorDeleted: false };
    }

    const donorUserId = existing.user_id;

    // Transfer the identity row itself. primary_for_channel resets — the
    // new user may already have a primary for this channel and we don't
    // want to silently overwrite that.
    db.prepare(
      `UPDATE identities
       SET user_id = ?, primary_for_channel = 0, verified_at = datetime('now')
       WHERE channel = ? AND handle = ?`,
    ).run(targetUserId, channel, handle);

    // Anything left on the donor that lets them sign in?
    const remainingIdentities = (
      db.prepare('SELECT COUNT(*) AS n FROM identities WHERE user_id = ?').get(donorUserId) as { n: number }
    ).n;
    const remainingOidc = (
      db.prepare('SELECT COUNT(*) AS n FROM oidc_links WHERE user_id = ?').get(donorUserId) as { n: number }
    ).n;

    if (remainingIdentities > 0 || remainingOidc > 0) {
      log.info('identity transferred (donor retained)', { donorUserId, targetUserId, channel, handle });
      return { outcome: 'transferred', donorUserId, donorDeleted: false };
    }

    // Donor is orphaned — merge its referenced state onto the target.
    //
    // Tables that reference users(id) without ON DELETE CASCADE — we
    // must hand-move these or the donor delete will fail FK checks:
    //   user_roles, agent_group_members, user_dms,
    //   ui_sessions, ui_magic_links, ui_download_tokens
    //
    // Tables that cascade on user delete — left alone:
    //   identities, oidc_links, identity_link_challenges
    //
    // INSERT OR IGNORE handles primary-key clashes (target already had
    // the same role / membership / DM cache entry).
    db.prepare(
      `INSERT OR IGNORE INTO user_roles (user_id, role, agent_group_id, granted_by, granted_at)
       SELECT ?, role, agent_group_id, granted_by, granted_at FROM user_roles WHERE user_id = ?`,
    ).run(targetUserId, donorUserId);
    db.prepare('DELETE FROM user_roles WHERE user_id = ?').run(donorUserId);

    db.prepare(
      `INSERT OR IGNORE INTO agent_group_members (user_id, agent_group_id, added_by, added_at)
       SELECT ?, agent_group_id, added_by, added_at FROM agent_group_members WHERE user_id = ?`,
    ).run(targetUserId, donorUserId);
    db.prepare('DELETE FROM agent_group_members WHERE user_id = ?').run(donorUserId);

    db.prepare(
      `INSERT OR IGNORE INTO user_dms (user_id, channel_type, messaging_group_id, resolved_at)
       SELECT ?, channel_type, messaging_group_id, resolved_at FROM user_dms WHERE user_id = ?`,
    ).run(targetUserId, donorUserId);
    db.prepare('DELETE FROM user_dms WHERE user_id = ?').run(donorUserId);

    db.prepare('UPDATE ui_sessions SET user_id = ? WHERE user_id = ?').run(targetUserId, donorUserId);
    db.prepare('UPDATE ui_magic_links SET user_id = ? WHERE user_id = ?').run(targetUserId, donorUserId);
    db.prepare('UPDATE ui_private_web_sessions SET user_id = ? WHERE user_id = ?').run(targetUserId, donorUserId);
    db.prepare('UPDATE ui_download_tokens SET issuer_user_id = ? WHERE issuer_user_id = ?').run(
      targetUserId,
      donorUserId,
    );
    db.prepare('UPDATE ui_download_tokens SET recipient_user_id = ? WHERE recipient_user_id = ?').run(
      targetUserId,
      donorUserId,
    );

    // Clear references that block the donor delete. These columns are
    // nullable audit pointers (who granted / who added) — preserving
    // them is nice-to-have but not worth keeping the donor row alive.
    db.prepare('UPDATE user_roles SET granted_by = NULL WHERE granted_by = ?').run(donorUserId);
    db.prepare('UPDATE agent_group_members SET added_by = NULL WHERE added_by = ?').run(donorUserId);

    // Donor row — cascade clears identities/oidc_links/challenges,
    // which are already empty (or only stale challenges) for this user.
    db.prepare('DELETE FROM users WHERE id = ?').run(donorUserId);

    log.info('identity transferred (donor merged)', { donorUserId, targetUserId, channel, handle });
    return { outcome: 'merged', donorUserId, donorDeleted: true };
  })();
}
