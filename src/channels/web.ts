/**
 * Web channel — chat-in-browser side panel of the file browser UI.
 *
 * Each browser tab opens a fresh thread on page load (UUID minted server-side
 * via `POST /ui/chat/api/groups/<groupId>/chat/start`) and connects a
 * WebSocket. POST `/send` synthesizes an `InboundEvent` via
 * `submitWebInbound` → `ChannelSetup.onInboundEvent`. The router writes the
 * row into the per-thread session's `inbound.db`; the container processes
 * it and writes to `outbound.db`; the host delivery loop calls back into
 * this adapter's `deliver`, which republishes to live WS subscribers.
 *
 * Pub/sub key: `${platformId}::${threadId}`. The platformId carries the
 * userId so two users on the same agent group don't cross-publish.
 *
 * No platform identity, no credentials — this adapter is always-on and
 * only enabled when the UI is mounted. Messaging-group rows are
 * auto-provisioned on first use by the chat route handler.
 */
import type {
  ActivityLine,
  ChannelAdapter,
  ChannelSetup,
  InboundEvent,
  OutboundMessage,
  TypingMetadata,
} from './adapter.js';
import { registerChannelAdapter } from './channel-registry.js';
import { log } from '../log.js';
import { sendToUser as sendPushToUser } from '../modules/push/sender.js';
import { onTaskRun as onTaskRunNotice, type TaskRunNotice } from '../task-events.js';

export const WEB_CHANNEL_TYPE = 'web';

/** A scheduled task firing — a completed `kind='task'` row in this session. */
export interface WebTaskRunEvent {
  /** messages_in.id of the completed task row (client dedup key). */
  id: string;
  /** ISO timestamp the run was due (process_after, falling back to the row
   *  creation timestamp for legacy rows). */
  timestamp: string;
  /** Raw task content JSON (`{ prompt, script }`) for summary derivation. */
  content: string;
  /** Cron expression when recurring; null for a one-off. */
  recurrence: string | null;
  /** series_id grouping recurring occurrences (null for legacy one-offs). */
  seriesId: string | null;
}

/** A live subscriber — typically a WebSocket connection. */
export interface WebSubscriber {
  /** Called with each outbound row delivered for this (platformId, threadId). */
  onOutbound(message: OutboundMessage): void;
  /** Called with the user's own inbound right after it's accepted. `id` is the
   *  messages_in.id we just wrote — clients use it as the dedup key. */
  onInboundEcho(id: string, text: string, files?: { filename: string; size: number }[]): void;
  /** Called when the typing indicator should turn on or off. The web channel
   *  uses explicit start/stop signals (no client-side timeout). `hint` is
   *  an optional one-line progress string from the container. When present,
   *  `items` is the complete host-reduced activity snapshot for this turn. */
  onTyping?(on: boolean, hint?: string, items?: ActivityLine[], metadata?: TypingMetadata): void;
  /** Called when a scheduled task fires (a task row transitions to
   *  `completed`), so the client can drop a timeline event without a reload. */
  onTaskRun?(event: WebTaskRunEvent): void;
}

let setupCallbacks: ChannelSetup | null = null;
const subscribers = new Map<string, Set<WebSubscriber>>();
let unsubscribeTaskRun: (() => void) | null = null;

function subKey(platformId: string, threadId: string | null): string {
  return `${platformId}::${threadId ?? ''}`;
}

/**
 * Fan a scheduled-task firing out to any live subscribers on this session.
 * No-op when no tab is attached (history backfills on reload).
 *
 * DM task rows store `thread_id = NULL`, but the DM socket subscribes under a
 * synthetic `__dm:` thread key, so a null threadId fans out to every DM
 * subscriber on this platform.
 */
function fanOutTaskRun(platformId: string, threadId: string | null, event: WebTaskRunEvent): void {
  const deliver = (set: Set<WebSubscriber> | undefined): void => {
    if (!set) return;
    for (const sub of set) {
      try {
        sub.onTaskRun?.(event);
      } catch (err) {
        log.warn('web subscriber onTaskRun threw', { err });
      }
    }
  };
  if (threadId) {
    deliver(subscribers.get(subKey(platformId, threadId)));
    return;
  }
  const dmPrefix = `${platformId}::__dm:`;
  for (const [key, set] of subscribers) {
    if (key.startsWith(dmPrefix)) deliver(set);
  }
}

/** Subscribe to the core task-run bus, filtering to web task rows. */
function handleTaskRunNotice(notice: TaskRunNotice): void {
  if (notice.channelType !== WEB_CHANNEL_TYPE) return;
  fanOutTaskRun(notice.platformId, notice.threadId, {
    id: notice.id,
    timestamp: notice.timestamp,
    content: notice.content,
    recurrence: notice.recurrence,
    seriesId: notice.seriesId,
  });
}

/** Register a subscriber for live messages on this (platformId, threadId). */
export function subscribeWeb(platformId: string, threadId: string | null, sub: WebSubscriber): () => void {
  const key = subKey(platformId, threadId);
  let set = subscribers.get(key);
  if (!set) {
    set = new Set();
    subscribers.set(key, set);
  }
  set.add(sub);
  return () => {
    const s = subscribers.get(key);
    if (!s) return;
    s.delete(sub);
    if (s.size === 0) subscribers.delete(key);
  };
}

/**
 * Synthesize an inbound chat message from the web UI and inject it into
 * the router via the stored `ChannelSetup` callbacks. Returns the
 * generated message id.
 */
export async function submitWebInbound(args: {
  userId: string;
  platformId: string;
  threadId: string;
  text: string;
  clientMessageId?: string;
  attachments?: { filename: string; contentType?: string; data: string /* base64 */; size: number }[];
}): Promise<string> {
  if (!setupCallbacks) throw new Error('web channel not initialized');
  const id = args.clientMessageId
    ? `web-${args.clientMessageId}`
    : `web-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const contentPayload: Record<string, unknown> = {
    text: args.text,
    sender: args.userId,
    senderId: args.userId,
  };
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
  // Echo to local subscribers immediately so the sending tab sees its own
  // message even if the router/container path is slow.
  const echoSet = subscribers.get(subKey(args.platformId, args.threadId));
  if (echoSet) {
    const echoFiles = args.attachments?.map((a) => ({ filename: a.filename, size: a.size }));
    for (const sub of echoSet) {
      try {
        sub.onInboundEcho(id, args.text, echoFiles);
      } catch (err) {
        log.warn('web subscriber onInboundEcho threw', { err });
      }
    }
  }
  await setupCallbacks.onInboundEvent(event);
  return id;
}

function createAdapter(): ChannelAdapter {
  const adapter: ChannelAdapter = {
    name: 'web',
    channelType: WEB_CHANNEL_TYPE,
    supportsThreads: true,
    supportsMultiFile: true,

    async setup(config: ChannelSetup): Promise<void> {
      setupCallbacks = config;
      unsubscribeTaskRun?.();
      unsubscribeTaskRun = onTaskRunNotice(handleTaskRunNotice);
      log.info('Web channel ready');
    },

    async teardown(): Promise<void> {
      setupCallbacks = null;
      unsubscribeTaskRun?.();
      unsubscribeTaskRun = null;
      subscribers.clear();
    },

    isConnected(): boolean {
      return setupCallbacks !== null;
    },

    async deliver(platformId, threadId, message: OutboundMessage): Promise<string | undefined> {
      // Fire a push to the owning user regardless of whether a live tab is
      // attached — service worker dedupes against focused windows. Thin
      // payload only; the SW fetches text via an authenticated request.
      // platformId format: `${userId}#${agentGroupId}` (chat.ts platformIdFor).
      const hashIdx = platformId.indexOf('#');
      if (hashIdx > 0 && threadId && message.id && (message.kind === 'chat' || message.kind === 'text')) {
        const userId = platformId.slice(0, hashIdx);
        const groupId = platformId.slice(hashIdx + 1);
        void sendPushToUser(userId, {
          v: 1,
          kind: 'message',
          groupId,
          threadId,
          msgId: message.id,
          ts: new Date().toISOString(),
        }).catch((err) => log.warn('web push send failed', { err }));
      }
      const set = subscribers.get(subKey(platformId, threadId));
      if (!set || set.size === 0) {
        // No live tab — the row stays in outbound.db; reconnecting clients
        // can fetch history via the REST `messages` endpoint.
        return undefined;
      }
      for (const sub of set) {
        try {
          sub.onOutbound(message);
        } catch (err) {
          log.warn('web subscriber onOutbound threw', { err });
        }
      }
      return undefined;
    },

    async setTyping(platformId, threadId, hint, items, metadata): Promise<void> {
      const set = subscribers.get(subKey(platformId, threadId));
      if (!set) return;
      for (const sub of set) {
        try {
          sub.onTyping?.(true, hint, items, metadata);
        } catch (err) {
          log.warn('web subscriber onTyping threw', { err });
        }
      }
    },

    async clearTyping(platformId, threadId): Promise<void> {
      const set = subscribers.get(subKey(platformId, threadId));
      if (!set) return;
      for (const sub of set) {
        try {
          sub.onTyping?.(false);
        } catch (err) {
          log.warn('web subscriber onTyping threw', { err });
        }
      }
    },
  };
  return adapter;
}

registerChannelAdapter('web', { factory: createAdapter });
