/**
 * HTTP route handlers for the chat web app (mounted at /ui/chat by the
 * UI shell in ../server.ts). The shell owns shared auth at /ui/auth/* and
 * mints the cookie this dispatcher reads.
 */
import fs from 'fs';
import http from 'http';
import path from 'path';
import { URL } from 'url';

import Router from 'find-my-way';

import { GROUPS_DIR } from '../../../config.js';
import { getAgentGroup } from '../../../db/agent-groups.js';
import { getDb } from '../../../db/connection.js';
import { getSession } from '../../../db/sessions.js';
import { log } from '../../../log.js';
import { listAccessibleAgentGroups, canAccessAgentGroup } from '../../../modules/permissions/access.js';
import { grantRole, hasAdminPrivilege, isGlobalAdmin, isOwner } from '../../../modules/permissions/db/user-roles.js';
import { isUserOnboarded } from '../../../modules/permissions/db/users.js';
import { createGroup, GroupCreateError } from '../../../modules/groups/create.js';
import { deleteSubscriptionByEndpoint, upsertSubscription } from '../../../modules/push/db.js';
import { pushAvailable, vapidPublicKey } from '../../../modules/push/sender.js';
import { dispatchResponse } from '../../../response-registry.js';
import type { PendingApproval } from '../../../types.js';
import { authenticate, recordAccess } from '../auth.js';
import { applyBrandTokens, brandBootstrapScript, getBranding } from '../branding.js';
import { createDownloadToken, redeemDownloadToken } from '../download-tokens.js';
import { uiBaseUrl } from '../server.js';
import { siteFqdn } from '../pages/site.js';
import { classify, resolveSafe } from './classify.js';
import { decideFileApiCors } from './cors.js';
import { fileEtag } from './etag.js';
import {
  handleChatRequest,
  handleChatUpgrade,
  listAllThreadsForAgentGroup,
  listAllThreadsForUser,
  readChatHistory,
  viewerHasContent,
} from './chat.js';
import type { ThreadSummary, HistoryMessage } from './chat.js';
import { handleGroupAdminRequest } from './group-admin.js';
import { handleWriteRequest } from './write.js';

export { handleChatUpgrade };

// UI assets live under src/ (not compiled by tsc); resolve from project root,
// which the host always runs from.
const UI_DIR = path.resolve(process.cwd(), 'src', 'ui', 'client', 'chat');
const MAX_INLINE_BYTES = 10 * 1024 * 1024; // 10 MB
const MAX_DOWNLOAD_BYTES = 100 * 1024 * 1024; // 100 MB
const ASSET_VERSION = String(Date.now());

/** Path prefix the chat web app is mounted under on the shared HTTP server. */
export const CHAT_MOUNT_PREFIX = '/ui/chat';

interface Ctx {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  url: URL;
}

export async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  const ctx: Ctx = { req, res, url };

  // Strip the mount prefix so route patterns stay local.
  let pathname = url.pathname;
  if (pathname === CHAT_MOUNT_PREFIX) {
    // /ui/chat (no trailing slash) → redirect to /ui/chat/ so relative URLs resolve.
    res.writeHead(308, { Location: CHAT_MOUNT_PREFIX + '/' });
    res.end();
    return;
  }
  if (pathname.startsWith(CHAT_MOUNT_PREFIX + '/')) {
    pathname = pathname.slice(CHAT_MOUNT_PREFIX.length) || '/';
  }

  // Cross-origin (same-site) access from a group's own Pages subdomain to its
  // file API. A page served at https://<slug>.<pages-domain> may read/write
  // the files of *its own* group only; the allowed origin is derived from the
  // group id in the path. Preflight (OPTIONS) is answered here because it
  // carries no cookie and would otherwise fall through to a 401. Same-origin
  // UI requests carry a non-matching (or absent) Origin and are untouched.
  const cors = decideFileApiCors(pathname, req.method || 'GET', req.headers.origin, allowedPagesOriginForGroup);
  if (cors) {
    for (const [k, v] of Object.entries(cors.headers)) res.setHeader(k, v);
    if (cors.preflight) {
      res.writeHead(cors.preflight.status);
      res.end();
      return;
    }
  }

  try {
    const found = router.find(req.method as 'GET' | 'POST' | 'PUT' | 'DELETE' | 'HEAD' | 'OPTIONS' | 'PATCH', pathname);
    if (found) {
      await (found.handler as unknown as RouteHandler)(ctx, found.params as Record<string, string>);
      return;
    }
    // Fall-through: chat + write modules still own their own internal
    // dispatch. Try them before returning 404.
    const session = authenticate(req);
    if (!session) return json(ctx, 401, { error: 'unauthorized' });
    if (await handleGroupAdminRequest(req, res, pathname)) return;
    if (await handleChatRequest(req, res, pathname, session.userId)) return;
    if (await handleWriteRequest(req, res, url, pathname, session.userId)) return;
    return json(ctx, 404, { error: 'not_found' });
  } catch (err) {
    log.error('File browser handler threw', { url: req.url, err });
    return json(ctx, 500, { error: 'internal_error' });
  }
}

// ── router ────────────────────────────────────────────────────────────────

type RouteHandler = (ctx: Ctx, params: Record<string, string>) => void | Promise<void>;
type FmwMethod = Parameters<ReturnType<typeof Router>['on']>[0];

const router = Router({
  caseSensitive: true,
  ignoreTrailingSlash: false,
  // Never invoked — we dispatch via router.find() — but the option is required.
  defaultRoute: (_req, res) => {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end('{"error":"not_found"}');
  },
});

/** Register a RouteHandler with find-my-way. The cast hides the fact
 * that we don't use FMW's (req, res, params) calling convention — we
 * call handlers ourselves from find() with a Ctx. */
function on(method: FmwMethod, route: string, handler: RouteHandler): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  router.on(method, route, handler as any);
}

/** Wrap a handler that requires an authenticated session; injects userId.
 *
 * When the request is a top-level browser navigation (Sec-Fetch-Mode:
 * navigate, GET, accepts HTML), redirect to the shared login page with
 * `?next=` set to the original URL so the user lands back on the file
 * after signing in. XHR/fetch from the SPA still gets a JSON 401. */
function authed(fn: (ctx: Ctx, userId: string, params: Record<string, string>) => void | Promise<void>): RouteHandler {
  return async (ctx, params) => {
    const session = authenticate(ctx.req);
    if (!session) {
      if (isBrowserNavigation(ctx.req)) return redirectToLogin(ctx);
      return json(ctx, 401, { error: 'unauthorized' });
    }
    return fn(ctx, session.userId, params);
  };
}

function isBrowserNavigation(req: http.IncomingMessage): boolean {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;
  const mode = req.headers['sec-fetch-mode'];
  if (mode === 'navigate') return true;
  // Older browsers without Sec-Fetch-Mode: fall back to Accept sniffing.
  // XHR/fetch typically sends Accept: */* or application/json.
  if (mode == null) {
    const accept = String(req.headers['accept'] || '');
    if (accept.includes('text/html')) return true;
  }
  return false;
}

function redirectToLogin(ctx: Ctx): void {
  // req.url is the original mount-relative URL (the chat dispatcher only
  // mutates a local `pathname`), so it already starts with /ui/chat/...
  // and is safe as the next= target.
  const next = ctx.req.url || CHAT_MOUNT_PREFIX + '/';
  const loginUrl = `/ui/login?next=${encodeURIComponent(next)}`;
  ctx.res.writeHead(303, { Location: loginUrl });
  ctx.res.end();
}

// Static + public.
on('GET', '/', (ctx) => serveShell(ctx, 'index.html'));
on('GET', '/index.html', (ctx) => serveShell(ctx, 'index.html'));
// Web Share Target landing — the manifest points /ui/chat/share here.
// We serve the SPA shell; the client reads the share params from the URL.
on('GET', '/share', (ctx) => serveShell(ctx, 'index.html'));
on('GET', '/manifest.webmanifest', (ctx) => serveStatic(ctx, 'manifest.webmanifest'));
on('GET', '/icon.svg', (ctx) => serveStatic(ctx, 'icon.svg'));
on('GET', '/icon-192.png', (ctx) => serveStatic(ctx, 'icon-192.png'));
on('GET', '/icon-512.png', (ctx) => serveStatic(ctx, 'icon-512.png'));
on('GET', '/icon-maskable-512.png', (ctx) => serveStatic(ctx, 'icon-maskable-512.png'));
on('GET', '/dist/*', (ctx, params) => serveStatic(ctx, 'dist/' + params['*']));
on('GET', '/dl', (ctx) => handleTokenDownload(ctx));

// Authenticated.
on(
  'GET',
  '/api/me',
  authed((ctx, userId) => handleMe(ctx, userId)),
);
on(
  'GET',
  '/api/groups',
  authed((ctx, userId) => handleGroups(ctx, userId)),
);
on(
  'POST',
  '/api/groups',
  authed((ctx, userId) => handleCreateGroup(ctx, userId)),
);

// File/dir resources: path-in-URL, single endpoint per kind.
//   GET|HEAD /api/groups/:gid/files/<rel/path>           → file bytes
//   GET      /api/groups/:gid/files/<rel/path>?meta=1    → file metadata JSON
//   GET      /api/groups/:gid/dirs[/<rel/path>/]         → directory listing JSON
//   GET      /api/groups/:gid/zip?path=&path=...         → multi-path zip
const filesHandler = authed((ctx, userId, params) => {
  const rel = safeDecode(params['*']);
  if (rel == null) return json(ctx, 400, { error: 'invalid_path' });
  if (ctx.req.method === 'GET' && ctx.url.searchParams.has('meta')) return handleMeta(ctx, userId, params.gid, rel);
  return handleFile(ctx, userId, params.gid, rel);
});
on('GET', '/api/groups/:gid/files/*', filesHandler);
on('HEAD', '/api/groups/:gid/files/*', filesHandler);

const dirsHandler = authed((ctx, userId, params) => {
  const raw = params['*'] ?? '';
  const stripped = raw.replace(/\/$/, '');
  const rel = stripped ? safeDecode(stripped) : '';
  if (rel == null) return json(ctx, 400, { error: 'invalid_path' });
  return handleTree(ctx, userId, params.gid, rel);
});
on('GET', '/api/groups/:gid/dirs', dirsHandler);
on('GET', '/api/groups/:gid/dirs/*', dirsHandler);

on(
  'GET',
  '/api/groups/:gid/zip',
  authed((ctx, userId, params) => handleZip(ctx, userId, params.gid, ctx.url.searchParams.getAll('path'))),
);

on(
  'POST',
  '/api/groups/:gid/share-token',
  authed((ctx, userId, params) => handleShareToken(ctx, userId, params.gid)),
);
// Pending approvals visible to this user (banner inbox in ChatMain).
on(
  'GET',
  '/api/approvals',
  authed((ctx, userId) => handleListApprovals(ctx, userId)),
);
on(
  'POST',
  '/api/approvals/:id/respond',
  authed((ctx, userId, params) => handleRespondApproval(ctx, userId, params.id)),
);
// Consolidated polling endpoint. One ticker on the client hits this and
// receives whichever slices it asked for: approvals (always), threads list
// (when ?gid= present), and a thread's message history (when ?gid=&tid=&
// channel=&mg= present and channel is non-web — web threads use the WS).
on(
  'GET',
  '/api/sync',
  authed((ctx, userId) => handleSync(ctx, userId)),
);
// ── push (PWA tier-2 notifications) ─────────────────────────────────
on('GET', '/api/push/public-key', (ctx) => handlePushPublicKey(ctx));
on(
  'POST',
  '/api/push/subscribe',
  authed((ctx, userId) => handlePushSubscribe(ctx, userId)),
);
on(
  'DELETE',
  '/api/push/subscribe',
  authed((ctx, userId) => handlePushUnsubscribe(ctx, userId)),
);
on(
  'GET',
  '/api/push/notification',
  authed((ctx, userId) => handlePushNotification(ctx, userId)),
);
// Service worker — must be served from the app scope so it can control /ui/chat/.
on('GET', '/sw.js', (ctx) => serveServiceWorker(ctx));
// ── handlers ──────────────────────────────────────────────────────────────

function handleMe(ctx: Ctx, userId: string): void {
  const row = getDb().prepare('SELECT display_name FROM users WHERE id = ?').get(userId) as
    | { display_name: string | null }
    | undefined;
  const displayName = row?.display_name?.trim() || null;
  // `isElevated` controls UI surfaces that are reserved for global
  // owners/admins (e.g. the "Show all" dropdown toggle that enables
  // spectator mode). Group-level admins do NOT get isElevated.
  const isElevated = isOwner(userId) || isGlobalAdmin(userId);
  json(ctx, 200, { userId, displayName, isElevated });
}

function handleGroups(ctx: Ctx, userId: string): void {
  const accessible = listAccessibleAgentGroups(userId);
  // Cheap per-group last-activity lookup so the dropdown can sort by recency.
  type Row = { agent_group_id: string; last_active: string | null };
  const rows = getDb()
    .prepare('SELECT agent_group_id, MAX(last_active) AS last_active FROM sessions GROUP BY agent_group_id')
    .all() as Row[];
  const lastByGroup = new Map<string, string | null>();
  for (const r of rows) lastByGroup.set(r.agent_group_id, r.last_active);
  const groups = accessible.map((g) => ({
    id: g.id,
    name: g.name,
    folder: g.folder,
    isAdmin: hasAdminPrivilege(userId, g.id),
    // Whether this viewer has any messaging context (web mg, or a non-web
    // mg matching one of their identities) in the group. Drives the
    // default dropdown filter; admins can override with "Show all".
    hasContent: viewerHasContent(userId, g.id),
    lastActivityAt: lastByGroup.get(g.id) ?? null,
  }));
  json(ctx, 200, { groups });
}

/**
 * Create a new agent group from the chat UI.
 *
 * Reserved for owners and global admins — scoped admins manage their own
 * group but cannot mint new ones. The creator is auto-granted a scoped
 * `admin` role on the new group so they can immediately manage it from
 * the UI without a second roundtrip.
 */
async function handleCreateGroup(ctx: Ctx, userId: string): Promise<void> {
  if (!isOwner(userId) && !isGlobalAdmin(userId)) {
    return json(ctx, 403, { error: 'forbidden' });
  }

  let body: { name?: unknown; folder?: unknown; instructions?: unknown };
  try {
    body = (await readJsonBody(ctx.req)) as typeof body;
  } catch {
    return json(ctx, 400, { error: 'invalid_json' });
  }

  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!name) return json(ctx, 400, { error: 'name_required' });
  const folder = typeof body.folder === 'string' && body.folder.trim() ? body.folder.trim() : undefined;
  const instructions = typeof body.instructions === 'string' ? body.instructions : undefined;

  let group;
  try {
    group = createGroup({ name, folder, instructions });
  } catch (err) {
    if (err instanceof GroupCreateError) {
      const status = err.code === 'folder_conflict' ? 409 : 400;
      return json(ctx, status, { error: err.code, message: err.message });
    }
    throw err;
  }

  // Auto-grant the creator scoped admin on the new group so the UI's
  // admin surfaces (Settings, Danger Zone) light up immediately.
  try {
    grantRole({
      user_id: userId,
      role: 'admin',
      agent_group_id: group.id,
      granted_by: userId,
      granted_at: new Date().toISOString(),
    });
  } catch (err) {
    log.warn('Failed to auto-grant scoped admin on new group', { userId, groupId: group.id, err });
  }

  log.info('admin_action', {
    actor: userId,
    action: 'group_create',
    target: `agent_group:${group.id}`,
    payload: { name: group.name, folder: group.folder },
  });

  return json(ctx, 200, {
    id: group.id,
    name: group.name,
    folder: group.folder,
    createdAt: group.created_at,
  });
}

interface ApprovalDto {
  approvalId: string;
  action: string;
  title: string;
  details: string | null;
  options: { label: string; value: string }[];
  agentGroupId: string | null;
  agentGroupName: string | null;
  createdAt: string;
}

/** Build a one-line description of the approval from the persisted payload
 * for known actions. The original `question` text from requestApproval is
 * not stored on the row, so we re-derive a comparable summary here. */
function describeApproval(action: string, payloadJson: string): string | null {
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(payloadJson) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (action === 'install_packages') {
    const apt = Array.isArray(payload.apt) ? (payload.apt as string[]) : [];
    const npm = Array.isArray(payload.npm) ? (payload.npm as string[]) : [];
    const pkgs = [...apt.map((p) => `apt: ${p}`), ...npm.map((p) => `npm: ${p}`)].join(', ');
    const reason = typeof payload.reason === 'string' && payload.reason ? ` — ${payload.reason}` : '';
    return pkgs ? `${pkgs}${reason}` : reason || null;
  }
  if (action === 'add_mcp_server') {
    const name = typeof payload.name === 'string' ? payload.name : '';
    const url = typeof payload.url === 'string' ? payload.url : '';
    const command = typeof payload.command === 'string' ? payload.command : '';
    const transport = typeof payload.transport === 'string' ? payload.transport.toUpperCase() : '';
    if (url) return `${name} (${transport} ${url})`;
    if (command) return `${name} (stdio: ${command})`;
    return name || null;
  }
  if (action === 'cli_command') {
    const frame = (payload.frame as Record<string, unknown> | undefined) || undefined;
    if (frame) {
      const cmd = typeof frame.command === 'string' ? frame.command : '';
      const args = (frame.args as Record<string, unknown> | undefined) || {};
      const argStr = Object.entries(args)
        .map(([k, v]) => `--${k} ${typeof v === 'string' ? v : JSON.stringify(v)}`)
        .join(' ');
      return cmd ? `ncl ${cmd}${argStr ? ' ' + argStr : ''}` : null;
    }
  }
  return null;
}

function listApprovalsForUser(userId: string): ApprovalDto[] {
  // pending_approvals are unbounded global rows; filter to those the user
  // is eligible to approve. Owner/global-admin sees all (incl. agent_group_id IS NULL);
  // a scoped admin sees only rows for their agent groups.
  const rows = getDb()
    .prepare("SELECT * FROM pending_approvals WHERE status = 'pending' ORDER BY created_at DESC")
    .all() as PendingApproval[];
  const elevated = isOwner(userId) || isGlobalAdmin(userId);
  const groupNameCache = new Map<string, string | null>();
  const visible: ApprovalDto[] = [];
  for (const r of rows) {
    if (r.agent_group_id == null) {
      if (!elevated) continue;
    } else if (!hasAdminPrivilege(userId, r.agent_group_id)) {
      continue;
    }
    // Display group: prefer row.agent_group_id; fall back to the session's
    // agent group (cli_command rows have null agent_group_id but their
    // session is scoped to one).
    let displayGroupId: string | null = r.agent_group_id;
    if (displayGroupId == null && r.session_id) {
      const s = getSession(r.session_id);
      displayGroupId = s?.agent_group_id ?? null;
    }
    let groupName: string | null = null;
    if (displayGroupId) {
      if (groupNameCache.has(displayGroupId)) {
        groupName = groupNameCache.get(displayGroupId) ?? null;
      } else {
        const g = getAgentGroup(displayGroupId);
        groupName = g?.name ?? null;
        groupNameCache.set(displayGroupId, groupName);
      }
    }
    let options: { label: string; value: string }[] = [];
    try {
      const parsed = JSON.parse(r.options_json) as { label?: string; value?: string }[];
      if (Array.isArray(parsed)) {
        options = parsed
          .filter((o) => o && typeof o.label === 'string' && typeof o.value === 'string')
          .map((o) => ({ label: o.label as string, value: o.value as string }));
      }
    } catch {
      // ignore — fall back to empty options
    }
    visible.push({
      approvalId: r.approval_id,
      action: r.action,
      title: r.title,
      details: describeApproval(r.action, r.payload),
      options,
      agentGroupId: displayGroupId,
      agentGroupName: groupName,
      createdAt: r.created_at,
    });
  }
  return visible;
}

function handleListApprovals(ctx: Ctx, userId: string): void {
  json(ctx, 200, { approvals: listApprovalsForUser(userId) });
}

interface QuestionDto {
  questionId: string;
  title: string;
  question: string;
  options: { label: string; value: string }[];
  threadId: string | null;
  agentGroupId: string;
  createdAt: string;
}

function listPendingQuestionsForUser(userId: string, filterGroupId?: string, filterThreadId?: string): QuestionDto[] {
  const rows = getDb()
    .prepare(
      'SELECT pq.*, s.agent_group_id FROM pending_questions pq JOIN sessions s ON pq.session_id = s.id ORDER BY pq.created_at DESC',
    )
    .all() as Array<{
    question_id: string;
    session_id: string;
    message_out_id: string;
    platform_id: string | null;
    channel_type: string | null;
    thread_id: string | null;
    title: string;
    options_json: string;
    created_at: string;
    agent_group_id: string;
  }>;
  const visible: QuestionDto[] = [];
  for (const r of rows) {
    if (!canAccessAgentGroup(userId, r.agent_group_id).allowed) continue;
    if (filterGroupId && r.agent_group_id !== filterGroupId) continue;
    if (filterThreadId && r.thread_id !== filterThreadId) continue;
    let options: { label: string; value: string }[] = [];
    try {
      const parsed = JSON.parse(r.options_json) as { label?: string; value?: string }[];
      if (Array.isArray(parsed)) {
        options = parsed
          .filter((o) => o && typeof o.label === 'string' && typeof o.value === 'string')
          .map((o) => ({ label: o.label as string, value: o.value as string }));
      }
    } catch {
      /* ignore */
    }
    visible.push({
      questionId: r.question_id,
      title: r.title,
      question: r.title, // title is the display question text
      options,
      threadId: r.thread_id,
      agentGroupId: r.agent_group_id,
      createdAt: r.created_at,
    });
  }
  return visible;
}

interface SyncResponse {
  approvals: ApprovalDto[];
  questions?: QuestionDto[];
  threads?: ThreadSummary[];
  threadMessages?: HistoryMessage[];
}

function handleSync(ctx: Ctx, userId: string): void {
  const out: SyncResponse = { approvals: listApprovalsForUser(userId) };
  const gid = ctx.url.searchParams.get('gid') || '';
  if (gid && canAccessAgentGroup(userId, gid).allowed && getAgentGroup(gid)) {
    // Elevated users (owner/global admin) see every thread; others see
    // only their own. No query-param gate — derived from user role.
    const elevated = isOwner(userId) || isGlobalAdmin(userId);
    try {
      out.threads = elevated ? listAllThreadsForAgentGroup(gid) : listAllThreadsForUser(userId, gid);
    } catch (err) {
      log.warn('sync threads list failed', { userId, gid, err });
    }
    const tid = ctx.url.searchParams.get('tid') || '';
    const channel = ctx.url.searchParams.get('channel') || '';
    const mg = ctx.url.searchParams.get('mg') || '';
    if (tid && channel && channel !== 'web' && mg) {
      try {
        out.threadMessages = readChatHistory(userId, gid, tid, { channelType: channel, messagingGroupId: mg });
      } catch (err) {
        log.warn('sync history read failed', { userId, gid, tid, err });
      }
    }
    // Include pending questions for the active thread.
    out.questions = listPendingQuestionsForUser(userId, gid, tid || undefined);
  }
  json(ctx, 200, out);
}

async function handleRespondApproval(ctx: Ctx, userId: string, approvalId: string): Promise<void> {
  const row = getDb().prepare('SELECT * FROM pending_approvals WHERE approval_id = ?').get(approvalId) as
    | PendingApproval
    | undefined;

  // If the ID doesn't match a pending approval, it might be a pending question
  // (ask_user_question). Both use the same dispatchResponse chain, so fall
  // through to the shared handler below.
  if (row) {
    if (row.status !== 'pending') return json(ctx, 409, { error: 'not_pending' });
    if (row.agent_group_id == null) {
      if (!isOwner(userId) && !isGlobalAdmin(userId)) return json(ctx, 403, { error: 'forbidden' });
    } else if (!hasAdminPrivilege(userId, row.agent_group_id)) {
      return json(ctx, 403, { error: 'forbidden' });
    }
  }

  let body: { value?: unknown };
  try {
    body = (await readJsonBody(ctx.req)) as { value?: unknown };
  } catch {
    return json(ctx, 400, { error: 'invalid_body' });
  }
  const value = typeof body?.value === 'string' ? body.value : null;
  if (!value) return json(ctx, 400, { error: 'value_required' });

  const claimed = await dispatchResponse({
    questionId: approvalId,
    value,
    userId,
    channelType: 'web',
    platformId: userId,
    threadId: null,
  });
  if (!claimed) {
    log.warn('Web approval/question response unclaimed', { approvalId, userId, value });
    return json(ctx, 404, { error: 'not_found' });
  }
  json(ctx, 200, { ok: true });
}

function handleTree(ctx: Ctx, userId: string, groupId: string, relPath: string): void {
  const group = resolveGroupAccess(userId, groupId);
  if (!group) return json(ctx, 403, { error: 'forbidden' });

  const groupDir = path.resolve(GROUPS_DIR, group.folder);
  const abs = resolveSafe(groupDir, relPath);
  if (!abs) return json(ctx, 400, { error: 'invalid_path' });

  let stat: fs.Stats;
  try {
    stat = fs.statSync(abs);
  } catch {
    return json(ctx, 404, { error: 'not_found' });
  }
  if (!stat.isDirectory()) return json(ctx, 400, { error: 'not_a_directory' });

  const isAdmin = hasAdminPrivilege(userId, group.id);
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(abs, { withFileTypes: true });
  } catch (err) {
    log.warn('readdir failed', { groupId, relPath, err });
    return json(ctx, 500, { error: 'readdir_failed' });
  }

  const out = [];
  for (const e of entries) {
    const childRel = relPath ? `${relPath}/${e.name}` : e.name;
    const cls = classify(childRel);
    if (cls.kind === 'hidden') continue;
    if (cls.tier === 'admin' && !isAdmin) continue;

    let size: number | null = null;
    let mtime: string | null = null;
    try {
      const s = fs.statSync(path.join(abs, e.name));
      size = s.isFile() ? s.size : null;
      mtime = s.mtime.toISOString();
    } catch {
      // dangling symlink or race; skip stat fields.
    }
    out.push({
      name: e.name,
      path: childRel,
      type: e.isDirectory() ? 'dir' : e.isFile() ? 'file' : 'other',
      size,
      mtime,
      readonly: cls.readonly,
      tier: cls.tier,
    });
  }
  out.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  recordAccess({ userId, groupId: group.id, path: relPath, action: 'tree', req: ctx.req });
  json(ctx, 200, { path: relPath, entries: out });
}

function handleFile(ctx: Ctx, userId: string, groupId: string, relPath: string): void {
  const group = resolveGroupAccess(userId, groupId);
  if (!group) return json(ctx, 403, { error: 'forbidden' });
  if (!relPath) return json(ctx, 400, { error: 'invalid_path' });

  const cls = classify(relPath);
  if (cls.kind === 'hidden') return json(ctx, 404, { error: 'not_found' });
  const isAdmin = hasAdminPrivilege(userId, group.id);
  if (cls.tier === 'admin' && !isAdmin) return json(ctx, 403, { error: 'forbidden' });

  const groupDir = path.resolve(GROUPS_DIR, group.folder);
  const abs = resolveSafe(groupDir, relPath);
  if (!abs) return json(ctx, 400, { error: 'invalid_path' });

  let stat: fs.Stats;
  try {
    stat = fs.statSync(abs);
  } catch {
    return json(ctx, 404, { error: 'not_found' });
  }
  if (!stat.isFile()) return json(ctx, 400, { error: 'not_a_file' });
  if (stat.size > MAX_DOWNLOAD_BYTES) return json(ctx, 413, { error: 'too_large' });

  const filename = path.basename(abs);
  const ext = path.extname(filename).toLowerCase();
  const mime = mimeFor(ext);
  const inline = mime.inlineSafe && stat.size <= MAX_INLINE_BYTES;

  const headers: http.OutgoingHttpHeaders = {
    'Content-Type': mime.type,
    'Content-Length': stat.size,
    'Last-Modified': stat.mtime.toUTCString(),
    // Strong validator a client echoes back as `If-Match` when it later
    // overwrites this file via the write/upload API (optimistic concurrency).
    ETag: fileEtag(stat),
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'private, max-age=0, must-revalidate',
  };
  headers['Content-Disposition'] = `${inline ? 'inline' : 'attachment'}; filename="${encodeURIComponent(filename)}"`;

  // HTML rendered inline is same-origin to the UI, so a malicious page
  // could read the auth cookie via JS or fetch the UI's APIs. Sandbox it
  // so the document gets an opaque origin (no document.cookie / no
  // same-origin fetch) while still allowing scripts, forms, and the
  // browser to load sibling assets via the same /raw route. Asset GETs
  // are still cookie-authenticated because cookies attach by URL, not
  // origin — so relative <img src>, <link href>, etc. work normally.
  if (mime.type === 'text/html; charset=utf-8') {
    headers['Content-Security-Policy'] = 'sandbox allow-scripts allow-forms';
  }

  recordAccess({ userId, groupId: group.id, path: relPath, action: 'file', req: ctx.req });
  ctx.res.writeHead(200, headers);
  if (ctx.req.method === 'HEAD') {
    ctx.res.end();
    return;
  }
  fs.createReadStream(abs).pipe(ctx.res);
}

// File extensions we'll try to extract embedded metadata from. music-metadata
// covers audio/video container tags (ID3, Vorbis, MP4 atoms…); exifr covers
// image EXIF. Both are dynamically imported — if either isn't installed the
// endpoint just returns basic stat info.
const AUDIO_META_EXTS = new Set(['.mp3', '.m4a', '.aac', '.wav', '.ogg', '.oga', '.opus', '.flac', '.weba']);
const VIDEO_META_EXTS = new Set(['.mp4', '.m4v', '.mov', '.webm', '.ogv']);
const IMAGE_META_EXTS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.tif', '.tiff', '.heic', '.heif']);

async function handleMeta(ctx: Ctx, userId: string, groupId: string, relPath: string): Promise<void> {
  const group = resolveGroupAccess(userId, groupId);
  if (!group) return json(ctx, 403, { error: 'forbidden' });
  if (!relPath) return json(ctx, 400, { error: 'invalid_path' });

  const cls = classify(relPath);
  if (cls.kind === 'hidden') return json(ctx, 404, { error: 'not_found' });
  const isAdmin = hasAdminPrivilege(userId, group.id);
  if (cls.tier === 'admin' && !isAdmin) return json(ctx, 403, { error: 'forbidden' });

  const groupDir = path.resolve(GROUPS_DIR, group.folder);
  const abs = resolveSafe(groupDir, relPath);
  if (!abs) return json(ctx, 400, { error: 'invalid_path' });

  let stat: fs.Stats;
  try {
    stat = fs.statSync(abs);
  } catch {
    return json(ctx, 404, { error: 'not_found' });
  }
  if (!stat.isFile()) return json(ctx, 400, { error: 'not_a_file' });

  const ext = path.extname(abs).toLowerCase();
  const etag = fileEtag(stat);
  ctx.res.setHeader('ETag', etag);
  const out: Record<string, unknown> = {
    name: path.basename(abs),
    size: stat.size,
    mtime: stat.mtime.toISOString(),
    // Version token for optimistic-concurrency writes (pass back as If-Match).
    etag,
    mime: mimeFor(ext).type,
    ext,
  };
  const media = await readMediaTags(abs, ext);
  if (media?.tags) out.tags = media.tags;
  if (media?.lyrics) out.lyrics = media.lyrics;
  return json(ctx, 200, out);
}

interface MediaMeta {
  tags: Record<string, string> | null;
  lyrics: string | null;
}

async function readMediaTags(abs: string, ext: string): Promise<MediaMeta | null> {
  try {
    if (AUDIO_META_EXTS.has(ext) || VIDEO_META_EXTS.has(ext)) {
      const mm = await import('music-metadata').catch(() => null);
      if (!mm) return null;
      const parsed = await mm.parseFile(abs, { duration: true });
      const c = parsed.common;
      const f = parsed.format;
      const t: Record<string, string> = {};
      if (c.title) t.Title = c.title;
      if (c.artist) t.Artist = c.artist;
      if (c.albumartist && c.albumartist !== c.artist) t['Album artist'] = c.albumartist;
      if (c.album) t.Album = c.album;
      if (c.year) t.Year = String(c.year);
      if (c.track?.no != null) t.Track = c.track.of ? `${c.track.no}/${c.track.of}` : String(c.track.no);
      if (c.genre?.length) t.Genre = c.genre.join(', ');
      if (c.composer?.length) t.Composer = c.composer.join(', ');
      if (f.duration) t.Duration = formatDuration(f.duration);
      if (f.bitrate) t.Bitrate = `${Math.round(f.bitrate / 1000)} kbps`;
      if (f.sampleRate) t['Sample rate'] = `${f.sampleRate} Hz`;
      if (f.numberOfChannels) t.Channels = String(f.numberOfChannels);
      if (f.codec) t.Codec = f.codec;
      if (f.container && f.container !== f.codec) t.Container = f.container;
      let lyrics: string | null = null;
      const rawLyrics = (c as { lyrics?: unknown }).lyrics;
      if (Array.isArray(rawLyrics)) {
        const texts: string[] = [];
        for (const l of rawLyrics) {
          if (typeof l === 'string') texts.push(l);
          else if (l && typeof l === 'object' && typeof (l as { text?: unknown }).text === 'string') {
            texts.push((l as { text: string }).text);
          }
        }
        const joined = texts.join('\n\n').trim();
        if (joined) lyrics = joined;
      } else if (typeof rawLyrics === 'string' && rawLyrics.trim()) {
        lyrics = rawLyrics.trim();
      }
      return { tags: Object.keys(t).length > 0 ? t : null, lyrics };
    }
    if (IMAGE_META_EXTS.has(ext)) {
      const exifr = await import('exifr').catch(() => null);
      if (!exifr) return null;
      const fn =
        (exifr as { parse?: (p: string) => Promise<Record<string, unknown> | undefined> }).parse ??
        (exifr as { default?: { parse: (p: string) => Promise<Record<string, unknown> | undefined> } }).default?.parse;
      if (!fn) return null;
      const e = await fn(abs).catch(() => null);
      if (!e) return null;
      const t: Record<string, string> = {};
      const make = e.Make ? String(e.Make).trim() : '';
      const model = e.Model ? String(e.Model).trim() : '';
      if (make || model) t.Camera = [make, model].filter(Boolean).join(' ');
      if (e.LensModel) t.Lens = String(e.LensModel);
      if (e.DateTimeOriginal) {
        const d = e.DateTimeOriginal instanceof Date ? e.DateTimeOriginal : new Date(String(e.DateTimeOriginal));
        if (!Number.isNaN(d.getTime())) t.Taken = d.toISOString();
      }
      if (typeof e.ExposureTime === 'number' && e.ExposureTime > 0) {
        t.Exposure = e.ExposureTime >= 1 ? `${e.ExposureTime} s` : `1/${Math.round(1 / e.ExposureTime)} s`;
      }
      if (typeof e.FNumber === 'number') t.Aperture = `f/${e.FNumber}`;
      if (e.ISO != null) t.ISO = String(e.ISO);
      if (typeof e.FocalLength === 'number') t['Focal length'] = `${e.FocalLength} mm`;
      const w = e.ImageWidth ?? e.ExifImageWidth;
      const h = e.ImageHeight ?? e.ExifImageHeight;
      if (typeof w === 'number' && typeof h === 'number') t.Dimensions = `${w} × ${h}`;
      if (e.Orientation != null) t.Orientation = String(e.Orientation);
      if (e.latitude != null && e.longitude != null)
        t.GPS = `${Number(e.latitude).toFixed(5)}, ${Number(e.longitude).toFixed(5)}`;
      return { tags: Object.keys(t).length > 0 ? t : null, lyrics: null };
    }
  } catch (err) {
    // music-metadata throws on malformed media; treat as "no tags".
    log.debug('media metadata extraction failed', { abs, err });
  }
  return null;
}

function formatDuration(seconds: number): string {
  const s = Math.round(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
}

function handleZip(ctx: Ctx, userId: string, groupId: string, paths: string[]): void {
  const group = resolveGroupAccess(userId, groupId);
  if (!group) return json(ctx, 403, { error: 'forbidden' });
  if (paths.length === 0) return json(ctx, 400, { error: 'no_paths' });
  if (paths.length > 500) return json(ctx, 400, { error: 'too_many_paths' });

  const isAdmin = hasAdminPrivilege(userId, group.id);
  const groupDir = path.resolve(GROUPS_DIR, group.folder);

  // Resolve + classify every requested path up front so we either
  // refuse the whole request or stream a complete archive.
  const resolved: { rel: string; abs: string; isDir: boolean }[] = [];
  for (const rel of paths) {
    if (!rel) return json(ctx, 400, { error: 'invalid_path' });
    const cls = classify(rel);
    if (cls.kind === 'hidden') return json(ctx, 404, { error: 'not_found', path: rel });
    if (cls.tier === 'admin' && !isAdmin) return json(ctx, 403, { error: 'forbidden', path: rel });
    const abs = resolveSafe(groupDir, rel);
    if (!abs) return json(ctx, 400, { error: 'invalid_path', path: rel });
    let stat: fs.Stats;
    try {
      stat = fs.statSync(abs);
    } catch {
      return json(ctx, 404, { error: 'not_found', path: rel });
    }
    resolved.push({ rel, abs, isDir: stat.isDirectory() });
  }

  // Build a friendly archive name: single dir → that dir's basename;
  // single file → that file's basename (without ext); multi → group folder.
  let baseName: string;
  if (resolved.length === 1) baseName = path.basename(resolved[0].rel) || group.folder;
  else baseName = `${group.folder}-files`;
  const zipName = `${baseName}.zip`;

  recordAccess({ userId, groupId: group.id, path: paths.join(','), action: 'zip', req: ctx.req });

  ctx.res.writeHead(200, {
    'Content-Type': 'application/zip',
    'Content-Disposition': `attachment; filename="${encodeURIComponent(zipName)}"`,
    'Cache-Control': 'private, no-store',
    'X-Content-Type-Options': 'nosniff',
  });

  // Dynamic import to keep startup lean and so an absent archiver
  // dependency degrades gracefully (returns 500 rather than crashing
  // module load — though we install it as a regular dep so this should
  // never fire in practice).
  void (async () => {
    let archiverMod;
    try {
      archiverMod = (await import('archiver')).default;
    } catch (err) {
      log.error('archiver dynamic import failed', { err });
      try {
        ctx.res.end();
      } catch {
        /* ignore */
      }
      return;
    }
    const archive = archiverMod('zip', { zlib: { level: 6 } });
    archive.on('warning', (err: NodeJS.ErrnoException) => {
      // ENOENT in here is "we lost a race with rm" — log but don't fail.
      if (err.code === 'ENOENT') log.warn('zip archive missing entry', { err });
      else log.error('zip archive warning', { err });
    });
    archive.on('error', (err: Error) => {
      log.error('zip archive error', { err });
      try {
        ctx.res.destroy(err);
      } catch {
        /* ignore */
      }
    });
    archive.pipe(ctx.res);
    for (const { rel, abs, isDir } of resolved) {
      const inZipBase = path.basename(rel);
      if (isDir) archive.directory(abs, inZipBase);
      else archive.file(abs, { name: inZipBase });
    }
    await archive.finalize();
  })();
}

// User-initiated "magic link" share. Mints an unbound (recipient_user_id
// IS NULL) download token for a file the user can already see, and returns
// the public URL. Anyone with the link can download the file (until it
// expires or the use count is exhausted).
const SHARE_TTL_MIN_DEFAULT = 60; // 1h
const SHARE_TTL_MIN_MAX = 7 * 24 * 60; // 7 days
const SHARE_TTL_MIN_MIN = 1;
const SHARE_USES_DEFAULT = 1;
const SHARE_USES_MAX = 100;

async function handleShareToken(ctx: Ctx, userId: string, groupId: string): Promise<void> {
  let body: Record<string, unknown>;
  try {
    body = (await readJsonBody(ctx.req)) as Record<string, unknown>;
  } catch {
    return json(ctx, 400, { error: 'invalid_body' });
  }

  const rawPath = typeof body?.path === 'string' ? body.path : '';
  const relPath = rawPath.replace(/^\/+/, '');
  if (!relPath) return json(ctx, 400, { error: 'invalid_path' });

  const ttlMinutes = clampInt(body?.ttlMinutes, SHARE_TTL_MIN_DEFAULT, SHARE_TTL_MIN_MIN, SHARE_TTL_MIN_MAX);
  const uses = clampInt(body?.uses, SHARE_USES_DEFAULT, 1, SHARE_USES_MAX);

  const group = resolveGroupAccess(userId, groupId);
  if (!group) return json(ctx, 403, { error: 'forbidden' });

  const cls = classify(relPath);
  if (cls.kind === 'hidden') return json(ctx, 404, { error: 'not_found' });
  if (cls.tier === 'admin' && !hasAdminPrivilege(userId, group.id)) {
    return json(ctx, 403, { error: 'forbidden' });
  }

  const groupDir = path.resolve(GROUPS_DIR, group.folder);
  const abs = resolveSafe(groupDir, relPath);
  if (!abs) return json(ctx, 400, { error: 'invalid_path' });

  let stat: fs.Stats;
  try {
    stat = fs.statSync(abs);
  } catch {
    return json(ctx, 404, { error: 'not_found' });
  }
  if (!stat.isFile()) return json(ctx, 400, { error: 'not_a_file' });

  const ttlMs = ttlMinutes * 60_000;
  const { token, expiresAt } = createDownloadToken({
    issuerUserId: userId,
    recipientUserId: null,
    groupId: group.id,
    relPath,
    ttlMs,
    uses,
  });
  const url = `${uiBaseUrl()}${CHAT_MOUNT_PREFIX.slice('/ui'.length)}/dl?t=${token}`;
  recordAccess({ userId, groupId: group.id, path: relPath, action: 'share_token', req: ctx.req });
  return json(ctx, 200, { url, token, expiresAt, ttlMinutes, uses });
}

// ── push handlers ───────────────────────────────────────────────────

function handlePushPublicKey(ctx: Ctx): void {
  if (!pushAvailable()) return json(ctx, 503, { error: 'push_unavailable' });
  json(ctx, 200, { publicKey: vapidPublicKey() });
}

interface PushSubscribeBody {
  endpoint?: unknown;
  keys?: { p256dh?: unknown; auth?: unknown };
}

async function handlePushSubscribe(ctx: Ctx, userId: string): Promise<void> {
  if (!pushAvailable()) return json(ctx, 503, { error: 'push_unavailable' });
  let body: PushSubscribeBody;
  try {
    body = (await readJsonBody(ctx.req)) as PushSubscribeBody;
  } catch {
    return json(ctx, 400, { error: 'invalid_body' });
  }
  const endpoint = typeof body.endpoint === 'string' ? body.endpoint : '';
  const p256dh = typeof body.keys?.p256dh === 'string' ? body.keys.p256dh : '';
  const auth = typeof body.keys?.auth === 'string' ? body.keys.auth : '';
  if (!endpoint || !p256dh || !auth) return json(ctx, 400, { error: 'missing_fields' });
  if (!/^https?:\/\//.test(endpoint)) return json(ctx, 400, { error: 'invalid_endpoint' });
  const ua = String(ctx.req.headers['user-agent'] || '').slice(0, 500) || null;
  upsertSubscription({ userId, endpoint, p256dh, auth, ua });
  json(ctx, 200, { ok: true });
}

async function handlePushUnsubscribe(ctx: Ctx, userId: string): Promise<void> {
  let body: { endpoint?: unknown };
  try {
    body = (await readJsonBody(ctx.req)) as { endpoint?: unknown };
  } catch {
    return json(ctx, 400, { error: 'invalid_body' });
  }
  const endpoint = typeof body.endpoint === 'string' ? body.endpoint : '';
  if (!endpoint) return json(ctx, 400, { error: 'missing_endpoint' });
  // Scope by user_id so a stolen endpoint can't unsubscribe another account.
  const row = getDb().prepare('SELECT user_id FROM push_subscriptions WHERE endpoint = ?').get(endpoint) as
    | { user_id: string }
    | undefined;
  if (row && row.user_id === userId) deleteSubscriptionByEndpoint(endpoint);
  json(ctx, 200, { ok: true });
}

function handlePushNotification(ctx: Ctx, userId: string): void {
  const groupId = ctx.url.searchParams.get('groupId') || '';
  const threadId = ctx.url.searchParams.get('threadId') || '';
  const msgId = ctx.url.searchParams.get('msgId') || '';
  if (!groupId || !threadId || !msgId) return json(ctx, 400, { error: 'missing_params' });
  if (!canAccessAgentGroup(userId, groupId).allowed) return json(ctx, 403, { error: 'forbidden' });
  const group = getAgentGroup(groupId);
  if (!group) return json(ctx, 404, { error: 'group_not_found' });
  const history = readChatHistory(userId, groupId, threadId);
  const msg = history.find((h) => h.id === msgId && h.direction === 'out');
  if (!msg) return json(ctx, 404, { error: 'message_not_found' });
  const text = (msg.text || '').trim();
  const fileCount = msg.files?.length ?? 0;
  const filePart = fileCount > 0 ? ` · ${fileCount} file${fileCount > 1 ? 's' : ''}` : '';
  const body = (text.slice(0, 200) + filePart).trim() || (filePart ? filePart.trim() : 'New message');
  const groupName = group.name || getBranding().name;
  // Per-thread title makes notifications distinguishable when the same
  // group has multiple active threads. Lookup is bounded by the user's
  // accessible thread list and only runs on push delivery (rare).
  let threadTitle = '';
  try {
    const elevated = isOwner(userId) || isGlobalAdmin(userId);
    const threads = elevated ? listAllThreadsForAgentGroup(groupId) : listAllThreadsForUser(userId, groupId);
    threadTitle = threads.find((t) => t.threadId === threadId)?.title || '';
  } catch {
    /* fall back to group name only */
  }
  // System tray clips long titles; keep room for both parts.
  const truncatedThread = threadTitle.length > 40 ? threadTitle.slice(0, 39) + '…' : threadTitle;
  const title = truncatedThread ? `${truncatedThread} · ${groupName}` : groupName;
  json(ctx, 200, {
    title,
    body,
    icon: '/ui/chat/icon.svg',
    timestamp: msg.timestamp,
    groupId,
    threadId,
    msgId,
  });
}

let cachedSw: { version: string; body: Buffer } | null = null;

function serveServiceWorker(ctx: Ctx): void {
  const swPath = path.join(UI_DIR, 'sw.js');
  const appJsPath = path.join(UI_DIR, 'dist', 'app.js');
  let swStat: fs.Stats;
  try {
    swStat = fs.statSync(swPath);
  } catch {
    return text(ctx, 404, 'Not found');
  }
  // Per-deploy stamp so each new dist activates a fresh cache. Includes the
  // bundle size to guard against mtime preservation across rsync/copy.
  let version = `sw-${Math.floor(swStat.mtimeMs)}`;
  try {
    const appStat = fs.statSync(appJsPath);
    let maxMtime = Math.max(Math.floor(swStat.mtimeMs), Math.floor(appStat.mtimeMs));
    // Roll the cache key when a shell-cached static asset (icons, manifest)
    // changes on disk, so installed PWAs pick up the new file on next launch
    // instead of holding the previous version forever via stale-while-revalidate.
    for (const name of ['icon.svg', 'icon-192.png', 'icon-512.png', 'icon-maskable-512.png', 'manifest.webmanifest']) {
      try {
        const s = fs.statSync(path.join(UI_DIR, name));
        if (Math.floor(s.mtimeMs) > maxMtime) maxMtime = Math.floor(s.mtimeMs);
      } catch {
        /* missing asset is fine */
      }
    }
    version = `${maxMtime}-${appStat.size}`;
  } catch {
    /* fall back to sw mtime only */
  }
  if (!cachedSw || cachedSw.version !== version) {
    const raw = fs.readFileSync(swPath, 'utf-8').replace(/__CACHE_VERSION__/g, version);
    cachedSw = { version, body: Buffer.from(applyBrandTokens(raw), 'utf-8') };
  }
  ctx.res.writeHead(200, {
    'Content-Type': 'application/javascript; charset=utf-8',
    'Content-Length': cachedSw.body.length,
    // `private` prevents Cloudflare/proxies from caching; browser still caches per SW rules.
    'Cache-Control': 'private, no-cache, no-store, must-revalidate',
    'CDN-Cache-Control': 'no-store',
    'Service-Worker-Allowed': '/ui/chat/',
  });
  ctx.res.end(cachedSw.body);
}

function clampInt(v: unknown, def: number, min: number, max: number): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? Math.floor(v) : def;
  return Math.min(Math.max(n, min), max);
}

async function readJsonBody(req: http.IncomingMessage, max = 64 * 1024): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const c of req) {
    const buf = c as Buffer;
    total += buf.length;
    if (total > max) throw new Error('body_too_large');
    chunks.push(buf);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function handleTokenDownload(ctx: Ctx): void {
  const token = ctx.url.searchParams.get('t');
  if (!token) return text(ctx, 400, 'Missing token');

  const fwd = ctx.req.headers['x-forwarded-for'];
  const ip = (typeof fwd === 'string' ? fwd.split(',')[0]?.trim() : null) || ctx.req.socket.remoteAddress || null;
  const ua = (ctx.req.headers['user-agent'] as string | undefined) ?? null;

  const row = redeemDownloadToken(token, ip, ua);
  if (!row) {
    recordAccess({ userId: null, groupId: null, path: null, action: 'dl_invalid', req: ctx.req });
    return text(ctx, 404, 'Link is invalid, expired, or already used.');
  }

  const group = getAgentGroup(row.group_id);
  if (!group) {
    log.warn('download token references missing group', { groupId: row.group_id });
    return text(ctx, 404, 'Not found');
  }

  // Re-validate visibility — file may have been moved/hidden since issuance.
  const cls = classify(row.rel_path);
  if (cls.kind === 'hidden') return text(ctx, 404, 'Not found');

  const groupDir = path.resolve(GROUPS_DIR, group.folder);
  const abs = resolveSafe(groupDir, row.rel_path);
  if (!abs) return text(ctx, 400, 'Invalid path');

  let stat: fs.Stats;
  try {
    stat = fs.statSync(abs);
  } catch {
    return text(ctx, 404, 'Not found');
  }
  if (!stat.isFile()) return text(ctx, 400, 'Not a file');
  if (stat.size > MAX_DOWNLOAD_BYTES) return text(ctx, 413, 'File too large');

  const filename = path.basename(abs);
  const ext = path.extname(filename).toLowerCase();
  const mime = mimeFor(ext);
  recordAccess({
    userId: row.recipient_user_id ?? row.issuer_user_id,
    groupId: row.group_id,
    path: row.rel_path,
    action: 'dl_token',
    req: ctx.req,
  });
  ctx.res.writeHead(200, {
    'Content-Type': mime.type,
    'Content-Length': stat.size,
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'private, no-store',
    'Content-Disposition': `attachment; filename="${encodeURIComponent(filename)}"`,
  });
  fs.createReadStream(abs).pipe(ctx.res);
}

// ── helpers ──────────────────────────────────────────────────────────────

function resolveGroupAccess(userId: string, groupId: string): { id: string; folder: string } | null {
  const groups = listAccessibleAgentGroups(userId);
  const match = groups.find((g) => g.id === groupId);
  if (!match) return null;
  const full = getAgentGroup(groupId);
  return full ? { id: full.id, folder: full.folder } : null;
}

const TEXT_EXTS = new Set([
  '.txt',
  '.md',
  '.json',
  '.yaml',
  '.yml',
  '.log',
  '.csv',
  '.tsv',
  '.html',
  '.css',
  '.js',
  '.ts',
  '.tsx',
  '.jsx',
  '.py',
  '.sh',
  '.toml',
  '.ini',
  '.conf',
  '.env',
  '.xml',
  '.svg',
]);
const IMAGE_EXTS: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
};
const AUDIO_EXTS: Record<string, string> = {
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.flac': 'audio/flac',
  '.weba': 'audio/webm',
};
const VIDEO_EXTS: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.ogv': 'video/ogg',
};
const PDF_MIME = 'application/pdf';

// Additional mime types beyond the IMAGE/AUDIO/VIDEO/PDF tables — chosen
// because they show up as sub-resources of typical HTML/JS content and
// must be served with the right Content-Type for the browser to use them
// (fonts, JSON fetched by scripts, source maps, web workers, wasm, etc.).
const EXTRA_MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.cjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.wasm': 'application/wasm',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.eot': 'application/vnd.ms-fontobject',
  '.ico': 'image/x-icon',
  '.bmp': 'image/bmp',
  '.avif': 'image/avif',
  '.heic': 'image/heic',
  '.heif': 'image/heif',
};

function mimeFor(ext: string): { type: string; inlineSafe: boolean } {
  if (ext in IMAGE_EXTS) return { type: IMAGE_EXTS[ext], inlineSafe: ext !== '.svg' };
  if (ext in AUDIO_EXTS) return { type: AUDIO_EXTS[ext], inlineSafe: true };
  if (ext in VIDEO_EXTS) return { type: VIDEO_EXTS[ext], inlineSafe: true };
  if (ext === '.pdf') return { type: PDF_MIME, inlineSafe: true };
  if (ext in EXTRA_MIME) return { type: EXTRA_MIME[ext], inlineSafe: true };
  if (TEXT_EXTS.has(ext)) return { type: 'text/plain; charset=utf-8', inlineSafe: true };
  return { type: 'application/octet-stream', inlineSafe: false };
}

function json(ctx: Ctx, status: number, body: unknown): void {
  ctx.res.writeHead(status, { 'Content-Type': 'application/json' });
  ctx.res.end(JSON.stringify(body));
}

/**
 * The single origin permitted to make cross-origin requests to a group's
 * file API: its own Pages site origin (`https://<slug>.<pages-domain>`).
 * Returns null when the group doesn't exist, has no enabled site, or the
 * Pages feature isn't configured — in which case no CORS header is emitted.
 */
function allowedPagesOriginForGroup(groupId: string): string | null {
  const group = getAgentGroup(groupId);
  if (!group || !group.site_enabled) return null;
  const fqdn = siteFqdn(group);
  return fqdn ? `https://${fqdn}` : null;
}

function text(ctx: Ctx, status: number, body: string): void {
  ctx.res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
  ctx.res.end(body);
}

function safeDecode(s: string): string | null {
  try {
    return decodeURIComponent(s);
  } catch {
    return null;
  }
}

/**
 * SPA shell entrypoint. Same as serveStatic but redirects authenticated
 * users who haven't completed onboarding to the wizard first. Without
 * this gate, users with a live session cookie skip OIDC's
 * `postLoginRedirect` and land straight in the chat app — where, if the
 * per-user agent group doesn't exist, they see "No accessible groups."
 * Unauthenticated requests fall through to the SPA, which handles its
 * own login flow.
 */
function serveShell(ctx: Ctx, relName: string): void {
  const session = authenticate(ctx.req);
  if (session && !isUserOnboarded(session.userId)) {
    ctx.res.writeHead(303, { Location: '/ui/onboarding', 'Cache-Control': 'no-store' });
    ctx.res.end();
    return;
  }
  return serveStatic(ctx, relName);
}

function serveStatic(ctx: Ctx, relName: string): void {
  // Lexical guard: no traversal, no absolute paths. Allow exactly one level
  // of subdirectory (e.g. `dist/app.js`) but reject anything deeper.
  if (relName.includes('..') || path.isAbsolute(relName)) {
    return text(ctx, 400, 'Bad request');
  }
  const segments = relName.split('/');
  if (segments.length > 2 || segments.some((s) => s === '')) {
    return text(ctx, 400, 'Bad request');
  }
  let full = path.join(UI_DIR, ...segments);
  // Per-deploy icon override via UI_BRAND_ICON_DIR. Only top-level icon
  // files (icon.svg, icon-192.png, etc.) are overridable; the override
  // file must exist or we fall back to the bundled default.
  if (segments.length === 1 && /^icon([-.][a-z0-9-]+)?\.(svg|png)$/i.test(segments[0])) {
    const dir = getBranding().iconDir;
    if (dir) {
      const candidate = path.join(dir, segments[0]);
      try {
        if (fs.statSync(candidate).isFile()) full = candidate;
      } catch {
        /* override missing — fall through to bundled default */
      }
    }
  }
  let stat: fs.Stats;
  try {
    stat = fs.statSync(full);
  } catch {
    return text(ctx, 404, 'Not found');
  }
  if (!stat.isFile()) return text(ctx, 404, 'Not found');
  const ext = path.extname(relName).toLowerCase();
  const type =
    ext === '.html'
      ? 'text/html; charset=utf-8'
      : ext === '.css'
        ? 'text/css; charset=utf-8'
        : ext === '.js'
          ? 'application/javascript; charset=utf-8'
          : ext === '.svg'
            ? 'image/svg+xml'
            : ext === '.png'
              ? 'image/png'
              : ext === '.webmanifest'
                ? 'application/manifest+json; charset=utf-8'
                : 'application/octet-stream';
  if (ext === '.html') {
    let body = fs
      .readFileSync(full, 'utf8')
      .replace(/(<script[^>]+src="dist\/app\.js)"/g, `$1?v=${ASSET_VERSION}"`)
      .replace(/(<link[^>]+href="dist\/app\.css)"/g, `$1?v=${ASSET_VERSION}"`);
    body = applyBrandTokens(body).replace(/\{\{BRAND_BOOTSTRAP\}\}/g, brandBootstrapScript());
    const buf = Buffer.from(body, 'utf8');
    ctx.res.writeHead(200, {
      'Content-Type': type,
      'Content-Length': buf.length,
      'Cache-Control': 'no-store, must-revalidate',
      Pragma: 'no-cache',
      Expires: '0',
    });
    ctx.res.end(buf);
    return;
  }
  if (ext === '.webmanifest') {
    const body = applyBrandTokens(fs.readFileSync(full, 'utf8'));
    const buf = Buffer.from(body, 'utf8');
    ctx.res.writeHead(200, {
      'Content-Type': type,
      'Content-Length': buf.length,
      'Cache-Control': 'no-store, must-revalidate',
      Pragma: 'no-cache',
      Expires: '0',
    });
    ctx.res.end(buf);
    return;
  }
  ctx.res.writeHead(200, {
    'Content-Type': type,
    'Content-Length': stat.size,
    'Cache-Control': 'no-store, must-revalidate',
    Pragma: 'no-cache',
    Expires: '0',
  });
  fs.createReadStream(full).pipe(ctx.res);
}
