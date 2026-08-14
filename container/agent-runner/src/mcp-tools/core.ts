/**
 * Core MCP tools: send_message, send_file, edit_message, add_reaction.
 *
 * All outbound tools resolve destinations via the local destination map
 * (see destinations.ts). Agents reference destinations by name; the map
 * translates name → routing tuple. Permission enforcement happens on
 * the host side in delivery.ts via the agent_destinations table.
 */
import fs from 'fs';
import path from 'path';

import { getCurrentInReplyTo, noteSendMessage } from '../current-batch.js';
import { findByName, getAllDestinations } from '../destinations.js';
import { stripThinkTags } from '../formatter.js';
import { getMessageIdBySeq, getRoutingBySeq, writeMessageOut } from '../db/messages-out.js';
import { getSessionRouting } from '../db/session-routing.js';
import { registerTools } from './server.js';
import type { McpToolDefinition } from './types.js';

function log(msg: string): void {
  console.error(`[mcp-tools] ${msg}`);
}

function generateId(): string {
  return `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function ok(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

function err(text: string) {
  return { content: [{ type: 'text' as const, text: `Error: ${text}` }], isError: true };
}

function destinationList(): string {
  const all = getAllDestinations();
  if (all.length === 0) return '(none)';
  return all.map((d) => d.name).join(', ');
}

/**
 * Resolve a destination name to routing fields.
 *
 * If `to` is omitted, use the session's default reply routing (channel +
 * thread the conversation is in) — the agent replies in place.
 *
 * If `to` is specified, look up the named destination. If it resolves to
 * the same channel the session is bound to, the session's thread_id is
 * preserved so replies land in the correct thread. Otherwise thread_id
 * is null (a cross-destination send starts a new conversation).
 */
function resolveRouting(
  to: string | undefined,
): { channel_type: string; platform_id: string; thread_id: string | null; resolvedName: string } | { error: string } {
  if (!to) {
    // Default: reply to whatever thread/channel this session is bound to.
    const session = getSessionRouting();
    if (session.channel_type && session.platform_id) {
      return {
        channel_type: session.channel_type,
        platform_id: session.platform_id,
        thread_id: session.thread_id,
        resolvedName: '(current conversation)',
      };
    }
    // No session routing (e.g., agent-shared or internal-only agent) —
    // fall back to the legacy single-destination shortcut.
    const all = getAllDestinations();
    if (all.length === 0) return { error: 'No destinations configured.' };
    if (all.length > 1) {
      return {
        error: `You have multiple destinations — specify "to". Options: ${all.map((d) => d.name).join(', ')}`,
      };
    }
    to = all[0].name;
  }
  const dest = findByName(to);
  if (!dest) return { error: `Unknown destination "${to}". Known: ${destinationList()}` };
  if (dest.type === 'channel') {
    // If the destination is the same channel the session is bound to,
    // preserve the thread_id so replies land in the correct thread.
    const session = getSessionRouting();
    const threadId =
      session.channel_type === dest.channelType && session.platform_id === dest.platformId ? session.thread_id : null;
    return {
      channel_type: dest.channelType!,
      platform_id: dest.platformId!,
      thread_id: threadId,
      resolvedName: to,
    };
  }
  return { channel_type: 'agent', platform_id: dest.agentGroupId!, thread_id: null, resolvedName: to };
}

export const sendMessage: McpToolDefinition = {
  tool: {
    name: 'send_message',
    description: 'Send a message to a named destination. If you have only one destination, you can omit `to`.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        to: {
          type: 'string',
          description: 'Destination name (e.g., "family", "worker-1"). Optional if you have only one destination.',
        },
        text: { type: 'string', description: 'Message content' },
      },
      required: ['text'],
    },
  },
  async handler(args) {
    const raw = args.text as string;
    if (!raw) return err('text is required');

    // Weak reasoning models (e.g. minimax-m3 via OpenCode) sometimes dump
    // inline chain-of-thought or a stray <message> wrapper into the tool arg;
    // strip both before writing outbound. This path bypasses the provider's
    // normalizeAssistantText, so the sanitize has to happen here too.
    const text = stripThinkTags(raw).replace(/<\/?message\b[^>]*>/gi, '').trim();
    if (!text) return err('text is required');

    const routing = resolveRouting(args.to as string | undefined);
    if ('error' in routing) return err(routing.error);

    if (!noteSendMessage(routing.resolvedName, text)) {
      log(`send_message: dropped duplicate to ${routing.resolvedName}`);
      return err(
        'You already sent this exact message to this destination during this turn. ' +
          'It was NOT sent again. Do not retry it. Stop calling tools and finish your turn.',
      );
    }

    const id = generateId();
    const seq = writeMessageOut({
      id,
      in_reply_to: getCurrentInReplyTo(),
      kind: 'chat',
      platform_id: routing.platform_id,
      channel_type: routing.channel_type,
      thread_id: routing.thread_id,
      content: JSON.stringify({ text, delivery_origin: 'send_message' }),
    });

    log(`send_message: #${seq} → ${routing.resolvedName}`);
    return ok(`Message sent to ${routing.resolvedName} (id: ${seq})`);
  },
};

export const sendFile: McpToolDefinition = {
  tool: {
    name: 'send_file',
    description:
      'Send one or more files to a named destination as a single message. Pass `path` for a single file or `paths` for several. Prefer `paths` when sending multiple files together — the host coalesces them into one delivery on channels that support multi-attachment (e.g. one email with N attachments), and transparently splits into N sends on channels that do not. If you have only one destination, you can omit `to`.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        to: { type: 'string', description: 'Destination name. Optional if you have only one destination.' },
        path: { type: 'string', description: 'File path (relative to /workspace/agent/ or absolute). Use for a single file.' },
        paths: {
          type: 'array',
          items: { type: 'string' },
          description: 'Multiple file paths to send together in one message. Use instead of `path` for batches.',
        },
        text: { type: 'string', description: 'Optional accompanying message' },
        filename: {
          type: 'string',
          description: 'Display name (default: basename of path). Only honored when sending a single file via `path`.',
        },
      },
    },
  },
  async handler(args) {
    const rawPaths: string[] = Array.isArray(args.paths)
      ? (args.paths as string[]).filter((p) => typeof p === 'string' && p.length > 0)
      : typeof args.path === 'string' && args.path.length > 0
        ? [args.path]
        : [];
    if (rawPaths.length === 0) return err('path or paths is required');

    const routing = resolveRouting(args.to as string | undefined);
    if ('error' in routing) return err(routing.error);

    const resolved: Array<{ src: string; filename: string; workspacePath: string | null }> = [];
    const singleFilenameOverride =
      rawPaths.length === 1 && typeof args.filename === 'string' && args.filename.length > 0
        ? (args.filename as string)
        : undefined;
    for (const p of rawPaths) {
      const abs = path.isAbsolute(p) ? p : path.resolve('/workspace/agent', p);
      if (!fs.existsSync(abs)) return err(`File not found: ${p}`);
      // Workspace-relative path so the chat UI can deep-link to the
      // source in the FILES panel. Null when the source lives outside
      // /workspace/agent (e.g. a generated tmp file) — the chat chip
      // will then be inert (no nav target).
      const rel = path.relative('/workspace/agent', abs);
      const workspacePath = rel.startsWith('..') || path.isAbsolute(rel) ? null : rel;
      resolved.push({ src: abs, filename: singleFilenameOverride ?? path.basename(abs), workspacePath });
    }

    const id = generateId();
    const outboxDir = path.join('/workspace/outbox', id);
    fs.mkdirSync(outboxDir, { recursive: true });
    for (const f of resolved) {
      fs.copyFileSync(f.src, path.join(outboxDir, f.filename));
    }

    const filenames = resolved.map((f) => f.filename);
    // Parallel array to `files` carrying workspace-relative source paths
    // (or null when the source lives outside /workspace/agent). Kept
    // separate from `files` to preserve the existing string[] contract
    // that delivery.ts/readOutboxFiles read.
    const filePaths = resolved.map((f) => f.workspacePath);
    writeMessageOut({
      id,
      in_reply_to: getCurrentInReplyTo(),
      kind: 'chat',
      platform_id: routing.platform_id,
      channel_type: routing.channel_type,
      thread_id: routing.thread_id,
      content: JSON.stringify({
        text: (args.text as string) || '',
        files: filenames,
        file_paths: filePaths,
        delivery_origin: 'send_file',
      }),
    });

    log(`send_file: ${id} → ${routing.resolvedName} (${filenames.join(', ')})`);
    return ok(
      `${filenames.length === 1 ? 'File' : `${filenames.length} files`} sent to ${routing.resolvedName} (id: ${id}, filenames: ${filenames.join(', ')})`,
    );
  },
};

export const editMessage: McpToolDefinition = {
  tool: {
    name: 'edit_message',
    description: 'Edit a previously sent message. Targets the same destination the original message was sent to.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        messageId: { type: 'integer', description: 'Message ID (the numeric id shown in messages)' },
        text: { type: 'string', description: 'New message content' },
      },
      required: ['messageId', 'text'],
    },
  },
  async handler(args) {
    const seq = Number(args.messageId);
    const text = args.text as string;
    if (!seq || !text) return err('messageId and text are required');

    const platformId = getMessageIdBySeq(seq);
    if (!platformId) return err(`Message #${seq} not found`);

    const routing = getRoutingBySeq(seq);
    if (!routing || !routing.channel_type || !routing.platform_id) {
      return err(`Cannot determine destination for message #${seq}`);
    }

    const id = generateId();
    writeMessageOut({
      id,
      kind: 'chat',
      platform_id: routing.platform_id,
      channel_type: routing.channel_type,
      thread_id: routing.thread_id,
      content: JSON.stringify({ operation: 'edit', messageId: platformId, text }),
    });

    log(`edit_message: #${seq} → ${platformId}`);
    return ok(`Message edit queued for #${seq}`);
  },
};

export const addReaction: McpToolDefinition = {
  tool: {
    name: 'add_reaction',
    description: 'Add an emoji reaction to a message.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        messageId: { type: 'integer', description: 'Message ID (the numeric id shown in messages)' },
        emoji: { type: 'string', description: 'Emoji name (e.g., thumbs_up, heart, check)' },
      },
      required: ['messageId', 'emoji'],
    },
  },
  async handler(args) {
    const seq = Number(args.messageId);
    const emoji = args.emoji as string;
    if (!seq || !emoji) return err('messageId and emoji are required');

    const platformId = getMessageIdBySeq(seq);
    if (!platformId) return err(`Message #${seq} not found`);

    const routing = getRoutingBySeq(seq);
    if (!routing || !routing.channel_type || !routing.platform_id) {
      return err(`Cannot determine destination for message #${seq}`);
    }

    const id = generateId();
    writeMessageOut({
      id,
      kind: 'chat',
      platform_id: routing.platform_id,
      channel_type: routing.channel_type,
      thread_id: routing.thread_id,
      content: JSON.stringify({ operation: 'reaction', messageId: platformId, emoji }),
    });

    log(`add_reaction: #${seq} → ${emoji} on ${platformId}`);
    return ok(`Reaction queued for #${seq}`);
  },
};

export const sendEmail: McpToolDefinition = {
  tool: {
    name: 'send_email',
    description:
      'Compose a NEW email to an arbitrary recipient using your wired email channel (Resend). Sender = your bot alias. Optional file attachments (paths under /workspace/agent or absolute). Use this when the user asks you to email someone other than the current correspondent. Responses are delivered to you automatically in the conversation that initiated the email, prefixed with "Email response from ..."; no inbox tool or session search is needed. A normal assistant reply stays in that originating conversation, so call send_email explicitly to contact the email sender again. For replies when the current conversation itself is an email thread, use send_message / send_file instead.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        to: { type: 'string', description: 'Recipient email address.' },
        subject: { type: 'string', description: 'Email subject line.' },
        body: { type: 'string', description: 'Email body (Markdown supported).' },
        files: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional file paths to attach (relative to /workspace/agent/ or absolute).',
        },
      },
      required: ['to', 'subject', 'body'],
    },
  },
  async handler(args) {
    const to = String(args.to || '').trim();
    const subject = String(args.subject || '').trim();
    const body = String(args.body || '');
    if (!to || !/^[^@\s]+@[^@\s]+$/.test(to)) return err(`Invalid "to" address: ${to || '(empty)'}`);
    if (!subject) return err('subject is required');
    if (!body) return err('body is required');

    const destinations = getAllDestinations();
    const resendDest =
      destinations.find((d) => d.name === 'email' && d.type === 'channel' && d.channelType === 'resend') ??
      destinations.find((d) => d.type === 'channel' && d.channelType === 'resend');
    if (!resendDest || !resendDest.platformId) {
      return err('No Resend (email) channel destination configured for this agent.');
    }

    const id = generateId();

    // Stage any attachments in the outbox dir — same pattern as send_file.
    // Delivery reads /workspace/outbox/<id>/<filename> for each entry in content.files.
    const inputFiles = Array.isArray(args.files) ? (args.files as unknown[]).map(String) : [];
    const filenames: string[] = [];
    if (inputFiles.length > 0) {
      const outboxDir = path.join('/workspace/outbox', id);
      fs.mkdirSync(outboxDir, { recursive: true });
      for (const f of inputFiles) {
        const resolved = path.isAbsolute(f) ? f : path.resolve('/workspace/agent', f);
        if (!fs.existsSync(resolved)) return err(`File not found: ${f}`);
        const filename = path.basename(resolved);
        fs.copyFileSync(resolved, path.join(outboxDir, filename));
        filenames.push(filename);
      }
    }

    const seq = writeMessageOut({
      id,
      in_reply_to: getCurrentInReplyTo(),
      kind: 'chat',
      platform_id: resendDest.platformId,
      channel_type: 'resend',
      thread_id: null,
      content: JSON.stringify({
        type: 'email_compose',
        to,
        subject,
        body,
        ...(filenames.length > 0 ? { files: filenames } : {}),
      }),
    });

    log(`send_email: #${seq} → ${to} (subject: ${subject}, files: ${filenames.length})`);
    return ok(
      `Email queued to ${to} (id: ${seq}${filenames.length ? `, ${filenames.length} attachment(s)` : ''}). ` +
        'Responses will be delivered automatically to this conversation; do not ask the user to forward them or look for an inbox.',
    );
  },
};

registerTools([sendMessage, sendFile, editMessage, addReaction, sendEmail]);
