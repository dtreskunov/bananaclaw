/**
 * Delivery action handler: mint_file_link.
 *
 * Container agent invokes the `mint_file_link` MCP tool when it wants to
 * give a user a download URL for a specific file (instead of attaching
 * the bytes inline). The host validates that the recipient has access to
 * the agent group, that the file exists and isn't hidden/admin-restricted,
 * mints a file-bound single-use short-TTL token, and DMs the URL to the
 * user — never to the originating thread, which may be a group chat.
 */
import fs from 'fs';
import path from 'path';

import { GROUPS_DIR } from '../../config.js';
import { getAgentGroup } from '../../db/agent-groups.js';
import { registerDeliveryAction, getDeliveryAdapter } from '../../delivery.js';
import { log } from '../../log.js';
import { canAccessAgentGroup } from '../../modules/permissions/access.js';
import { hasAdminPrivilege } from '../../modules/permissions/db/user-roles.js';
import { ensureUserDm } from '../../modules/permissions/user-dm.js';
import { getIdentitiesForUser } from '../../modules/permissions/db/identities.js';
import { createDownloadToken } from './download-tokens.js';
import { classify, resolveSafe } from './chat/classify.js';
import { isUiEnabled, uiBaseUrl } from './config.js';

const DEFAULT_TTL_MS = 15 * 60 * 1000; // 15 min
const MAX_TTL_MS = 24 * 60 * 60 * 1000; // 24h
const DEFAULT_USES = 1;
const MAX_USES = 5;

registerDeliveryAction('mint_file_link', async (content, session) => {
  const userId = content.userId as string | undefined;
  const relPath = (content.path as string | undefined)?.replace(/^\/+/, '');
  const ttlMsRaw = content.ttlMs as number | undefined;
  const usesRaw = content.uses as number | undefined;
  const originChannelType = (content.channelType as string | undefined) ?? null;
  const originPlatformId = (content.platformId as string | undefined) ?? null;
  const originThreadId = (content.threadId as string | null | undefined) ?? null;

  if (!userId || !relPath) {
    log.warn('mint_file_link missing args', { sessionId: session.id, hasUserId: !!userId, hasPath: !!relPath });
    return;
  }
  if (!isUiEnabled()) {
    log.warn('mint_file_link but UI disabled', { sessionId: session.id });
    return;
  }

  const adapter = getDeliveryAdapter();
  if (!adapter) {
    log.warn('mint_file_link no adapter', { sessionId: session.id });
    return;
  }

  const groupId = session.agent_group_id;
  const group = getAgentGroup(groupId);
  if (!group) {
    log.warn('mint_file_link unknown group', { sessionId: session.id, groupId });
    return;
  }

  // Authorization: recipient must be allowed on this agent group.
  const decision = canAccessAgentGroup(userId, groupId);
  if (!decision.allowed) {
    log.warn('mint_file_link recipient lacks access', { userId, groupId, reason: decision.reason });
    return;
  }

  // Visibility: never link a hidden file; admin-tier requires admin role.
  const cls = classify(relPath);
  if (cls.kind === 'hidden') {
    log.warn('mint_file_link refused hidden path', { userId, groupId, relPath });
    return;
  }
  if (cls.tier === 'admin' && !hasAdminPrivilege(userId, groupId)) {
    log.warn('mint_file_link refused admin-tier for non-admin', { userId, groupId, relPath });
    return;
  }

  // Path safety + existence.
  const groupDir = path.resolve(GROUPS_DIR, group.folder);
  const abs = resolveSafe(groupDir, relPath);
  if (!abs) {
    log.warn('mint_file_link path escapes group dir', { userId, groupId, relPath });
    return;
  }
  let stat: fs.Stats;
  try {
    stat = fs.statSync(abs);
  } catch {
    log.warn('mint_file_link file not found', { userId, groupId, relPath });
    return;
  }
  if (!stat.isFile()) {
    log.warn('mint_file_link not a file', { userId, groupId, relPath });
    return;
  }

  // DM-only delivery, same rule as mint_login_link.
  const dm = await ensureUserDm(userId);
  let targetChannelType: string | null;
  let targetPlatformId: string | null;
  let targetThreadId: string | null;
  if (dm) {
    targetChannelType = dm.channel_type;
    targetPlatformId = dm.platform_id;
    targetThreadId = null;
  } else {
    const isOriginAlreadyUserDm =
      originChannelType !== null &&
      originPlatformId !== null &&
      getIdentitiesForUser(userId).some((i) => i.channel === originChannelType && i.handle === originPlatformId);
    if (!isOriginAlreadyUserDm) {
      log.warn('mint_file_link: cannot resolve DM and origin is not a 1:1 with the user', {
        userId,
        originChannelType,
        originPlatformId,
        sessionId: session.id,
      });
      return;
    }
    targetChannelType = originChannelType;
    targetPlatformId = originPlatformId;
    targetThreadId = originThreadId;
  }

  const ttlMs = Math.min(Math.max(ttlMsRaw ?? DEFAULT_TTL_MS, 60_000), MAX_TTL_MS);
  const uses = Math.min(Math.max(usesRaw ?? DEFAULT_USES, 1), MAX_USES);
  const { token, expiresAt } = createDownloadToken({
    issuerUserId: userId,
    recipientUserId: userId,
    groupId,
    relPath,
    ttlMs,
    uses,
  });
  const url = `${uiBaseUrl()}/files/dl?t=${token}`;

  const minutes = Math.round(ttlMs / 60_000);
  const text =
    `Download link for \`${path.basename(relPath)}\` ` +
    `(valid for ${minutes} min${uses > 1 ? `, ${uses} uses` : ', single use'}):\n\n${url}`;

  try {
    await adapter.deliver(targetChannelType, targetPlatformId, targetThreadId, 'chat', JSON.stringify({ text }));
    log.info('File link delivered', {
      userId,
      groupId,
      relPath,
      targetChannelType,
      targetPlatformId,
      expiresAt,
      uses,
      sessionId: session.id,
    });
  } catch (err) {
    log.error('Failed to deliver file link', { userId, groupId, relPath, sessionId: session.id, err });
  }
});
