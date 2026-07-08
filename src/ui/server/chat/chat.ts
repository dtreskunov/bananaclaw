/**
 * Chat side-panel for the file browser UI.
 *
 * Web channel auto-provisioning + REST endpoints + WebSocket fan-out for
 * outbound. Mounted under `/ui/chat/api/groups/<groupId>/chat/...` by the
 * file browser router (see ../routes.ts). The web channel adapter
 * (src/channels/web.ts) handles the actual inbound injection and outbound
 * pub/sub.
 */
import crypto from 'crypto';
import http from 'http';
import type internal from 'stream';
import path from 'path';

import Busboy from 'busboy';
import { WebSocketServer, type WebSocket } from 'ws';

import { getAgentGroup } from '../../../db/agent-groups.js';
import { getContainerConfig } from '../../../db/container-configs.js';
import { getDb } from '../../../db/connection.js';
import {
  createMessagingGroup,
  createMessagingGroupAgent,
  getMessagingGroup,
  getMessagingGroupAgents,
  getMessagingGroupAgentByPair,
  getMessagingGroupByPlatform,
} from '../../../db/messaging-groups.js';
import { deleteSession, findSessionByAgentGroup, findSessionForAgent } from '../../../db/sessions.js';
import { openInboundDb, openOutboundDb, sessionDir, writeSessionMessage } from '../../../session-manager.js';
import { killContainer } from '../../../container-runner.js';
import { canAccessAgentGroup } from '../../../modules/permissions/access.js';
import { searchMessages, type SearchResultRow } from '../../../search-index.js';
import { getUser } from '../../../modules/permissions/db/users.js';
import { getIdentitiesForUser } from '../../../modules/permissions/db/identities.js';
import { hasAdminPrivilege, isGlobalAdmin, isOwner } from '../../../modules/permissions/db/user-roles.js';

/**
 * Elevated access (cross-user thread listing + history) is reserved
 * for global owners/admins. Group-level admins still have full admin
 * rights on their own group (file write, approvals, etc.) but cannot
 * peek into other users' DM threads — that would leak content across
 * the per-user boundary inside a group.
 */
function isElevated(userId: string): boolean {
  return isOwner(userId) || isGlobalAdmin(userId);
}
import { log } from '../../../log.js';
import { getChannelAdapter } from '../../../channels/channel-registry.js';
import { subscribeWeb, submitWebInbound, WEB_CHANNEL_TYPE, type WebSubscriber } from '../../../channels/web.js';
import { extractDisplayQuery, HA_CHANNEL_TYPE } from '../../../channels/homeassistant.js';
import { setResendPendingWebOverride } from '../../../channels/resend.js';
import type { OutboundMessage } from '../../../channels/adapter.js';
import { authenticate, COOKIE_NAME } from '../auth.js';
import { streamTranscribe } from './voice-transcribe.js';
import { ensureOneCliAgent } from './onecli-proxy.js';
import { reconcileVoiceMode } from './voice-mode.js';
import fs from 'fs';

function appendTranscriptDelta(text: string, delta: string): string {
  if (!text || !delta) return text + delta;
  if (/\s$/.test(text) || /^\s/.test(delta)) return text + delta;
  // LLM transcription tokens occasionally arrive without their leading space,
  // producing "Hello.World" or "okay,let's". Insert one when the boundary
  // looks like a word break — the previous chunk ends in a letter/digit or a
  // sentence-final / closing punctuation mark, and the new chunk starts with
  // a letter/digit or an opening bracket/quote.
  const endsWord = /[\p{L}\p{N}.,!?;:)\]}"]$/u.test(text);
  const startsWord = /^[\p{L}\p{N}([{"]/u.test(delta);
  if (endsWord && startsWord) return `${text} ${delta}`;
  return text + delta;
}

/** Map (userId, agentGroupId) → deterministic web platform_id. */
function platformIdFor(userId: string, agentGroupId: string): string {
  return `${userId}#${agentGroupId}`;
}

/**
 * Idempotently ensure a `web` messaging group exists for this (user, agent
 * group) and is wired to that agent group. Returns the messaging_group id.
 */
function ensureWebMessagingGroup(userId: string, agentGroupId: string): string {
  const platformId = platformIdFor(userId, agentGroupId);
  let mg = getMessagingGroupByPlatform(WEB_CHANNEL_TYPE, platformId);
  if (!mg) {
    const id = `mg-web-${crypto.randomBytes(6).toString('hex')}`;
    createMessagingGroup({
      id,
      channel_type: WEB_CHANNEL_TYPE,
      platform_id: platformId,
      name: null,
      is_group: 0,
      unknown_sender_policy: 'request_approval',
      denied_at: null,
      created_at: new Date().toISOString(),
    });
    mg = getMessagingGroupByPlatform(WEB_CHANNEL_TYPE, platformId)!;
  }
  const wired = getMessagingGroupAgents(mg.id).some((a) => a.agent_group_id === agentGroupId);
  if (!wired) {
    createMessagingGroupAgent({
      id: `mga-web-${crypto.randomBytes(6).toString('hex')}`,
      messaging_group_id: mg.id,
      agent_group_id: agentGroupId,
      engage_mode: 'pattern',
      engage_pattern: '.',
      sender_scope: 'all',
      ignored_message_policy: 'drop',
      session_mode: 'per-thread',
      priority: 0,
      created_at: new Date().toISOString(),
    });
  }
  return mg.id;
}

function userOwnsWebThread(userId: string, agentGroupId: string, threadId: string): boolean {
  const platformId = platformIdFor(userId, agentGroupId);
  const senderMg = getMessagingGroupByPlatform(WEB_CHANNEL_TYPE, platformId);
  const existingCount = (
    getDb()
      .prepare('SELECT count(*) AS n FROM sessions WHERE agent_group_id = ? AND thread_id = ?')
      .get(agentGroupId, threadId) as { n: number }
  ).n;
  if (existingCount === 0) return true;
  const senderOwns = senderMg
    ? (getDb()
        .prepare(
          'SELECT 1 AS x FROM sessions WHERE agent_group_id = ? AND thread_id = ? AND messaging_group_id = ? LIMIT 1',
        )
        .get(agentGroupId, threadId, senderMg.id) as { x: number } | undefined)
    : undefined;
  return !!senderOwns;
}

interface ChatContext {
  userId: string;
  groupId: string;
  platformId: string;
  threadId: string;
}

/**
 * Match `/api/groups/<groupId>/chat/...` (after the mount prefix has been
 * stripped). Returns null if not a chat path.
 */
export function matchChatPath(
  pathname: string,
):
  | { kind: 'start'; groupId: string }
  | { kind: 'send'; groupId: string; threadId: string }
  | { kind: 'history'; groupId: string; threadId: string }
  | { kind: 'threads'; groupId: string }
  | { kind: 'search'; groupId: string }
  | { kind: 'delete'; groupId: string; threadId: string }
  | { kind: 'voice-transcribe'; groupId: string; threadId: string }
  | { kind: 'attachment'; groupId: string; threadId: string; attachmentPath: string }
  | null {
  const start = pathname.match(/^\/api\/groups\/([^/]+)\/chat\/start$/);
  if (start) return { kind: 'start', groupId: start[1] };
  const threads = pathname.match(/^\/api\/groups\/([^/]+)\/chat\/threads$/);
  if (threads) return { kind: 'threads', groupId: threads[1] };
  const search = pathname.match(/^\/api\/groups\/([^/]+)\/chat\/search$/);
  if (search) return { kind: 'search', groupId: decodeURIComponent(search[1]) };
  const voiceTranscribe = pathname.match(/^\/api\/groups\/([^/]+)\/chat\/([^/]+)\/voice\/transcribe$/);
  if (voiceTranscribe)
    return {
      kind: 'voice-transcribe',
      groupId: decodeURIComponent(voiceTranscribe[1]),
      threadId: decodeURIComponent(voiceTranscribe[2]),
    };
  const attachment = pathname.match(/^\/api\/groups\/([^/]+)\/chat\/([^/]+)\/attachments\/(.+)$/);
  if (attachment)
    return {
      kind: 'attachment',
      groupId: decodeURIComponent(attachment[1]),
      threadId: decodeURIComponent(attachment[2]),
      attachmentPath: decodeURIComponent(attachment[3]),
    };
  const send = pathname.match(/^\/api\/groups\/([^/]+)\/chat\/([^/]+)\/send$/);
  if (send) return { kind: 'send', groupId: decodeURIComponent(send[1]), threadId: decodeURIComponent(send[2]) };
  const hist = pathname.match(/^\/api\/groups\/([^/]+)\/chat\/([^/]+)\/history$/);
  if (hist) return { kind: 'history', groupId: decodeURIComponent(hist[1]), threadId: decodeURIComponent(hist[2]) };
  const del = pathname.match(/^\/api\/groups\/([^/]+)\/chat\/([^/]+)$/);
  if (del) return { kind: 'delete', groupId: decodeURIComponent(del[1]), threadId: decodeURIComponent(del[2]) };
  return null;
}

function writeJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    // All chat-api responses are dynamic per-user state; the browser
    // (especially on mobile after backgrounding) was serving stale
    // /history responses from cache on visibility-resume catchup,
    // so the just-arrived agent reply wasn't visible until a hard
    // reload. no-store is the right tier for this content.
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(body));
}

async function readJsonBody(req: http.IncomingMessage, max = 64 * 1024): Promise<unknown> {
  const chunks: Buffer[] = [];
  let n = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    n += buf.length;
    if (n > max) throw new Error('body_too_large');
    chunks.push(buf);
  }
  if (n === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

/** Limits for multipart chat uploads. Tweak if needed; mirrors the
 * documented design (per-file 25 MB, per-message 50 MB, max 10 files). */
const UPLOAD_MAX_FILE_SIZE = 25 * 1024 * 1024;
const UPLOAD_MAX_TOTAL_SIZE = 50 * 1024 * 1024;
const UPLOAD_MAX_FILES = 10;
const UPLOAD_MAX_FILENAME = 255;

interface ParsedUpload {
  text: string;
  files: { filename: string; contentType: string; buffer: Buffer }[];
}

/**
 * Parse a `multipart/form-data` body for the chat send endpoint.
 * Resolves with the accumulated text + files; rejects with a tagged error
 * for size/count violations (caller maps these to HTTP status codes).
 */
function readMultipartBody(req: http.IncomingMessage): Promise<ParsedUpload> {
  return new Promise((resolve, reject) => {
    let bb: ReturnType<typeof Busboy>;
    try {
      bb = Busboy({
        headers: req.headers,
        limits: {
          fileSize: UPLOAD_MAX_FILE_SIZE,
          files: UPLOAD_MAX_FILES,
          fields: 4,
          fieldNameSize: 64,
          fieldSize: 64 * 1024,
        },
      });
    } catch (err) {
      reject(Object.assign(new Error('invalid_multipart'), { detail: (err as Error).message }));
      return;
    }
    const out: ParsedUpload = { text: '', files: [] };
    let totalBytes = 0;
    let aborted = false;
    const fail = (code: string, detail?: string) => {
      if (aborted) return;
      aborted = true;
      req.unpipe(bb);
      req.resume();
      reject(Object.assign(new Error(code), detail ? { detail } : {}));
    };

    bb.on('field', (name, value) => {
      if (name === 'text' && typeof value === 'string') out.text = value;
    });
    bb.on('file', (_name, stream, info) => {
      const rawName = info.filename || 'upload';
      const filename = rawName.slice(0, UPLOAD_MAX_FILENAME);
      const contentType = info.mimeType || 'application/octet-stream';
      const chunks: Buffer[] = [];
      stream.on('data', (chunk: Buffer) => {
        if (aborted) return;
        totalBytes += chunk.length;
        if (totalBytes > UPLOAD_MAX_TOTAL_SIZE) {
          stream.resume();
          fail('total_too_large');
          return;
        }
        chunks.push(chunk);
      });
      stream.on('limit', () => fail('file_too_large', `file=${filename}`));
      stream.on('end', () => {
        if (aborted) return;
        out.files.push({ filename, contentType, buffer: Buffer.concat(chunks) });
      });
    });
    bb.on('filesLimit', () => fail('too_many_files'));
    bb.on('error', (err) => fail('multipart_error', (err as Error).message));
    bb.on('close', () => {
      if (aborted) return;
      resolve(out);
    });
    req.pipe(bb);
  });
}

/** REST handlers. Returns true if the path was a chat route. */
export async function handleChatRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pathname: string,
  userId: string,
): Promise<boolean> {
  const m = matchChatPath(pathname);
  if (!m) return false;

  const access = canAccessAgentGroup(userId, m.groupId);
  if (!access.allowed) {
    writeJson(res, 403, { error: 'forbidden' });
    return true;
  }
  if (!getAgentGroup(m.groupId)) {
    writeJson(res, 404, { error: 'group_not_found' });
    return true;
  }

  if (m.kind === 'start') {
    if (req.method !== 'POST') {
      writeJson(res, 405, { error: 'method_not_allowed' });
      return true;
    }
    ensureWebMessagingGroup(userId, m.groupId);
    const threadId = crypto.randomUUID();
    writeJson(res, 200, { threadId, platformId: platformIdFor(userId, m.groupId) });
    return true;
  }

  if (m.kind === 'send') {
    if (req.method !== 'POST') {
      writeJson(res, 405, { error: 'method_not_allowed' });
      return true;
    }
    const ctype = (req.headers['content-type'] || '').toLowerCase();
    let text = '';
    let attachments: { filename: string; contentType: string; data: string; size: number }[] = [];
    if (ctype.startsWith('multipart/form-data')) {
      try {
        const parsed = await readMultipartBody(req);
        text = parsed.text;
        attachments = parsed.files.map((f) => ({
          filename: f.filename,
          contentType: f.contentType,
          data: f.buffer.toString('base64'),
          size: f.buffer.length,
        }));
      } catch (err) {
        const code = (err as Error).message;
        const status =
          code === 'file_too_large' || code === 'total_too_large' ? 413 : code === 'too_many_files' ? 400 : 400;
        writeJson(res, status, { error: code, detail: (err as { detail?: string }).detail });
        return true;
      }
    } else {
      let body: unknown;
      try {
        body = await readJsonBody(req);
      } catch (err) {
        writeJson(res, 400, { error: 'invalid_body', detail: (err as Error).message });
        return true;
      }
      const t = (body as { text?: unknown })?.text;
      if (typeof t === 'string') text = t;
    }
    if (!text && attachments.length === 0) {
      writeJson(res, 400, { error: 'empty_message' });
      return true;
    }

    // Cross-channel send: when the client passes ?channel=&mg=, dispatch
    // through that channel's adapter.deliver instead of the web inbound
    // path. The web case stays separate because web has no platform-side
    // delivery — the agent's reply IS the platform message.
    const q = new URLSearchParams((req.url || '').split('?')[1] || '');
    const qChannel = q.get('channel') || undefined;
    const qMg = q.get('mg') || undefined;

    if (qChannel && qMg && qChannel !== WEB_CHANNEL_TYPE) {
      try {
        const id = await sendViaChannelAdapter({
          userId,
          agentGroupId: m.groupId,
          threadId: m.threadId,
          channelType: qChannel,
          messagingGroupId: qMg,
          text,
          attachments,
        });
        writeJson(res, 200, { id });
      } catch (err) {
        const code = (err as Error).message;
        const status = code.startsWith('http_') ? Number(code.slice(5)) : 500;
        log.warn('cross-channel chat send failed', { userId, groupId: m.groupId, channel: qChannel, err });
        writeJson(res, Number.isFinite(status) ? status : 500, {
          error: code || 'send_failed',
          detail: (err as { detail?: string }).detail,
        });
      }
      return true;
    }

    ensureWebMessagingGroup(userId, m.groupId);
    const platformId = platformIdFor(userId, m.groupId);
    // Spectator guard: if a session already exists for this (agentGroup,
    // threadId) but none of them belong to the sender's mg, the sender
    // is trying to write into someone else's thread. Refuse rather than
    // minting a polluting session in the sender's mg with a borrowed
    // thread UUID. (Cross-channel sends are already guarded by
    // userOwnsMessagingGroup inside sendViaChannelAdapter.)
    if (!userOwnsWebThread(userId, m.groupId, m.threadId)) {
      writeJson(res, 403, { error: 'not_owner_of_thread' });
      return true;
    }
    try {
      const id = await submitWebInbound({
        userId,
        platformId,
        threadId: m.threadId,
        text,
        attachments: attachments.length > 0 ? attachments : undefined,
      });
      writeJson(res, 200, { id });
    } catch (err) {
      log.error('web chat send failed', { userId, groupId: m.groupId, err });
      writeJson(res, 500, { error: 'send_failed' });
    }
    return true;
  }

  if (m.kind === 'voice-transcribe') {
    if (req.method !== 'POST') {
      writeJson(res, 405, { error: 'method_not_allowed' });
      return true;
    }
    const cfg = getContainerConfig(m.groupId);
    if (!cfg || cfg.voice_mode !== 'transcribe') {
      writeJson(res, 400, { error: 'voice_disabled' });
      return true;
    }
    if (!userOwnsWebThread(userId, m.groupId, m.threadId)) {
      writeJson(res, 403, { error: 'not_owner_of_thread' });
      return true;
    }
    try {
      const parsed = await readMultipartBody(req);
      const file = parsed.files[0];
      if (!file || !file.contentType.startsWith('audio/')) {
        writeJson(res, 400, { error: 'audio_file_required' });
        return true;
      }
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      let fullText = '';
      try {
        // Scope transcription credentials to the agent group: the OneCLI
        // proxy injects whichever vault entries that agent has access to.
        // Mirrors container-runner.ts — identifier is always agentGroup.id.
        const group = getAgentGroup(m.groupId);
        if (group) await ensureOneCliAgent(group.name, group.id);
        for await (const delta of streamTranscribe(file.buffer, file.contentType, cfg.transcription_model, m.groupId)) {
          const nextText = appendTranscriptDelta(fullText, delta);
          const normalizedDelta = nextText.slice(fullText.length);
          fullText = nextText;
          res.write(`event: partial\ndata: ${JSON.stringify({ text: normalizedDelta })}\n\n`);
        }
        res.write(`event: done\ndata: ${JSON.stringify({ text: fullText })}\n\n`);
        res.end();
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'transcription_failed';
        res.write(`event: error\ndata: ${JSON.stringify({ error: msg })}\n\n`);
        res.end();
      }
    } catch (err) {
      const code = (err as Error).message;
      const status =
        code === 'file_too_large' || code === 'total_too_large' ? 413 : code === 'too_many_files' ? 400 : 400;
      writeJson(res, status, { error: code });
    }
    return true;
  }

  if (m.kind === 'attachment') {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      writeJson(res, 405, { error: 'method_not_allowed' });
      return true;
    }
    if (!userOwnsWebThread(userId, m.groupId, m.threadId)) {
      writeJson(res, 403, { error: 'not_owner_of_thread' });
      return true;
    }
    serveInboundAttachment(req, res, userId, m.groupId, m.threadId, m.attachmentPath);
    return true;
  }

  if (m.kind === 'history') {
    if (req.method !== 'GET') {
      writeJson(res, 405, { error: 'method_not_allowed' });
      return true;
    }
    const q = new URLSearchParams((req.url || '').split('?')[1] || '');
    const qChannel = q.get('channel') || undefined;
    const qMg = q.get('mg') || undefined;
    const override = qChannel && qMg ? { channelType: qChannel, messagingGroupId: qMg } : undefined;
    try {
      const cfg = getContainerConfig(m.groupId);
      const voiceMode = await reconcileVoiceMode(m.groupId, cfg);
      const messages = readChatHistory(userId, m.groupId, m.threadId, override);
      writeJson(res, 200, { messages, voiceMode });
    } catch (err) {
      log.warn('web chat history read failed', { userId, groupId: m.groupId, threadId: m.threadId, err });
      writeJson(res, 200, { messages: [], voiceMode: 'off' });
    }
    return true;
  }

  if (m.kind === 'threads') {
    if (req.method !== 'GET') {
      writeJson(res, 405, { error: 'method_not_allowed' });
      return true;
    }
    try {
      // Elevated users (owner/global admin) see every thread in the
      // group; everyone else sees only their own.
      const threads = isElevated(userId)
        ? listAllThreadsForAgentGroup(m.groupId)
        : listAllThreadsForUser(userId, m.groupId);
      writeJson(res, 200, { threads });
    } catch (err) {
      log.warn('web chat threads list failed', { userId, groupId: m.groupId, err });
      writeJson(res, 200, { threads: [] });
    }
    return true;
  }

  if (m.kind === 'search') {
    if (req.method !== 'GET') {
      writeJson(res, 405, { error: 'method_not_allowed' });
      return true;
    }
    const q = new URLSearchParams((req.url || '').split('?')[1] || '');
    const query = q.get('q') || '';
    if (!query.trim()) {
      writeJson(res, 200, { results: [] });
      return true;
    }
    try {
      // Elevated users search all messaging groups; everyone else is
      // scoped to their own contexts.
      const elevated = isElevated(userId);
      let mgIds: string[] | undefined;
      if (!elevated) {
        const contexts = listUserMessagingContexts(userId, m.groupId);
        const ids = contexts.map((c) => c.messagingGroupId).filter(Boolean) as string[];
        mgIds = ids.length > 0 ? ids : ['__none__'];
      }
      const results = searchMessages(query, {
        agentGroupId: m.groupId,
        messagingGroupIds: mgIds,
      });
      writeJson(res, 200, { results });
    } catch (err) {
      log.warn('web chat search failed', { userId, groupId: m.groupId, query, err });
      writeJson(res, 200, { results: [] });
    }
    return true;
  }

  if (m.kind === 'delete') {
    if (req.method !== 'DELETE') {
      writeJson(res, 405, { error: 'method_not_allowed' });
      return true;
    }
    try {
      const removed = deleteChatThread(userId, m.groupId, m.threadId);
      writeJson(res, removed ? 200 : 404, { ok: removed });
    } catch (err) {
      log.warn('web chat thread delete failed', { userId, groupId: m.groupId, threadId: m.threadId, err });
      writeJson(res, 500, { error: 'delete_failed' });
    }
    return true;
  }

  return false;
}

export interface TurnUsageDto {
  cost_usd: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  reasoning_tokens?: number;
  model: string;
  context_window?: number;
  max_output_tokens?: number;
  duration_ms?: number;
}

export interface HistoryMessage {
  direction: 'in' | 'out' | 'internal' | 'event';
  // messages_in.id / messages_out.id — stable per-row id the client uses
  // as the dedup key against live WS pushes.
  id: string;
  timestamp: string;
  text: string;
  files?: { filename: string; size: number; path?: string; url?: string; contentType?: string }[];
  usage?: TurnUsageDto;
  /** Persisted activity trace (tool calls / progress steps) for this turn,
   *  in emit order. Present on outbound messages that recorded a trace. */
  activity?: { ts: string; text: string }[];
  /** Non-chat timeline event (e.g. a scheduled task firing). Present only
   *  when `direction === 'event'`; drives distinct rendering client-side. */
  event?: { kind: 'task-run'; taskId?: string; summary: string; recurrence?: string | null };
}

/**
 * Look up `turn_usage` for a single outbound message id. Used by the live
 * WS subscriber to push usage to the client as soon as it's written —
 * without this, usage only appears after the next REST `/history` fetch
 * (i.e. on page reload).
 */
export function readTurnUsageForOutbound(
  agentGroupId: string,
  sessionId: string,
  messageOutId: string,
): TurnUsageDto | undefined {
  try {
    const outDb = openOutboundDb(agentGroupId, sessionId);
    try {
      const row = outDb
        .prepare(
          `SELECT cost_usd, input_tokens, output_tokens,
                  cache_read_tokens, cache_write_tokens, reasoning_tokens,
                  model, context_window, max_output_tokens, duration_ms
             FROM turn_usage WHERE message_out_id = ?`,
        )
        .get(messageOutId) as
        | {
            cost_usd: number;
            input_tokens: number;
            output_tokens: number;
            cache_read_tokens: number;
            cache_write_tokens: number;
            reasoning_tokens: number | null;
            model: string;
            context_window: number | null;
            max_output_tokens: number | null;
            duration_ms: number | null;
          }
        | undefined;
      if (!row) return undefined;
      return {
        cost_usd: row.cost_usd,
        input_tokens: row.input_tokens,
        output_tokens: row.output_tokens,
        cache_read_tokens: row.cache_read_tokens,
        cache_write_tokens: row.cache_write_tokens,
        ...(row.reasoning_tokens != null ? { reasoning_tokens: row.reasoning_tokens } : {}),
        model: row.model,
        ...(row.context_window != null ? { context_window: row.context_window } : {}),
        ...(row.max_output_tokens != null ? { max_output_tokens: row.max_output_tokens } : {}),
        ...(row.duration_ms != null ? { duration_ms: row.duration_ms } : {}),
      };
    } finally {
      outDb.close();
    }
  } catch {
    // outbound DB or turn_usage table may not exist
    return undefined;
  }
}

/**
 * Read merged inbound + outbound history for a (user, group, thread) from
 * the session DBs. Returns [] if no session exists yet.
 *
 * `override` lets the caller target a non-web messaging group; without it
 * defaults to the per-user web messaging group (legacy behavior).
 *
 * For elevated users (owner/global admin), the ownership check on the
 * target messaging group is skipped so they can read history of threads
 * they don't participate in. DM viewer-handle scoping is also skipped
 * so threadless DMs come through in full.
 */
export function readChatHistory(
  userId: string,
  groupId: string,
  threadId: string,
  override?: { channelType: string; messagingGroupId: string },
): HistoryMessage[] {
  const elevated = isElevated(userId);
  const target = resolveTargetMessagingGroup(userId, groupId, override, elevated);
  if (!target) return [];
  // Threadless DM rooms (e.g. Telegram 1:1) use a synthetic `__dm:<mg>`
  // threadId. The session-lookup wants thread_id=null and the message
  // queries need `thread_id IS NULL`. We also scope by the viewer's
  // platform_id(s) so DMs from other users sharing the mg don't leak —
  // unless the viewer is elevated, in which case all DMs in the mg are
  // returned.
  const isDm = threadId.startsWith('__dm:');
  const session = resolveSessionForMode(groupId, target.messagingGroupId, target.sessionMode, isDm ? '' : threadId);
  if (!session) return [];
  const viewerHandles = isDm && !elevated ? viewerHandlesForChannel(userId, target.channelType) : [];
  if (isDm && !elevated && viewerHandles.length === 0) return [];

  const messages: HistoryMessage[] = [];
  try {
    const inDb = openInboundDb(groupId, session.id);
    try {
      let rows: { id: string; timestamp: string; content: string }[];
      if (isDm && elevated) {
        rows = inDb
          .prepare(
            'SELECT id, timestamp, content FROM messages_in WHERE channel_type = ? AND thread_id IS NULL ORDER BY seq',
          )
          .all(target.channelType) as { id: string; timestamp: string; content: string }[];
      } else if (isDm) {
        rows = inDb
          .prepare(
            `SELECT id, timestamp, content FROM messages_in
              WHERE channel_type = ? AND thread_id IS NULL
                AND platform_id IN (${viewerHandles.map(() => '?').join(',')})
              ORDER BY seq`,
          )
          .all(target.channelType, ...viewerHandles) as { id: string; timestamp: string; content: string }[];
      } else {
        rows = inDb
          .prepare(
            'SELECT id, timestamp, content FROM messages_in WHERE channel_type = ? AND thread_id = ? ORDER BY seq',
          )
          .all(target.channelType, threadId) as { id: string; timestamp: string; content: string }[];
      }
      // Router namespaces ids as `<rawId>:<agentGroupId>` when writing
      // into per-agent session DBs (router.ts messageIdForAgent), but the
      // live WS echo from submitWebInbound sends the raw `<rawId>`. If we
      // leak the namespaced form to the client the dedup key (direction:id)
      // mismatches and the user's own message paints twice on visibility
      // resume. Strip the suffix here so history matches the echo.
      const suffix = `:${groupId}`;
      for (const r of rows) {
        const parsed = parseInboundContent(r.content, groupId, threadId, target.channelType === WEB_CHANNEL_TYPE);
        if (parsed != null) {
          const id = r.id.endsWith(suffix) ? r.id.slice(0, -suffix.length) : r.id;
          // HA replays the full transcript on every turn (see buildTurn);
          // show only the user's actual query in the UI.
          const text = target.channelType === HA_CHANNEL_TYPE ? extractDisplayQuery(parsed.text) : parsed.text;
          messages.push({ direction: 'in', id, timestamp: r.timestamp, text, files: parsed.files });
        }
      }
    } finally {
      inDb.close();
    }
  } catch {
    // inbound DB may not exist
  }

  try {
    const outDb = openOutboundDb(groupId, session.id);
    try {
      const rows = isDm
        ? (outDb
            .prepare(
              `SELECT id, timestamp, kind, content FROM messages_out
                WHERE channel_type = ? AND thread_id IS NULL ORDER BY seq`,
            )
            .all(target.channelType) as { id: string; timestamp: string; kind: string; content: string }[])
        : (outDb
            .prepare(
              'SELECT id, timestamp, kind, content FROM messages_out WHERE channel_type = ? AND thread_id = ? ORDER BY seq',
            )
            .all(target.channelType, threadId) as { id: string; timestamp: string; kind: string; content: string }[]);

      // Load turn_usage for all outbound messages in one query.
      const outIds = rows.filter((r) => r.kind === 'chat' || r.kind === 'text').map((r) => r.id);
      const usageMap = new Map<string, TurnUsageDto>();
      if (outIds.length > 0) {
        try {
          const usageRows = outDb
            .prepare(
              `SELECT message_out_id, cost_usd, input_tokens, output_tokens,
                      cache_read_tokens, cache_write_tokens, reasoning_tokens,
                      model, context_window, max_output_tokens, duration_ms
               FROM turn_usage WHERE message_out_id IN (${outIds.map(() => '?').join(',')})`,
            )
            .all(...outIds) as Array<{
            message_out_id: string;
            cost_usd: number;
            input_tokens: number;
            output_tokens: number;
            cache_read_tokens: number;
            cache_write_tokens: number;
            reasoning_tokens: number | null;
            model: string;
            context_window: number | null;
            max_output_tokens: number | null;
            duration_ms: number | null;
          }>;
          for (const u of usageRows) {
            usageMap.set(u.message_out_id, {
              cost_usd: u.cost_usd,
              input_tokens: u.input_tokens,
              output_tokens: u.output_tokens,
              cache_read_tokens: u.cache_read_tokens,
              cache_write_tokens: u.cache_write_tokens,
              ...(u.reasoning_tokens != null ? { reasoning_tokens: u.reasoning_tokens } : {}),
              model: u.model,
              ...(u.context_window != null ? { context_window: u.context_window } : {}),
              ...(u.max_output_tokens != null ? { max_output_tokens: u.max_output_tokens } : {}),
              ...(u.duration_ms != null ? { duration_ms: u.duration_ms } : {}),
            });
          }
        } catch {
          // turn_usage table may not exist in older outbound.db files
        }
      }

      // Load turn_activity for all outbound messages in one query, grouped
      // by message id in append order. Older outbound.db files predate the
      // table — swallow the error and render without traces.
      const activityMap = new Map<string, { ts: string; text: string }[]>();
      if (outIds.length > 0) {
        try {
          const actRows = outDb
            .prepare(
              `SELECT message_out_id, ts, text FROM turn_activity
                WHERE message_out_id IN (${outIds.map(() => '?').join(',')})
                ORDER BY message_out_id, ordinal`,
            )
            .all(...outIds) as Array<{ message_out_id: string; ts: string; text: string }>;
          for (const a of actRows) {
            let arr = activityMap.get(a.message_out_id);
            if (!arr) {
              arr = [];
              activityMap.set(a.message_out_id, arr);
            }
            arr.push({ ts: a.ts, text: a.text });
          }
        } catch {
          // turn_activity table may not exist in older outbound.db files
        }
      }

      for (const r of rows) {
        if (r.kind === 'internal') {
          const parsed = parseOutboundContent(r.content);
          messages.push({
            direction: 'internal',
            id: r.id,
            timestamp: r.timestamp,
            text: parsed.text,
            files: parsed.files,
          });
          continue;
        }
        if (r.kind === 'chat-sdk') {
          // Structured interactive messages (ask_question, send_card).
          // Render as a plain text bubble using the question text or card fallback.
          let text = '';
          try {
            const c = JSON.parse(r.content) as {
              type?: string;
              title?: string;
              question?: string;
              fallbackText?: string;
            };
            if (c?.type === 'ask_question') {
              text = c.question || c.title || '';
            } else if (c?.type === 'card') {
              text = c.fallbackText || '';
            }
          } catch {
            /* ignore */
          }
          if (text) {
            messages.push({
              direction: 'out',
              id: r.id,
              timestamp: r.timestamp,
              text,
              files: undefined,
            });
          }
          continue;
        }
        if (r.kind !== 'chat' && r.kind !== 'text') continue;
        const parsed = parseOutboundContent(r.content);
        const usage = usageMap.get(r.id);
        const activity = activityMap.get(r.id);
        messages.push({
          direction: 'out',
          id: r.id,
          timestamp: r.timestamp,
          text: parsed.text,
          files: parsed.files,
          ...(usage ? { usage } : {}),
          ...(activity && activity.length > 0 ? { activity } : {}),
        });
      }
    } finally {
      outDb.close();
    }
  } catch {
    // outbound DB may not exist
  }

  // Scheduled-task firings: completed `kind='task'` rows are the record of
  // a schedule waking this session. They carry no chat text (parseInbound
  // skips them), so surface each as a distinct timeline "event" bubble so
  // the user can see why an otherwise-quiet thread keeps looking active.
  try {
    const inDb = openInboundDb(groupId, session.id);
    try {
      const taskRows = isDm
        ? (inDb
            .prepare(
              `SELECT id, timestamp, content, recurrence, series_id FROM messages_in
                WHERE kind = 'task' AND status = 'completed'
                  AND channel_type = ? AND thread_id IS NULL ORDER BY seq`,
            )
            .all(target.channelType) as {
            id: string;
            timestamp: string;
            content: string;
            recurrence: string | null;
            series_id: string | null;
          }[])
        : (inDb
            .prepare(
              `SELECT id, timestamp, content, recurrence, series_id FROM messages_in
                WHERE kind = 'task' AND status = 'completed'
                  AND channel_type = ? AND thread_id = ? ORDER BY seq`,
            )
            .all(target.channelType, threadId) as {
            id: string;
            timestamp: string;
            content: string;
            recurrence: string | null;
            series_id: string | null;
          }[]);
      for (const r of taskRows) {
        const summary = summarizeTaskPrompt(r.content);
        messages.push({
          direction: 'event',
          id: r.id,
          timestamp: r.timestamp,
          text: `Scheduled task ran: ${summary}`,
          event: {
            kind: 'task-run',
            ...(r.series_id ? { taskId: r.series_id } : {}),
            summary,
            ...(r.recurrence ? { recurrence: r.recurrence } : {}),
          },
        });
      }
    } finally {
      inDb.close();
    }
  } catch {
    // inbound DB may not exist
  }

  messages.sort((a, b) => Date.parse(normTs(a.timestamp)) - Date.parse(normTs(b.timestamp)));
  return messages;
}

/**
 * Resolve the (channelType, messagingGroupId, sessionMode) the user is
 * targeting. If `override` is provided, authorize that user is the
 * counterparty of that messaging group (web ownership or `user_dms`
 * entry). Elevated users skip the ownership check. Returns null on
 * auth failure or unknown mg.
 */
function resolveTargetMessagingGroup(
  userId: string,
  agentGroupId: string,
  override: { channelType: string; messagingGroupId: string } | undefined,
  elevated: boolean,
): { channelType: string; messagingGroupId: string; sessionMode: 'per-thread' | 'shared' | 'agent-shared' } | null {
  if (!override) {
    // Without an explicit mg, default to the viewer's own web mg (if any)
    // — elevated users can specify a different mg via override to peek at
    // someone else's thread.
    const platformId = platformIdFor(userId, agentGroupId);
    const mg = getMessagingGroupByPlatform(WEB_CHANNEL_TYPE, platformId);
    if (!mg) return null;
    return { channelType: WEB_CHANNEL_TYPE, messagingGroupId: mg.id, sessionMode: 'per-thread' };
  }
  // Override path: require ownership unless the caller is elevated.
  if (!elevated && !userOwnsMessagingGroup(userId, agentGroupId, override.channelType, override.messagingGroupId)) {
    return null;
  }
  const mga = getMessagingGroupAgentByPair(override.messagingGroupId, agentGroupId);
  if (!mga) return null;
  const mode = (mga.session_mode || 'per-thread') as 'per-thread' | 'shared' | 'agent-shared';
  return { channelType: override.channelType, messagingGroupId: override.messagingGroupId, sessionMode: mode };
}

/** Authorize: viewer is the counterparty of this messaging group. */
function userOwnsMessagingGroup(userId: string, agentGroupId: string, channelType: string, mgId: string): boolean {
  if (channelType === WEB_CHANNEL_TYPE) {
    const platformId = platformIdFor(userId, agentGroupId);
    const mg = getMessagingGroupByPlatform(WEB_CHANNEL_TYPE, platformId);
    return mg?.id === mgId;
  }
  // Accept either a user_dms row OR a userId whose channel prefix matches
  // the mg's channel and which is wired to this agent group. The latter
  // covers email-bot-style aliases where the cold-DM cache isn't written.
  const dmRow = getDb()
    .prepare('SELECT 1 FROM user_dms WHERE user_id = ? AND channel_type = ? AND messaging_group_id = ?')
    .get(userId, channelType, mgId);
  if (dmRow) return true;
  const viewerHandles = viewerHandlesForChannel(userId, channelType);
  if (viewerHandles.length === 0) return false;
  const mgaRow = getDb()
    .prepare(
      `SELECT 1 FROM messaging_group_agents mga
         JOIN messaging_groups mg ON mg.id = mga.messaging_group_id
        WHERE mga.messaging_group_id = ? AND mga.agent_group_id = ? AND mg.channel_type = ?`,
    )
    .get(mgId, agentGroupId, channelType);
  return !!mgaRow;
}

function resolveSessionForMode(
  agentGroupId: string,
  messagingGroupId: string,
  sessionMode: 'per-thread' | 'shared' | 'agent-shared',
  threadId: string,
): { id: string } | undefined {
  // Look up the session that actually holds this thread's messages.
  // Order matters: a per-thread session for (ag, mg, threadId) is the
  // most specific match. Otherwise a shared session for (ag, mg) holds
  // every thread for that mg. Finally an agent-shared session (mg NULL)
  // is the fallback. Each step is scoped, so we never return a session
  // that belongs to a different messaging group.
  void sessionMode;
  return (
    findSessionForAgent(agentGroupId, messagingGroupId, threadId) ||
    findSessionForAgent(agentGroupId, messagingGroupId, null) ||
    findSessionByAgentGroup(agentGroupId)
  );
}

/**
 * Cross-channel web send: ship the viewer's message out through the
 * named channel's existing adapter.deliver, then log it as an inbound
 * row with trigger=0 (the agent sees it as context on its next natural
 * wake; no auto-response). Throws Error('http_NNN') with optional .detail
 * for the route handler to map to an HTTP status.
 */
async function sendViaChannelAdapter(args: {
  userId: string;
  agentGroupId: string;
  threadId: string;
  channelType: string;
  messagingGroupId: string;
  text: string;
  attachments: { filename: string; contentType: string; data: string; size: number }[];
}): Promise<string> {
  const target = resolveTargetMessagingGroup(
    args.userId,
    args.agentGroupId,
    {
      channelType: args.channelType,
      messagingGroupId: args.messagingGroupId,
    },
    false,
  );
  if (!target) throw Object.assign(new Error('http_403'), { detail: 'not_owner_of_messaging_group' });

  const adapter = getChannelAdapter(args.channelType);
  if (!adapter || !adapter.isConnected()) {
    throw Object.assign(new Error('http_503'), { detail: 'channel_offline' });
  }
  if (!adapter.supportsMultiFile && args.attachments.length > 1) {
    throw Object.assign(new Error('http_400'), { detail: 'multifile_not_supported' });
  }

  // Threadless DM rooms use a synthetic '__dm:<mgId>' threadId in the web
  // UI. Translate to a real null thread before talking to the channel
  // adapter or writing the session message — the platform has no such id.
  const isDm = args.threadId.startsWith('__dm:');
  const realThreadId: string | null = isDm ? null : args.threadId;
  const session = resolveSessionForMode(
    args.agentGroupId,
    target.messagingGroupId,
    target.sessionMode,
    isDm ? '' : args.threadId,
  );
  if (!session) throw Object.assign(new Error('http_409'), { detail: 'no_active_session' });

  const mg = getMessagingGroup(target.messagingGroupId);
  if (!mg) throw Object.assign(new Error('http_404'), { detail: 'messaging_group_not_found' });

  // For DMs, resolve the actual platform_id of the recipient (the viewer's
  // own handle on that channel) — this is who the bot will message.
  let dmPlatformId: string | null = null;
  if (isDm) {
    const handles = viewerHandlesForChannel(args.userId, args.channelType);
    // Prefer the prefixed form the adapter expects (matches mg.platform_id
    // convention on most channels). Fall back to whatever we have.
    dmPlatformId = handles.find((h) => h.startsWith(`${args.channelType}:`)) || handles[0] || null;
    if (!dmPlatformId) throw Object.assign(new Error('http_404'), { detail: 'no_identity_for_channel' });
  }

  const fileBuffers = args.attachments.map((a) => ({
    filename: a.filename,
    data: Buffer.from(a.data, 'base64'),
  }));
  const outbound: OutboundMessage = {
    kind: 'chat',
    content: { text: args.text, files: args.attachments.map((a) => ({ filename: a.filename, size: a.size })) },
    files: fileBuffers.length > 0 ? fileBuffers : undefined,
  };

  // Per-channel UX tweaks before the generic dispatch.
  if (args.channelType === 'resend') {
    const u = getUser(args.userId);
    const fallback = args.userId.includes(':') ? args.userId.split(':')[1] : args.userId;
    const localPart = fallback.split('@')[0] || fallback;
    const displayName = (u?.display_name && u.display_name.trim()) || localPart;
    setResendPendingWebOverride({
      fromName: `${displayName} (via web)`,
      extraHeaders: { 'X-Sent-Via': 'web-ui', 'X-Sent-By': args.userId },
    });
  }

  let platformMsgId: string | undefined;
  try {
    platformMsgId = await adapter.deliver(dmPlatformId || mg.platform_id, realThreadId, outbound);
  } catch (err) {
    // Clear stash even on failure so a later send doesn't pick up stale state.
    if (args.channelType === 'resend') setResendPendingWebOverride({ fromName: null, extraHeaders: null });
    throw Object.assign(new Error('http_500'), { detail: (err as Error).message || 'channel_send_failed' });
  }

  // Log the user's send as an inbound row so the agent acts on it. The
  // host's sweep gates on trigger=1 to wake an idle container; without
  // it, a web-relayed reply that arrives after the container has gone
  // idle just sits in the DB until the next natural wake.
  const id = `web-relay-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const contentPayload: Record<string, unknown> = {
    text: args.text,
    sender: args.userId,
    senderId: args.userId,
    _via: 'web',
    _sender: args.userId,
    _platform_msg_id: platformMsgId,
  };
  if (args.attachments.length > 0) {
    contentPayload.files = args.attachments.map((a) => ({ filename: a.filename, size: a.size }));
  }
  writeSessionMessage(args.agentGroupId, session.id, {
    id,
    kind: 'chat',
    timestamp: new Date().toISOString(),
    platformId: dmPlatformId || mg.platform_id,
    channelType: args.channelType,
    threadId: realThreadId,
    content: JSON.stringify(contentPayload),
    trigger: 1,
  });
  return id;
}

function normTs(s: string): string {
  return s.includes('T') ? s : s.replace(' ', 'T') + 'Z';
}

/**
 * Condense a scheduled-task prompt into a one-line label for the timeline
 * event bubble / thread badge. Tasks store a JSON `{ prompt, script }`
 * blob; we surface the first non-empty line of the prompt, trimmed.
 */
function summarizeTaskPrompt(content: string): string {
  let prompt = '';
  try {
    const o = JSON.parse(content);
    if (typeof o?.prompt === 'string') prompt = o.prompt;
    else if (typeof o === 'string') prompt = o;
  } catch {
    prompt = content;
  }
  const firstLine =
    prompt
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l.length > 0) || 'Scheduled task';
  return firstLine.length > 80 ? firstLine.slice(0, 77) + '\u2026' : firstLine;
}

function encodedAttachmentUrl(groupId: string, threadId: string, localPath: string): string {
  const encodedPath = localPath
    .split('/')
    .map((part) => encodeURIComponent(part))
    .join('/');
  return `api/groups/${encodeURIComponent(groupId)}/chat/${encodeURIComponent(threadId)}/attachments/${encodedPath}`;
}

function parseInboundContent(
  content: string,
  groupId?: string,
  threadId?: string,
  includeAttachmentUrls = false,
): {
  text: string;
  files?: { filename: string; size: number; url?: string; contentType?: string }[];
  viaWeb?: boolean;
} | null {
  try {
    const o = JSON.parse(content);
    if (typeof o === 'string') return { text: o };
    if (typeof o?.text === 'string' || Array.isArray(o?.attachments) || Array.isArray(o?.files)) {
      const text = typeof o?.text === 'string' ? o.text : '';
      // `attachments` for native inbound (base64 + name/mimeType); `files`
      // for web-relayed sends (filename + size only).
      const filesArr = Array.isArray(o?.attachments) ? o.attachments : Array.isArray(o?.files) ? o.files : undefined;
      const files = filesArr
        ? filesArr
            .map(
              (a: {
                filename?: string;
                name?: string;
                data?: string;
                size?: number;
                localPath?: string;
                mimeType?: string;
                contentType?: string;
              }) => {
                const size =
                  typeof a?.size === 'number'
                    ? a.size
                    : typeof a?.data === 'string'
                      ? Math.floor((a.data.length * 3) / 4)
                      : 0;
                const localPath = typeof a?.localPath === 'string' ? a.localPath : undefined;
                const contentType =
                  typeof a?.mimeType === 'string'
                    ? a.mimeType
                    : typeof a?.contentType === 'string'
                      ? a.contentType
                      : undefined;
                return {
                  filename: String(a?.name ?? a?.filename ?? ''),
                  size,
                  ...(includeAttachmentUrls && localPath && groupId && threadId
                    ? { url: encodedAttachmentUrl(groupId, threadId, localPath) }
                    : {}),
                  ...(contentType ? { contentType } : {}),
                };
              },
            )
            .filter((f: { filename: string }) => f.filename)
        : undefined;
      return {
        text,
        files: files && files.length > 0 ? files : undefined,
        viaWeb: o?._via === 'web' || undefined,
      };
    }
  } catch {
    /* not JSON */
  }
  return null;
}

function mimeFromFilename(filename: string): string {
  const ext = filename.toLowerCase().split('.').pop() || '';
  switch (ext) {
    case 'webm':
      return 'audio/webm';
    case 'm4a':
      return 'audio/mp4';
    case 'mp3':
      return 'audio/mpeg';
    case 'ogg':
      return 'audio/ogg';
    case 'wav':
      return 'audio/wav';
    case 'mp4':
      return 'video/mp4';
    case 'mov':
      return 'video/quicktime';
    default:
      return 'application/octet-stream';
  }
}

function serveInboundAttachment(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  userId: string,
  groupId: string,
  threadId: string,
  requestedPath: string,
): void {
  const normalizedPath = path.posix.normalize(requestedPath);
  if (normalizedPath.startsWith('../') || normalizedPath === '..' || path.posix.isAbsolute(normalizedPath)) {
    writeJson(res, 400, { error: 'bad_attachment_path' });
    return;
  }
  const mg = getMessagingGroupByPlatform(WEB_CHANNEL_TYPE, platformIdFor(userId, groupId));
  if (!mg) {
    writeJson(res, 404, { error: 'not_found' });
    return;
  }
  const session = resolveSessionForMode(groupId, mg.id, 'per-thread', threadId);
  if (!session) {
    writeJson(res, 404, { error: 'not_found' });
    return;
  }

  let found: { filename: string; contentType: string } | null = null;
  try {
    const inDb = openInboundDb(groupId, session.id);
    try {
      const rows = inDb
        .prepare('SELECT content FROM messages_in WHERE channel_type = ? AND thread_id = ? ORDER BY seq')
        .all(WEB_CHANNEL_TYPE, threadId) as { content: string }[];
      for (const row of rows) {
        let parsed: { attachments?: unknown };
        try {
          parsed = JSON.parse(row.content) as { attachments?: unknown };
        } catch {
          continue;
        }
        if (!Array.isArray(parsed.attachments)) continue;
        for (const att of parsed.attachments as Array<Record<string, unknown>>) {
          if (att.localPath !== normalizedPath) continue;
          const filename = String(att.name ?? att.filename ?? path.posix.basename(normalizedPath));
          const contentType = typeof att.mimeType === 'string' ? att.mimeType : mimeFromFilename(filename);
          found = { filename, contentType };
          break;
        }
        if (found) break;
      }
    } finally {
      inDb.close();
    }
  } catch {
    // inbound DB may not exist
  }
  if (!found) {
    writeJson(res, 404, { error: 'not_found' });
    return;
  }

  const sessionRoot = sessionDir(groupId, session.id);
  const abs = path.join(sessionRoot, normalizedPath);
  let realAbs: string;
  let stat: fs.Stats;
  try {
    const realRoot = fs.realpathSync(sessionRoot);
    realAbs = fs.realpathSync(abs);
    const rel = path.relative(realRoot, realAbs);
    if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('escaped');
    stat = fs.statSync(realAbs);
    if (!stat.isFile()) throw new Error('not_file');
  } catch {
    writeJson(res, 404, { error: 'not_found' });
    return;
  }

  const range = req.headers.range;
  const headers = {
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'private, max-age=3600',
    'Content-Type': found.contentType,
    'Content-Disposition': `inline; filename="${found.filename.replace(/["\\]/g, '_')}"`,
  };
  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (!match) {
      res.writeHead(416, { ...headers, 'Content-Range': `bytes */${stat.size}` });
      res.end();
      return;
    }
    const start = match[1] ? Number(match[1]) : 0;
    const end = match[2] ? Math.min(Number(match[2]), stat.size - 1) : stat.size - 1;
    if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= stat.size) {
      res.writeHead(416, { ...headers, 'Content-Range': `bytes */${stat.size}` });
      res.end();
      return;
    }
    res.writeHead(206, {
      ...headers,
      'Content-Length': String(end - start + 1),
      'Content-Range': `bytes ${start}-${end}/${stat.size}`,
    });
    if (req.method === 'HEAD') return void res.end();
    fs.createReadStream(realAbs, { start, end }).pipe(res);
    return;
  }

  res.writeHead(200, { ...headers, 'Content-Length': String(stat.size) });
  if (req.method === 'HEAD') return void res.end();
  fs.createReadStream(realAbs).pipe(res);
}

function parseOutboundContent(content: string): {
  text: string;
  files?: { filename: string; size: number; path?: string }[];
} {
  try {
    const o = JSON.parse(content);
    if (typeof o === 'string') return { text: o };
    const text = typeof o?.text === 'string' ? o.text : typeof o?.markdown === 'string' ? o.markdown : '';
    // file_paths is a parallel array to files written by send_file with
    // workspace-relative source paths (or null when the source isn't in
    // /workspace/agent). Lets the chat UI link the chip to the FILES
    // panel without changing the established `files: string[]` contract
    // that delivery / readOutboxFiles depend on.
    const filePaths: (string | null | undefined)[] = Array.isArray(o?.file_paths) ? o.file_paths : [];
    const files = Array.isArray(o?.files)
      ? o.files
          .map((f: { filename?: string; name?: string; size?: number } | string, i: number) => {
            if (typeof f === 'string') {
              const p = filePaths[i];
              return { filename: f, size: 0, path: typeof p === 'string' ? p : undefined };
            }
            const p = filePaths[i];
            return {
              filename: String(f?.filename ?? f?.name ?? ''),
              size: typeof f?.size === 'number' ? f.size : 0,
              path: typeof p === 'string' ? p : undefined,
            };
          })
          .filter((f: { filename: string }) => f.filename)
      : undefined;
    return { text, files };
  } catch {
    return { text: content };
  }
}

export interface ThreadSummary {
  threadId: string;
  sessionId: string;
  channelType: string;
  messagingGroupId: string;
  platformId: string;
  sessionMode: 'per-thread' | 'shared' | 'agent-shared';
  title: string;
  lastActivityAt: string;
  messageCount: number;
  counterparty?: string;
  /** True when the web UI can dispatch a send through this channel's adapter. */
  canSend?: boolean;
  /**
   * 'dm' marks a threadless room — one chat per (channel, mg) with
   * thread_id IS NULL. Rendered in its own section in the rail; not
   * sendable from web (yet).
   */
  kind?: 'thread' | 'dm';
  /** Aggregate cost in USD across all turns in this thread. */
  totalCost?: number;
  /** Aggregate input + output tokens across all turns. */
  totalTokens?: number;
  /** Number of provider turns that have usage data. */
  turnCount?: number;
  /**
   * Present when this thread's session has one or more pending/paused
   * scheduled tasks keeping it alive. Drives the ⏰ badge in the rail so
   * an auto-active thread reads differently from a conversational one.
   */
  liveTask?: LiveTaskDto;
}

/** Summary of the live (pending/paused) scheduled tasks in a thread. */
export interface LiveTaskDto {
  /** How many distinct task series are live in this thread. */
  count: number;
  /** ISO timestamp of the soonest next run across all live tasks. */
  nextRunAt: string | null;
  /** Cron expression of the soonest-next-run task, if recurring. */
  recurrence: string | null;
  /** One-line summary of the soonest-next-run task's prompt. */
  summary: string;
  /** True when the soonest-next-run task is paused rather than pending. */
  paused: boolean;
}

interface UserMessagingContext {
  messagingGroupId: string;
  channelType: string;
  platformId: string;
  sessionMode: 'per-thread' | 'shared' | 'agent-shared';
}

/**
 * For a non-web channel, return every handle the viewer holds on that
 * channel. We look up the `identities` table first (authoritative —
 * works for OIDC-created UUID user IDs and bootstrap `<channel>:<handle>`
 * IDs alike); as a fallback, parse the channel prefix out of legacy
 * `<channel>:<handle>` user IDs in case some identity rows haven't been
 * backfilled. Returns [] when the viewer has no identity on the channel.
 */
function viewerHandlesForChannel(userId: string, channelType: string): string[] {
  if (channelType === WEB_CHANNEL_TYPE) return [];
  // Most channels write `messages_in.platform_id` as `<channel>:<handle>`
  // (matches `messaging_groups.platform_id`); a few write the bare handle.
  // We accept either, so callers don't need to know per-channel quirks.
  const prefix = channelType + ':';
  const withVariants = (h: string, push: (s: string) => void) => {
    if (!h) return;
    push(h);
    if (h.startsWith(prefix)) push(h.slice(prefix.length));
    else push(prefix + h);
  };
  const set = new Set<string>();
  for (const ident of getIdentitiesForUser(userId)) {
    if (ident.channel === channelType && ident.handle) withVariants(ident.handle, (s) => set.add(s));
  }
  if (set.size > 0) return [...set];
  if (userId.startsWith(prefix)) {
    const handle = userId.slice(prefix.length);
    if (handle) withVariants(handle, (s) => set.add(s));
  }
  return [...set];
}

/**
 * All messaging-group contexts the viewer could plausibly have threads
 * in, scoped to one agent group. Always includes the implicit web mg if
 * one exists. For every other mga wired to the agent group, includes the
 * mg iff the viewer's userId carries the matching channel prefix — we
 * don't require a user_dms entry, because email-bot-style adapters don't
 * always write one, and we filter per-thread later by inbound platform_id.
 */
/**
 * Cheap viewer-scoped "does this user have any threads they can see in
 * this group" probe. Used by the dropdown filter so groups the viewer
 * has no actual conversations in are hidden by default. Owners/global
 * admins can still see those groups by enabling the "Show all" toggle
 * (which uses {@link listAllThreadsForAgentGroup} for spectator-mode
 * threads listing).
 *
 * "Content" means "viewer has at least one session in a messaging
 * group they own" — not just "the messaging group exists". A web mg is
 * provisioned eagerly when a user clicks into a group; we only count
 * the group as having content once a session row exists.
 *
 * Non-web channels: we still report `hasContent=true` whenever the
 * viewer has a matching identity AND the (mg, agent_group) pair has
 * any session, even if no thread belongs to the viewer — confirming
 * "you have threads here" via per-thread filtering would require
 * opening every session DB, too expensive for the dropdown.
 */
export function viewerHasContent(userId: string, agentGroupId: string): boolean {
  const ctxs = listUserMessagingContexts(userId, agentGroupId);
  if (ctxs.length === 0) return false;
  // Web contexts always count — the user can start a new thread even
  // without existing sessions. Non-web contexts require a session to
  // exist (we can't know if ANY thread belongs to the viewer without
  // opening every session DB).
  if (ctxs.some((c) => c.channelType === WEB_CHANNEL_TYPE)) return true;
  const stmt = getDb().prepare(
    'SELECT 1 AS x FROM sessions WHERE agent_group_id = ? AND messaging_group_id = ? LIMIT 1',
  );
  for (const ctx of ctxs) {
    if (stmt.get(agentGroupId, ctx.messagingGroupId)) return true;
  }
  // Agent-shared session (no mg link) is shared by everyone with a
  // messaging context, so it also counts.
  if (hasAgentSharedSession(agentGroupId)) return true;
  return false;
}

function listUserMessagingContexts(userId: string, agentGroupId: string): UserMessagingContext[] {
  const out: UserMessagingContext[] = [];
  const seen = new Set<string>();

  // Web: implicit per-(user, agentGroup) mg.
  const webPlatformId = platformIdFor(userId, agentGroupId);
  const webMg = getMessagingGroupByPlatform(WEB_CHANNEL_TYPE, webPlatformId);
  if (webMg) {
    const mga = getMessagingGroupAgentByPair(webMg.id, agentGroupId);
    if (mga) {
      out.push({
        messagingGroupId: webMg.id,
        channelType: WEB_CHANNEL_TYPE,
        platformId: webMg.platform_id,
        sessionMode: (mga.session_mode || 'per-thread') as UserMessagingContext['sessionMode'],
      });
      seen.add(webMg.id);
    }
  }

  // Every other mga wired to this agent group. Include iff the viewer's
  // userId prefix matches the mg's channel.
  type Row = {
    mg_id: string;
    channel_type: string;
    platform_id: string;
    session_mode: string | null;
  };
  const rows = getDb()
    .prepare(
      `SELECT mg.id AS mg_id, mg.channel_type, mg.platform_id, mga.session_mode
         FROM messaging_groups mg
         JOIN messaging_group_agents mga ON mga.messaging_group_id = mg.id
        WHERE mga.agent_group_id = ? AND mg.channel_type != ?`,
    )
    .all(agentGroupId, WEB_CHANNEL_TYPE) as Row[];
  for (const r of rows) {
    if (seen.has(r.mg_id)) continue;
    const viewerHandles = viewerHandlesForChannel(userId, r.channel_type);
    if (viewerHandles.length === 0) continue;
    // platformId on the context is informational — the rail filters per
    // thread against the full handle set, not just this one.
    out.push({
      messagingGroupId: r.mg_id,
      channelType: r.channel_type,
      platformId: viewerHandles[0],
      sessionMode: (r.session_mode || 'per-thread') as UserMessagingContext['sessionMode'],
    });
    seen.add(r.mg_id);
  }
  return out;
}

/** Channel-aware title extraction from an inbound `content` JSON blob. */
function extractTitle(channelType: string, content: string): string {
  if (channelType === 'resend') {
    try {
      const o = JSON.parse(content) as {
        subject?: unknown;
        metadata?: { subject?: unknown };
        headers?: { subject?: unknown };
      };
      const subj = o?.subject ?? o?.metadata?.subject ?? o?.headers?.subject;
      if (typeof subj === 'string' && subj.trim()) return subj.trim();
    } catch {
      /* fall through */
    }
  }
  const parsed = parseInboundContent(content);
  const text = parsed?.text ?? '';
  // HA replays the full transcript on every turn (see buildTurn); strip it
  // so the thread title reflects the user's actual query.
  return channelType === HA_CHANNEL_TYPE ? extractDisplayQuery(text) : text;
}

/** Strip auto-prepended context blockquote + whitespace, cap to 60 chars. */
function finalizeTitle(raw: string): string {
  const cleaned = raw
    .replace(/^>\s*Context.*\n+/i, '')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned ? cleaned.slice(0, 60) : '(new thread)';
}

/**
 * List all chat threads across every messaging group the viewer is in
 * for this agent group. We dispatch based on the actual session rows
 * (whether a session has a thread_id) rather than the configured
 * session_mode, so the listing stays correct when mga.session_mode and
 * the session table have drifted (e.g. mode was changed mid-life).
 */
export function listAllThreadsForUser(userId: string, agentGroupId: string): ThreadSummary[] {
  const ctxs = listUserMessagingContexts(userId, agentGroupId);
  return collectThreadsForContexts(userId, agentGroupId, ctxs, false);
}

/**
 * Spectator view: list every thread for every messaging group wired to
 * this agent group, regardless of viewer ownership. Used by the "Show
 * all" admin toggle so owners/global admins can inspect activity in
 * groups they don't actively participate in. The route handler MUST
 * gate this on `hasAdminPrivilege(userId, agentGroupId)`.
 */
export function listAllThreadsForAgentGroup(agentGroupId: string): ThreadSummary[] {
  // Enumerate every messaging group wired to this agent group, with no
  // viewer-handle filter so all conversations are visible.
  type Row = { mg_id: string; channel_type: string; platform_id: string; session_mode: string | null };
  const rows = getDb()
    .prepare(
      `SELECT mg.id AS mg_id, mg.channel_type, mg.platform_id, mga.session_mode
         FROM messaging_groups mg
         JOIN messaging_group_agents mga ON mga.messaging_group_id = mg.id
        WHERE mga.agent_group_id = ?`,
    )
    .all(agentGroupId) as Row[];
  const ctxs: UserMessagingContext[] = rows.map((r) => ({
    messagingGroupId: r.mg_id,
    channelType: r.channel_type,
    platformId: r.platform_id,
    sessionMode: (r.session_mode || 'per-thread') as UserMessagingContext['sessionMode'],
  }));
  return collectThreadsForContexts('', agentGroupId, ctxs, true);
}

function collectThreadsForContexts(
  userId: string,
  agentGroupId: string,
  ctxs: UserMessagingContext[],
  spectator: boolean,
): ThreadSummary[] {
  const out: ThreadSummary[] = [];

  // Per-mg: any session with thread_id IS NOT NULL is per-thread-style;
  // any session with thread_id IS NULL is shared-style. Either may exist.
  const sharedCtxs: UserMessagingContext[] = [];
  for (const ctx of ctxs) {
    enumeratePerThread(userId, agentGroupId, ctx, out, spectator);
    if (hasSharedSession(agentGroupId, ctx.messagingGroupId)) sharedCtxs.push(ctx);
  }
  for (const ctx of sharedCtxs) enumerateShared(agentGroupId, ctx, out);

  // Threadless DMs: shared sessions where messages_in.thread_id IS NULL.
  // These are e.g. Telegram 1:1 DMs — the channel adapter doesn't
  // synthesize a thread id, so all messages live in a single virtual
  // chat keyed by (mg, viewer platform id).
  for (const ctx of sharedCtxs) enumerateThreadlessDm(userId, agentGroupId, ctx, out, spectator);

  // Agent-shared session (one per agent group, no mg link in sessions).
  if (ctxs.length > 0 && hasAgentSharedSession(agentGroupId)) {
    enumerateAgentShared(agentGroupId, ctxs, out);
  }

  // Stamp canSend by channel — true iff the adapter is registered and
  // connected. Web is always sendable (handled by submitWebInbound).
  const canSendByChannel = new Map<string, boolean>();
  for (const t of out) {
    if (canSendByChannel.has(t.channelType)) continue;
    if (t.channelType === WEB_CHANNEL_TYPE) {
      canSendByChannel.set(t.channelType, true);
    } else {
      const a = getChannelAdapter(t.channelType);
      canSendByChannel.set(t.channelType, !!a && a.isConnected());
    }
  }
  for (const t of out) t.canSend = canSendByChannel.get(t.channelType) === true;

  out.sort((a, b) => Date.parse(normTs(b.lastActivityAt)) - Date.parse(normTs(a.lastActivityAt)));

  // Deduplicate by threadId — keep the entry with the latest activity.
  // This can happen when the same thread_id exists under multiple
  // messaging groups (e.g. user logged in via two identities).
  const seen = new Set<string>();
  const deduped: ThreadSummary[] = [];
  for (const t of out) {
    if (seen.has(t.threadId)) continue;
    seen.add(t.threadId);
    deduped.push(t);
  }
  return deduped;
}

function hasSharedSession(agentGroupId: string, mgId: string): boolean {
  const row = getDb()
    .prepare(
      'SELECT 1 AS x FROM sessions WHERE agent_group_id = ? AND messaging_group_id = ? AND thread_id IS NULL LIMIT 1',
    )
    .get(agentGroupId, mgId);
  return !!row;
}

function hasAgentSharedSession(agentGroupId: string): boolean {
  const row = getDb()
    .prepare(
      'SELECT 1 AS x FROM sessions WHERE agent_group_id = ? AND messaging_group_id IS NULL AND thread_id IS NULL LIMIT 1',
    )
    .get(agentGroupId);
  return !!row;
}

/**
 * Enumerate per-thread-style sessions for a (ag, mg). For non-web
 * channels, only include threads where the inbound side's `platform_id`
 * matches the viewer's handle on that channel — otherwise the rail would
 * leak other users' threads on a shared mg (e.g. an email-bot alias).
 */
function enumeratePerThread(
  userId: string,
  agentGroupId: string,
  ctx: UserMessagingContext,
  out: ThreadSummary[],
  spectator: boolean,
): void {
  type Row = { id: string; thread_id: string; last_active: string | null; created_at: string };
  const rows = getDb()
    .prepare(
      `SELECT id, thread_id, last_active, created_at FROM sessions
       WHERE agent_group_id = ? AND messaging_group_id = ? AND thread_id IS NOT NULL`,
    )
    .all(agentGroupId, ctx.messagingGroupId) as Row[];
  const isWeb = ctx.channelType === WEB_CHANNEL_TYPE;
  const viewerHandles = isWeb || spectator ? [] : viewerHandlesForChannel(userId, ctx.channelType);
  if (!isWeb && !spectator && viewerHandles.length === 0) return;
  for (const r of rows) {
    if (
      !spectator &&
      !isWeb &&
      !threadBelongsToViewer(agentGroupId, r.id, ctx.channelType, r.thread_id, viewerHandles)
    ) {
      continue;
    }
    const stats = readThreadStats(agentGroupId, r.id, ctx.channelType, r.thread_id);
    out.push({
      threadId: r.thread_id,
      sessionId: r.id,
      channelType: ctx.channelType,
      messagingGroupId: ctx.messagingGroupId,
      platformId: ctx.platformId,
      sessionMode: 'per-thread',
      title: finalizeTitle(stats.title),
      lastActivityAt: stats.maxTs || r.last_active || r.created_at,
      messageCount: stats.count,
      counterparty: isWeb ? undefined : ctx.platformId,
      ...(stats.turnCount > 0
        ? { totalCost: stats.totalCost, totalTokens: stats.totalTokens, turnCount: stats.turnCount }
        : {}),
      ...(stats.liveTask ? { liveTask: stats.liveTask } : {}),
    });
  }
}

/**
 * True if some inbound message in this thread was sent by the viewer.
 * For most channels the sender lives in `content.sender` (Chat SDK
 * convention) rather than `messages_in.platform_id`, since platform_id
 * holds the *inbox* identity (e.g. the email-bot alias) for inbound
 * channels. We fall back to platform_id matching as a last resort.
 */
function threadBelongsToViewer(
  agentGroupId: string,
  sessionId: string,
  channelType: string,
  threadId: string,
  viewerHandles: string[],
): boolean {
  if (viewerHandles.length === 0) return false;
  const handleSet = new Set(viewerHandles);
  try {
    const inDb = openInboundDb(agentGroupId, sessionId);
    try {
      const rows = inDb
        .prepare(
          'SELECT content, platform_id FROM messages_in WHERE channel_type = ? AND thread_id = ? ORDER BY seq LIMIT 5',
        )
        .all(channelType, threadId) as { content: string; platform_id: string }[];
      for (const r of rows) {
        if (handleSet.has(r.platform_id)) return true;
        try {
          const o = JSON.parse(r.content) as { sender?: unknown; from?: unknown };
          const sender = typeof o?.sender === 'string' ? o.sender : typeof o?.from === 'string' ? o.from : null;
          if (sender && handleSet.has(sender)) return true;
        } catch {
          /* not JSON */
        }
      }
      return false;
    } finally {
      inDb.close();
    }
  } catch {
    return false;
  }
}

function enumerateShared(agentGroupId: string, ctx: UserMessagingContext, out: ThreadSummary[]): void {
  const session = findSessionForAgent(agentGroupId, ctx.messagingGroupId, null);
  if (!session) return;
  collectThreadsFromSharedSession(agentGroupId, session.id, [{ ctx, mode: 'shared' }], out);
}

/**
 * Enumerate threadless DM "rooms" in a shared session — messages_in rows
 * where thread_id IS NULL, scoped to a (channel, mg) the viewer owns.
 * Yields at most one ThreadSummary per (mg, viewer platform id) and
 * tags it with `kind: 'dm'` so the rail can render these in a separate
 * area. Synthetic threadId is `__dm:<mgId>`, decoded by readChatHistory.
 */
function enumerateThreadlessDm(
  userId: string,
  agentGroupId: string,
  ctx: UserMessagingContext,
  out: ThreadSummary[],
  spectator: boolean,
): void {
  if (ctx.channelType === WEB_CHANNEL_TYPE) return;
  const session = findSessionForAgent(agentGroupId, ctx.messagingGroupId, null);
  if (!session) return;
  const handles = spectator ? [] : viewerHandlesForChannel(userId, ctx.channelType);
  if (!spectator && handles.length === 0) return;
  let inDb: ReturnType<typeof openInboundDb>;
  try {
    inDb = openInboundDb(agentGroupId, session.id);
  } catch {
    return;
  }
  try {
    type Row = { platform_id: string; max_ts: string | null; n: number };
    let rows: Row[];
    if (spectator) {
      rows = inDb
        .prepare(
          `SELECT platform_id, MAX(timestamp) AS max_ts, COUNT(*) AS n
             FROM messages_in
            WHERE channel_type = ? AND thread_id IS NULL
            GROUP BY platform_id`,
        )
        .all(ctx.channelType) as Row[];
    } else {
      const placeholders = handles.map(() => '?').join(',');
      rows = inDb
        .prepare(
          `SELECT platform_id, MAX(timestamp) AS max_ts, COUNT(*) AS n
             FROM messages_in
            WHERE channel_type = ? AND thread_id IS NULL AND platform_id IN (${placeholders})
            GROUP BY platform_id`,
        )
        .all(ctx.channelType, ...handles) as Row[];
    }
    if (rows.length === 0) return;

    // Collapse all matched handles into a single summary per mg. (A user
    // would only ever DM the bot from one of their handles on a given
    // channel; aggregating is just defensive.)
    let total = 0;
    let maxTs = '';
    let representativeHandle = handles[0] ?? rows[0].platform_id;
    for (const r of rows) {
      total += r.n;
      if (r.max_ts && (!maxTs || Date.parse(normTs(r.max_ts)) > Date.parse(normTs(maxTs)))) maxTs = r.max_ts;
      representativeHandle = r.platform_id;
    }

    let outCount = 0;
    let outMaxTs: string | null = null;
    try {
      const outDb = openOutboundDb(agentGroupId, session.id);
      try {
        const c = outDb
          .prepare(
            "SELECT COUNT(*) AS n, MAX(timestamp) AS t FROM messages_out WHERE channel_type = ? AND thread_id IS NULL AND kind IN ('chat','text')",
          )
          .get(ctx.channelType) as { n: number; t: string | null };
        outCount = c.n;
        outMaxTs = c.t;
      } finally {
        outDb.close();
      }
    } catch {
      /* outbound db missing */
    }
    if (outMaxTs && (!maxTs || Date.parse(normTs(outMaxTs)) > Date.parse(normTs(maxTs)))) maxTs = outMaxTs;

    out.push({
      threadId: `__dm:${ctx.messagingGroupId}`,
      sessionId: session.id,
      channelType: ctx.channelType,
      messagingGroupId: ctx.messagingGroupId,
      platformId: representativeHandle,
      sessionMode: 'shared',
      title: `Direct messages`,
      lastActivityAt: maxTs || new Date(0).toISOString(),
      messageCount: total + outCount,
      counterparty: representativeHandle,
      kind: 'dm',
    });
  } finally {
    inDb.close();
  }
}

function enumerateAgentShared(agentGroupId: string, ctxs: UserMessagingContext[], out: ThreadSummary[]): void {
  const session = findSessionByAgentGroup(agentGroupId);
  if (!session) return;
  collectThreadsFromSharedSession(
    agentGroupId,
    session.id,
    ctxs.map((c) => ({ ctx: c, mode: 'agent-shared' as const })),
    out,
  );
}

/**
 * Enumerate distinct threads inside a shared/agent-shared session DB,
 * scoping to a list of (channelType, platformId) tuples the viewer owns.
 */
function collectThreadsFromSharedSession(
  agentGroupId: string,
  sessionId: string,
  scopes: { ctx: UserMessagingContext; mode: 'shared' | 'agent-shared' }[],
  out: ThreadSummary[],
): void {
  if (scopes.length === 0) return;
  let inDb: ReturnType<typeof openInboundDb>;
  try {
    inDb = openInboundDb(agentGroupId, sessionId);
  } catch {
    return;
  }
  try {
    const placeholders = scopes.map(() => '(channel_type = ? AND platform_id = ?)').join(' OR ');
    const params: string[] = [];
    for (const s of scopes) params.push(s.ctx.channelType, s.ctx.platformId);
    type GroupRow = { channel_type: string; platform_id: string; thread_id: string; max_ts: string | null; n: number };
    const groups = inDb
      .prepare(
        `SELECT channel_type, platform_id, thread_id, MAX(timestamp) AS max_ts, COUNT(*) AS n
           FROM messages_in
          WHERE thread_id IS NOT NULL AND (${placeholders})
          GROUP BY channel_type, platform_id, thread_id`,
      )
      .all(...params) as GroupRow[];

    const titleStmt = inDb.prepare(
      `SELECT content FROM messages_in
        WHERE channel_type = ? AND platform_id = ? AND thread_id = ?
        ORDER BY seq LIMIT 1`,
    );

    let outDb: ReturnType<typeof openOutboundDb> | undefined;
    try {
      try {
        outDb = openOutboundDb(agentGroupId, sessionId);
      } catch {
        outDb = undefined;
      }
      const outStmt = outDb?.prepare(
        `SELECT COUNT(*) AS n, MAX(timestamp) AS t FROM messages_out
          WHERE channel_type = ? AND thread_id = ? AND kind IN ('chat','text')`,
      );

      // Aggregate turn_usage per thread (if the table exists).
      // Note: for shared sessions the turn_usage table covers all threads
      // combined. This is a rough approximation; per-thread scoping would
      // require joining through message_out_id.
      let usageTotals: { cost: number; tokens: number; turns: number } | undefined;
      if (outDb) {
        try {
          usageTotals = outDb
            .prepare(
              `SELECT COALESCE(SUM(cost_usd), 0) AS cost,
                    COALESCE(SUM(input_tokens + output_tokens), 0) AS tokens,
                    COUNT(*) AS turns
             FROM turn_usage`,
            )
            .get() as { cost: number; tokens: number; turns: number } | undefined;
        } catch {
          // turn_usage table may not exist
        }
      }

      for (const g of groups) {
        const scope = scopes.find((s) => s.ctx.channelType === g.channel_type && s.ctx.platformId === g.platform_id);
        if (!scope) continue;
        const first = titleStmt.get(g.channel_type, g.platform_id, g.thread_id) as { content: string } | undefined;
        const title = first ? extractTitle(g.channel_type, first.content) : '';
        let count = g.n;
        let maxTs = g.max_ts ?? '';
        if (outStmt) {
          const oc = outStmt.get(g.channel_type, g.thread_id) as { n: number; t: string | null };
          count += oc.n;
          if (oc.t && (!maxTs || Date.parse(normTs(oc.t)) > Date.parse(normTs(maxTs)))) maxTs = oc.t;
        }
        const usageProps =
          usageTotals && usageTotals.turns > 0
            ? { totalCost: usageTotals.cost, totalTokens: usageTotals.tokens, turnCount: usageTotals.turns }
            : {};
        out.push({
          threadId: g.thread_id,
          sessionId,
          channelType: g.channel_type,
          messagingGroupId: scope.ctx.messagingGroupId,
          platformId: g.platform_id,
          sessionMode: scope.mode,
          title: finalizeTitle(title),
          lastActivityAt: maxTs || new Date(0).toISOString(),
          messageCount: count,
          counterparty: g.channel_type !== WEB_CHANNEL_TYPE ? g.platform_id : undefined,
          ...usageProps,
        });
      }
    } finally {
      outDb?.close();
    }
  } finally {
    inDb.close();
  }
}

/**
 * Per-thread session stats (title + count + max timestamp). Used by the
 * per-thread mode branch where each thread lives in its own session.
 */
function readThreadStats(
  agentGroupId: string,
  sessionId: string,
  channelType: string,
  threadId: string,
): {
  title: string;
  count: number;
  maxTs: string;
  totalCost: number;
  totalTokens: number;
  turnCount: number;
  liveTask?: LiveTaskDto;
} {
  let title = '';
  let count = 0;
  let maxTs = '';
  let totalCost = 0;
  let totalTokens = 0;
  let turnCount = 0;
  let liveTask: LiveTaskDto | undefined;
  try {
    const inDb = openInboundDb(agentGroupId, sessionId);
    try {
      const first = inDb
        .prepare('SELECT content FROM messages_in WHERE channel_type = ? AND thread_id = ? ORDER BY seq LIMIT 1')
        .get(channelType, threadId) as { content: string } | undefined;
      if (first) title = extractTitle(channelType, first.content);
      const c = inDb
        .prepare('SELECT COUNT(*) AS n, MAX(timestamp) AS t FROM messages_in WHERE channel_type = ? AND thread_id = ?')
        .get(channelType, threadId) as { n: number; t: string | null };
      count += c.n;
      if (c.t) maxTs = c.t;
      // Live scheduled tasks: one row per series (the pending/paused
      // occurrence), soonest next-run first. The head row drives the badge.
      try {
        const taskRows = inDb
          .prepare(
            `SELECT series_id AS id, status, process_after, recurrence, content, MAX(seq) AS _seq
               FROM messages_in
              WHERE kind = 'task' AND status IN ('pending', 'paused')
                AND channel_type = ? AND thread_id = ?
              GROUP BY series_id
              ORDER BY (process_after IS NULL) ASC, process_after ASC`,
          )
          .all(channelType, threadId) as {
          id: string;
          status: string;
          process_after: string | null;
          recurrence: string | null;
          content: string;
        }[];
        if (taskRows.length > 0) {
          const head = taskRows[0]!;
          liveTask = {
            count: taskRows.length,
            nextRunAt: head.process_after,
            recurrence: head.recurrence,
            summary: summarizeTaskPrompt(head.content),
            paused: head.status === 'paused',
          };
        }
      } catch {
        // messages_in may predate the task columns
      }
    } finally {
      inDb.close();
    }
  } catch {
    /* inbound db missing */
  }
  try {
    const outDb = openOutboundDb(agentGroupId, sessionId);
    try {
      const c = outDb
        .prepare(
          "SELECT COUNT(*) AS n, MAX(timestamp) AS t FROM messages_out WHERE channel_type = ? AND thread_id = ? AND kind IN ('chat','text')",
        )
        .get(channelType, threadId) as { n: number; t: string | null };
      count += c.n;
      if (c.t && (!maxTs || Date.parse(normTs(c.t)) > Date.parse(normTs(maxTs)))) maxTs = c.t;
      // Aggregate turn_usage stats for this thread.
      try {
        const u = outDb
          .prepare(
            `SELECT COALESCE(SUM(cost_usd), 0) AS cost,
                    COALESCE(SUM(input_tokens + output_tokens), 0) AS tokens,
                    COUNT(*) AS turns
             FROM turn_usage`,
          )
          .get() as { cost: number; tokens: number; turns: number };
        totalCost = u.cost;
        totalTokens = u.tokens;
        turnCount = u.turns;
      } catch {
        // turn_usage table may not exist in older outbound.db files
      }
    } finally {
      outDb.close();
    }
  } catch {
    /* outbound db missing */
  }
  return { title, count, maxTs, totalCost, totalTokens, turnCount, ...(liveTask ? { liveTask } : {}) };
}

/**
 * Delete a chat thread — drops the sessions row and removes the on-disk
/**
 * Delete a chat thread: drop its session row + remove its on-disk
 * session directory. Returns true if a row was deleted.
 *
 * Kills the running container first so the agent-runner doesn't poll a
 * nuked inbound.db forever (which used to spam `unable to open database
 * file` until the host sweeper noticed — and even then the sweeper only
 * acts on heartbeat staleness, not on missing files).
 */
function deleteChatThread(userId: string, groupId: string, threadId: string): boolean {
  const platformId = platformIdFor(userId, groupId);
  const mg = getMessagingGroupByPlatform(WEB_CHANNEL_TYPE, platformId);
  if (!mg) return false;
  const session = findSessionForAgent(groupId, mg.id, threadId);
  if (!session) return false;
  const dir = sessionDir(groupId, session.id);
  killContainer(session.id, 'thread-deleted');
  deleteSession(session.id);
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (err) {
    log.warn('failed to rm session dir', { dir, err });
  }
  return true;
}

// ── WebSocket upgrade ──

const wss = new WebSocketServer({ noServer: true });

// Keepalive: send a ws-level ping to every open client every 30s. Browsers
// auto-respond with pong, so any intermediary (Cloudflare, nginx, LB) sees
// frames in both directions and won't drop the socket for idleness. A
// client that misses two consecutive pings (no pong, no inbound message)
// is considered dead and terminated.
const WS_PING_INTERVAL_MS = 30_000;
interface KeepaliveWs extends WebSocket {
  isAlive?: boolean;
}
const wsKeepaliveTimer = setInterval(() => {
  for (const client of wss.clients as Set<KeepaliveWs>) {
    if (client.readyState !== client.OPEN) continue;
    if (client.isAlive === false) {
      try {
        client.terminate();
      } catch {
        // already gone
      }
      continue;
    }
    client.isAlive = false;
    try {
      client.ping();
    } catch {
      // socket may have just closed
    }
  }
}, WS_PING_INTERVAL_MS);
if (typeof wsKeepaliveTimer.unref === 'function') wsKeepaliveTimer.unref();
wss.on('close', () => clearInterval(wsKeepaliveTimer));

/** Match `/ui/chat/api/groups/<groupId>/chat/<thread>/ws` on upgrade. */
function matchChatWsPath(pathname: string): { groupId: string; threadId: string } | null {
  const m = pathname.match(/^\/ui\/chat\/api\/groups\/([^/]+)\/chat\/([^/]+)\/ws$/);
  if (!m) return null;
  return { groupId: m[1], threadId: m[2] };
}

function readCookieToken(req: http.IncomingMessage): string | null {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const k = part.slice(0, eq).trim();
    if (k === COOKIE_NAME) return part.slice(eq + 1).trim();
  }
  return null;
}

/** Upgrade handler — mount at `/ui/chat` via mountUpgradeHandler. */
export function handleChatUpgrade(req: http.IncomingMessage, socket: internal.Duplex, head: Buffer): void {
  const url = req.url || '/';
  const pathname = url.split('?')[0];
  const match = matchChatWsPath(pathname);
  if (!match) {
    socket.destroy();
    return;
  }
  const session = authenticate(req);
  if (!session) {
    // No cookie — reject with HTTP 401 before completing upgrade.
    socket.write('HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n');
    socket.destroy();
    return;
  }
  const access = canAccessAgentGroup(session.userId, match.groupId);
  if (!access.allowed) {
    socket.write('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n');
    socket.destroy();
    return;
  }
  // Verify token cookie was present (paranoia: authenticate succeeded so it
  // must have been). Used to silence the unused-import lint.
  if (!readCookieToken(req)) {
    socket.destroy();
    return;
  }

  wss.handleUpgrade(req, socket, head, (ws) => {
    attachChatSocket(ws, {
      userId: session.userId,
      groupId: match.groupId,
      platformId: platformIdFor(session.userId, match.groupId),
      threadId: match.threadId,
    });
  });
}

function attachChatSocket(ws: WebSocket, ctx: ChatContext): void {
  // Auto-provision on connect so the messaging group exists before any
  // inbound. (POST /start already does this, but a client could open the
  // WS before calling /start — be defensive.)
  ensureWebMessagingGroup(ctx.userId, ctx.groupId);

  // Lazy-resolved session id for this (user, agentGroup, thread). Cached
  // once found — used to look up `turn_usage` on each outbound message.
  // Resolved lazily because the session may not yet exist when the WS
  // attaches (first message in a brand-new thread creates it).
  let cachedSessionId: string | undefined;
  function resolveSessionIdForUsage(): string | undefined {
    if (cachedSessionId) return cachedSessionId;
    try {
      const mg = getMessagingGroupByPlatform(WEB_CHANNEL_TYPE, ctx.platformId);
      if (!mg) return undefined;
      const isDm = ctx.threadId.startsWith('__dm:');
      const session = resolveSessionForMode(ctx.groupId, mg.id, 'per-thread', isDm ? '' : ctx.threadId);
      cachedSessionId = session?.id;
      return cachedSessionId;
    } catch {
      return undefined;
    }
  }

  function pushUsageFrame(messageId: string, attempt: number): void {
    try {
      const sid = resolveSessionIdForUsage();
      if (sid) {
        const usage = readTurnUsageForOutbound(ctx.groupId, sid, messageId);
        if (usage) {
          ws.send(JSON.stringify({ kind: 'usage', id: messageId, usage }));
          return;
        }
      }
      // Race: the host may deliver the outbound row before the container
      // has flushed the matching `turn_usage` row. One short retry covers
      // this; on miss the user still sees usage on next reload via /history.
      if (attempt < 1) setTimeout(() => pushUsageFrame(messageId, attempt + 1), 500);
    } catch (err) {
      log.warn('web chat ws usage send failed', { err });
    }
  }

  const subscriber: WebSubscriber = {
    onOutbound(message) {
      try {
        // send_file writes a `file_paths` array parallel to `files` with
        // workspace-relative source paths so the chat UI can link the
        // attachment chip into the FILES panel. Fish it out of the
        // parsed content (delivery.ts has already JSON.parsed it).
        const c = (typeof message.content === 'object' && message.content) as { file_paths?: unknown } | undefined;
        const filePaths: unknown[] = Array.isArray(c?.file_paths) ? c!.file_paths! : [];

        // For chat-sdk messages (ask_question, send_card), include the
        // structured content so the client can render interactive cards
        // without an extra sync round-trip.
        let question: { questionId: string; title: string; options: { label: string; value: string }[] } | undefined;
        if (message.kind === 'chat-sdk' && typeof message.content === 'object' && message.content) {
          const sdk = message.content as {
            type?: string;
            questionId?: string;
            title?: string;
            options?: { label: string; value: string }[];
          };
          if (sdk.type === 'ask_question' && sdk.questionId && sdk.title && Array.isArray(sdk.options)) {
            question = { questionId: sdk.questionId, title: sdk.title, options: sdk.options };
          }
        }

        ws.send(
          JSON.stringify({
            kind: 'outbound',
            id: message.id,
            messageKind: message.kind,
            content: message.content,
            files:
              message.files?.map((f, i) => ({
                filename: f.filename,
                size: f.data.length,
                path: typeof filePaths[i] === 'string' ? (filePaths[i] as string) : undefined,
              })) ?? [],
            timestamp: new Date().toISOString(),
            ...(question ? { question } : {}),
          }),
        );
      } catch (err) {
        log.warn('web chat ws send failed', { err });
      }
      if (message.id && (message.kind === 'chat' || message.kind === 'text')) {
        pushUsageFrame(message.id, 0);
      }
    },
    onInboundEcho(id, text, files) {
      try {
        // Live echo files arrive with just {filename, size}. Enrich them
        // with the same attachment `url` + `contentType` that /history
        // supplies so inline audio/video players render immediately on send
        // instead of only after a page reload. The host namespaces the
        // stored message id as `<id>:<agentGroupId>` and writes attachments
        // to inbox/<namespaced-id>/<filename>; reconstruct that localPath to
        // build the matching url.
        const enriched = (files ?? []).map((f) => ({
          ...f,
          url: encodedAttachmentUrl(ctx.groupId, ctx.threadId, `inbox/${id}:${ctx.groupId}/${f.filename}`),
          contentType: mimeFromFilename(f.filename),
        }));
        ws.send(JSON.stringify({ kind: 'inbound', id, text, files: enriched, timestamp: new Date().toISOString() }));
      } catch (err) {
        log.warn('web chat ws echo failed', { err });
      }
    },
    onTyping(on, hint, items) {
      try {
        ws.send(JSON.stringify({ kind: 'typing', on, hint: hint ?? null, items: items ?? null }));
      } catch (err) {
        log.warn('web chat ws typing send failed', { err });
      }
    },
  };
  const unsubscribe = subscribeWeb(ctx.platformId, ctx.threadId, subscriber);

  // Mark socket alive and refresh liveness on any inbound frame (pong from
  // the auto-response to our ping, or an app-level ping from the client).
  const keepalive = ws as WebSocket & { isAlive?: boolean };
  keepalive.isAlive = true;
  ws.on('pong', () => {
    keepalive.isAlive = true;
  });
  ws.on('message', () => {
    keepalive.isAlive = true;
  });

  ws.on('close', () => unsubscribe());
  ws.on('error', (err) => log.warn('web chat ws error', { err }));

  // Send a ready frame so the client can mark the connection open.
  try {
    ws.send(JSON.stringify({ kind: 'ready', threadId: ctx.threadId }));
  } catch {
    // swallow
  }
}
