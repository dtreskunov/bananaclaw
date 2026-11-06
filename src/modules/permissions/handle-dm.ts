/**
 * DM an arbitrary (channel_type, handle) without going through a user
 * row. Used by the identity-linking verification flow, where the host
 * needs to send a code to a handle that doesn't yet belong to any user.
 *
 * The handle's DM platform_id is resolved the same way `ensureUserDm`
 * does it: openDM(handle) on resolution-required channels, otherwise
 * the handle itself. A `messaging_groups` row is find-or-created so the
 * downstream delivery has somewhere to live; if the user later verifies,
 * `ensureUserDm` will reuse that mg via its find-by-platform lookup.
 *
 * Returns true on a successful deliver, false on any failure (no
 * adapter, openDM throws, delivery throws, no delivery adapter set).
 * Failures are logged at warn/error — caller just gets a boolean.
 */
import { createMessagingGroup, getMessagingGroupByPlatform } from '../../db/messaging-groups.js';
import { getDeliveryAdapter } from '../../delivery.js';
import { log } from '../../log.js';
import { resolveDmPlatformId } from './user-dm.js';

export async function sendHandleDm(channelType: string, handle: string, text: string): Promise<boolean> {
  const dmPlatformId = await resolveDmPlatformId(channelType, handle);
  if (!dmPlatformId) return false;

  // Find-or-create the messaging_group. If a prior DM created it (e.g.
  // an earlier verification attempt to the same handle), reuse it.
  let mg = getMessagingGroupByPlatform(channelType, dmPlatformId);
  if (!mg) {
    const id = `mg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    mg = {
      id,
      channel_type: channelType,
      platform_id: dmPlatformId,
      name: null,
      is_group: 0,
      unknown_sender_policy: 'strict',
      created_at: Date.now(),
    };
    createMessagingGroup(mg);
    log.info('sendHandleDm: created messaging_group for verification DM', {
      channelType,
      handle,
      messagingGroupId: id,
    });
  }

  const adapter = getDeliveryAdapter();
  if (!adapter) {
    log.warn('sendHandleDm: no delivery adapter set', { channelType, handle });
    return false;
  }

  try {
    await adapter.deliver(channelType, mg.platform_id, null, 'chat-sdk', JSON.stringify({ text }));
    return true;
  } catch (err) {
    log.error('sendHandleDm: deliver failed', { channelType, handle, err });
    return false;
  }
}
