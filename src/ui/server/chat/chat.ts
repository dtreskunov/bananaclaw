/**
 * Chat side-panel for the file browser UI.
 *
 * Web channel auto-provisioning + REST endpoints + WebSocket fan-out for
 * outbound. Mounted under `/ui/chat/api/groups/<groupId>/chat/...` by the
 * file browser router (see ../routes.ts). The web channel adapter
 * (src/channels/web.ts) handles the actual inbound injection and outbound
 * pub/sub.
 */
import {
  isElevated,
  platformIdFor,
  resolveTargetMessagingGroup,
  userOwnsMessagingGroup,
  resolveSessionForMode,
  type TurnContext,
  resolveTurnContext,
  viewerHandlesForChannel,
} from './conversation-context.js';
import { parseInputHandling } from './history.js';
import crypto from 'crypto';
import http from 'http';
import type internal from 'stream';
import path from 'path';

import type { ChatStartResponse, TaskAttemptDto, TaskDetailDto, ThreadSummary } from '../../shared/thread.js';

import Busboy from 'busboy';
import { WebSocketServer, type WebSocket } from 'ws';

import { getAgentGroup } from '../../../db/agent-groups.js';
import { getDb } from '../../../db/connection.js';
import {
  createMessagingGroup,
  createMessagingGroupAgent,
  getMessagingGroup,
  getMessagingGroupAgents,
  getMessagingGroupAgentByPair,
  getMessagingGroupByPlatform,
} from '../../../db/messaging-groups.js';
import {
  deleteSession,
  findSessionForAgent,
  getSession,
  SessionApprovalCancellationRequiredError,
  SessionApprovalInProgressError,
} from '../../../db/sessions.js';
import {
  getSessionActiveTurn,
  isSessionTurnId,
  notifySessionHostState,
  requestSessionTurnStop,
  requestSessionToolStop,
  type SessionActiveTurn,
} from '../../../session-link.js';
import { isToolCallId } from '../../../session-link-validate.js';
import {
  openInboundDb,
  openOutboundDb,
  resolveSession,
  sessionDir,
  writeSessionMessage,
} from '../../../session-manager.js';
import { killContainer, wakeContainer } from '../../../container-runner.js';
import {
  cancelTask,
  pauseTask,
  resumeTask,
  runTaskNow,
  updateTask,
  DEFAULT_TASK_SCRIPT_TIMEOUT_MS,
  MAX_TASK_SCRIPT_TIMEOUT_MS,
  MIN_TASK_SCRIPT_TIMEOUT_MS,
  type TaskUpdate,
} from '../../../modules/scheduling/db.js';
import { summarizeTaskPrompt } from './thread-scan.js';
import { listThreadsForViewer } from './threads.js';
export { listThreadsForViewer, viewerHasContent } from './threads.js';
import { readThreadTitle } from '../../../modules/thread-titles/db.js';
import { ForkError, forkThread, type ForkThreadResult } from '../../../fork-session.js';
import { deleteThreadFork, getThreadForkChildren, getThreadForkDescendants } from '../../../db/thread-forks.js';
import { TIMEZONE } from '../../../config.js';
import { canAccessAgentGroup } from '../../../modules/permissions/access.js';
import {
  deleteSessionFromIndex,
  reassignIndexedMessages,
  searchMessages,
  type SearchConversationScope,
} from '../../../search-index.js';
import { getUser } from '../../../modules/permissions/db/users.js';

import { hasAdminPrivilege } from '../../../modules/permissions/db/user-roles.js';
import { log } from '../../../log.js';
import { getChannelAdapter } from '../../../channels/channel-registry.js';

import { submitWebInbound, WEB_CHANNEL_TYPE } from '../../../channels/web.js';
import { setResendPendingWebOverride } from '../../../channels/resend.js';
import type { OutboundMessage } from '../../../channels/adapter.js';
import { authenticate } from '../auth.js';
import { handleVoiceUpgrade } from './voice-stream.js';
import { uiBaseUrl } from '../config.js';
import fs from 'fs';
import { type InputHandling } from '../../shared/input-state.js';
import { INPUT_EDIT_ID } from '../../../pending-input-edit.js';
import { cancelPendingInput, editPendingInput } from './pending-input-edit.js';
import { attachSyncSocket } from './sync-socket.js';
import { transaction } from '../../../db/transaction.js';

/**
 * Idempotently ensure the shared `web` messaging group exists for this agent
 * group and is wired to it. Returns the messaging_group id.
 */
function ensureWebMessagingGroup(agentGroupId: string): string {
  const platformId = platformIdFor(agentGroupId);
  let mg = getMessagingGroupByPlatform(WEB_CHANNEL_TYPE, platformId);
  if (!mg) {
    const id = `mg-web-shared-${agentGroupId}`;
    createMessagingGroup({
      id,
      channel_type: WEB_CHANNEL_TYPE,
      platform_id: platformId,
      name: null,
      is_group: 1,
      unknown_sender_policy: 'strict',
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

/**
 * Match `/api/groups/<groupId>/chat/...` (after the mount prefix has been
 * stripped). Returns null if not a chat path.
 */
export function matchChatPath(pathname: string):
  | { kind: 'start'; groupId: string }
  | { kind: 'warmup'; groupId: string; threadId: string }
  | { kind: 'send'; groupId: string; threadId: string }
  | { kind: 'stop'; groupId: string; threadId: string }
  | { kind: 'stop-tool'; groupId: string; threadId: string }
  | { kind: 'edit-input'; groupId: string; threadId: string; messageId: string }
  | { kind: 'threads'; groupId: string }
  | { kind: 'search'; groupId: string }
  | { kind: 'tasks'; groupId: string; threadId: string }
  | {
      kind: 'task-action';
      groupId: string;
      threadId: string;
      seriesId: string;
      action: 'pause' | 'resume' | 'cancel' | 'run';
    }
  | { kind: 'task-update'; groupId: string; threadId: string; seriesId: string }
  | { kind: 'delete'; groupId: string; threadId: string }
  | { kind: 'fork'; groupId: string; threadId: string }
  | { kind: 'attachment'; groupId: string; threadId: string; attachmentPath: string }
  | null {
  const start = pathname.match(/^\/api\/groups\/([^/]+)\/chat\/start$/);
  if (start) return { kind: 'start', groupId: start[1] };
  const threads = pathname.match(/^\/api\/groups\/([^/]+)\/chat\/threads$/);
  if (threads) return { kind: 'threads', groupId: threads[1] };
  const search = pathname.match(/^\/api\/groups\/([^/]+)\/chat\/search$/);
  if (search) return { kind: 'search', groupId: decodeURIComponent(search[1]) };
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
  const warmup = pathname.match(/^\/api\/groups\/([^/]+)\/chat\/([^/]+)\/warmup$/);
  if (warmup)
    return { kind: 'warmup', groupId: decodeURIComponent(warmup[1]), threadId: decodeURIComponent(warmup[2]) };
  const stop = pathname.match(/^\/api\/groups\/([^/]+)\/chat\/([^/]+)\/stop$/);
  if (stop) return { kind: 'stop', groupId: decodeURIComponent(stop[1]), threadId: decodeURIComponent(stop[2]) };
  const stopTool = pathname.match(/^\/api\/groups\/([^/]+)\/chat\/([^/]+)\/stop-tool$/);
  if (stopTool)
    return { kind: 'stop-tool', groupId: decodeURIComponent(stopTool[1]), threadId: decodeURIComponent(stopTool[2]) };
  const editInput = pathname.match(/^\/api\/groups\/([^/]+)\/chat\/([^/]+)\/messages\/([^/]+)$/);
  if (editInput)
    return {
      kind: 'edit-input',
      groupId: decodeURIComponent(editInput[1]),
      threadId: decodeURIComponent(editInput[2]),
      messageId: decodeURIComponent(editInput[3]),
    };
  const fork = pathname.match(/^\/api\/groups\/([^/]+)\/chat\/([^/]+)\/fork$/);
  if (fork) return { kind: 'fork', groupId: decodeURIComponent(fork[1]), threadId: decodeURIComponent(fork[2]) };
  const tasksList = pathname.match(/^\/api\/groups\/([^/]+)\/chat\/([^/]+)\/tasks$/);
  if (tasksList)
    return { kind: 'tasks', groupId: decodeURIComponent(tasksList[1]), threadId: decodeURIComponent(tasksList[2]) };
  const taskAction = pathname.match(
    /^\/api\/groups\/([^/]+)\/chat\/([^/]+)\/tasks\/([^/]+)\/(pause|resume|cancel|run)$/,
  );
  if (taskAction)
    return {
      kind: 'task-action',
      groupId: decodeURIComponent(taskAction[1]),
      threadId: decodeURIComponent(taskAction[2]),
      seriesId: decodeURIComponent(taskAction[3]),
      action: taskAction[4] as 'pause' | 'resume' | 'cancel' | 'run',
    };
  const taskUpdate = pathname.match(/^\/api\/groups\/([^/]+)\/chat\/([^/]+)\/tasks\/([^/]+)$/);
  if (taskUpdate)
    return {
      kind: 'task-update',
      groupId: decodeURIComponent(taskUpdate[1]),
      threadId: decodeURIComponent(taskUpdate[2]),
      seriesId: decodeURIComponent(taskUpdate[3]),
    };
  const del = pathname.match(/^\/api\/groups\/([^/]+)\/chat\/([^/]+)$/);
  if (del) return { kind: 'delete', groupId: decodeURIComponent(del[1]), threadId: decodeURIComponent(del[2]) };
  return null;
}

function writeJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    // All chat-api responses are dynamic per-user state.
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
  clientMessageId?: string;
  inputHandling?: unknown;
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
      if (name === 'clientMessageId' && typeof value === 'string') out.clientMessageId = value;
      if (name === 'inputHandling') {
        try {
          out.inputHandling = JSON.parse(value);
        } catch {
          fail('invalid_input_handling');
        }
      }
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
    const messagingGroupId = ensureWebMessagingGroup(m.groupId);
    const threadId = crypto.randomUUID();
    writeJson(res, 200, {
      threadId,
      messagingGroupId,
      platformId: platformIdFor(m.groupId),
    } satisfies ChatStartResponse);
    return true;
  }

  if (m.kind === 'warmup') {
    if (req.method !== 'POST') {
      writeJson(res, 405, { error: 'method_not_allowed' });
      return true;
    }
    if (!m.threadId || m.threadId.length > 256 || /[\0/]/.test(m.threadId) || m.threadId.startsWith('__dm:')) {
      writeJson(res, 400, { error: 'invalid_thread_id' });
      return true;
    }
    if (new URLSearchParams((req.url || '').split('?')[1] || '').size > 0) {
      writeJson(res, 400, { error: 'invalid_context' });
      return true;
    }
    const messagingGroupId = ensureWebMessagingGroup(m.groupId);
    const context = resolveTurnContext(userId, m.groupId, m.threadId);
    if (!context?.canSend || context.channelType !== WEB_CHANNEL_TYPE) {
      writeJson(res, 403, { error: 'forbidden' });
      return true;
    }
    const wiring = getMessagingGroupAgentByPair(messagingGroupId, m.groupId);
    const { session } = resolveSession(
      m.groupId,
      messagingGroupId,
      m.threadId,
      wiring?.session_mode === 'agent-shared' ? 'agent-shared' : 'per-thread',
    );
    const started = await wakeContainer(session);
    if (!getSession(session.id)) {
      killContainer(session.id, 'thread-deleted');
      writeJson(res, 409, { error: 'thread_deleted' });
      return true;
    }
    writeJson(res, started ? 200 : 503, {
      sessionId: session.id,
      ...(!started ? { error: 'warmup_deferred' } : {}),
    });
    return true;
  }

  if (m.kind === 'edit-input') {
    if (req.method !== 'PATCH' && req.method !== 'DELETE') {
      writeJson(res, 405, { error: 'method_not_allowed' });
      return true;
    }
    let body: unknown;
    try {
      body = await readJsonBody(req, 256 * 1024);
    } catch {
      writeJson(res, 400, { error: 'invalid_body' });
      return true;
    }
    const cancelling = req.method === 'DELETE';
    if (
      !body ||
      typeof body !== 'object' ||
      Array.isArray(body) ||
      Object.keys(body).length !== (cancelling ? 1 : 3) ||
      !('requestId' in body) ||
      typeof body.requestId !== 'string' ||
      !INPUT_EDIT_ID.test(body.requestId) ||
      (!cancelling &&
        (!('expectedText' in body) ||
          typeof body.expectedText !== 'string' ||
          Buffer.byteLength(body.expectedText) > 64 * 1024 ||
          !('text' in body) ||
          typeof body.text !== 'string' ||
          !body.text.trim() ||
          Buffer.byteLength(body.text) > 64 * 1024))
    ) {
      writeJson(res, 400, { error: 'invalid_body' });
      return true;
    }
    const query = new URLSearchParams((req.url || '').split('?')[1] || '');
    if (
      query.has('channel') !== query.has('mg') ||
      query.has('sessionId') ||
      (query.has('channel') && (!query.get('channel') || !query.get('mg')))
    ) {
      writeJson(res, 400, { error: 'invalid_context' });
      return true;
    }
    const context = resolveTurnContext(userId, m.groupId, m.threadId, taskOverride(req));
    if (!context?.canSend || context.channelType !== WEB_CHANNEL_TYPE) {
      writeJson(res, 403, { error: 'forbidden' });
      return true;
    }
    if (!context.sessionId) {
      writeJson(res, 404, { error: 'message_not_found' });
      return true;
    }
    try {
      const mutationContext = {
        groupId: m.groupId,
        sessionId: context.sessionId,
        userId,
        platformIds: context.platformIds,
        threadId: context.threadId,
        messageId: m.messageId,
        requestId: body.requestId,
      };
      const result = cancelling
        ? await cancelPendingInput(mutationContext)
        : 'expectedText' in body &&
            typeof body.expectedText === 'string' &&
            'text' in body &&
            typeof body.text === 'string'
          ? await editPendingInput({ ...mutationContext, expectedText: body.expectedText, text: body.text })
          : { status: 400, body: { error: 'invalid_body' } };
      writeJson(res, result.status, result.body);
    } catch (err) {
      log.warn('Pending input mutation failed', { groupId: m.groupId, messageId: m.messageId, err });
      writeJson(res, 500, { error: cancelling ? 'input_cancel_failed' : 'input_edit_failed' });
    }
    return true;
  }

  if (m.kind === 'stop' || m.kind === 'stop-tool') {
    if (req.method !== 'POST') {
      writeJson(res, 405, { error: 'method_not_allowed' });
      return true;
    }
    let body: unknown;
    try {
      body = await readJsonBody(req, 4096);
    } catch {
      writeJson(res, 400, { error: 'invalid_body' });
      return true;
    }
    if (
      !body ||
      typeof body !== 'object' ||
      Array.isArray(body) ||
      !Object.keys(body).every((key) => key === 'turnId' || (m.kind === 'stop-tool' && key === 'toolCallId')) ||
      !('turnId' in body) ||
      !isSessionTurnId(body.turnId)
    ) {
      writeJson(res, 400, { error: 'invalid_turn_id' });
      return true;
    }
    const toolCallId = 'toolCallId' in body && isToolCallId(body.toolCallId) ? body.toolCallId : null;
    if (m.kind === 'stop-tool' && toolCallId === null) {
      writeJson(res, 400, { error: 'invalid_tool_call' });
      return true;
    }
    const query = new URLSearchParams((req.url || '').split('?')[1] || '');
    if (
      query.has('channel') !== query.has('mg') ||
      query.has('sessionId') ||
      (query.has('channel') && (!query.get('channel') || !query.get('mg')))
    ) {
      writeJson(res, 400, { error: 'invalid_context' });
      return true;
    }
    const context = resolveTurnContext(userId, m.groupId, m.threadId, taskOverride(req));
    if (!context || !context.canSend) {
      writeJson(res, 403, { error: 'forbidden' });
      return true;
    }
    if (!context.sessionId) {
      writeJson(res, 409, { error: 'not_active' });
      return true;
    }
    const current = getSessionActiveTurn(context.sessionId);
    if (current.turn && !turnMatchesContext(current.turn, context)) {
      writeJson(res, 409, { error: 'not_active' });
      return true;
    }
    const result = toolCallId
      ? { kind: 'tool' as const, ...(await requestSessionToolStop(context.sessionId, body.turnId, toolCallId)) }
      : { kind: 'turn' as const, ...(await requestSessionTurnStop(context.sessionId, body.turnId)) };
    if (!result.accepted) {
      const status = {
        disconnected: 503,
        timeout: 503,
        invalid_tool_call: 400,
        invalid_turn_id: 400,
        failed: 500,
        not_active: 409,
        not_running: 409,
        unsupported: 409,
      }[result.error];
      writeJson(res, status, { error: result.error });
      return true;
    }
    writeJson(
      res,
      202,
      result.kind === 'turn' ? { activeTurn: publicActiveTurn(result.turn), connected: true } : { accepted: true },
    );
    return true;
  }

  if (m.kind === 'send') {
    if (req.method !== 'POST') {
      writeJson(res, 405, { error: 'method_not_allowed' });
      return true;
    }
    const ctype = (req.headers['content-type'] || '').toLowerCase();
    let text = '';
    let clientMessageId: unknown;
    let rawInputHandling: unknown;
    let attachments: { filename: string; contentType: string; data: string; size: number }[] = [];
    if (ctype.startsWith('multipart/form-data')) {
      try {
        const parsed = await readMultipartBody(req);
        text = parsed.text;
        clientMessageId = parsed.clientMessageId;
        rawInputHandling = parsed.inputHandling;
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
      clientMessageId = (body as { clientMessageId?: unknown })?.clientMessageId;
      rawInputHandling = (body as { inputHandling?: unknown })?.inputHandling;
    }
    let inputHandling: InputHandling | undefined;
    try {
      inputHandling = parseInputHandling(rawInputHandling);
    } catch {
      writeJson(res, 400, { error: 'invalid_input_handling' });
      return true;
    }
    if (
      clientMessageId !== undefined &&
      (typeof clientMessageId !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(clientMessageId))
    ) {
      writeJson(res, 400, { error: 'invalid_client_message_id' });
      return true;
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
    if (q.has('channel') !== q.has('mg') || q.has('sessionId') || (q.has('channel') && (!qChannel || !qMg))) {
      writeJson(res, 400, { error: 'invalid_context' });
      return true;
    }

    if (qChannel && qMg && qChannel !== WEB_CHANNEL_TYPE) {
      if (inputHandling) {
        writeJson(res, 400, { error: 'invalid_input_handling_context' });
        return true;
      }
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

    ensureWebMessagingGroup(m.groupId);
    const context = resolveTurnContext(userId, m.groupId, m.threadId, taskOverride(req));
    if (!context?.canSend || context.channelType !== WEB_CHANNEL_TYPE) {
      writeJson(res, 403, { error: 'forbidden' });
      return true;
    }
    if (inputHandling?.mode === 'steer' && context.sessionId) {
      const current = getSessionActiveTurn(context.sessionId);
      // A stale captured target remains a follow-up, never a steer of its successor.
      if (current.turn && current.turn.id === inputHandling.turnId) {
        if (!turnMatchesContext(current.turn, context)) {
          writeJson(res, 409, { error: 'different_conversation' });
          return true;
        }
        if (!current.turn.supportsSteering) {
          writeJson(res, 409, { error: 'unsupported' });
          return true;
        }
        if (!current.connected || current.turn.status !== 'running') {
          writeJson(res, 409, { error: current.connected ? 'not_running' : 'disconnected' });
          return true;
        }
      }
    }
    const platformId = context.platformIds[0];
    try {
      const id = await submitWebInbound({
        userId,
        senderDisplayName: getUser(userId)?.display_name?.trim() || userId,
        platformId,
        threadId: m.threadId,
        text,
        clientMessageId: clientMessageId as string | undefined,
        inputHandling,
        attachments: attachments.length > 0 ? attachments : undefined,
      });
      writeJson(res, 200, { id });
    } catch (err) {
      log.error('web chat send failed', { userId, groupId: m.groupId, err });
      writeJson(res, 500, { error: 'send_failed' });
    }
    return true;
  }

  if (m.kind === 'attachment') {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      writeJson(res, 405, { error: 'method_not_allowed' });
      return true;
    }
    serveInboundAttachment(req, res, m.groupId, m.threadId, m.attachmentPath);
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
      const threads = await listThreadsForViewer(userId, m.groupId);
      writeJson(res, 200, { threads });
    } catch (err) {
      log.warn('web chat threads list failed', { userId, groupId: m.groupId, err });
      writeJson(res, 503, { error: 'Thread list unavailable; retry the request' });
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
      const visibleThreads = await listThreadsForViewer(userId, m.groupId);
      const results = searchMessages(query, {
        agentGroupId: m.groupId,
        conversations: buildViewerSearchConversations(visibleThreads),
      });
      writeJson(res, 200, { results });
    } catch (err) {
      log.warn('web chat search failed', { userId, groupId: m.groupId, query, err });
      writeJson(res, 503, { error: 'Search unavailable; retry the request' });
    }
    return true;
  }

  if (m.kind === 'delete') {
    if (req.method !== 'DELETE') {
      writeJson(res, 405, { error: 'method_not_allowed' });
      return true;
    }
    if (!hasAdminPrivilege(userId, m.groupId)) {
      writeJson(res, 403, { error: 'forbidden' });
      return true;
    }
    try {
      const params = new URLSearchParams((req.url || '').split('?')[1] || '');
      const result = deleteChatThread(
        userId,
        m.groupId,
        m.threadId,
        taskOverride(req),
        params.get('cascade') === '1',
        params.get('cancelApprovals') === '1',
      );
      writeJson(res, result.removed > 0 ? 200 : 404, { ok: result.removed > 0, ...result });
    } catch (err) {
      if (err instanceof SessionApprovalInProgressError) {
        writeJson(res, 409, { error: 'approval_in_progress', detail: err.message });
        return true;
      }
      if (err instanceof SessionApprovalCancellationRequiredError) {
        writeJson(res, 409, { error: 'approval_cancellation_required', detail: err.message });
        return true;
      }
      log.warn('web chat thread delete failed', { userId, groupId: m.groupId, threadId: m.threadId, err });
      writeJson(res, 500, { error: 'delete_failed' });
    }
    return true;
  }

  if (m.kind === 'fork') {
    if (req.method !== 'POST') {
      writeJson(res, 405, { error: 'method_not_allowed' });
      return true;
    }
    let body: unknown;
    try {
      body = await readJsonBody(req);
    } catch (err) {
      writeJson(res, 400, { error: 'invalid_body', detail: (err as Error).message });
      return true;
    }
    const atMessageId = (body as { atMessageId?: unknown })?.atMessageId;
    if (typeof atMessageId !== 'string' || !atMessageId) {
      writeJson(res, 400, { error: 'at_message_id_required' });
      return true;
    }
    try {
      const result = forkChatThread(userId, m.groupId, m.threadId, atMessageId, taskOverride(req));
      writeJson(res, 200, {
        threadId: result.threadId,
        sessionId: result.sessionId,
        fidelity: result.fidelity,
        copied: { in: result.copiedIn, out: result.copiedOut },
      });
    } catch (err) {
      if (err instanceof ForkError) {
        const status = err.message === 'thread_not_found' || err.message === 'anchor_not_found' ? 404 : 400;
        writeJson(res, status, { error: err.message });
        return true;
      }
      log.error('web chat thread fork failed', { userId, groupId: m.groupId, threadId: m.threadId, err });
      writeJson(res, 500, { error: 'fork_failed' });
    }
    return true;
  }

  if (m.kind === 'tasks') {
    if (req.method !== 'GET') {
      writeJson(res, 405, { error: 'method_not_allowed' });
      return true;
    }
    const r = resolveThreadSessionForTasks(userId, m.groupId, m.threadId, taskOverride(req));
    if (!r) {
      writeJson(res, 200, { tasks: [], timezone: TIMEZONE });
      return true;
    }
    try {
      const tasks = readLiveTaskDetails(m.groupId, r.sessionId, r.channelType, m.threadId, r.isDm);
      writeJson(res, 200, { tasks, timezone: TIMEZONE });
    } catch (err) {
      log.warn('web chat task list failed', { userId, groupId: m.groupId, threadId: m.threadId, err });
      writeJson(res, 200, { tasks: [], timezone: TIMEZONE });
    }
    return true;
  }

  if (m.kind === 'task-action') {
    if (req.method !== 'POST') {
      writeJson(res, 405, { error: 'method_not_allowed' });
      return true;
    }
    const r = resolveThreadSessionForTasks(userId, m.groupId, m.threadId, taskOverride(req));
    if (!r) {
      writeJson(res, 404, { error: 'thread_not_found' });
      return true;
    }
    try {
      const inDb = openInboundDb(m.groupId, r.sessionId);
      try {
        const exists = inDb
          .prepare(
            `SELECT 1 FROM messages_in
              WHERE (id = ? OR series_id = ?) AND kind = 'task'
                AND status IN ('pending', 'paused')
                AND COALESCE(json_extract(content, '$.triggerSource'), 'scheduled') != 'manual'
              LIMIT 1`,
          )
          .get(m.seriesId, m.seriesId);
        if (!exists) {
          writeJson(res, 404, { error: 'task_not_found' });
          return true;
        }
        let occurrenceId: string | null = null;
        if (m.action === 'pause') pauseTask(inDb, m.seriesId);
        else if (m.action === 'resume') resumeTask(inDb, m.seriesId);
        else if (m.action === 'cancel') cancelTask(inDb, m.seriesId);
        else {
          occurrenceId = runTaskNow(inDb, m.seriesId, new Date().toISOString());
          if (!occurrenceId) {
            writeJson(res, 409, { error: 'task_not_runnable' });
            return true;
          }
        }
        if (occurrenceId) {
          const tasks = readLiveTaskDetails(m.groupId, r.sessionId, r.channelType, m.threadId, r.isDm);
          writeJson(res, 200, { ok: true, occurrenceId, tasks });
          return true;
        }
      } finally {
        inDb.close();
        notifySessionHostState(r.sessionId);
      }
      const tasks = readLiveTaskDetails(m.groupId, r.sessionId, r.channelType, m.threadId, r.isDm);
      writeJson(res, 200, { ok: true, tasks });
    } catch (err) {
      log.warn('web chat task action failed', {
        userId,
        groupId: m.groupId,
        threadId: m.threadId,
        action: m.action,
        err,
      });
      writeJson(res, 500, { error: 'task_action_failed' });
    }
    return true;
  }

  if (m.kind === 'task-update') {
    if (req.method !== 'PATCH') {
      writeJson(res, 405, { error: 'method_not_allowed' });
      return true;
    }
    let body: unknown;
    try {
      body = await readJsonBody(req);
    } catch (err) {
      writeJson(res, 400, { error: 'invalid_body', detail: (err as Error).message });
      return true;
    }
    const b = (body ?? {}) as Record<string, unknown>;
    const update: TaskUpdate = {};
    if (typeof b.prompt === 'string') {
      if (!b.prompt.trim()) {
        writeJson(res, 400, { error: 'empty_prompt' });
        return true;
      }
      update.prompt = b.prompt;
    }
    if (b.script === null || typeof b.script === 'string') {
      // Empty/whitespace-only script clears the script (recorded as null so
      // hasScript reads false); otherwise store the raw body verbatim.
      const s = b.script as string | null;
      update.script = typeof s === 'string' && s.trim().length > 0 ? s : null;
    }
    if (typeof b.processAfter === 'string') {
      if (Number.isNaN(Date.parse(b.processAfter))) {
        writeJson(res, 400, { error: 'invalid_process_after' });
        return true;
      }
      update.processAfter = b.processAfter;
    }
    if (b.recurrence === null || typeof b.recurrence === 'string') {
      const cron = b.recurrence as string | null;
      if (typeof cron === 'string' && cron.trim() && !(await isValidCron(cron))) {
        writeJson(res, 400, { error: 'invalid_recurrence' });
        return true;
      }
      update.recurrence = typeof cron === 'string' && !cron.trim() ? null : cron;
    }
    if (typeof b.scriptTimeoutMs === 'number') {
      if (
        !Number.isFinite(b.scriptTimeoutMs) ||
        b.scriptTimeoutMs < MIN_TASK_SCRIPT_TIMEOUT_MS ||
        b.scriptTimeoutMs > MAX_TASK_SCRIPT_TIMEOUT_MS
      ) {
        writeJson(res, 400, { error: 'invalid_script_timeout' });
        return true;
      }
      update.scriptTimeoutMs = Math.round(b.scriptTimeoutMs);
    }
    if (Object.keys(update).length === 0) {
      writeJson(res, 400, { error: 'no_fields' });
      return true;
    }
    const r = resolveThreadSessionForTasks(userId, m.groupId, m.threadId, taskOverride(req));
    if (!r) {
      writeJson(res, 404, { error: 'thread_not_found' });
      return true;
    }
    try {
      let touched = 0;
      const inDb = openInboundDb(m.groupId, r.sessionId);
      try {
        touched = updateTask(inDb, m.seriesId, update);
      } finally {
        inDb.close();
        notifySessionHostState(r.sessionId);
      }
      if (touched === 0) {
        writeJson(res, 404, { error: 'task_not_found' });
        return true;
      }
      const tasks = readLiveTaskDetails(m.groupId, r.sessionId, r.channelType, m.threadId, r.isDm);
      writeJson(res, 200, { ok: true, tasks });
    } catch (err) {
      log.warn('web chat task update failed', { userId, groupId: m.groupId, threadId: m.threadId, err });
      writeJson(res, 500, { error: 'task_update_failed' });
    }
    return true;
  }

  return false;
}

export type ChatActiveTurn = Pick<
  SessionActiveTurn,
  'id' | 'status' | 'supportsSteering' | 'supportsInputEditing' | 'supportsInputCancellation'
>;

function publicActiveTurn(turn: SessionActiveTurn): ChatActiveTurn {
  return {
    id: turn.id,
    status: turn.status,
    ...(turn.supportsSteering ? { supportsSteering: true } : {}),
    ...(turn.supportsInputEditing ? { supportsInputEditing: true } : {}),
    ...(turn.supportsInputCancellation ? { supportsInputCancellation: true } : {}),
  };
}

function turnMatchesContext(turn: SessionActiveTurn, context: TurnContext): boolean {
  return (
    turn.channelType === context.channelType &&
    context.platformIds.includes(turn.platformId) &&
    turn.threadId === context.threadId
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

export function inboundAttachmentSecurityHeaders(contentType: string, filename = ''): Record<string, string> {
  const mime = contentType.split(';', 1)[0].trim().toLowerCase();
  const extension = path.extname(filename).toLowerCase();
  if (mime !== 'text/html' && mime !== 'application/xhtml+xml' && !['.html', '.htm', '.xhtml'].includes(extension))
    return {};
  return {
    'Content-Security-Policy': [
      'sandbox',
      "default-src 'none'",
      "script-src 'none'",
      "style-src 'unsafe-inline'",
      'img-src data:',
      'font-src data:',
      'media-src data:',
      "connect-src 'none'",
      "frame-src 'none'",
      "object-src 'none'",
      "base-uri 'none'",
      "form-action 'none'",
      "frame-ancestors 'self'",
    ].join('; '),
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
  };
}

function serveInboundAttachment(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  groupId: string,
  threadId: string,
  requestedPath: string,
): void {
  const normalizedPath = path.posix.normalize(requestedPath);
  if (normalizedPath.startsWith('../') || normalizedPath === '..' || path.posix.isAbsolute(normalizedPath)) {
    writeJson(res, 400, { error: 'bad_attachment_path' });
    return;
  }
  const mg = getMessagingGroupByPlatform(WEB_CHANNEL_TYPE, platformIdFor(groupId));
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
    'Last-Modified': stat.mtime.toUTCString(),
    ...inboundAttachmentSecurityHeaders(found.contentType, found.filename),
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

export function buildViewerSearchConversations(threads: ThreadSummary[]): SearchConversationScope[] {
  const seen = new Set<string>();
  const scopes: SearchConversationScope[] = [];
  for (const thread of threads) {
    // Threadless DMs share one session across multiple viewers and outbound
    // rows have no durable audience key in the index, so fail closed.
    if (thread.kind === 'dm' || thread.threadId.startsWith('__dm:')) continue;
    const key = `${thread.sessionId}\0${thread.threadId}\0${thread.channelType}`;
    if (seen.has(key)) continue;
    seen.add(key);
    scopes.push({
      sessionId: thread.sessionId,
      threadId: thread.threadId,
      channelType: thread.channelType,
    });
  }
  return scopes;
}

/** Parse a task row's content JSON into its prompt + script text. */
function parseTaskContent(content: string): {
  prompt: string;
  script: string;
  scriptTimeoutMs: number;
  consecutiveFailures: number;
} {
  try {
    const o = JSON.parse(content) as Record<string, unknown>;
    return {
      prompt: typeof o?.prompt === 'string' ? o.prompt : '',
      script: typeof o?.script === 'string' ? o.script : '',
      scriptTimeoutMs: typeof o?.scriptTimeoutMs === 'number' ? o.scriptTimeoutMs : DEFAULT_TASK_SCRIPT_TIMEOUT_MS,
      consecutiveFailures: typeof o?.consecutiveFailures === 'number' ? o.consecutiveFailures : 0,
    };
  } catch {
    return {
      prompt: '',
      script: '',
      scriptTimeoutMs: DEFAULT_TASK_SCRIPT_TIMEOUT_MS,
      consecutiveFailures: 0,
    };
  }
}

function readTaskAttempts(groupId: string, sessionId: string, seriesId: string): TaskAttemptDto[] {
  try {
    const outDb = openOutboundDb(groupId, sessionId);
    try {
      const rows = outDb
        .prepare(
          `SELECT task_message_id, trigger_source, status, started_at, completed_at,
                  duration_ms, exit_code, signal, error, wake_agent, provider_invoked
             FROM task_attempts WHERE series_id = ?
             ORDER BY started_at DESC LIMIT 10`,
        )
        .all(seriesId) as Array<{
        task_message_id: string;
        trigger_source: string;
        status: TaskAttemptDto['status'];
        started_at: string;
        completed_at: string | null;
        duration_ms: number | null;
        exit_code: number | null;
        signal: string | null;
        error: string | null;
        wake_agent: number | null;
        provider_invoked: number;
      }>;
      return rows.map((row) => ({
        taskMessageId: row.task_message_id,
        triggerSource: row.trigger_source === 'manual' ? 'manual' : 'scheduled',
        status: row.status,
        startedAt: row.started_at,
        completedAt: row.completed_at,
        durationMs: row.duration_ms,
        exitCode: row.exit_code,
        signal: row.signal,
        error: row.error,
        wakeAgent: row.wake_agent === null ? null : row.wake_agent === 1,
        providerInvoked: row.provider_invoked === 1,
      }));
    } finally {
      outDb.close();
    }
  } catch {
    return [];
  }
}

/** Validate a cron expression in the configured timezone. */
async function isValidCron(expr: string): Promise<boolean> {
  try {
    const { CronExpressionParser } = await import('cron-parser');
    CronExpressionParser.parse(expr, { tz: TIMEZONE });
    return true;
  } catch {
    return false;
  }
}

/** `?channel=&mg=` override for locating a non-web thread's session. */
function taskOverride(req: http.IncomingMessage): { channelType: string; messagingGroupId: string } | undefined {
  const q = new URLSearchParams((req.url || '').split('?')[1] || '');
  const channel = q.get('channel') || undefined;
  const mg = q.get('mg') || undefined;
  return channel && mg ? { channelType: channel, messagingGroupId: mg } : undefined;
}

/**
 * Resolve the session backing a chat thread for task management. Mirrors the
 * ownership/DM scoping of readChatHistory so a user can only reach tasks in
 * a thread they may view.
 */
function resolveThreadSessionForTasks(
  userId: string,
  groupId: string,
  threadId: string,
  override: { channelType: string; messagingGroupId: string } | undefined,
): { sessionId: string; channelType: string; isDm: boolean } | null {
  const elevated = isElevated(userId);
  const target = resolveTargetMessagingGroup(userId, groupId, override, elevated);
  if (!target) return null;
  const isDm = threadId.startsWith('__dm:');
  const session = resolveSessionForMode(groupId, target.messagingGroupId, target.sessionMode, isDm ? '' : threadId);
  if (!session) return null;
  return { sessionId: session.id, channelType: target.channelType, isDm };
}

/** Read full detail of the live (pending/paused) tasks in a thread's session. */
function readLiveTaskDetails(
  groupId: string,
  sessionId: string,
  channelType: string,
  threadId: string,
  isDm: boolean,
): TaskDetailDto[] {
  const out: TaskDetailDto[] = [];
  try {
    const inDb = openInboundDb(groupId, sessionId);
    try {
      const rows = (
        isDm
          ? inDb
              .prepare(
                `SELECT series_id AS id, status, process_after, recurrence, content, MAX(seq) AS _seq
                   FROM messages_in
                  WHERE kind = 'task' AND status IN ('pending', 'paused')
                    AND COALESCE(json_extract(content, '$.triggerSource'), 'scheduled') != 'manual'
                    AND channel_type = ? AND thread_id IS NULL
                  GROUP BY series_id
                  ORDER BY (process_after IS NULL) ASC, process_after ASC`,
              )
              .all(channelType)
          : inDb
              .prepare(
                `SELECT series_id AS id, status, process_after, recurrence, content, MAX(seq) AS _seq
                   FROM messages_in
                  WHERE kind = 'task' AND status IN ('pending', 'paused')
                    AND COALESCE(json_extract(content, '$.triggerSource'), 'scheduled') != 'manual'
                    AND channel_type = ? AND thread_id = ?
                  GROUP BY series_id
                  ORDER BY (process_after IS NULL) ASC, process_after ASC`,
              )
              .all(channelType, threadId)
      ) as {
        id: string;
        status: string;
        process_after: string | null;
        recurrence: string | null;
        content: string;
      }[];
      for (const r of rows) {
        const { prompt, script, scriptTimeoutMs, consecutiveFailures } = parseTaskContent(r.content);
        out.push({
          seriesId: r.id,
          status: r.status === 'paused' ? 'paused' : 'pending',
          nextRunAt: r.process_after,
          recurrence: r.recurrence,
          summary: summarizeTaskPrompt(r.content),
          prompt,
          hasScript: script.length > 0,
          script,
          scriptTimeoutMs,
          consecutiveFailures,
          attempts: readTaskAttempts(groupId, sessionId, r.id),
        });
      }
    } finally {
      inDb.close();
    }
  } catch {
    // inbound db missing or predates task columns
  }
  return out;
}

/**
 * Branch a chat thread at `atMessageId` into a new thread in the same
 * messaging group. Authorized like history reads — anyone who can read a
 * thread may branch it, since a fork produces a private copy and mutates
 * nothing the original participants can see.
 */
function forkChatThread(
  userId: string,
  groupId: string,
  threadId: string,
  atMessageId: string,
  override: { channelType: string; messagingGroupId: string } | undefined,
): ForkThreadResult {
  const target = resolveTargetMessagingGroup(userId, groupId, override, isElevated(userId));
  if (!target) throw new ForkError('thread_not_found');
  // Shared and agent-shared sessions hold many threads in one session; a fork
  // needs a session of its own, which would silently add a second session to
  // a messaging group whose whole point is having one.
  if (target.sessionMode !== 'per-thread') throw new ForkError('unsupported_session_mode');
  // Threadless DM rooms have no thread to cut.
  if (threadId.startsWith('__dm:')) throw new ForkError('unsupported_session_mode');

  const session = findSessionForAgent(groupId, target.messagingGroupId, threadId);
  if (!session) throw new ForkError('thread_not_found');

  let parentTitle: string | null = null;
  try {
    const inDb = openInboundDb(groupId, session.id);
    try {
      parentTitle = readThreadTitle(inDb, {
        channelType: target.channelType,
        platformId: null,
        threadId,
      });
    } finally {
      inDb.close();
    }
  } catch {
    /* title is cosmetic */
  }

  return forkThread({
    agentGroupId: groupId,
    messagingGroupId: target.messagingGroupId,
    channelType: target.channelType,
    parentSession: session,
    parentThreadId: threadId,
    anchorMessageId: atMessageId,
    newThreadId: crypto.randomUUID(),
    parentTitle,
  });
}

/**
 * Delete a chat thread: drop its session row, its search-index rows, and its
 * on-disk session directory. Returns thread and cancelled-approval counts.
 *
 * Kills the running container before removing files so the agent-runner doesn't poll a
 * nuked inbound.db forever (which used to spam `unable to open database
 * file` until the host sweeper noticed — and even then the sweeper only
 * acts on heartbeat staleness, not on missing files).
 *
 * A fork shares no mutable state with its parent, so deleting either side
 * alone is safe. Without `cascade` the branches survive and render as
 * orphans; with it, the whole subtree goes.
 */
function deleteChatThread(
  userId: string,
  groupId: string,
  threadId: string,
  override: { channelType: string; messagingGroupId: string } | undefined,
  cascade = false,
  cancelApprovals = false,
): { removed: number; cancelledApprovals: number } {
  const target = resolveTargetMessagingGroup(userId, groupId, override, true);
  if (!target) return { removed: 0, cancelledApprovals: 0 };
  const session = findSessionForAgent(groupId, target.messagingGroupId, threadId);
  if (!session) return { removed: 0, cancelledApprovals: 0 };

  const targets = [threadId];
  if (cascade) {
    for (const d of getThreadForkDescendants(groupId, target.messagingGroupId, threadId)) targets.push(d.thread_id);
  }

  const sessions = targets.flatMap((id) => {
    const s = id === threadId ? session : findSessionForAgent(groupId, target.messagingGroupId, id);
    return s ? [{ threadId: id, session: s }] : [];
  });
  const cancelledApprovals = transaction(getDb(), () => {
    let cancelled = 0;
    for (const { session: s } of sessions) cancelled += deleteSession(s.id, cancelApprovals);
    // Surviving branches retain their lineage to the deleted parent.
    for (const id of targets) deleteThreadFork(groupId, target.messagingGroupId, id);
    return cancelled;
  })();
  if (cancelledApprovals > 0) {
    log.info('Outstanding approvals cancelled by thread deletion', {
      userId,
      groupId,
      threadId,
      cancelledApprovals,
    });
  }
  const doomed = new Set(targets);
  for (const { threadId: id, session: s } of sessions) {
    const dir = sessionDir(groupId, s.id);
    killContainer(s.id, 'thread-deleted');
    handoffIndexedMessages(groupId, target.messagingGroupId, id, s.id, doomed);
    deleteSessionFromIndex(s.id);
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch (err) {
      log.warn('failed to rm session dir', { dir, err });
    }
  }
  return { removed: sessions.length, cancelledApprovals };
}

/**
 * Move a dying thread's still-live messages to a branch before the purge.
 *
 * Every surviving branch holds the parent's messages up to its own cut, so the
 * branch that cut deepest covers a superset of what the others do — and since
 * the index is keyed by message id there is only one destination to give.
 */
function handoffIndexedMessages(
  agentGroupId: string,
  messagingGroupId: string,
  threadId: string,
  sessionId: string,
  doomed: Set<string>,
): void {
  let heir: { sessionId: string; threadId: string; ts: string } | null = null;
  for (const child of getThreadForkChildren(agentGroupId, messagingGroupId, threadId)) {
    if (doomed.has(child.thread_id)) continue;
    if (heir && child.parent_message_ts <= heir.ts) continue;
    const childSession = findSessionForAgent(agentGroupId, messagingGroupId, child.thread_id);
    if (!childSession) continue;
    heir = { sessionId: childSession.id, threadId: child.thread_id, ts: child.parent_message_ts };
  }
  if (!heir) return;
  reassignIndexedMessages(sessionId, heir.sessionId, heir.threadId, heir.ts);
}

// ── WebSocket upgrade ──

const wss = new WebSocketServer({ noServer: true, maxPayload: 4096, perMessageDeflate: false });

export function closeChatSockets(): void {
  for (const client of wss.clients) client.terminate();
}

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

function authenticateChatUpgrade(req: http.IncomingMessage, socket: internal.Duplex): ReturnType<typeof authenticate> {
  const session = authenticate(req);
  if (!session || req.headers.origin !== new URL(uiBaseUrl()).origin) {
    socket.write(`HTTP/1.1 ${session ? '403 Forbidden' : '401 Unauthorized'}\r\nContent-Length: 0\r\n\r\n`);
    socket.destroy();
    return null;
  }
  return session;
}

/** Upgrade handler — mount at `/ui/chat` via mountUpgradeHandler. */
export function handleChatUpgrade(req: http.IncomingMessage, socket: internal.Duplex, head: Buffer): void {
  if ((req.url || '').split('?')[0] === '/ui/chat/api/sync/ws') {
    const session = authenticateChatUpgrade(req, socket);
    if (!session) return;
    wss.handleUpgrade(req, socket, head, (ws) => {
      attachKeepalive(ws);
      attachSyncSocket(ws, session.userId, session.sessionHash);
    });
    return;
  }
  if (
    handleVoiceUpgrade(req, socket, head, {
      expectedOrigin: new URL(uiBaseUrl()).origin,
      canSend: (userId, groupId, query) => {
        const mg = query.get('mg');
        const channel = query.get('channel') || WEB_CHANNEL_TYPE;
        if (!mg) ensureWebMessagingGroup(groupId);
        const target = resolveTargetMessagingGroup(
          userId,
          groupId,
          mg ? { channelType: channel, messagingGroupId: mg } : undefined,
          false,
        );
        return !!target && userOwnsMessagingGroup(userId, groupId, target.channelType, target.messagingGroupId);
      },
    })
  )
    return;
  socket.destroy();
}

function attachKeepalive(ws: WebSocket): void {
  const keepalive = ws as KeepaliveWs;
  keepalive.isAlive = true;
  ws.on('pong', () => {
    keepalive.isAlive = true;
  });
  ws.on('message', () => {
    keepalive.isAlive = true;
  });
}
