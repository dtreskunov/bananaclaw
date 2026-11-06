/**
 * Telegram channel adapter (v2) — uses Chat SDK bridge, with a pairing
 * interceptor wrapped around onInbound to verify chat ownership before
 * registration. See telegram-pairing.ts for the why.
 */
import { createTelegramAdapter } from '@chat-adapter/telegram';

import { readEnvFile } from '../env.js';
import { log } from '../log.js';
import { createMessagingGroup, getMessagingGroupByPlatform, updateMessagingGroup } from '../db/messaging-groups.js';
import { grantRole, hasAnyOwner } from '../modules/permissions/db/user-roles.js';
import { getOrCreateUserByIdentity } from '../modules/permissions/db/identities.js';
import {
  consumeChallenge,
  findActiveDeepLinkChallengeByCode,
  setChallengeHandle,
} from '../modules/permissions/db/identity-link-challenges.js';
import { claimIdentity } from '../modules/permissions/identity-claim.js';
import { registerDeepLinkBuilder } from '../modules/permissions/identity-link-deeplinks.js';
import { createChatSdkBridge, type ReplyContext } from './chat-sdk-bridge.js';
import { sanitizeTelegramLegacyMarkdown } from './telegram-markdown-sanitize.js';
import { registerChannelAdapter } from './channel-registry.js';
import type { ChannelAdapter, ChannelSetup, InboundMessage } from './adapter.js';
import { tryConsume } from './telegram-pairing.js';

/**
 * Retry a one-shot operation that can fail on transient network errors at
 * cold-start (DNS hiccups, brief upstream outages). Exponential backoff capped
 * at 5 attempts — if the network is truly down we surface it instead of
 * hanging the service indefinitely.
 */
async function withRetry<T>(fn: () => Promise<T>, label: string, maxAttempts = 5): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt === maxAttempts) break;
      const delay = Math.min(16000, 1000 * 2 ** (attempt - 1));
      log.warn('Telegram setup failed, retrying', { label, attempt, delayMs: delay, err });
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastErr;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractReplyContext(raw: Record<string, any>): ReplyContext | null {
  if (!raw.reply_to_message) return null;
  const reply = raw.reply_to_message;
  return {
    text: reply.text || reply.caption || '',
    sender: reply.from?.first_name || reply.from?.username || 'Unknown',
  };
}

/** Look up the bot username via Telegram getMe. Cached after first call. */
async function fetchBotUsername(token: string): Promise<string | null> {
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/getMe`);
    const json = (await res.json()) as { ok: boolean; result?: { username?: string } };
    return json.ok ? (json.result?.username ?? null) : null;
  } catch (err) {
    log.warn('Telegram getMe failed', { err });
    return null;
  }
}

function isGroupPlatformId(platformId: string): boolean {
  // platformId is "telegram:<chatId>". Negative chat IDs are groups/channels.
  const id = platformId.split(':').pop() ?? '';
  return id.startsWith('-');
}

interface InboundFields {
  text: string;
  authorUserId: string | null;
}

function readInboundFields(message: InboundMessage): InboundFields {
  if (message.kind !== 'chat-sdk' || !message.content || typeof message.content !== 'object') {
    return { text: '', authorUserId: null };
  }
  const c = message.content as { text?: string; author?: { userId?: string } };
  return { text: c.text ?? '', authorUserId: c.author?.userId ?? null };
}

/**
 * Build an onInbound interceptor that consumes pairing codes before they
 * reach the router. On match: records the chat + its paired user, promotes
 * the user to owner if the instance has no owner yet, and short-circuits.
 * On miss: forwards to the host.
 */
/**
 * Send a one-shot confirmation back to the paired chat. Best-effort — failures
 * are logged but never propagated, so a Telegram outage can't undo a successful
 * pairing or trigger the interceptor's fail-open path.
 */
async function sendPairingConfirmation(token: string, platformId: string): Promise<void> {
  const chatId = platformId.split(':').slice(1).join(':');
  if (!chatId) return;
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: 'Pairing success! Head back to the NanoClaw installer to finish setup.',
      }),
    });
    if (!res.ok) {
      log.warn('Telegram pairing confirmation non-OK', { status: res.status });
    }
  } catch (err) {
    log.warn('Telegram pairing confirmation failed', { err });
  }
}

function createPairingInterceptor(
  botUsernamePromise: Promise<string | null>,
  hostOnInbound: ChannelSetup['onInbound'],
  token: string,
): ChannelSetup['onInbound'] {
  return async (platformId, threadId, message) => {
    try {
      const botUsername = await botUsernamePromise;
      if (!botUsername) {
        hostOnInbound(platformId, threadId, message);
        return;
      }
      const { text, authorUserId } = readInboundFields(message);
      if (!text) {
        hostOnInbound(platformId, threadId, message);
        return;
      }
      const consumed = await tryConsume({
        text,
        botUsername,
        platformId,
        isGroup: isGroupPlatformId(platformId),
        adminUserId: authorUserId,
      });
      if (!consumed) {
        hostOnInbound(platformId, threadId, message);
        return;
      }
      // Pairing matched — record the chat and short-circuit so the
      // code-bearing message never reaches an agent. Privilege is now a
      // property of the paired user, not the chat: upsert the user, and if
      // this instance has no owner yet, promote them to owner.
      const existing = getMessagingGroupByPlatform('telegram', platformId);
      if (existing) {
        updateMessagingGroup(existing.id, {
          is_group: consumed.consumed!.isGroup ? 1 : 0,
        });
      } else {
        createMessagingGroup({
          id: `mg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          channel_type: 'telegram',
          platform_id: platformId,
          name: consumed.consumed!.name,
          is_group: consumed.consumed!.isGroup ? 1 : 0,
          unknown_sender_policy: 'strict',
          created_at: Date.now(),
        });
      }

      const pairedUserId = getOrCreateUserByIdentity({
        channel: 'telegram',
        handle: String(consumed.consumed!.adminUserId),
      });

      let promotedToOwner = false;
      if (!hasAnyOwner()) {
        grantRole({
          user_id: pairedUserId,
          role: 'owner',
          agent_group_id: null,
          granted_by: null,
          granted_at: Date.now(),
        });
        promotedToOwner = true;
      }

      log.info('Telegram pairing accepted — chat registered', {
        platformId,
        pairedUser: pairedUserId,
        promotedToOwner,
        intent: consumed.intent,
      });

      await sendPairingConfirmation(token, platformId);
    } catch (err) {
      log.error('Telegram pairing interceptor error', { err });
      // Fail open: pass through so a pairing bug doesn't break normal traffic.
      hostOnInbound(platformId, threadId, message);
    }
  };
}

/**
 * Send a one-shot reply to a chat. Best-effort: failures don't roll back
 * the identity link, since the DB write already happened.
 */
async function sendChatReply(token: string, platformId: string, text: string): Promise<void> {
  const chatId = platformId.split(':').slice(1).join(':');
  if (!chatId) return;
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text }),
    });
    if (!res.ok) log.warn('Telegram chat reply non-OK', { status: res.status });
  } catch (err) {
    log.warn('Telegram chat reply failed', { err });
  }
}

/**
 * Intercept `/start link-<token>` deep-link payloads before they reach
 * the router. On match: claim the challenge for the user who initiated
 * it, insert a (telegram, chat_id) identity, and reply confirmation.
 * Only valid in 1:1 chats — group `/start` payloads are ignored.
 */
function createIdentityLinkInterceptor(
  hostOnInbound: ChannelSetup['onInbound'],
  token: string,
): ChannelSetup['onInbound'] {
  return async (platformId, threadId, message) => {
    try {
      if (isGroupPlatformId(platformId)) return hostOnInbound(platformId, threadId, message);
      const { text, authorUserId } = readInboundFields(message);
      const m = text?.match(/^\/start\s+link-([A-Za-z0-9]+)\s*$/);
      if (!m || !authorUserId) return hostOnInbound(platformId, threadId, message);
      const linkToken = m[1];
      const challenge = findActiveDeepLinkChallengeByCode('telegram', linkToken);
      if (!challenge) {
        await sendChatReply(
          token,
          platformId,
          'That link is invalid or has expired. Generate a new one from NanoClaw settings.',
        );
        return;
      }
      const handle = String(authorUserId);
      let result;
      try {
        result = claimIdentity({ targetUserId: challenge.user_id, channel: 'telegram', handle });
      } catch (err) {
        log.warn('identity deep-link claim failed', {
          challengeId: challenge.id,
          err: (err as Error).message,
        });
        consumeChallenge(challenge.id);
        await sendChatReply(token, platformId, 'Could not link this Telegram account. Please try again.');
        return;
      }
      setChallengeHandle(challenge.id, handle);
      consumeChallenge(challenge.id);
      log.info('identity linked via deep link', {
        userId: challenge.user_id,
        channel: 'telegram',
        handle,
        outcome: result.outcome,
        donorUserId: result.donorUserId,
      });
      const replyText =
        result.outcome === 'merged'
          ? 'Linked! This Telegram account was previously connected to another NanoClaw user; that account has been merged into yours.'
          : result.outcome === 'transferred' && result.donorUserId
            ? 'Linked! This Telegram account was reassigned from a different NanoClaw user to you.'
            : 'Linked! Your Telegram account is now connected to NanoClaw.';
      await sendChatReply(token, platformId, replyText);
    } catch (err) {
      log.error('Telegram identity-link interceptor error', { err });
      hostOnInbound(platformId, threadId, message);
    }
  };
}

registerChannelAdapter('telegram', {
  factory: () => {
    const env = readEnvFile(['TELEGRAM_BOT_TOKEN']);
    if (!env.TELEGRAM_BOT_TOKEN) return null;
    const token = env.TELEGRAM_BOT_TOKEN;
    const telegramAdapter = createTelegramAdapter({
      botToken: token,
      mode: 'polling',
    });
    const bridge = createChatSdkBridge({
      adapter: telegramAdapter,
      concurrency: 'concurrent',
      extractReplyContext,
      supportsThreads: false,
      transformOutboundText: sanitizeTelegramLegacyMarkdown,
      maxTextLength: 4000,
    });

    const botUsernamePromise = fetchBotUsername(token);

    // Make this adapter discoverable to the settings UI as a deep-link
    // channel. The builder embeds the bot username so the URL points at
    // *this* bot — there can be many Telegram bots on the same instance.
    registerDeepLinkBuilder('telegram', async (linkToken) => {
      const u = await botUsernamePromise;
      return u ? `https://t.me/${u}?start=link-${linkToken}` : null;
    });

    const wrapped: ChannelAdapter = {
      ...bridge,
      resolveChannelName: async (platformId: string) => {
        const chatId = platformId.split(':').slice(1).join(':');
        if (!chatId) return null;
        try {
          const res = await fetch(`https://api.telegram.org/bot${token}/getChat`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ chat_id: chatId }),
          });
          const data = (await res.json()) as { ok?: boolean; result?: { title?: string } };
          return data.ok ? (data.result?.title ?? null) : null;
        } catch {
          return null;
        }
      },
      async setup(hostConfig: ChannelSetup) {
        // Compose: identity-link → pairing → host. Identity link runs
        // first so a deep-link `/start link-<token>` is never confused
        // with a pairing code.
        const pairing = createPairingInterceptor(botUsernamePromise, hostConfig.onInbound, token);
        const intercepted: ChannelSetup = {
          ...hostConfig,
          onInbound: createIdentityLinkInterceptor(pairing, token),
        };
        return withRetry(() => bridge.setup(intercepted), 'bridge.setup');
      },
    };
    return wrapped;
  },
});
