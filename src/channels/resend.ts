/**
 * Resend (email) channel adapter (v2) — uses Chat SDK bridge.
 * Self-registers on import.
 *
 * Per-alias routing: the upstream @resend/chat-sdk-adapter keys threads on
 * the SENDER (one inbox per remote correspondent). We override that so the
 * messaging_group key is the RECIPIENT alias instead — `support@…`,
 * `tutor@…`, etc. each become their own messaging_group that can be wired
 * to a distinct agent group. Sender stays as the user identity.
 *
 * New threadId format: `resend:<alias>:<sender>:<rootMessageIdHash>`
 * Legacy 3-part format `resend:<sender>:<hash>` is still decoded (treated
 * as alias = RESEND_FROM_ADDRESS) for in-flight threads after the upgrade.
 *
 * Concurrency: `postMessage` temporarily swaps `config.fromAddress` to
 * send from the alias. Safe only because we ask the bridge for
 * `concurrency: 'queue'` (host serializes deliveries per channel).
 */
import { createHash, randomBytes } from 'node:crypto';

import { createResendAdapter } from '@resend/chat-sdk-adapter';
import { Message, parseMarkdown, type Attachment } from 'chat';

import { isSenderAllowed, provisionEmailBot, readBotFolder } from '../auto-provision.js';
import { wakeContainer } from '../container-runner.js';
import { getDb } from '../db/connection.js';
import { getMessagingGroup, getMessagingGroupByPlatform, getMessagingGroupAgents } from '../db/messaging-groups.js';
import { getAskQuestionRender, getSession } from '../db/sessions.js';
import { readEnvFile } from '../env.js';
import { log } from '../log.js';
import { getEnabledAgentGroupForEmailAlias } from '../modules/email/agent-email.js';
import {
  createResendOutboundCorrelation,
  deleteResendOutboundCorrelation,
  getResendOutboundCorrelationByToken,
} from '../modules/email/resend-correlations.js';
import { getUserDmByMessagingGroup } from '../modules/permissions/db/user-dms.js';
import { getOwners, getGlobalAdmins, getAdminsOfAgentGroup } from '../modules/permissions/db/user-roles.js';
import { getPrimaryIdentityForChannel } from '../modules/permissions/db/identities.js';
import { dispatchResponse } from '../response-registry.js';
import { writeSessionMessage } from '../session-manager.js';
import { normalizeOptions } from './ask-question.js';
import type { DeliveryContext } from './adapter.js';
import { createChatSdkBridge } from './chat-sdk-bridge.js';
import { registerChannelAdapter } from './channel-registry.js';

// CommonMark treats a single `\n` inside a paragraph as a soft break, which
// HTML renders as a space. That swallows intra-verse line breaks in poems,
// addresses, signatures, etc. Convert single newlines into hard breaks
// (two trailing spaces + `\n`) but skip fenced code blocks so their content
// stays byte-exact.
function hardenSoftBreaks(text: string): string {
  const parts = text.split(/(```[\s\S]*?```)/g);
  return parts.map((part, i) => (i % 2 === 1 ? part : part.replace(/([^\n])\n(?!\n)/g, '$1  \n'))).join('');
}

// Pull the bare email out of "Name <e@m>" or "e@m".
function parseEmailAddress(field: string): string {
  const m = field.match(/<([^>]+)>/);
  return (m ? m[1] : field).trim().toLowerCase();
}

export function tokenizedReplyAddress(alias: string, token: string): string {
  const at = alias.lastIndexOf('@');
  if (at <= 0) throw new Error(`Cannot tokenize invalid email alias: ${alias}`);
  return `${alias.slice(0, at)}+r-${token}${alias.slice(at)}`;
}

export function parseTokenizedReplyAddress(address: string): { alias: string; token: string } | null {
  const parsed = parseEmailAddress(address);
  const match = parsed.match(/^([^@+]+)\+r-([a-z0-9_-]+)@([^@]+)$/i);
  if (!match) return null;
  return { alias: `${match[1]}@${match[3]}`, token: match[2] };
}

export function isResendSelfSender(sender: string, alias: string): boolean {
  const senderAddress = parseEmailAddress(sender);
  const canonicalSender = parseTokenizedReplyAddress(senderAddress)?.alias || senderAddress;
  return canonicalSender === parseEmailAddress(alias);
}

interface ResendEmailEventData {
  created_at: string;
  email_id: string;
  from: string;
  to: string[];
  subject: string;
}

export type ResendDeliveryFailureEvent =
  | {
      type: 'email.bounced';
      created_at: string;
      data: ResendEmailEventData & { bounce: { message: string; type: string; subType: string } };
    }
  | {
      type: 'email.failed';
      created_at: string;
      data: ResendEmailEventData & { failed: { reason: string } };
    }
  | {
      type: 'email.suppressed';
      created_at: string;
      data: ResendEmailEventData & { suppressed: { message: string; type: string } };
    };

function isResendDeliveryFailureEvent(event: { type?: string }): event is ResendDeliveryFailureEvent {
  return event.type === 'email.bounced' || event.type === 'email.failed' || event.type === 'email.suppressed';
}

function recipientFromEmailThreadId(threadId: string): string | null {
  const parts = threadId.split(':');
  if (parts[0] !== 'resend') return null;
  if (parts.length === 4) return parts[2]?.toLowerCase() || null;
  if (parts.length === 3) return parts[1]?.toLowerCase() || null;
  return null;
}

export async function routeResendDeliveryFailure(event: ResendDeliveryFailureEvent): Promise<boolean> {
  const tokenizedSender = parseTokenizedReplyAddress(event.data.from);
  const correlation = tokenizedSender ? getResendOutboundCorrelationByToken(tokenizedSender.token) : undefined;
  const originSession = correlation ? getSession(correlation.origin_session_id) : undefined;
  if (!correlation || !originSession) return false;

  const intendedRecipient = recipientFromEmailThreadId(correlation.email_thread_id);
  const failedRecipients = event.data.to.map(parseEmailAddress);
  if (!intendedRecipient || !failedRecipients.includes(intendedRecipient)) {
    log.warn('Ignoring Resend delivery failure for non-primary recipient', {
      eventType: event.type,
      emailId: event.data.email_id,
      intendedRecipient,
      failedRecipients,
    });
    return false;
  }

  const failure =
    event.type === 'email.bounced'
      ? {
          reason: event.data.bounce.message,
          type: event.data.bounce.type,
          subType: event.data.bounce.subType,
        }
      : event.type === 'email.failed'
        ? { reason: event.data.failed.reason }
        : { reason: event.data.suppressed.message, type: event.data.suppressed.type };

  const details = [
    'System delivery report: an email you sent was not delivered.',
    `Recipient: ${intendedRecipient}`,
    event.data.subject ? `Subject: ${event.data.subject}` : '',
    `Failure event: ${event.type}`,
    'Tell the user the email was not delivered. Do not continue waiting for a response. Retry only with a verified corrected address.',
  ]
    .filter(Boolean)
    .join('\n');

  writeSessionMessage(originSession.agent_group_id, originSession.id, {
    id: `resend-delivery-failure:${event.data.email_id}`,
    kind: 'chat',
    timestamp: event.created_at || event.data.created_at,
    platformId: originSession.agent_group_id,
    channelType: 'agent',
    threadId: null,
    content: JSON.stringify({
      text: details,
      sender: 'NanoClaw email delivery',
      senderId: 'system',
      emailDeliveryFailure: {
        provider: 'resend',
        event: event.type,
        recipient: intendedRecipient,
        subject: event.data.subject,
        ...failure,
      },
    }),
    trigger: 1,
    idempotent: true,
  });
  const woke = await wakeContainer(originSession);
  if (!woke) {
    throw new Error(`Failed to wake origin session ${originSession.id} for Resend delivery failure`);
  }
  deleteResendOutboundCorrelation(correlation.correlation_token);
  log.info('Resend delivery failure routed to origin session', {
    eventType: event.type,
    emailId: event.data.email_id,
    recipient: intendedRecipient,
    originSessionId: originSession.id,
  });
  return true;
}

export interface InboundEmailBody {
  body: string;
  htmlAttachment?: { type: 'file'; name: string; mimeType: 'text/html'; data: string };
}

export function prepareInboundEmailBody(text?: string | null, html?: string | null): InboundEmailBody {
  const rawText = text || '';
  const rawHtml = html || '';
  return {
    body: rawText,
    ...(rawHtml
      ? {
          htmlAttachment: {
            type: 'file' as const,
            name: 'original-message.html',
            mimeType: 'text/html' as const,
            data: Buffer.from(rawHtml).toString('base64'),
          },
        }
      : {}),
  };
}

/**
 * Resend rejects emails with no html/text body. When the agent sends an
 * attachments-only message (`{text:"", files:[...]}`), the chat-sdk-bridge
 * hands us `{markdown:"", files:[...]}` and the underlying send fails with
 * `Missing 'html' or 'text' field`. Substitute a minimal body listing the
 * attached filenames so delivery succeeds. Returns the (possibly cloned)
 * message; safe to call with no files or non-empty markdown.
 */
export function ensureBodyForAttachments<T extends { markdown?: unknown; files?: unknown }>(message: T): T {
  const files = message?.files as Array<{ filename: string }> | undefined;
  if (!files || files.length === 0) return message;
  const md = typeof message?.markdown === 'string' ? message.markdown : '';
  if (md.trim()) return message;
  const names = files.map((f) => `- ${f.filename}`).join('\n');
  return { ...message, markdown: `Attached:\n\n${names}` };
}

// Module-scope stash for the next outbound send. The web-UI send route
// sets these before invoking adapter.deliver so the email goes out with a
// distinguishing From display name ("<Name> (via web) <alias>") and audit
// headers. Safe because the bridge runs with concurrency: 'queue' — only
// one send is in flight at a time. Consumed and cleared by the
// resendClient.emails.send override below.
let pendingWebFromName: string | null = null;
let pendingWebExtraHeaders: Record<string, string> | null = null;

export function setResendPendingWebOverride(opts: {
  fromName?: string | null;
  extraHeaders?: Record<string, string> | null;
}): void {
  pendingWebFromName = opts.fromName ?? null;
  pendingWebExtraHeaders = opts.extraHeaders ?? null;
}

registerChannelAdapter('resend', {
  factory: () => {
    const env = readEnvFile(['RESEND_API_KEY', 'RESEND_FROM_ADDRESS', 'RESEND_FROM_NAME', 'RESEND_WEBHOOK_SECRET']);
    if (!env.RESEND_API_KEY) return null;
    const FROM = env.RESEND_FROM_ADDRESS;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adapter: any = createResendAdapter({
      apiKey: env.RESEND_API_KEY,
      fromAddress: FROM,
      fromName: env.RESEND_FROM_NAME,
      webhookSecret: env.RESEND_WEBHOOK_SECRET,
    });
    const resendClient = adapter.getResend();

    // ── Alias-aware threadId encoding ────────────────────────────────
    const tr = adapter.threadResolver;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    tr.encodeThreadId = (id: any): string => {
      const alias = id.alias ?? FROM;
      return `resend:${alias}:${id.toAddress}:${id.rootMessageIdHash}`;
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    tr.decodeThreadId = (threadId: string): any => {
      const parts = threadId.split(':');
      if (parts[0] !== 'resend') throw new Error(`Invalid thread ID format: ${threadId}`);
      if (parts.length === 4) {
        return { alias: parts[1], toAddress: parts[2], rootMessageIdHash: parts[3] };
      }
      // Back-compat: pre-alias 3-part ids — assume default mailbox.
      if (parts.length === 3) {
        return { alias: FROM, toAddress: parts[1], rootMessageIdHash: parts[2] };
      }
      throw new Error(`Invalid thread ID format: ${threadId}`);
    };

    adapter.channelIdFromThreadId = (threadId: string): string => {
      const { alias } = tr.decodeThreadId(threadId);
      return `resend:${alias}`;
    };

    // Override resolveThreadId so the alias is actually propagated into
    // encodeThreadId. Upstream destructures only {toAddress, messageId,
    // inReplyTo, references} from input and drops alias on the floor.
    //
    // Also: the fallback root is now the FIRST entry of References (the
    // conversation root per RFC 5322), not the current messageId. The
    // in-memory messageToThread map is wiped on every host restart, so the
    // original "hash(messageId)" fallback minted a new thread for every
    // reply received after a restart — and a new thread means a new session
    // with no history. Using references[0] makes the threadId deterministic
    // across restarts for any reply chain.
    //
    // Cross-restart fix #2: persist `threadId → rootMessageId` so outbound
    // replies can set RFC 5322 In-Reply-To/References headers even after a
    // restart wipes the in-memory threadMessages map. Without these headers
    // the agent's reply looks like a brand-new email; the user's next reply
    // then builds References starting from the agent's Message-ID, so our
    // resolveThreadId picks a different references[0] and mints a NEW
    // thread. Result: a 34-email Gmail conversation gets sharded across
    // many sessions, one per host restart.
    const db = getDb();
    const selectRoot = db.prepare<[string], { root_message_id: string }>(
      'SELECT root_message_id FROM resend_thread_roots WHERE thread_id = ?',
    );
    const insertRoot = db.prepare<[string, string, string]>(
      'INSERT OR IGNORE INTO resend_thread_roots (thread_id, root_message_id, created_at) VALUES (?, ?, ?)',
    );
    const recordRoot = (threadId: string, rootMessageId: string): void => {
      // INSERT OR IGNORE makes this first-writer-wins, so a later message
      // can't clobber the true root.
      try {
        insertRoot.run(threadId, rootMessageId, new Date().toISOString());
      } catch (err) {
        log.warn('resend: failed to persist thread root', { err, threadId });
      }
    };
    const lookupRoot = (threadId: string): string | undefined => {
      try {
        return selectRoot.get(threadId)?.root_message_id;
      } catch (err) {
        log.warn('resend: failed to lookup thread root', { err, threadId });
        return undefined;
      }
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    tr.resolveThreadId = async function (input: any): Promise<string> {
      const { toAddress, alias, messageId, inReplyTo, references } = input;
      const candidateIds: string[] = inReplyTo || references ? this.extractMessageIds(inReplyTo, references) : [];
      for (const candidate of candidateIds) {
        const existingThread = this.messageToThread.get(candidate);
        if (existingThread) {
          this.trackMessage(existingThread, messageId);
          return existingThread;
        }
      }
      // Deterministic root: first reference if any (extractMessageIds returns
      // References in order, then In-Reply-To). Falls back to messageId only
      // for true thread roots (no prior history).
      const rootId = candidateIds[0] || messageId;
      const hash = createHash('sha256').update(rootId).digest('hex').slice(0, 16);
      const threadId = this.encodeThreadId({ alias, toAddress, rootMessageIdHash: hash });
      this.trackMessage(threadId, messageId);
      recordRoot(threadId, rootId);
      return threadId;
    };

    // After restart `threadMessages` is empty so the upstream impl returns
    // undefined and our outbound replies ship without In-Reply-To /
    // References — breaking Gmail threading. Fall back to the persisted
    // root so the conversation chain survives. We deliberately set both
    // headers to the same root id: clients build References from the email
    // they're replying to, so as long as our reply references the root,
    // the user's subsequent reply will include the root in their chain.
    const origGetReplyHeaders = tr.getReplyHeaders.bind(tr);
    tr.getReplyHeaders = function (threadId: string): Record<string, string> | undefined {
      const fromMemory = origGetReplyHeaders(threadId);
      if (fromMemory) return fromMemory;
      const root = lookupRoot(threadId);
      if (!root) return undefined;
      return { 'In-Reply-To': root, References: root };
    };

    // ── Inbound: key messaging_group on recipient alias ──────────────
    // Replaces upstream handleWebhook to route terminal delivery failures
    // before its webhook handler filters out every event except email.received,
    // then extracts the recipient alias for the normal inbound path.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    adapter.handleWebhook = async function (request: Request, options?: any): Promise<Response> {
      if (!(this.webhookHandler && this.chat)) {
        throw new Error('Adapter not initialized. Call initialize() first.');
      }
      const webhookBody = await request.text();
      let event: any;
      try {
        event = resendClient.webhooks.verify({
          payload: webhookBody,
          headers: {
            id: request.headers.get('svix-id') || '',
            timestamp: request.headers.get('svix-timestamp') || '',
            signature: request.headers.get('svix-signature') || '',
          },
          webhookSecret: env.RESEND_WEBHOOK_SECRET,
        });
      } catch {
        return new Response(null, { status: 401 });
      }
      if (isResendDeliveryFailureEvent(event)) {
        await routeResendDeliveryFailure(event);
        return new Response(null, { status: 200 });
      }
      if (event.type !== 'email.received') return new Response(null, { status: 200 });
      const email = await this.webhookHandler.fetchEmailContent(event.data.email_id);
      if (event.data.attachments?.length && !email.attachments?.length) {
        email.attachments = event.data.attachments;
      }
      const senderAddress = parseEmailAddress(email.from);
      const tokenizedRecipient = email.to?.map(parseTokenizedReplyAddress).find(Boolean) || null;
      const alias = tokenizedRecipient?.alias || (email.to?.[0] ? parseEmailAddress(email.to[0]) : FROM);
      if (isResendSelfSender(senderAddress, alias)) {
        log.warn('Resend dropped self-sent inbound email', {
          emailId: email.id,
          from: senderAddress,
          alias,
          subject: email.subject,
        });
        return new Response(null, { status: 200 });
      }
      const headers = headersOf(email);
      const inReplyTo = headers['In-Reply-To'] || headers['in-reply-to'] || undefined;
      const references = headers.References || headers.references || undefined;
      const normalizedBody = prepareInboundEmailBody(email.text, email.html);
      log.info('Resend inbound', { from: senderAddress, alias, to: email.to, subject: email.subject });

      // ── Approval-reply matcher ───────────────────────────────────────
      // If the inbound email is a reply to an approval card we sent —
      // recognised by the "[ref:appr-...]" tag we embed in the outbound
      // subject (preserved across "Re:" prefixes) — parse the answer and
      // dispatch through the response-handler chain. Subject-tag is
      // primary because Gmail's text/plain reply often omits the quoted
      // history that holds the body footer; the body fallback is a
      // defense-in-depth for clients that DO quote. This bypasses the
      // alias gate because cold-DM approvals are sent from the default
      // FROM alias and the approver may not be in any allow-list.
      const approvalReply =
        matchApprovalReplyFromSubject(email.subject || '', normalizedBody.body) ||
        matchApprovalReply(normalizedBody.body);
      if (approvalReply) {
        const { approvalId, optionValue } = approvalReply;
        log.info('Resend approval reply detected', { approvalId, from: senderAddress, optionValue });
        const platformId = `resend:${alias}`;
        const threadIdForReply = await tr.resolveThreadId({
          toAddress: senderAddress,
          alias,
          messageId: email.message_id,
          inReplyTo: headersOf(email)['In-Reply-To'] || headersOf(email)['in-reply-to'],
          references: headersOf(email).References || headersOf(email).references,
        });
        const claimed = await dispatchResponse({
          questionId: approvalId,
          value: optionValue,
          userId: senderAddress,
          channelType: 'resend',
          platformId,
          threadId: threadIdForReply,
        });
        if (!claimed) {
          log.warn('Resend approval reply not claimed by any handler', { approvalId, from: senderAddress });
        }
        return new Response(null, { status: 200 });
      }

      // ── Correlated response ──────────────────────────────────────────
      // A tokenized return address is the correlation capability. Correlated
      // responses are written to the originating session with that session's
      // existing routing fields, so the agent's result returns to the web/chat
      // user who initiated the email rather than being sent back over email.
      const correlation = tokenizedRecipient
        ? getResendOutboundCorrelationByToken(tokenizedRecipient.token)
        : undefined;
      const originSession = correlation ? getSession(correlation.origin_session_id) : undefined;
      if (correlation && originSession) {
        const originMessagingGroup = originSession.messaging_group_id
          ? getMessagingGroup(originSession.messaging_group_id)
          : undefined;
        const text = [
          `Email response from ${senderAddress}`,
          email.subject ? `Subject: ${email.subject}` : '',
          normalizedBody.body,
        ]
          .filter(Boolean)
          .join('\n\n');
        const attachments = (email.attachments || []).map((attachment: { filename: string; content_type: string }) => ({
          type: 'file',
          name: attachment.filename,
          mimeType: attachment.content_type,
        }));
        if (normalizedBody.htmlAttachment) attachments.push(normalizedBody.htmlAttachment);

        writeSessionMessage(originSession.agent_group_id, originSession.id, {
          id: `email-response:${email.id}`,
          kind: 'chat-sdk',
          timestamp: email.created_at,
          platformId: originMessagingGroup?.platform_id ?? null,
          channelType: originMessagingGroup?.channel_type ?? null,
          threadId: originSession.thread_id,
          content: JSON.stringify({
            text,
            senderId: senderAddress,
            sender: senderAddress,
            senderName: senderAddress,
            attachments,
            emailResponse: {
              from: email.from,
              to: email.to,
              cc: email.cc,
              subject: email.subject,
              messageId: email.message_id,
              emailThreadId: correlation.email_thread_id,
            },
          }),
          idempotent: true,
        });
        if (email.message_id) tr.trackMessage(correlation.email_thread_id, email.message_id);
        tr.trackSubject(correlation.email_thread_id, email.subject);
        log.info('Resend response routed to origin session', {
          from: senderAddress,
          originSessionId: originSession.id,
        });
        await wakeContainer(originSession);
        return new Response(null, { status: 200 });
      }

      // ── Email-bot gate ───────────────────────────────────────────────
      // Filesystem-driven allow-list: groups/<alias>/CLAUDE.local.md must
      // exist for the alias to be enabled, and the sender must match a
      // regex in allowed-senders.txt. Missing folder / missing regex file /
      // no regex match → silent drop. The default alias (FROM) bypasses
      // this gate so the legacy single-mailbox setup keeps working without
      // a folder.
      const managedAgent = getEnabledAgentGroupForEmailAlias(alias);
      if (alias !== FROM && !managedAgent) {
        const bot = readBotFolder(alias);
        if (!bot) {
          log.info('Resend dropped — alias not enabled (no groups/<alias>/CLAUDE.local.md)', {
            alias,
            from: senderAddress,
          });
          return new Response(null, { status: 200 });
        }
        if (!isSenderAllowed(bot, senderAddress)) {
          log.info('Resend dropped — sender not in allowed-senders.txt', {
            alias,
            from: senderAddress,
          });
          return new Response(null, { status: 200 });
        }
        // Lazy-register the bot (idempotent — no-op once wired).
        provisionEmailBot({ channelType: 'resend', platformId: `resend:${alias}`, bot });
      }

      const threadId = await tr.resolveThreadId({
        toAddress: senderAddress,
        alias,
        messageId: email.message_id,
        inReplyTo,
        references,
      });
      tr.trackSubject(threadId, email.subject);

      // Inline of upstream parseInboundEmail — not exported from the
      // package, so re-create the Message here.
      // Prepend the subject line so the agent sees it (raw fields are
      // dropped by the bridge before reaching the session DB).
      const body = normalizedBody.body;
      const text = email.subject ? `Subject: ${email.subject}\n\n${body}` : body;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const attachments = (email.attachments || []) as any[];
      const messageAttachments: Attachment[] = attachments.map((a) => ({
        type: 'file',
        name: a.filename,
        mimeType: a.content_type,
      }));
      if (normalizedBody.htmlAttachment) {
        const htmlAttachment = normalizedBody.htmlAttachment;
        messageAttachments.push({
          type: htmlAttachment.type,
          name: htmlAttachment.name,
          mimeType: htmlAttachment.mimeType,
          fetchData: async () => Buffer.from(htmlAttachment.data, 'base64'),
        });
      }
      const parsed = new Message({
        id: email.id,
        threadId,
        text,
        formatted: parseMarkdown(text),
        raw: {
          id: email.id,
          messageId: email.message_id,
          from: email.from,
          to: email.to,
          cc: email.cc,
          subject: email.subject,
          text: email.text,
          html: email.html,
          headers: email.headers,
          createdAt: email.created_at,
          attachments: attachments.map((a) => ({ filename: a.filename, contentType: a.content_type })),
        },
        author: {
          userId: senderAddress,
          userName: senderAddress,
          fullName: senderAddress,
          isBot: false,
          isMe: senderAddress === FROM,
        },
        metadata: { dateSent: new Date(email.created_at), edited: false },
        attachments: messageAttachments,
        isMention: true,
      });
      this.chat.processMessage(this, threadId, parsed, options);
      return new Response(null, { status: 200 });
    };

    // ── Outbound: send from the alias encoded in the threadId ────────
    // Also override fromName per-alias: a managed agent group's current
    // name wins, then legacy bot.json.name, then the local-part. Without
    // this, every alias would send as RESEND_FROM_NAME (the global default).
    //
    // Also handle file attachments. The chat-sdk-adapter's postMessage
    // accepts a `files` field but its normalizer silently drops it on
    // the way to `resend.emails.send`. Monkey-patch the Resend client so
    // a per-call closure stash can inject `attachments: [...]` (base64
    // per Resend's API) before the real send. Safe because the bridge
    // is `concurrency: 'queue'` — deliveries are serialized.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const origSend = resendClient.emails.send.bind(resendClient.emails);
    let pendingAttachments: Array<{ filename: string; content: string }> | null = null;
    // For email_compose (new outbound emails): override the subject postMessage
    // would otherwise build ("Re: <stored>" or "New message"). Cleared after one send.
    let pendingSubjectOverride: string | null = null;
    // Extra Reply-To address (e.g. routing replies to a human owner). Set
    // before postMessage; consumed by the next send. Resend exposes this as
    // top-level `replyTo` — passing it via custom headers does NOT work.
    let pendingReplyTo: string | null = null;
    // Extra BCC for audit trail of bot-initiated outreach. Owner sees every
    // outbound and any Reply-All response; recipient does not see the BCC.
    let pendingBcc: string | null = null;
    let pendingCorrelation: { token: string; replyAddress: string } | null = null;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    resendClient.emails.send = async (payload: any) => {
      if (pendingSubjectOverride) {
        payload = { ...payload, subject: pendingSubjectOverride };
        pendingSubjectOverride = null;
      }
      if (pendingReplyTo) {
        payload = { ...payload, replyTo: pendingReplyTo };
        pendingReplyTo = null;
      }
      if (pendingBcc) {
        const existing = payload.bcc ? (Array.isArray(payload.bcc) ? payload.bcc : [payload.bcc]) : [];
        payload = { ...payload, bcc: [...existing, pendingBcc] };
        pendingBcc = null;
      }
      const correlation = pendingCorrelation;
      pendingCorrelation = null;
      if (correlation) {
        const rawFrom = String(payload.from || '');
        const displayName = rawFrom.match(/^\s*([^<]+?)\s*<[^>]+>\s*$/)?.[1]?.trim();
        payload = {
          ...payload,
          from: displayName ? `${displayName} <${correlation.replyAddress}>` : correlation.replyAddress,
          replyTo: correlation.replyAddress,
        };
      }
      if (pendingAttachments) {
        payload = { ...payload, attachments: pendingAttachments };
        pendingAttachments = null;
      }
      if (pendingWebFromName) {
        // Resend accepts `"Display Name <address>"` for `from`. Extract
        // the bare address from the payload (the chat-sdk-adapter may
        // pass it already-formatted or bare).
        const rawFrom = String(payload.from || '');
        const angle = rawFrom.match(/<([^>]+)>/);
        const bareAddr = (angle ? angle[1] : rawFrom).trim();
        if (bareAddr) {
          payload = { ...payload, from: `${pendingWebFromName} <${bareAddr}>` };
        }
        pendingWebFromName = null;
      }
      if (pendingWebExtraHeaders) {
        const existing = (payload.headers || {}) as Record<string, string>;
        payload = { ...payload, headers: { ...existing, ...pendingWebExtraHeaders } };
        pendingWebExtraHeaders = null;
      }
      return origSend(payload);
    };

    const origPostMessage = adapter.postMessage.bind(adapter);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    adapter.postMessage = async function (threadId: string, message: any) {
      const { alias } = tr.decodeThreadId(threadId);
      const savedAddress = this.config.fromAddress;
      const savedName = this.config.fromName;
      this.config.fromAddress = alias;
      if (alias !== FROM) {
        const managedAgent = getEnabledAgentGroupForEmailAlias(alias);
        const bot = readBotFolder(alias);
        this.config.fromName = managedAgent?.name || bot?.config?.name || alias.split('@')[0];
      }
      const files = message?.files as Array<{ data: Buffer; filename: string }> | undefined;
      if (files && files.length > 0) {
        pendingAttachments = files.map((f) => ({
          filename: f.filename,
          content: f.data.toString('base64'),
        }));
      }
      message = ensureBodyForAttachments(message);
      try {
        return await origPostMessage(threadId, message);
      } finally {
        this.config.fromAddress = savedAddress;
        this.config.fromName = savedName;
        pendingAttachments = null;
        pendingCorrelation = null;
        pendingReplyTo = null;
        pendingBcc = null;
      }
    };

    const bridge = createChatSdkBridge({
      adapter,
      concurrency: 'queue',
      supportsThreads: true,
      supportsMultiFile: true,
      transformOutboundText: hardenSoftBreaks,
    });

    // ── Outbound deliver wrapper ─────────────────────────────────────
    // 1. Cold-DM MGs (platform_id "resend:<alias>" with no recipient) have
    //    a null threadId — the chat-sdk-bridge falls back to threadId =
    //    platformId, which our 4-part decoder rejects. Look up the recipient
    //    via user_dms and ask the adapter to mint a real threadId.
    // 2. ask_question cards render as Card+Buttons, which has no equivalent
    //    in email. Intercept and send a plain markdown body with the option
    //    list and an "Approval ref: <id>" footer; the inbound webhook
    //    parses that footer to route the reply back to the right approval.
    const origDeliver = bridge.deliver.bind(bridge);
    bridge.deliver = async function (platformId, threadId, message, context?: DeliveryContext) {
      const content = (message.content || {}) as Record<string, unknown>;

      // email_compose: send a NEW email to an arbitrary recipient (not a
      // reply in an existing thread). The MCP `send_email` tool writes this.
      // Sender = alias encoded in platformId ("resend:<alias>"). We mint a
      // fresh threadId via encodeThreadId, then route through postMessage
      // so per-alias from-name swap + attachment stash still apply. The
      // pendingSubjectOverride bypasses postMessage's "Re: <stored>" logic.
      if (content.type === 'email_compose') {
        const aliasMatch = platformId.match(/^resend:(.+)$/);
        if (!aliasMatch) throw new Error(`email_compose: bad platformId ${platformId}`);
        const alias = aliasMatch[1];
        const to = String(content.to || '')
          .trim()
          .toLowerCase();
        if (!to || !/^[^@\s]+@[^@\s]+$/.test(to)) {
          throw new Error(`email_compose: invalid "to" address: ${to || '(empty)'}`);
        }
        const subject = String(content.subject || 'New message');
        const body = String(content.body || '');
        const seedId = `<${createHash('sha256').update(`${Date.now()}-${Math.random()}`).digest('hex').slice(0, 32)}@${alias.split('@')[1] || alias}>`;
        const hash = createHash('sha256').update(seedId).digest('hex').slice(0, 16);
        const newTid = tr.encodeThreadId({ alias, toAddress: to, rootMessageIdHash: hash });
        tr.trackMessage(newTid, seedId);
        pendingSubjectOverride = subject;
        let correlationToken: string | null = null;
        if (context?.sessionId) {
          correlationToken = randomBytes(16).toString('hex');
          createResendOutboundCorrelation({
            correlation_token: correlationToken,
            origin_session_id: context.sessionId,
            email_thread_id: newTid,
            created_at: new Date().toISOString(),
          });
          pendingCorrelation = {
            token: correlationToken,
            replyAddress: tokenizedReplyAddress(alias, correlationToken),
          };
        }
        // Reply-To: prefer a scoped admin of the agent group sending this
        // email, then global admin, then owner. Any resend: identity wins.
        // Routes replies from unknown recipients straight to a human instead
        // of into the silent-drop allow-list path.
        const mgForReplyTo = getMessagingGroupByPlatform('resend', platformId);
        const agentGroupId = mgForReplyTo ? getMessagingGroupAgents(mgForReplyTo.id)[0]?.agent_group_id : undefined;
        const ownerEmail = pickReplyToEmail(agentGroupId);
        if (!correlationToken && ownerEmail && ownerEmail !== to) {
          pendingReplyTo = ownerEmail;
        }
        if (ownerEmail && ownerEmail !== to) {
          pendingBcc = ownerEmail;
        }
        try {
          const result = await adapter.postMessage(newTid, { markdown: body, files: message.files });
          return result?.id;
        } catch (err) {
          if (correlationToken) deleteResendOutboundCorrelation(correlationToken);
          throw err;
        }
      }

      let tid = threadId;
      if (!tid && /^resend:[^:]+$/.test(platformId)) {
        const mg = getMessagingGroupByPlatform('resend', platformId);
        const dm = mg ? getUserDmByMessagingGroup(mg.id) : undefined;
        const recipient = dm ? getPrimaryIdentityForChannel(dm.user_id, 'resend')?.handle : undefined;
        if (!recipient) {
          throw new Error(`Resend cold DM: no user_dms row for messaging group ${platformId} — cannot infer recipient`);
        }
        tid = await adapter.openDM(recipient);
      }

      if (content.type === 'ask_question' && content.questionId && tid) {
        const questionId = content.questionId as string;
        const title = (content.title as string) || '';
        const question = (content.question as string) || '';
        const options = normalizeOptions((content.options as never) || []);
        const lines: string[] = [];
        if (title) lines.push(`**${title}**`, '');
        if (question) lines.push(question, '');
        lines.push('Reply with one of:');
        for (const o of options) lines.push(`- ${o.label}`);
        lines.push('', `(Approval ref: ${questionId})`);
        // Embed the approval ref in the subject too so reply matching
        // survives clients that strip the quoted body. The adapter reads
        // the stored subject and prepends "Re:" automatically.
        const subjectBase = title || 'Approval';
        tr.trackSubject(tid, `${subjectBase} [ref:${questionId}]`);
        const result = await adapter.postMessage(tid, { markdown: lines.join('\n') });
        return result?.id;
      }

      return origDeliver(platformId, tid, message);
    };

    return bridge;
  },
});
// every callsite — type is opaque to us, so just shape-narrow here.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function headersOf(email: any): Record<string, string> {
  return (email.headers || {}) as Record<string, string>;
}

// Match the "Approval ref: appr-..." footer we embed in outbound approval
// emails, plus the answer the human typed above the quoted original.
// Returns { approvalId, optionValue } where optionValue is matched against
// the persisted options of the pending question (case-insensitive substring
// match on label or value). Falls back to the raw extracted text when no
// option list is on file so the response handlers can still try to match.
function matchApprovalReply(plain: string): { approvalId: string; optionValue: string } | null {
  const m = plain.match(
    /Approval ref:\s*(appr-[A-Za-z0-9_-]+|nsa-[A-Za-z0-9_-]+|mg-[A-Za-z0-9_-]+|pua-[A-Za-z0-9_-]+)/,
  );
  if (!m) return null;
  return resolveOptionForReply(m[1], extractUnquotedReply(plain));
}

// Match a "[ref:<id>]" tag in the subject (preserved across "Re:" prefixes).
// More reliable than body parsing because Gmail's text/plain replies often
// omit the quoted history. The reply body still has to be parsed to figure
// out which option the user picked.
function matchApprovalReplyFromSubject(
  subject: string,
  body: string,
): { approvalId: string; optionValue: string } | null {
  const m = subject.match(/\[ref:(appr-[A-Za-z0-9_-]+|nsa-[A-Za-z0-9_-]+|mg-[A-Za-z0-9_-]+|pua-[A-Za-z0-9_-]+)\]/);
  if (!m) return null;
  return resolveOptionForReply(m[1], extractUnquotedReply(body));
}

// Strip quoted lines + the "On <date> someone wrote:" attribution that sits
// just above them, then take the surviving prefix as the user's answer.
function extractUnquotedReply(plain: string): string {
  const lines = plain.split(/\r?\n/);
  const reply: string[] = [];
  for (const line of lines) {
    if (/^\s*>/.test(line)) break;
    if (/^On .+ wrote:\s*$/.test(line)) break;
    reply.push(line);
  }
  return reply.join(' ').replace(/\s+/g, ' ').trim();
}

function resolveOptionForReply(approvalId: string, answer: string): { approvalId: string; optionValue: string } {
  if (!answer) return { approvalId, optionValue: '' };
  const render = getAskQuestionRender(approvalId);
  if (!render) return { approvalId, optionValue: answer };
  const lower = answer.toLowerCase();
  const match = render.options.find(
    (o) => lower.includes(o.value.toLowerCase()) || lower.includes(o.label.toLowerCase()),
  );
  return { approvalId, optionValue: match?.value || answer };
}

// Pick the email address of an owner reachable on Resend, for use as Reply-To.
// First owner whose user_id is "resend:<email>" wins (deterministic by
// granted_at order). Returns null if no resend owner is configured.
// Pick a Reply-To email for outbound new emails. Resolution order:
//   1. scoped admin of the sending agent group with a resend: identity
//   2. global admin with a resend: identity
//   3. owner with a resend: identity
// Returns null if none match.
function pickReplyToEmail(agentGroupId: string | undefined): string | null {
  const candidates: { user_id: string }[] = [];
  if (agentGroupId) candidates.push(...getAdminsOfAgentGroup(agentGroupId));
  candidates.push(...getGlobalAdmins());
  candidates.push(...getOwners());
  for (const c of candidates) {
    const ident = getPrimaryIdentityForChannel(c.user_id, 'resend');
    if (ident) {
      const email = ident.handle.trim().toLowerCase();
      if (/^[^@\s]+@[^@\s]+$/.test(email)) return email;
    }
  }
  return null;
}
