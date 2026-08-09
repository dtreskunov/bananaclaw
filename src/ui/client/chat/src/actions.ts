// Action orchestrators. Mutate signals + perform IO.
import { batch, type Signal } from '@preact/signals';
import {
  groupId,
  threads,
  threadId,
  channelType,
  messagingGroupId,
  canSend,
  voiceMode,
  chatMessages,
  chatStatus,
  chatLoading,
  chatReady,
  isTyping,
  pendingWebSends,
  typingHint,
  typingStartedAt,
  typingModel,
  activityLog,
  refs,
  treePath,
  filePath,
  treeEntries,
  treeError,
  fileSearchOpen,
  fileSearchRoot,
  fileSearchQuery,
  fileSearchResults,
  fileSearchLoading,
  fileSearchError,
  fileSearchTruncated,
  fileSearchSelectedPath,
  pending,
  previewBlock,
  paneOpen,
  drawerOpen,
  isMobile,
  nowTick,
  pinnedContext,
  pendingApprovals,
  respondingApprovalIds,
  pendingQuestions,
  respondingQuestionIds,
  searchQuery,
  searchResults,
  searchLoading,
  searchError,
  searchOpen,
  highlightMessageId,
  scrollToBottomTick,
  taskPanelRequest,
  userMenuOpen,
  SYNC_INTERVAL_MS,
} from './state';
import { api, postJson } from './api';
import { writeHash } from './hash';
import { isFinalResponse, isWebEchoForClientMessage } from './chat-protocol';
import { maybeNotify } from './notify';
import { playProgressTick, playCompletionChime } from './sound';
import { parentPath } from './utils';
import type {
  Thread,
  ThreadCtx,
  Direction,
  ChatMessage,
  ChatMessageFile,
  DisplayCard,
  TreeEntry,
  PreviewBlock,
  PendingFile,
  PendingApprovalDto,
  PendingQuestionDto,
  WsPayload,
  SearchResult,
  SuggestedAction,
} from './types';

interface ServerMessage {
  id?: string;
  direction: string;
  text: string;
  card?: DisplayCard;
  files?: ChatMessageFile[] | null;
  timestamp: string;
  deliveryOrigin?: 'send_message' | 'send_file' | 'response';
  suggestedAction?: SuggestedAction;
  usage?: import('./types').TurnUsage;
  activity?: import('./types').ActivityLine[];
  event?: import('./types').TimelineEvent;
  reactions?: import('./types').MessageReaction[];
  author?: { userId: string; displayName: string };
}

export function returnToUserMenu(source: Signal<boolean>): void {
  batch(() => {
    source.value = false;
    userMenuOpen.value = true;
  });
}

/**
 * Focus the composer textarea once it's mounted, enabled, and visible. Its
 * form is hidden while a thread starts or reconnects, so a naive focus()
 * after openChat resolves often targets an element that cannot retain focus.
 * Poll briefly with rAF instead
 * (budget ~3s — enough for a typical WS handshake, not so long that a
 * later user click steals focus back from us).
 *
 * No-op on mobile unless the caller is opening a blank thread. Existing
 * threads may be opened for reading, while a blank thread is ready for input.
 */
function focusComposerSoon(options: { mobile?: boolean } = {}): void {
  if (isMobile.value && !options.mobile) return;
  let tries = 0;
  const attempt = (): void => {
    const el = document.getElementById('chat-input') as HTMLTextAreaElement | null;
    if (el && !el.disabled && el.offsetParent !== null) {
      el.focus();
      return;
    }
    if (++tries < 180) requestAnimationFrame(attempt);
  };
  requestAnimationFrame(attempt);
}

/**
 * Request the chat log to scroll to bottom. Used when sending a message
 * so the user sees their just-sent message without waiting for the
 * server round-trip to update chatMessages.
 */
export function requestScrollToBottom(): void {
  scrollToBottomTick.value++;
}

// ── threads ─────────────────────────────────────────────────────────
// Threads are part of the unified /api/sync response and live in the
// `threads` signal. Callers that just want a fresh snapshot before
// rendering can await this; everything else gets updated by the ticker.
export async function loadThreads(_gid: string): Promise<void> {
  await runSync();
}

export async function deleteThread(tid: string): Promise<void> {
  if (!groupId.value) return;
  try {
    const r = await fetch(`api/groups/${encodeURIComponent(groupId.value)}/chat/${encodeURIComponent(tid)}`, {
      method: 'DELETE',
      credentials: 'same-origin',
    });
    if (!r.ok) {
      chatStatus.value = 'delete failed (HTTP ' + r.status + ')';
      return;
    }
  } catch (err) {
    console.error('delete failed', err);
    const m = err instanceof Error ? err.message : 'network error';
    chatStatus.value = 'delete failed: ' + m;
    return;
  }
  threads.value = threads.value.filter((x) => x.threadId !== tid);
  if (threadId.value === tid) {
    const latest = threads.value.length > 0 ? threads.value[0]! : null;
    if (latest) openChat(groupId.value, latest.threadId, threadCtxOf(latest)).catch(console.error);
    else clearChat();
  }
}

function threadCtxOf(t: Thread | null | undefined): ThreadCtx | null {
  if (!t || !t.channelType || t.channelType === 'web') return null;
  return { channelType: t.channelType, messagingGroupId: t.messagingGroupId ?? null, canSend: !!t.canSend };
}

function bumpActiveThread(maxTs?: string): void {
  if (!threadId.value) return;
  const list = threads.value.slice();
  const idx = list.findIndex((x) => x.threadId === threadId.value);
  if (idx < 0) {
    if (groupId.value) loadThreads(groupId.value);
    return;
  }
  const t: Thread = { ...list[idx]! };
  t.lastActivityAt = maxTs || new Date().toISOString();
  t.messageCount = (t.messageCount || 0) + 1;
  list.splice(idx, 1);
  list.unshift(t);
  threads.value = list;
}

function updateActiveThreadTitleFromFirstMessage(text: string): void {
  if (!threadId.value) return;
  const list = threads.value.slice();
  const idx = list.findIndex((x) => x.threadId === threadId.value);
  if (idx < 0) return;
  const t = list[idx]!;
  if (t.title !== '(new thread)') return;
  const clean = String(text || '')
    .replace(/^>\s*Context[^\n]*\n+/i, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!clean) return;
  list[idx] = { ...t, title: clean.slice(0, 60) };
  threads.value = list;
}

// ── search ──────────────────────────────────────────────────────────
let searchGeneration = 0;
let searchController: AbortController | null = null;

export async function searchThreads(gid: string, query: string): Promise<void> {
  if (!query.trim()) {
    clearSearch();
    return;
  }
  const generation = ++searchGeneration;
  searchController?.abort();
  const controller = new AbortController();
  searchController = controller;
  batch(() => {
    searchOpen.value = true;
    searchLoading.value = true;
    searchError.value = '';
    searchQuery.value = query;
  });
  try {
    const url = `api/groups/${encodeURIComponent(gid)}/chat/search?q=${encodeURIComponent(query)}`;
    const { results } = await api<{ results: SearchResult[] }>(url, { signal: controller.signal });
    if (generation !== searchGeneration || controller.signal.aborted) return;
    searchResults.value = results ?? [];
  } catch (err) {
    if (generation !== searchGeneration || controller.signal.aborted) return;
    console.error('search failed', err);
    batch(() => {
      searchError.value = 'Search failed. Check your connection and try again.';
      searchResults.value = [];
    });
  } finally {
    if (generation === searchGeneration) {
      searchLoading.value = false;
      searchController = null;
    }
  }
}

export function clearSearch(): void {
  searchGeneration++;
  searchController?.abort();
  searchController = null;
  batch(() => {
    searchQuery.value = '';
    searchResults.value = null;
    searchLoading.value = false;
    searchError.value = '';
    searchOpen.value = false;
  });
}

// ── chat ────────────────────────────────────────────────────────────
export function clearChat(): void {
  refs.chatGeneration++;
  batch(() => {
    chatMessages.value = [];
    chatStatus.value = '';
    chatLoading.value = false;
    chatReady.value = false;
    threadId.value = null;
    channelType.value = 'web';
    messagingGroupId.value = null;
    canSend.value = true;
    highlightMessageId.value = null;
    isTyping.value = false;
    typingHint.value = '';
    typingStartedAt.value = null;
    typingModel.value = '';
    activityLog.value = [];
  });
  if (refs.ws) {
    try {
      refs.ws.close();
    } catch {
      /* ignore */
    }
    refs.ws = null;
  }
  if (refs.reconnectTimer) {
    clearTimeout(refs.reconnectTimer);
    refs.reconnectTimer = null;
  }
  if (refs.wsPingTimer) {
    clearInterval(refs.wsPingTimer);
    refs.wsPingTimer = null;
  }
  refs.seenIds.clear();
}

// Single global ticker. Hits /api/sync, which returns approvals plus
// (when applicable) the active group's thread list and the active
// non-web thread's history. Web threads use the WS for live updates;
// /api/sync does NOT fetch history for them. Pauses when the tab is
// hidden; resumes via the visibilitychange handler in installLivenessHandlers.
export function stopSyncPoll(): void {
  if (refs.syncTimer) {
    clearInterval(refs.syncTimer);
    refs.syncTimer = null;
  }
}

export function startSyncPoll(): void {
  if (refs.syncTimer) return;
  runSync().catch(() => {
    /* ignore */
  });
  refs.syncTimer = setInterval(() => {
    if (document.hidden) return;
    runSync().catch((err) => console.error('sync failed', err));
  }, SYNC_INTERVAL_MS);
}

interface SyncResponse {
  approvals: PendingApprovalDto[];
  questions?: PendingQuestionDto[];
  threads?: Thread[];
  threadMessages?: ServerMessage[];
}

export async function runSync(options: { replaceThreadMessages?: boolean } = {}): Promise<void> {
  const requestId = ++refs.syncRequestId;
  const gid = groupId.value;
  const tid = threadId.value;
  const ct = channelType.value;
  const mg = messagingGroupId.value;
  const params = new URLSearchParams();
  if (gid) {
    params.set('gid', gid);
    if (tid) params.set('tid', tid);
    if (tid && ct && ct !== 'web' && mg) {
      params.set('channel', ct);
      params.set('mg', mg);
    }
  }
  let res: SyncResponse;
  try {
    res = await api<SyncResponse>('api/sync' + (params.toString() ? '?' + params.toString() : ''));
  } catch {
    return;
  }
  if (requestId !== refs.syncRequestId) return;
  if (Array.isArray(res.approvals)) pendingApprovals.value = res.approvals;
  if (gid && groupId.value === gid && tid === threadId.value && Array.isArray(res.questions)) {
    const serverIds = new Set(res.questions.map((question) => question.questionId));
    const liveQuestions = pendingQuestions.value.filter((question) => {
      if (serverIds.has(question.questionId) || question.agentGroupId !== gid) return false;
      if (tid?.startsWith('__dm:')) return question.threadId === null;
      return question.threadId === tid;
    });
    pendingQuestions.value = liveQuestions.length > 0 ? [...res.questions, ...liveQuestions] : res.questions;
  }
  if (gid && groupId.value === gid && Array.isArray(res.threads)) {
    // Preserve any client-only "(new thread)" entries — they have no
    // server session yet (no inbound message has been sent), so they
    // won't appear in res.threads. Without this, sync would silently
    // drop the user's just-created blank thread and a subsequent
    // "New thread" click would mint yet another UUID instead of
    // reusing the blank one.
    const serverIds = new Set(res.threads.map((t) => t.threadId));
    const ephemeral = threads.value.filter(
      (t) =>
        !serverIds.has(t.threadId) &&
        (t.channelType || 'web') === 'web' &&
        t.title === '(new thread)' &&
        !t.messageCount,
    );
    threads.value = ephemeral.length > 0 ? [...ephemeral, ...res.threads] : res.threads;
  }
  if (
    gid &&
    groupId.value === gid &&
    tid &&
    threadId.value === tid &&
    ct === channelType.value &&
    ct !== 'web' &&
    Array.isArray(res.threadMessages)
  ) {
    if (options.replaceThreadMessages) replaceIncomingMessages(res.threadMessages);
    else mergeIncomingMessages(res.threadMessages);
  }
}

function toChatMessage(m: ServerMessage): ChatMessage {
  return {
    id: m.id,
    direction: normDirection(m.direction),
    text: m.text,
    ...(m.card ? { card: m.card } : {}),
    files: m.files || null,
    ts: m.timestamp,
    ...(m.author ? { author: m.author } : {}),
    ...(m.deliveryOrigin ? { deliveryOrigin: m.deliveryOrigin } : {}),
    ...(m.suggestedAction ? { suggestedAction: m.suggestedAction } : {}),
    ...(m.usage ? { usage: m.usage } : {}),
    ...(m.activity ? { activity: m.activity } : {}),
    ...(m.event ? { event: m.event } : {}),
    ...(m.reactions ? { reactions: m.reactions } : {}),
  };
}

function replaceIncomingMessages(messages: ServerMessage[]): void {
  chatMessages.value = messages.map(toChatMessage);
  refs.seenIds = new Set(messages.filter((m) => m.id).map((m) => `${normDirection(m.direction)}:${m.id}`));
  const echoedIds = messages.filter((m) => normDirection(m.direction) === 'in' && m.id).map((m) => m.id!);
  const tid = threadId.value;
  pendingWebSends.value = pendingWebSends.value.filter(
    (pendingSend) =>
      pendingSend.threadId !== tid ||
      !echoedIds.some((id) => isWebEchoForClientMessage(id, pendingSend.clientMessageId)),
  );
}

function mergeIncomingMessages(messages: ServerMessage[]): void {
  let maxTs = '';
  const additions: ChatMessage[] = [];
  for (const m of messages) {
    const direction = normDirection(m.direction);
    const key = m.id ? `${direction}:${m.id}` : null;
    if (key && refs.seenIds.has(key)) continue;
    const ts = m.timestamp || '';
    additions.push({
      id: m.id,
      direction,
      text: m.text,
      ...(m.card ? { card: m.card } : {}),
      files: m.files || null,
      ts,
      ...(m.author ? { author: m.author } : {}),
      ...(m.deliveryOrigin ? { deliveryOrigin: m.deliveryOrigin } : {}),
      ...(m.suggestedAction ? { suggestedAction: m.suggestedAction } : {}),
      ...(m.usage ? { usage: m.usage } : {}),
      ...(m.activity ? { activity: m.activity } : {}),
      ...(m.event ? { event: m.event } : {}),
      ...(m.reactions ? { reactions: m.reactions } : {}),
    });
    if (key) refs.seenIds.add(key);
    if (ts > maxTs) maxTs = ts;
    if (direction === 'out') maybeNotify(m.text, m.files || []);
  }
  if (additions.length) {
    chatMessages.value = chatMessages.value.concat(additions);
    bumpActiveThread(maxTs);
  }
}

/**
 * Build a task-endpoint URL for a thread, appending the `channel`/`mg`
 * override for non-web threads. `suffix`
 * is an extra path segment such as `/${seriesId}/pause`.
 */
export function taskUrl(gid: string, tid: string, suffix = ''): string {
  let u = `api/groups/${encodeURIComponent(gid)}/chat/${encodeURIComponent(tid)}/tasks${suffix}`;
  const params = new URLSearchParams();
  const t = threads.value.find((x) => x.threadId === tid);
  const ct = t?.channelType || channelType.value;
  const mg = t?.messagingGroupId || messagingGroupId.value;
  if (mg && ct !== 'web') {
    params.set('channel', ct);
    params.set('mg', mg);
  }
  const qs = params.toString();
  if (qs) u += '?' + qs;
  return u;
}

/** Open the scheduled-tasks management panel for a thread. */
export function openTaskPanel(gid: string, tid: string, focusSeriesId?: string): void {
  taskPanelRequest.value = { gid, tid, ...(focusSeriesId ? { focusSeriesId } : {}) };
}

function appendMsg(
  direction: Direction,
  text: string,
  files: ChatMessageFile[] | null | undefined,
  ts: string,
  id?: string,
  activity?: import('./types').ActivityLine[] | null,
  card?: DisplayCard,
  deliveryOrigin?: 'send_message' | 'send_file' | 'response',
  author?: { userId: string; displayName: string },
  suggestedAction?: SuggestedAction,
): void {
  const key = id ? `${direction}:${id}` : null;
  if (key && refs.seenIds.has(key)) return;
  if (key) refs.seenIds.add(key);
  chatMessages.value = chatMessages.value.concat({
    id,
    direction,
    text,
    ...(card ? { card } : {}),
    files: files || null,
    ts,
    ...(author ? { author } : {}),
    ...(deliveryOrigin ? { deliveryOrigin } : {}),
    ...(suggestedAction ? { suggestedAction } : {}),
    ...(activity && activity.length ? { activity } : {}),
  });
}

function normDirection(d: string): Direction {
  return d === 'in' ? 'in' : d === 'internal' ? 'internal' : d === 'event' ? 'event' : 'out';
}

/**
 * Attach an emoji reaction to the message with `targetId`, matched against
 * either an inbound or outbound bubble id. Dedupes identical emoji so a
 * live frame that races the socket snapshot doesn't double up. No-op when
 * the target isn't loaded (the next socket snapshot will surface it).
 */
function applyReaction(targetId: string, emoji: string, ts: string): void {
  let changed = false;
  const next = chatMessages.value.map((m) => {
    if (m.id !== targetId) return m;
    const existing = m.reactions || [];
    if (existing.some((r) => r.emoji === emoji)) return m;
    changed = true;
    return { ...m, reactions: [...existing, { emoji, ts }] };
  });
  if (changed) chatMessages.value = next;
}

interface ChatStartResponse {
  threadId: string;
  sessionId?: string | null;
  messagingGroupId?: string | null;
  sessionMode?: string;
}

export async function openChat(gid: string, resumeTid: string | null, opts: ThreadCtx | null): Promise<void> {
  if (resumeTid && groupId.value === gid && threadId.value === resumeTid) return;
  if (!resumeTid && refs.newChatInFlight) return;
  const generation = ++refs.chatGeneration;
  if (refs.ws) {
    try {
      refs.ws.close();
    } catch {
      /* ignore */
    }
    refs.ws = null;
  }
  if (refs.reconnectTimer) {
    clearTimeout(refs.reconnectTimer);
    refs.reconnectTimer = null;
  }
  if (refs.wsPingTimer) {
    clearInterval(refs.wsPingTimer);
    refs.wsPingTimer = null;
  }
  refs.reconnectAttempt = 0;

  let ct: string = 'web';
  let mg: string | null = null;
  let cs = true;
  if (opts && opts.channelType) {
    ct = opts.channelType;
    mg = opts.messagingGroupId || null;
    cs = !!opts.canSend;
  } else if (resumeTid) {
    const t = threads.value.find((x) => x.threadId === resumeTid);
    if (t && t.channelType) {
      ct = t.channelType;
      mg = t.messagingGroupId || null;
      cs = !!t.canSend;
    }
  }

  batch(() => {
    groupId.value = gid;
    chatMessages.value = [];
    chatReady.value = false;
    channelType.value = ct;
    messagingGroupId.value = mg;
    canSend.value = ct === 'web' ? false : cs;
    pendingQuestions.value = [];
    isTyping.value = false;
    typingHint.value = '';
    typingStartedAt.value = null;
    typingModel.value = '';
    activityLog.value = [];
    if (resumeTid) {
      threadId.value = resumeTid;
      chatLoading.value = true;
      chatStatus.value = ct === 'web' ? 'connecting\u2026' : 'loading history\u2026';
    }
  });
  refs.seenIds.clear();

  if (resumeTid) {
    writeHash();
    if (ct === 'web') {
      connectChatWs({ gid, tid: resumeTid, mg, generation });
      void runSync();
    } else {
      await runSync({ replaceThreadMessages: true });
      if (generation !== refs.chatGeneration) return;
      chatLoading.value = false;
      chatStatus.value = '';
    }
    // Don't steal focus from the search view when navigating via search result.
    if (!highlightMessageId.value) focusComposerSoon();
    return;
  }

  // New web chat. If there's already an empty web thread (the user
  // clicked "New thread" without sending anything in the last one,
  // or double-clicked), reuse it instead of minting another one —
  // otherwise we leave a trail of empty "(new thread)" entries.
  const empty = threads.value.find(
    (t) => (t.channelType || 'web') === 'web' && t.title === '(new thread)' && !t.messageCount,
  );
  if (empty) {
    threadId.value = empty.threadId;
    messagingGroupId.value = empty.messagingGroupId || null;
    chatLoading.value = true;
    chatStatus.value = 'syncing\u2026';
    writeHash();
    connectChatWs({ gid, tid: empty.threadId, mg: empty.messagingGroupId || null, generation });
    void runSync();
    focusComposerSoon({ mobile: true });
    return;
  }
  // Guard against rapid double-clicks while POST /chat/start is in
  // flight (the empty-thread check above can't catch this race since
  // the new thread isn't in `threads.value` yet).
  refs.newChatInFlight = true;
  batch(() => {
    channelType.value = 'web';
    messagingGroupId.value = null;
    canSend.value = false;
    chatLoading.value = true;
  });
  chatStatus.value = 'starting\u2026';
  let started: ChatStartResponse;
  try {
    const r = await fetch(`api/groups/${encodeURIComponent(gid)}/chat/start`, {
      method: 'POST',
      credentials: 'same-origin',
    });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    started = (await r.json()) as ChatStartResponse;
  } catch (err) {
    const m = err instanceof Error ? err.message : String(err);
    if (generation === refs.chatGeneration) chatStatus.value = 'failed to start chat: ' + m;
    refs.newChatInFlight = false;
    return;
  }
  if (generation !== refs.chatGeneration) {
    refs.newChatInFlight = false;
    return;
  }
  threadId.value = started.threadId;
  messagingGroupId.value = started.messagingGroupId || null;
  threads.value = [
    {
      threadId: started.threadId,
      sessionId: started.sessionId || null,
      channelType: 'web',
      messagingGroupId: started.messagingGroupId || null,
      sessionMode: started.sessionMode || 'per-thread',
      title: '(new thread)',
      lastActivityAt: new Date().toISOString(),
      messageCount: 0,
    },
    ...threads.value,
  ];
  writeHash();
  connectChatWs({
    gid,
    tid: started.threadId,
    mg: started.messagingGroupId || null,
    generation,
  });
  void runSync();
  focusComposerSoon({ mobile: true });
  refs.newChatInFlight = false;
}

interface ChatSocketContext {
  gid: string;
  tid: string;
  mg: string | null;
  generation: number;
}

function connectChatWs(ctx: ChatSocketContext): void {
  const { gid, tid, mg, generation } = ctx;
  if (generation !== refs.chatGeneration || groupId.value !== gid || threadId.value !== tid) return;
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  let wsUrl = `${proto}//${location.host}/ui/chat/api/groups/${encodeURIComponent(gid)}/chat/${encodeURIComponent(tid)}/ws`;
  if (mg) wsUrl += `?mg=${encodeURIComponent(mg)}`;
  const ws = new WebSocket(wsUrl);
  refs.ws = ws;
  ws.onopen = () => {
    if (refs.ws !== ws || generation !== refs.chatGeneration) return;
    chatStatus.value = 'syncing\u2026';
    // App-level keepalive: any frame keeps an intermediary's idle timer
    // from closing the socket. Server also sends ws pings, but the
    // browser doesn't expose ws.ping(), so push a tiny JSON frame.
    if (refs.wsPingTimer) clearInterval(refs.wsPingTimer);
    refs.wsPingTimer = setInterval(() => {
      if (refs.ws !== ws) return;
      if (ws.readyState !== WebSocket.OPEN) return;
      try {
        ws.send('{"kind":"ping"}');
      } catch {
        // socket closing — onclose will clear the timer
      }
    }, 25000);
  };
  ws.onclose = () => {
    if (refs.ws !== ws || generation !== refs.chatGeneration) return;
    refs.ws = null;
    chatReady.value = false;
    if (refs.wsPingTimer) {
      clearInterval(refs.wsPingTimer);
      refs.wsPingTimer = null;
    }
    isTyping.value = false;
    typingHint.value = '';
    typingStartedAt.value = null;
    typingModel.value = '';
    activityLog.value = [];
    if (groupId.value !== gid || threadId.value !== tid) return;
    const attempt = ++refs.reconnectAttempt;
    const delay = Math.min(15000, 500 * Math.pow(2, attempt - 1));
    chatStatus.value = `disconnected \u00b7 reconnecting in ${Math.round(delay / 1000)}s\u2026`;
    refs.reconnectTimer = setTimeout(() => {
      refs.reconnectTimer = null;
      if (generation === refs.chatGeneration && groupId.value === gid && threadId.value === tid) connectChatWs(ctx);
    }, delay);
  };
  ws.onerror = () => {
    if (refs.ws !== ws || generation !== refs.chatGeneration) return;
    chatReady.value = false;
    chatStatus.value = 'connection error';
  };
  ws.onmessage = (ev: MessageEvent) => {
    if (refs.ws !== ws || generation !== refs.chatGeneration) return;
    let payload: WsPayload;
    try {
      payload = JSON.parse(ev.data) as WsPayload;
    } catch {
      return;
    }
    if (payload.kind === 'history') {
      if (payload.threadId !== tid || !Array.isArray(payload.messages)) return;
      replaceIncomingMessages(payload.messages);
      voiceMode.value = payload.voiceMode || 'off';
      canSend.value = payload.canSend === true;
      return;
    }
    if (payload.kind === 'ready') {
      if (payload.threadId !== tid) return;
      refs.reconnectAttempt = 0;
      chatLoading.value = false;
      chatReady.value = true;
      chatStatus.value = 'connected';
      return;
    }
    if (payload.kind === 'typing') {
      isTyping.value = !!payload.on;
      typingHint.value = payload.hint || '';
      if (!payload.on) {
        typingStartedAt.value = null;
        typingModel.value = '';
        // Turn ended. This frame can arrive before the outbound response, so
        // stash the live trace and let the 'out' handler attach it to the
        // bubble; then clear the live log so the typing block unmounts clean.
        if (activityLog.value.length) refs.carryActivity = activityLog.value.slice();
        activityLog.value = [];
      } else if (payload.items !== null && payload.items !== undefined) {
        const changed = JSON.stringify(activityLog.value) !== JSON.stringify(payload.items);
        activityLog.value = payload.items;
        if (changed && payload.items.length) playProgressTick();
      }
      if (payload.on) {
        if (typeof payload.startedAt === 'number' && Number.isFinite(payload.startedAt)) {
          typingStartedAt.value = payload.startedAt;
        }
        if (typeof payload.model === 'string') typingModel.value = payload.model;
      }
      return;
    }
    if (payload.kind === 'inbound') {
      refs.carryActivity = [];
      if (payload.id) {
        pendingWebSends.value = pendingWebSends.value.filter(
          (pendingSend) => !isWebEchoForClientMessage(payload.id!, pendingSend.clientMessageId),
        );
      }
      appendMsg(
        'in',
        payload.text || '',
        payload.files || null,
        payload.timestamp || '',
        payload.id,
        null,
        undefined,
        undefined,
        payload.author,
      );
      updateActiveThreadTitleFromFirstMessage(payload.text || '');
      bumpActiveThread();
      return;
    }
    if (payload.kind === 'reaction') {
      const targetId = payload.targetId;
      const emoji = payload.emoji;
      if (targetId && emoji) applyReaction(targetId, emoji, payload.timestamp || new Date().toISOString());
      return;
    }
    if (payload.kind === 'outbound') {
      // chat-sdk messages (ask_question, send_card) need special handling.
      if (payload.messageKind === 'chat-sdk') {
        if (payload.question) {
          // Directly append the question to pendingQuestions so the card
          // renders immediately without waiting for the next sync.
          const q: PendingQuestionDto = {
            questionId: payload.question.questionId,
            title: payload.question.title,
            question: payload.question.question,
            responseMode: payload.question.responseMode,
            options: payload.question.options,
            status: 'pending',
            answerValue: null,
            answerType: null,
            answeredAt: null,
            threadId: threadId.value,
            agentGroupId: groupId.value || '',
            createdAt: payload.timestamp || new Date().toISOString(),
          };
          const existing = pendingQuestions.value;
          if (!existing.some((e) => e.questionId === q.questionId)) {
            pendingQuestions.value = [...existing, q];
          }
          // Also clear typing since the agent is now waiting for user input.
          isTyping.value = false;
          typingHint.value = '';
          typingStartedAt.value = null;
          typingModel.value = '';
          activityLog.value = [];
        } else {
          // Display cards keep fallbackText for notifications/degradation while
          // rendering their normalized structure when the server supplied it.
          const c = payload.content || {};
          const text = typeof c === 'string' ? c : (c as { fallbackText?: string }).fallbackText || '';
          if (payload.card || text) {
            const cardActivity = activityLog.value.length ? activityLog.value.slice() : null;
            appendMsg(
              'out',
              text,
              payload.files || [],
              payload.timestamp || '',
              payload.id,
              cardActivity,
              payload.card,
            );
            bumpActiveThread();
          }
        }
        return;
      }
      const c = payload.content || {};
      // Defensive: a reaction row should arrive as a dedicated `reaction`
      // frame, but if one slips through as `outbound`, fold it onto its
      // target instead of rendering an empty bubble.
      if (typeof c === 'object' && (c as { operation?: string }).operation === 'reaction') {
        const rc = c as { messageId?: string; emoji?: string };
        if (rc.messageId && rc.emoji) {
          applyReaction(rc.messageId, rc.emoji, payload.timestamp || new Date().toISOString());
        }
        return;
      }
      const text = typeof c === 'string' ? c : c.text || c.markdown || '';
      const dir: Direction = payload.messageKind === 'internal' ? 'internal' : 'out';
      const deliveryOrigin =
        typeof c === 'object' &&
        (c.delivery_origin === 'send_message' || c.delivery_origin === 'send_file' || c.delivery_origin === 'response')
          ? c.delivery_origin
          : undefined;
      const suggestedAction =
        typeof c === 'object' &&
        (c.suggested_action === 'continue' || c.suggested_action === 'retry' || c.suggested_action === 'report')
          ? c.suggested_action
          : undefined;
      const finalResponse = isFinalResponse(dir, deliveryOrigin);
      // For the final response, carry the live-accumulated trace onto the
      // message bubble so it stays visible immediately — the live outbound
      // frame has no activity of its own, and otherwise the trace would only
      // reappear in the next socket snapshot's persisted turn_activity.
      // The typing:{on:false} frame usually arrives first and moves the trace
      // into refs.carryActivity, so prefer that; fall back to the live log if
      // the outbound raced ahead of the typing-off frame.
      const carriedActivity = finalResponse
        ? activityLog.value.length
          ? activityLog.value.slice()
          : refs.carryActivity
        : null;
      appendMsg(
        dir,
        text,
        payload.files || [],
        payload.timestamp || '',
        payload.id,
        carriedActivity,
        undefined,
        deliveryOrigin,
        undefined,
        suggestedAction,
      );
      bumpActiveThread();
      if (dir === 'out') maybeNotify(text, payload.files || []);
      if (finalResponse) {
        // Final response arrived — the live activity trace has been carried
        // onto the message bubble above; clear the live log and carry buffer
        // so it doesn't linger under the new bubble or leak into next turn.
        activityLog.value = [];
        refs.carryActivity = [];
        playCompletionChime();
      }
      return;
    }
    if (payload.kind === 'usage') {
      const mid = payload.id;
      const usage = payload.usage;
      if (!mid || !usage) return;
      const list = chatMessages.value;
      let changed = false;
      const next = list.map((m) => {
        if (m.id === mid && m.direction === 'out') {
          changed = true;
          return { ...m, usage };
        }
        return m;
      });
      if (changed) chatMessages.value = next;
      return;
    }
    if (payload.kind === 'activity') {
      const mid = payload.id;
      const activity = payload.items;
      if (!mid || !activity) return;
      const list = chatMessages.value;
      let changed = false;
      const next = list.map((m) => {
        if (m.id === mid && m.direction === 'out') {
          changed = true;
          return { ...m, activity };
        }
        return m;
      });
      if (changed) chatMessages.value = next;
      return;
    }
    if (payload.kind === 'task-run') {
      // A scheduled task just fired. Drop a timeline event bubble (mirrors the
      // socket snapshot event row) and refresh the thread list so the live-task pill's
      // next-run label reflects the newly-cloned recurrence.
      const id = payload.id;
      if (id) {
        const key = `event:${id}`;
        if (!refs.seenIds.has(key)) {
          refs.seenIds.add(key);
          const summary = payload.summary || 'Scheduled task';
          chatMessages.value = chatMessages.value.concat({
            id,
            direction: 'event',
            text: `Scheduled task ran: ${summary}`,
            files: null,
            ts: payload.timestamp || new Date().toISOString(),
            event: {
              kind: 'task-run',
              summary,
              ...(payload.taskId ? { taskId: payload.taskId } : {}),
              ...(payload.recurrence ? { recurrence: payload.recurrence } : {}),
            },
          });
        }
      }
      if (groupId.value) void loadThreads(groupId.value);
      return;
    }
  };
}

export async function sendChat(text: string, files: PendingFile[] | null | undefined): Promise<boolean> {
  if (!groupId.value || !threadId.value) return false;
  const generation = refs.chatGeneration;
  const gid = groupId.value;
  const tid = threadId.value;
  const clientMessageId = crypto.randomUUID();
  // New turn boundary — drop any trace stashed from the previous turn.
  refs.carryActivity = [];
  // Scroll to bottom immediately so user sees their message area
  requestScrollToBottom();
  const isWeb = !channelType.value || channelType.value === 'web';
  if (isWeb && !chatReady.value) return false;
  if (isWeb) {
    pendingWebSends.value = pendingWebSends.value.concat({ threadId: tid, clientMessageId });
  }
  const hasFiles = Array.isArray(files) && files.length > 0;
  if (!isWeb) {
    const now = new Date().toISOString();
    const fileMetas: ChatMessageFile[] | null = hasFiles
      ? files!.map((f) => ({ filename: f.name, size: f.size }))
      : null;
    appendMsg('in', text || '', fileMetas, now);
  }
  let url = `api/groups/${encodeURIComponent(gid)}/chat/${encodeURIComponent(tid)}/send`;
  if (!isWeb && messagingGroupId.value) {
    url += `?channel=${encodeURIComponent(channelType.value)}&mg=${encodeURIComponent(messagingGroupId.value)}`;
  }
  try {
    let res: Response;
    if (hasFiles) {
      const fd = new FormData();
      fd.append('text', text || '');
      fd.append('clientMessageId', clientMessageId);
      for (const f of files!) {
        if (f.file) fd.append('file', f.file, f.name);
      }
      res = await fetch(url, { method: 'POST', credentials: 'same-origin', body: fd });
    } else {
      res = await fetch(url, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, clientMessageId }),
      });
    }
    if (!res.ok) {
      pendingWebSends.value = pendingWebSends.value.filter(
        (pendingSend) => pendingSend.clientMessageId !== clientMessageId,
      );
    }
    if (generation !== refs.chatGeneration) return false;
    if (!res.ok) {
      let detail = `HTTP ${res.status}`;
      try {
        const j = (await res.json()) as { error?: string; detail?: string };
        if (j && j.error) detail = j.error + (j.detail ? ` (${j.detail})` : '');
      } catch {
        /* ignore */
      }
      chatStatus.value = `send failed: ${detail}`;
      return false;
    } else if (!isWeb) {
      try {
        await runSync({ replaceThreadMessages: true });
      } catch {
        /* ignore */
      }
    }
    return true;
  } catch (err) {
    console.error('send failed', err);
    pendingWebSends.value = pendingWebSends.value.filter(
      (pendingSend) => pendingSend.clientMessageId !== clientMessageId,
    );
    if (generation !== refs.chatGeneration) return false;
    const m = err instanceof Error ? err.message : 'network error';
    chatStatus.value = `send failed: ${m}`;
    return false;
  }
}

// ── files ───────────────────────────────────────────────────────────
export async function selectGroup(gid: string): Promise<void> {
  // Tear down the previous group's thread/WS state synchronously before we
  // start awaiting the new group's thread list. selectGroup sets groupId
  // immediately but only resolves the new threadId later (inside openChat,
  // after two awaits). Without this reset, threadId still points at the
  // *previous* group's open thread during that window, and the old WS is
  // still 'connected' so the composer stays enabled. A message sent
  // mid-switch would POST to groups/<newGroup>/chat/<oldGroupThread> — the
  // server auto-creates an orphan session the client's WS never subscribes
  // to, so neither the echo nor the reply appears live. Clearing threadId
  // here makes sendChat early-return and disables the composer until
  // openChat wires up the new group's thread.
  clearChat();
  batch(() => {
    groupId.value = gid;
    treePath.value = '';
    filePath.value = null;
  });
  clearSearch();
  clearFileSearch();
  await loadThreads(gid);
  // Threads list refresh now happens via the unified sync ticker
  // (startSyncPoll), which picks up groupId.value automatically.
  await loadTree('');
  const latest = threads.value.length > 0 ? threads.value[0]! : null;
  if (latest) {
    openChat(gid, latest.threadId, threadCtxOf(latest)).catch((err) => console.error('chat open failed', err));
  } else {
    // Brand-new group with no threads — auto-start one so the user lands
    // in an immediately usable state instead of staring at a disabled
    // composer ("Reconnecting…") and wondering what to click.
    openChat(gid, null, null).catch((err) => console.error('auto-start chat failed', err));
  }
}

let fileSearchGeneration = 0;
let fileSearchController: AbortController | null = null;

export function openFileSearch(root: string): void {
  batch(() => {
    fileSearchOpen.value = true;
    fileSearchRoot.value = root;
    fileSearchQuery.value = '';
    fileSearchResults.value = null;
    fileSearchLoading.value = false;
    fileSearchError.value = '';
    fileSearchTruncated.value = false;
    fileSearchSelectedPath.value = null;
  });
}

export async function searchFiles(gid: string, query: string): Promise<void> {
  const trimmed = query.trim();
  if (!trimmed) return;

  const generation = ++fileSearchGeneration;
  fileSearchController?.abort();
  const controller = new AbortController();
  fileSearchController = controller;
  const root = fileSearchRoot.peek();
  batch(() => {
    fileSearchOpen.value = true;
    fileSearchQuery.value = trimmed;
    fileSearchLoading.value = true;
    fileSearchError.value = '';
    fileSearchTruncated.value = false;
    fileSearchSelectedPath.value = null;
  });
  try {
    const url = `api/groups/${encodeURIComponent(gid)}/search-files?path=${encodeURIComponent(root)}&q=${encodeURIComponent(trimmed)}`;
    const response = await api<{ results: TreeEntry[]; truncated?: boolean }>(url, { signal: controller.signal });
    if (generation !== fileSearchGeneration || controller.signal.aborted) return;
    batch(() => {
      fileSearchResults.value = response.results ?? [];
      fileSearchTruncated.value = !!response.truncated;
    });
  } catch (err) {
    if (generation !== fileSearchGeneration || controller.signal.aborted) return;
    console.error('file search failed', err);
    batch(() => {
      fileSearchError.value = 'Search failed. Check your connection and try again.';
      fileSearchResults.value = [];
    });
  } finally {
    if (generation === fileSearchGeneration) {
      fileSearchLoading.value = false;
      fileSearchController = null;
    }
  }
}

export function clearFileSearch(): void {
  fileSearchGeneration++;
  fileSearchController?.abort();
  fileSearchController = null;
  batch(() => {
    fileSearchOpen.value = false;
    fileSearchRoot.value = '';
    fileSearchQuery.value = '';
    fileSearchResults.value = null;
    fileSearchLoading.value = false;
    fileSearchError.value = '';
    fileSearchTruncated.value = false;
    fileSearchSelectedPath.value = null;
  });
}

export async function restoreFileSearch(open: boolean, root: string, query: string): Promise<void> {
  fileSearchGeneration++;
  fileSearchController?.abort();
  fileSearchController = null;
  batch(() => {
    fileSearchOpen.value = open;
    fileSearchRoot.value = open ? root : '';
    fileSearchQuery.value = query;
    fileSearchResults.value = null;
    fileSearchLoading.value = false;
    fileSearchError.value = '';
    fileSearchTruncated.value = false;
    fileSearchSelectedPath.value = null;
  });
  if (open && groupId.value && query.trim()) await searchFiles(groupId.value, query);
}

let fileSelectionGeneration = 0;

export async function loadTree(p: string): Promise<void> {
  fileSelectionGeneration++;
  batch(() => {
    treePath.value = p;
    filePath.value = null;
    previewBlock.value = null;
    treeError.value = '';
    treeEntries.value = [];
  });
  try {
    if (!groupId.value) return;
    const segs = String(p || '')
      .split('/')
      .filter(Boolean)
      .map(encodeURIComponent);
    const url = `api/groups/${encodeURIComponent(groupId.value)}/dirs/${segs.length ? segs.join('/') + '/' : ''}`;
    const { entries } = await api<{ entries: TreeEntry[] }>(url);
    treeEntries.value = entries || [];
  } catch (err) {
    const msg = /HTTP 404/.test(String(err && (err as Error).message))
      ? 'Not found. It may have been renamed or deleted.'
      : String((err as Error)?.message || err);
    treeError.value = msg;
  }
}

export async function navTree(p: string): Promise<void> {
  await loadTree(p);
  writeHash();
}

export async function navFile(entry: Pick<TreeEntry, 'path' | 'name'> & Partial<TreeEntry>): Promise<void> {
  if (isMobile.value) drawerOpen.files.value = true;
  else paneOpen.files.value = true;
  const parent = parentPath(entry.path);
  if (treePath.value !== parent) await loadTree(parent);
  await selectFile(entry);
  writeHash();
}

export async function previewAttachment(file: ChatMessageFile): Promise<void> {
  if (!file.url) return;
  if (isMobile.value) drawerOpen.files.value = true;
  else paneOpen.files.value = true;

  const selectionGeneration = ++fileSelectionGeneration;
  batch(() => {
    filePath.value = null;
    previewBlock.value = null;
  });
  writeHash();

  const setPreview = (block: PreviewBlock): void => {
    if (selectionGeneration !== fileSelectionGeneration || filePath.peek() !== null) return;
    previewBlock.value = block;
  };
  let size = file.size;
  let mime = file.contentType || '';
  let mtime: string | null = null;
  try {
    const response = await fetch(file.url, { method: 'HEAD', credentials: 'same-origin', cache: 'no-store' });
    if (!response.ok) {
      setPreview({
        kind: 'error',
        text: response.status === 404 ? 'Attachment not found.' : `HTTP ${response.status}`,
        name: file.filename,
        url: file.url,
      });
      return;
    }
    const contentLength = response.headers.get('content-length');
    if ((size == null || size <= 0) && contentLength) size = Number(contentLength);
    const lastModified = response.headers.get('last-modified');
    if (lastModified) {
      const timestamp = Date.parse(lastModified);
      if (Number.isFinite(timestamp)) mtime = new Date(timestamp).toISOString();
    }
    mime = response.headers.get('content-type') || mime;
  } catch {
    /* Let the preview element surface transient loading failures. */
  }

  const ext = file.filename.toLowerCase().split('.').pop() || '';
  const meta = {
    name: file.filename,
    size: size ?? null,
    mtime,
    mime: mime || undefined,
    url: refreshableFileUrl(file.url),
  };
  if (mime.startsWith('image/') || ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'].includes(ext)) {
    setPreview({ kind: 'image', ...meta });
    return;
  }
  if (mime.startsWith('audio/') || ['mp3', 'm4a', 'aac', 'wav', 'ogg', 'oga', 'opus', 'flac', 'weba'].includes(ext)) {
    setPreview({ kind: 'audio', ...meta });
    return;
  }
  if (mime.startsWith('video/') || ['mp4', 'm4v', 'mov', 'webm', 'ogv'].includes(ext)) {
    setPreview({ kind: 'video', ...meta });
    return;
  }
  if (mime === 'application/pdf' || ext === 'pdf') {
    setPreview({ kind: 'pdf', ...meta });
    return;
  }
  if (mime.startsWith('text/html') || ext === 'html' || ext === 'htm') {
    setPreview({ kind: 'html', ...meta });
    return;
  }
  try {
    const response = await fetch(file.url, { credentials: 'same-origin', cache: 'no-store' });
    if (!response.ok) {
      setPreview({ kind: 'error', text: `HTTP ${response.status}`, ...meta });
      return;
    }
    const contentType = response.headers.get('content-type') || mime;
    if (contentType.startsWith('text/') || contentType.includes('json') || contentType.includes('xml')) {
      const text = await response.text();
      setPreview({ kind: ext === 'md' || ext === 'markdown' ? 'markdown' : 'text', text, ...meta, mime: contentType });
      return;
    }
    setPreview({ kind: 'binary', ...meta, mime: contentType });
  } catch (err) {
    setPreview({ kind: 'error', text: String((err as Error)?.message || err), ...meta });
  }
}

export async function openFileSearchResult(
  entry: Pick<TreeEntry, 'path' | 'name'> & Partial<TreeEntry>,
): Promise<void> {
  if (isMobile.value) drawerOpen.files.value = true;
  else paneOpen.files.value = true;
  const selection = selectFile(entry);
  writeHash();
  await selection;
}

export async function openFileSearchDirectory(gid: string, path: string, query: string): Promise<void> {
  fileSearchRoot.value = path;
  fileSearchSelectedPath.value = null;
  await navTree(path);
  await searchFiles(gid, query);
}

let filePreviewRevision = 0;

function refreshableFileUrl(url: string): string {
  filePreviewRevision += 1;
  return `${url}${url.includes('?') ? '&' : '?'}preview=${filePreviewRevision}`;
}

export async function selectFile(entry: Pick<TreeEntry, 'path' | 'name'> & Partial<TreeEntry>): Promise<void> {
  const selectionGeneration = ++fileSelectionGeneration;
  filePath.value = entry.path;
  if (!groupId.value) return;
  const setPreview = (block: PreviewBlock): void => {
    if (selectionGeneration !== fileSelectionGeneration || filePath.peek() !== entry.path) return;
    previewBlock.value = block;
  };
  const segs = String(entry.path || '')
    .split('/')
    .filter(Boolean)
    .map(encodeURIComponent);
  const url = `api/groups/${encodeURIComponent(groupId.value)}/files/${segs.join('/')}`;
  let size = entry.size;
  let mtime = entry.mtime;
  try {
    const h = await fetch(url, { method: 'HEAD', credentials: 'same-origin', cache: 'no-store' });
    if (h.status >= 400) {
      const msg = h.status === 404 ? 'File not found. It may have been renamed or deleted.' : `HTTP ${h.status}`;
      setPreview({ kind: 'error', text: msg, name: entry.name, url });
      return;
    }
    if (size == null) {
      const cl = h.headers.get('content-length');
      if (cl) size = Number(cl);
    }
    if (!mtime) {
      const lm = h.headers.get('last-modified');
      if (lm) {
        const t = Date.parse(lm);
        if (t) mtime = new Date(t).toISOString();
      }
    }
  } catch {
    /* ignore */
  }
  if (selectionGeneration !== fileSelectionGeneration || filePath.peek() !== entry.path) return;
  const ext = entry.name.toLowerCase().split('.').pop() || '';
  const meta = { name: entry.name, size: size ?? null, mtime: mtime ?? null, url, path: entry.path };
  const refreshableMeta = (): typeof meta => ({ ...meta, url: refreshableFileUrl(url) });
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'].includes(ext)) {
    if (ext === 'svg') {
      try {
        const r = await fetch(url, { credentials: 'same-origin', cache: 'no-store' });
        if (!r.ok) {
          setPreview({ kind: 'error', text: `HTTP ${r.status}`, ...meta });
          return;
        }
        setPreview({
          kind: 'image',
          text: await r.text(),
          mime: r.headers.get('content-type') || 'image/svg+xml',
          etag: r.headers.get('etag') ?? undefined,
          ...refreshableMeta(),
        });
      } catch (err) {
        setPreview({ kind: 'error', text: String((err as Error)?.message || err), ...meta });
      }
    } else {
      setPreview({ kind: 'image', ...refreshableMeta() });
    }
  } else if (['mp3', 'm4a', 'aac', 'wav', 'ogg', 'oga', 'opus', 'flac', 'weba'].includes(ext))
    setPreview({ kind: 'audio', ...refreshableMeta() });
  else if (['mp4', 'm4v', 'mov', 'webm', 'ogv'].includes(ext)) setPreview({ kind: 'video', ...refreshableMeta() });
  else if (ext === 'pdf') setPreview({ kind: 'pdf', ...refreshableMeta() });
  else {
    try {
      const r = await fetch(url, { credentials: 'same-origin', cache: 'no-store' });
      if (!r.ok) {
        setPreview({ kind: 'error', text: `HTTP ${r.status}`, ...meta });
        return;
      }
      const ctType = r.headers.get('content-type') || '';
      const etag = r.headers.get('etag') ?? undefined;
      if (ctType.startsWith('text/') || ctType.includes('json') || ctType.includes('xml')) {
        const txt = await r.text();
        const isMd = ext === 'md' || ext === 'markdown';
        const isHtml = ext === 'html' || ext === 'htm';
        setPreview({
          kind: isHtml ? 'html' : isMd ? 'markdown' : 'text',
          text: txt,
          etag,
          ...meta,
          ...(isHtml ? { url: refreshableFileUrl(url) } : {}),
        });
      } else {
        setPreview({ kind: 'binary', mime: ctType, etag, ...meta });
      }
    } catch (err) {
      setPreview({ kind: 'error', text: String((err as Error)?.message || err), ...meta });
    }
  }
  fetchAndAttachMeta(entry.path).catch(() => {
    /* ignore */
  });
}

// Shape of the `?meta=1` file-metadata response. The server always emits
// name/size/mtime/etag/mime/ext for a readable file; tags/lyrics are only
// present for media with embedded metadata.
interface FileMetaResponse {
  name: string;
  size: number;
  mtime: string;
  etag: string;
  mime: string;
  ext: string;
  tags?: Record<string, unknown> | null;
  lyrics?: string | null;
}

async function fetchAndAttachMeta(p: string): Promise<void> {
  const gid = groupId.value;
  if (!gid) return;
  const segs = String(p || '')
    .split('/')
    .filter(Boolean)
    .map(encodeURIComponent);
  const u = `api/groups/${encodeURIComponent(gid)}/files/${segs.join('/')}?meta=1`;
  const r = await fetch(u, { credentials: 'same-origin', cache: 'no-store' });
  if (!r.ok) return;
  const data = (await r.json()) as FileMetaResponse;
  const cur = previewBlock.value;
  if (!cur || cur.path !== p) return;
  const next: PreviewBlock = {
    ...cur,
    tags: data.tags || null,
    lyrics: data.lyrics || null,
    mime: data.mime || cur.mime,
    size: data.size ?? cur.size,
    mtime: data.mtime || cur.mtime,
    etag: data.etag ?? cur.etag,
  };
  previewBlock.value = next;
}

export function closePreview(): void {
  fileSelectionGeneration++;
  batch(() => {
    filePath.value = null;
    previewBlock.value = null;
  });
  writeHash();
}

// ── pinned file-browser context ────────────────────────────────────
export function togglePinnedFile(path: string | null | undefined): void {
  if (!path) return;
  const cur = pinnedContext.value;
  pinnedContext.value = cur.includes(path) ? cur.filter((p) => p !== path) : cur.concat(path);
}

export function removePinnedPath(path: string): void {
  pinnedContext.value = pinnedContext.value.filter((p) => p !== path);
}

export function clearPinnedContext(): void {
  pinnedContext.value = [];
}

// ── pending uploads in composer ─────────────────────────────────────
export function addPendingFiles(
  fileList: File[] | FileList | null | undefined,
  max: number,
  maxSize: number,
  maxTotal: number,
): void {
  if (!fileList || fileList.length === 0) return;
  const next: PendingFile[] = pending.value.slice();
  let totalBytes = next.reduce((n, f) => n + f.size, 0);
  for (const f of Array.from(fileList)) {
    if (next.length >= max) {
      chatStatus.value = `max ${max} files per message`;
      break;
    }
    if (f.size > maxSize) {
      chatStatus.value = `${f.name} too large (max ${(maxSize / 1024 / 1024).toFixed(0)} MB)`;
      continue;
    }
    if (totalBytes + f.size > maxTotal) {
      chatStatus.value = `total upload too large (max ${(maxTotal / 1024 / 1024).toFixed(0)} MB)`;
      break;
    }
    next.push({ name: f.name, size: f.size, file: f });
    totalBytes += f.size;
  }
  pending.value = next;
}

export function removePending(i: number): void {
  const next = pending.value.slice();
  next.splice(i, 1);
  pending.value = next;
}

export function clearPending(): void {
  pending.value = [];
}

// ── liveness / catchup ──────────────────────────────────────────────
const NOW_TICK_MS = 30000;
export function installLivenessHandlers(): void {
  setInterval(() => {
    if (!document.hidden) nowTick.value = Date.now();
  }, NOW_TICK_MS);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    nowTick.value = Date.now();
    runSync().catch(() => {
      /* ignore */
    });
    if (!threadId.value) return;
    const ws = refs.ws;
    const open = !!ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING);
    if (channelType.value === 'web' && !open) {
      if (refs.reconnectTimer) {
        clearTimeout(refs.reconnectTimer);
        refs.reconnectTimer = null;
      }
      if (groupId.value) {
        connectChatWs({
          gid: groupId.value,
          tid: threadId.value,
          mg: messagingGroupId.value,
          generation: refs.chatGeneration,
        });
      }
    }
  });
}

// ── pending approvals (banner inbox) ────────────────────────────────
export async function respondApproval(approvalId: string, value: string): Promise<void> {
  if (respondingApprovalIds.value.has(approvalId)) return;
  const next = new Set(respondingApprovalIds.value);
  next.add(approvalId);
  respondingApprovalIds.value = next;
  // Optimistically remove the row so the banner updates immediately. The
  // server-side apply (e.g. install_packages → image rebuild) can take many
  // seconds; keeping the row visible the whole time is misleading. If the
  // POST fails we re-fetch the canonical list.
  const before = pendingApprovals.value;
  pendingApprovals.value = before.filter((a) => a.approvalId !== approvalId);
  const verb = value === 'approve' ? 'Approving' : value === 'reject' ? 'Rejecting' : 'Submitting';
  chatStatus.value = verb + '\u2026';
  try {
    const res = await postJson<{ ok?: boolean; error?: string }>(
      `api/approvals/${encodeURIComponent(approvalId)}/respond`,
      { value },
    );
    if (!res.ok) throw new Error(res.data?.error || 'HTTP ' + res.status);
    chatStatus.value = verb.replace(/ing$/, 'ed') + ' \u2014 applied';
    setTimeout(() => {
      if (
        chatStatus.value.startsWith('Approved') ||
        chatStatus.value.startsWith('Rejected') ||
        chatStatus.value.startsWith('Submitted')
      ) {
        chatStatus.value = '';
      }
    }, 4000);
  } catch (err) {
    console.error('approval respond failed', err);
    chatStatus.value = 'approval failed: ' + (err instanceof Error ? err.message : String(err));
    // Restore canonical state from the server.
    runSync().catch(() => {
      /* ignore */
    });
  } finally {
    const cleared = new Set(respondingApprovalIds.value);
    cleared.delete(approvalId);
    respondingApprovalIds.value = cleared;
  }
}

export async function respondQuestion(questionId: string, value: string): Promise<void> {
  if (respondingQuestionIds.value.has(questionId)) return;
  const next = new Set(respondingQuestionIds.value);
  next.add(questionId);
  respondingQuestionIds.value = next;
  // Keep the question visible and optimistically show its durable answer.
  pendingQuestions.value = pendingQuestions.value.map((q) =>
    q.questionId === questionId
      ? { ...q, status: 'answered', answerValue: value, answeredAt: new Date().toISOString() }
      : q,
  );
  try {
    // Reuse the approval respond endpoint — dispatchResponse routes to both handlers.
    const res = await postJson<{ ok?: boolean; error?: string }>(
      `api/approvals/${encodeURIComponent(questionId)}/respond`,
      { value },
    );
    if (!res.ok) throw new Error(res.data?.error || 'HTTP ' + res.status);
  } catch (err) {
    console.error('question respond failed', err);
    chatStatus.value = 'response failed: ' + (err instanceof Error ? err.message : String(err));
    setTimeout(() => {
      if (chatStatus.value.startsWith('response failed')) chatStatus.value = '';
    }, 4000);
    runSync().catch(() => {
      /* ignore */
    });
  } finally {
    const cleared = new Set(respondingQuestionIds.value);
    cleared.delete(questionId);
    respondingQuestionIds.value = cleared;
  }
}
