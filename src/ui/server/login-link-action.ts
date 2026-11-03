/**
 * Delivery action handler: mint_login_link.
 *
 * Container agent invokes the `request_login_link` MCP tool, which writes
 * a `{action:'mint_login_link', userId, ...}` system message. The host
 * picks it up here, mints a magic link, and DMs the URL to the user via
 * their direct DM channel — never via the originating thread, which may
 * be a group chat where the link would be exposed to everyone.
 */
import { registerDeliveryAction, getDeliveryAdapter } from '../../delivery.js';
import { log } from '../../log.js';
import { ensureUserDm, resolveUserId } from '../../modules/permissions/user-dm.js';
import { issueMagicLink } from './auth.js';
import { isUiEnabled, uiBaseUrl } from './config.js';

registerDeliveryAction('mint_login_link', async (content, session) => {
  const rawUserId = content.userId as string | undefined;
  const originChannelType = (content.channelType as string | undefined) ?? null;
  const originPlatformId = (content.platformId as string | undefined) ?? null;

  if (!rawUserId) {
    log.warn('mint_login_link missing userId', { sessionId: session.id });
    return;
  }

  // Resolve once up front — magic-link tokens, sessions, and user_dms are
  // all keyed on users.id (UUID), never the namespaced form.
  const userId = resolveUserId(rawUserId);
  if (!userId) {
    log.warn('mint_login_link: user not found', { rawUserId, sessionId: session.id });
    return;
  }

  const adapter = getDeliveryAdapter();
  if (!adapter) {
    log.warn('mint_login_link no adapter', { sessionId: session.id });
    return;
  }

  // Always deliver to the user's DM — never the originating thread, which
  // may be a group chat where the link would leak. If DM resolution fails,
  // bail rather than risk leaking the token to a group.
  const dm = await ensureUserDm(userId);
  if (!dm) {
    log.warn('mint_login_link: cannot resolve DM for user', {
      userId,
      originChannelType,
      originPlatformId,
      sessionId: session.id,
    });
    return;
  }
  const targetChannelType = dm.channel_type;
  const targetPlatformId = dm.platform_id;
  const targetThreadId: string | null = null;

  let text: string;
  if (!isUiEnabled()) {
    text = 'Web UI is not enabled on this server.';
  } else {
    const { token } = issueMagicLink(userId);
    const url = `${uiBaseUrl()}/auth/redeem?t=${token}`;
    text = `Here's your one-time login link (valid for 10 minutes):\n\n${url}`;
  }

  try {
    await adapter.deliver(targetChannelType, targetPlatformId, targetThreadId, 'chat', JSON.stringify({ text }));
    log.info('Login link delivered', {
      userId,
      targetChannelType,
      targetPlatformId,
      sessionId: session.id,
    });
  } catch (err) {
    log.error('Failed to deliver login link', { userId, sessionId: session.id, err });
  }
});
