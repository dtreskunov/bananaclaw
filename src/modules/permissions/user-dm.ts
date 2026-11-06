/**
 * User DM resolution.
 *
 * Exposes one primitive: `ensureUserDm(userId)` returns (or lazily creates)
 * the `messaging_groups` row that the host should deliver to when it wants
 * to DM a given user. Everything that needs to cold-DM a user — approvals,
 * pairing handshakes, host notifications — goes through this function.
 *
 * ## Two-class resolution
 *
 * Channels split cleanly into two classes based on whether the user id is
 * already the DM platform id:
 *
 *   - **Direct-addressable** (Telegram, WhatsApp, iMessage, email, Matrix):
 *     user handle IS the DM chat id. No adapter method needed; we just
 *     mint a messaging_group row with `platform_id = handle`.
 *
 *   - **Resolution-required** (Discord, Slack, Teams, Webex, gChat):
 *     user id and DM channel id are different. The adapter must implement
 *     `openDM(handle)`, which Chat SDK's `chat.openDM` handles for us via
 *     the bridge. The returned channel id becomes the `platform_id`.
 *
 * ## Caching
 *
 * Successful resolutions are persisted in `user_dms (user_id, channel_type
 * → messaging_group_id)`. The cache survives restarts; first-time DMs on a
 * given channel pay one `openDM` round trip, everyone after is a pure DB
 * read.
 *
 * The underlying platform APIs (`POST /users/@me/channels` on Discord,
 * `conversations.open` on Slack, etc.) are idempotent and return the same
 * channel on repeated calls, so re-resolving after a cache miss is always
 * safe — worst case we round-trip redundantly.
 */
import { getChannelAdapter } from '../../channels/channel-registry.js';
import { getMessagingGroup, getMessagingGroupByPlatform, createMessagingGroup } from '../../db/messaging-groups.js';
import { log } from '../../log.js';
import type { MessagingGroup } from '../../types.js';
import { getIdentitiesForUser, getIdentity } from './db/identities.js';
import { getUser } from './db/users.js';
import { getUserDm, upsertUserDm } from './db/user-dms.js';

/**
 * Accept either a canonical UUID user id or a legacy namespaced
 * `channel:handle` form (still emitted by chat-sdk-bridge's formatter for
 * inbound sender ids and forwarded by the agent through MCP tools).
 * Returns the canonical UUID, or null if the user is unknown.
 *
 * Validation is the DB lookup itself: an unknown id never resolves, so
 * callers can trust a non-null return as a verified existing user.
 */
export function resolveUserId(userId: string): string | null {
  // Canonical UUID form: direct hit on users.id.
  if (getUser(userId)) return userId;
  // Namespaced form: split exactly once at the first colon.
  const idx = userId.indexOf(':');
  if (idx <= 0 || idx === userId.length - 1) return null;
  const ident = getIdentity(userId.slice(0, idx), userId.slice(idx + 1));
  return ident ? ident.user_id : null;
}

/**
 * Return a messaging_group usable to DM this user, creating it lazily if
 * needed. Returns null when:
 *   - the user id isn't namespaced (no `kind:handle` prefix)
 *   - the user's channel has no adapter registered
 *   - the channel needs openDM but its adapter doesn't implement it
 *   - openDM throws (platform error, user blocked bot, etc.)
 *
 * Callers should treat null as "this user is unreachable on this channel".
 */
export async function ensureUserDm(userId: string): Promise<MessagingGroup | null> {
  const resolvedId = resolveUserId(userId);
  if (!resolvedId) {
    log.warn('ensureUserDm: user not found', { userId });
    return null;
  }
  const user = getUser(resolvedId)!;

  const parsed = parseUserId(resolvedId);
  if (!parsed) {
    log.warn('ensureUserDm: user has no identity rows', { userId: resolvedId });
    return null;
  }
  const { channelType, handle } = parsed;

  // Cache hit: existing user_dms row → load and return the messaging_group.
  // We refuse to reuse a cached row whose messaging_group looks like an
  // inbound bucket rather than a real DM. On Resend specifically, the
  // 2-part `resend:<alias>` form is the synthetic group the inbound router
  // mints for "anyone who emailed <alias>"; routing outbound through it
  // makes the host send FROM <alias> (often unverified) → Resend silently
  // rejects. A real outbound DM has a 4-part threadId encoded as the
  // platform_id. When the row is stale we drop it and re-resolve.
  const cached = getUserDm(resolvedId, channelType);
  if (cached) {
    const mg = getMessagingGroup(cached.messaging_group_id);
    if (mg && !isStaleDmGroup(mg)) return mg;
    log.warn('ensureUserDm: cached row stale, re-resolving', {
      userId: resolvedId,
      messagingGroupId: cached.messaging_group_id,
      platformId: mg?.platform_id ?? null,
    });
  }

  // Cache miss: resolve the DM platform_id either via openDM or directly.
  const dmPlatformId = await resolveDmPlatformId(channelType, handle);
  if (!dmPlatformId) return null;

  // Find-or-create the underlying messaging_group. A DM we received
  // earlier may already have a row matching (channel_type, platform_id).
  const now = Date.now();
  let mg = getMessagingGroupByPlatform(channelType, dmPlatformId);
  if (!mg) {
    const mgId = `mg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    mg = {
      id: mgId,
      channel_type: channelType,
      platform_id: dmPlatformId,
      name: user.display_name,
      is_group: 0,
      unknown_sender_policy: 'strict',
      created_at: now,
    };
    createMessagingGroup(mg);
    log.info('ensureUserDm: created DM messaging_group', {
      userId: resolvedId,
      channelType,
      messagingGroupId: mgId,
    });
  }

  upsertUserDm({
    user_id: resolvedId,
    channel_type: channelType,
    messaging_group_id: mg.id,
    resolved_at: now,
  });

  return mg;
}

/**
 * Call the adapter's openDM if it has one; otherwise fall through to using
 * the handle directly. Returns null if the adapter is missing entirely.
 *
 * Exported so callers that need to DM an arbitrary handle (e.g. the
 * identity-linking verification flow) can reuse it without having to
 * mint a fake user first.
 */
export async function resolveDmPlatformId(channelType: string, handle: string): Promise<string | null> {
  const adapter = getChannelAdapter(channelType);
  if (!adapter) {
    log.warn('ensureUserDm: no adapter for channel', { channelType });
    return null;
  }
  if (!adapter.openDM) {
    // Direct-addressable channel — handle doubles as the DM chat id.
    return handle;
  }
  try {
    return await adapter.openDM(handle);
  } catch (err) {
    log.error('ensureUserDm: adapter.openDM failed', { channelType, handle, err });
    return null;
  }
}

/**
 * True when a cached messaging_group is unsuitable as an outbound DM target.
 *
 * Resend-specific: the inbound router mints a "bucket" group keyed on
 * `resend:<alias>` for everyone who emails a given alias. That group is
 * fine for inbound routing, but if a `user_dms` row points at it, the
 * outbound deliver path will try to send FROM `<alias>` — which only
 * works if `<alias>` is a verified Resend sender. Real outbound DMs
 * always carry a 4-part threadId (`resend:<alias>:<to>:<hash>`) as
 * platform_id; anything else is a stale legacy mapping.
 */
function isStaleDmGroup(mg: MessagingGroup): boolean {
  if (mg.channel_type === 'resend') {
    // 4-part outbound threadId has at least 3 colons. The inbound bucket
    // form `resend:<alias>` has exactly one. Anything 2-part is stale.
    return mg.platform_id.split(':').length < 4;
  }
  return false;
}

function parseUserId(userId: string): { channelType: string; handle: string } | null {
  // After migration 018, users.id is a UUID and `(channel, handle)` lives in
  // the `identities` table. Pick the user's primary identity (or first one
  // ordered by channel/handle). In a multi-identity future (Phase 4), callers
  // that want a specific channel should pass a channel preference; for now
  // every user has exactly one identity so "first" is unambiguous.
  const identities = getIdentitiesForUser(userId);
  if (identities.length === 0) return null;
  const primary = identities.find((i) => i.primary_for_channel === 1) ?? identities[0];
  return { channelType: primary.channel, handle: primary.handle };
}
