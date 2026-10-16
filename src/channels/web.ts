/**
 * Web channel — chat-in-browser side panel of the file browser UI.
 *
 * POST `/send` synthesizes an `InboundEvent` via `submitWebInbound` →
 * `ChannelSetup.onInboundEvent`. The router writes the row into the
 * per-thread session's `inbound.db`; the container processes it and writes
 * to `outbound.db`. Browsers read the conversation stream from the session
 * DBs, so `deliver` only sends push notifications. Shared web rooms use one
 * `group:<agentGroupId>` platform id.
 *
 * No platform identity, no credentials — this adapter is always-on and
 * only enabled when the UI is mounted. Messaging-group rows are
 * auto-provisioned on first use by the chat route handler.
 */
import type { ChannelAdapter, ChannelSetup, InboundEvent, OutboundMessage } from './adapter.js';
import { registerChannelAdapter } from './channel-registry.js';
import { log } from '../log.js';
import { sendToUser as sendPushToUser } from '../modules/push/sender.js';
import { getMembers } from '../modules/permissions/db/agent-group-members.js';
import type { InputHandling } from '../ui/shared/input-state.js';

export const WEB_CHANNEL_TYPE = 'web';

let setupCallbacks: ChannelSetup | null = null;

export function getWebPushRecipientIds(agentGroupId: string): string[] {
  return getMembers(agentGroupId).map((member) => member.user_id);
}

/**
 * Synthesize an inbound chat message from the web UI and inject it into
 * the router via the stored `ChannelSetup` callbacks. Returns the
 * generated message id.
 */
export async function submitWebInbound(args: {
  userId: string;
  senderDisplayName: string;
  platformId: string;
  threadId: string;
  text: string;
  clientMessageId?: string;
  inputHandling?: InputHandling;
  attachments?: { filename: string; contentType?: string; data: string /* base64 */ }[];
}): Promise<string> {
  if (!setupCallbacks) throw new Error('web channel not initialized');
  const id = args.clientMessageId
    ? `web-${args.clientMessageId}`
    : `web-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const contentPayload: Record<string, unknown> = {
    text: args.text,
    sender: args.senderDisplayName,
    senderId: args.userId,
  };
  if (args.inputHandling) contentPayload.inputHandling = args.inputHandling;
  if (args.attachments && args.attachments.length > 0) {
    // Shape matches what `extractAttachmentFiles` / `deriveAttachmentName`
    // expects: `name` (filename), `mimeType`, `data` (base64).
    contentPayload.attachments = args.attachments.map((a) => ({
      name: a.filename,
      mimeType: a.contentType,
      data: a.data,
    }));
  }
  const event: InboundEvent = {
    channelType: WEB_CHANNEL_TYPE,
    platformId: args.platformId,
    threadId: args.threadId,
    message: {
      id,
      kind: 'chat',
      timestamp: new Date().toISOString(),
      isMention: true,
      isGroup: false,
      content: JSON.stringify(contentPayload),
      idempotent: !!args.clientMessageId,
    },
  };
  await setupCallbacks.onInboundEvent(event);
  return id;
}

export function createWebAdapter(): ChannelAdapter {
  const adapter: ChannelAdapter = {
    name: 'web',
    channelType: WEB_CHANNEL_TYPE,
    supportsThreads: true,
    supportsMultiFile: true,

    async setup(config: ChannelSetup): Promise<void> {
      setupCallbacks = config;
      log.info('Web channel ready');
    },

    async teardown(): Promise<void> {
      setupCallbacks = null;
    },

    isConnected(): boolean {
      return setupCallbacks !== null;
    },

    async deliver(platformId, threadId, message: OutboundMessage): Promise<string | undefined> {
      // Shared web rooms notify explicit members. Administrative access alone
      // does not imply interest in every room an owner or global admin can see.
      // The service worker suppresses notifications in focused windows.
      if (
        platformId.startsWith('group:') &&
        threadId &&
        message.id &&
        (message.kind === 'chat' || message.kind === 'text')
      ) {
        const groupId = platformId.slice('group:'.length);
        for (const userId of getWebPushRecipientIds(groupId)) {
          void sendPushToUser(userId, {
            v: 1,
            kind: 'message',
            groupId,
            threadId,
            msgId: message.id,
            ts: new Date().toISOString(),
          }).catch((err) => log.warn('web push send failed', { userId, err }));
        }
      }
      return undefined;
    },
  };
  return adapter;
}

registerChannelAdapter('web', { factory: createWebAdapter });
