/**
 * Web Push sender — wraps the `web-push` library with our DB-backed
 * subscription store. Payloads are intentionally thin (`{ v, kind, groupId,
 * threadId, msgId, ts }`); the service worker fetches actual content via an
 * authenticated request before calling `showNotification`. This keeps message
 * text out of the push transport, which is end-to-end encrypted to the user
 * agent but otherwise visible to the push service operator's metadata.
 */
import crypto from 'crypto';
import webpush from 'web-push';

import { readEnvFile } from '../../env.js';
import { log } from '../../log.js';
import {
  deleteSubscriptionByEndpoint,
  listSubscriptionsForUser,
  markSubscriptionFailure,
  markSubscriptionSuccess,
} from './db.js';

const MAX_FAILS = 5;

let configuredFor: string | null = null;

function getKeys(): { publicKey: string; privateKey: string; subject: string } | null {
  // Read .env on each call so keys generated at first boot by
  // ensureVapidKeys() take effect without restart. Intentionally NOT
  // copied into process.env — keeps secrets out of child-process envs.
  const env = readEnvFile(['VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY', 'VAPID_SUBJECT']);
  const publicKey = env.VAPID_PUBLIC_KEY || '';
  const privateKey = env.VAPID_PRIVATE_KEY || '';
  if (!publicKey || !privateKey) return null;
  const subject = env.VAPID_SUBJECT || 'mailto:admin@example.invalid';
  return { publicKey, privateKey, subject };
}

function ensureConfigured(): boolean {
  const keys = getKeys();
  if (!keys) return false;
  if (configuredFor !== keys.publicKey) {
    webpush.setVapidDetails(keys.subject, keys.publicKey, keys.privateKey);
    configuredFor = keys.publicKey;
  }
  return true;
}

export function pushAvailable(): boolean {
  return getKeys() !== null;
}

export function vapidPublicKey(): string {
  return getKeys()?.publicKey || '';
}

export interface PushPayload {
  v: 1;
  kind: 'message';
  groupId: string;
  threadId: string;
  msgId: string;
  ts: string;
}

export const PUSH_TTL_SECONDS = 6 * 60 * 60;

export function pushDeliveryOptions(payload: PushPayload): { TTL: number; topic: string } {
  const topic = crypto
    .createHash('sha256')
    .update(`${payload.groupId}\0${payload.threadId}`)
    .digest('base64url')
    .slice(0, 32);
  return { TTL: PUSH_TTL_SECONDS, topic };
}

/**
 * Fire push notifications to all subscriptions registered for `userId`.
 * Fire-and-forget from the caller's perspective — errors are logged and
 * handled per-subscription (delete on permanent, increment fail_count on
 * transient).
 */
export async function sendToUser(userId: string, payload: PushPayload): Promise<void> {
  if (!ensureConfigured()) return;
  const subs = listSubscriptionsForUser(userId);
  if (subs.length === 0) return;
  const body = JSON.stringify(payload);
  await Promise.all(
    subs.map(async (sub) => {
      try {
        await webpush.sendNotification(
          { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
          body,
          pushDeliveryOptions(payload),
        );
        markSubscriptionSuccess(sub.endpoint);
      } catch (err) {
        const status = (err as { statusCode?: number }).statusCode;
        const msg = err instanceof Error ? err.message : String(err);
        if (status === 404 || status === 410) {
          // Subscription gone — drop it.
          deleteSubscriptionByEndpoint(sub.endpoint);
          log.info('push subscription expired, removed', { userId, endpoint: sub.endpoint, status });
          return;
        }
        const fails = markSubscriptionFailure(sub.endpoint, msg);
        if (fails >= MAX_FAILS) {
          deleteSubscriptionByEndpoint(sub.endpoint);
          log.warn('push subscription removed after repeated failures', { userId, endpoint: sub.endpoint, fails });
        } else {
          log.warn('push delivery failed', { userId, endpoint: sub.endpoint, status, err: msg });
        }
      }
    }),
  );
}
