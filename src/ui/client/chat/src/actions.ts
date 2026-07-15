// Action orchestrators. Mutate signals + perform IO.
import { batch } from '@preact/signals';
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
  isTyping,
  typingHint,
  activityLog,
  refs,
  treePath,
  filePath,
  treeEntries,
  treeError,
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
  searchOpen,
  highlightMessageId,
  scrollToBottomTick,
  taskPanelRequest,
  SYNC_INTERVAL_MS,
} from './state';
import { api, postJson } from './api';
import { writeHash } from './hash';
import { maybeNotify } from './notify';
import { playProgressTick, playCompletionChime } from './sound';
import { parentPath } from './utils';
import type {
  Thread,
  ThreadCtx,
  Direction,
  ChatMessage,
  ChatMessageFile,
  TreeEntry,
  PreviewBlock,
  PendingFile,
  PendingApprovalDto,
  PendingQuestionDto,
  WsPayload,
  SearchResult,
} from './types';

interface ServerMessage {
  id?: string;
  direction: string;
  text: string;
  files?: ChatMessageFile[] | null;
  timestamp: string;
  usage?: import('./types').TurnUsage;
  activity?: import('./types').ActivityLine[];
  event?: import('./types').TimelineEvent;
  reactions?: import('./types').MessageReaction[];
}

/**
 * Focus the composer textarea once it's both mounted and enabled. The
 * element is unmounted while a group has no active thread and disabled
 * while the WebSocket is reconnecting, so a naive focus() after openChat
 * resolves often hits a dead element. Poll briefly with rAF instead
 * (budget ~3s — enough for a typical WS handshake, not so long that a
 * later user click steals focus back from us).
 *
 * No-op on mobile: focusing the textarea pops up the OS keyboard, which
 * is unwanted on load / thread-switch. The user taps to type explicitly.
 */
function focusComposerSoon(): void {
  if (isMobile.value) return;
  let tries = 0;
  const attempt = (): void => {
    const el = document.getElementById('chat-input') as HTMLTextAreaElement | null;
    if (el && !el.disabled) {
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
export async function searchThreads(gid: string, query: string): Promise<void> {
  if (!query.trim()) {
    clearSearch();
    return;
  }
  searchLoading.value = true;
  searchQuery.value = query;
  try {
    let url = `api/groups/${encodeURIComponent(gid)}/chat/search?q=${encodeURIComponent(query)}`;
    const { results } = await api<{ results: SearchResult[] }>(url);
    searchResults.value = results ?? [];
  } catch (err) {
    console.error('search failed', err);
    searchResults.value = [];
  } finally {
    searchLoading.value = false;
  }
}

export function clearSearch(): void {
  batch(() => {
    searchQuery.value = '';
    searchResults.value = null;
    searchLoading.value = false;
    searchOpen.value = false;
  });
}

// ── chat ────────────────────────────────────────────────────────────
export function clearChat(): void {
  batch(() => {
    chatMessages.value = [];
    chatStatus.value = '';
    chatLoading.value = false;
    threadId.value = null;
    channelType.value = 'web';
    messagingGroupId.value = null;
    canSend.value = true;
    highlightMessageId.value = null;
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

export async function runSync(): Promise<void> {
  const gid = groupId.value;
  const tid = threadId.value;
  const ct = channelType.value;
  const mg = messagingGroupId.value;
  const params = new URLSearchParams();
  if (gid) {
    params.set('gid', gid);
    if (tid && ct && ct !== 'web' && mg) {
      params.set('tid', tid);
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
  if (Array.isArray(res.approvals)) pendingApprovals.value = res.approvals;
  if (Array.isArray(res.questions)) pendingQuestions.value = res.questions;
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
    mergeIncomingMessages(res.threadMessages);
  }
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
      files: m.files || null,
      ts,
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

function historyUrl(gid: string, tid: string): string {
  let u = `api/groups/${encodeURIComponent(gid)}/chat/${encodeURIComponent(tid)}/history`;
  const params = new URLSearchParams();
  // For non-web threads, look up the thread to get its owning mg/channel
  // so the server can resolve the correct session DB.
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

/**
 * Build a task-endpoint URL for a thread, appending the `channel`/`mg`
 * override for non-web threads (same resolution as `historyUrl`). `suffix`
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
): void {
  const key = id ? `${direction}:${id}` : null;
  if (key && refs.seenIds.has(key)) return;
  if (key) refs.seenIds.add(key);
  chatMessages.value = chatMessages.value.concat({
    id,
    direction,
    text,
    files: files || null,
    ts,
    ...(activity && activity.length ? { activity } : {}),
  });
}

function normDirection(d: string): Direction {
  return d === 'in' ? 'in' : d === 'internal' ? 'internal' : d === 'event' ? 'event' : 'out';
}

/**
 * Attach an emoji reaction to the message with `targetId`, matched against
 * either an inbound or outbound bubble id. Dedupes identical emoji so a
 * live frame that races the /history backfill doesn't double up. No-op when
 * the target isn't loaded (history will surface it on the next fetch).
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

async function refetchThreadHistory(appendNewOnly: boolean): Promise<void> {
  const gid = groupId.value,
    tid = threadId.value;
  if (!gid || !tid) return;
  const r = await fetch(historyUrl(gid, tid), { credentials: 'same-origin', cache: 'no-store' });
  if (!r.ok) return;
  const { messages, voiceMode: nextVoiceMode } = (await r.json()) as { messages: ServerMessage[]; voiceMode?: string };
  if (!Array.isArray(messages)) return;
  if (nextVoiceMode) voiceMode.value = nextVoiceMode as typeof voiceMode.value;
  if (!appendNewOnly) {
    chatMessages.value = messages.map((m) => ({
      id: m.id,
      direction: normDirection(m.direction),
      text: m.text,
      files: m.files || null,
      ts: m.timestamp,
      ...(m.usage ? { usage: m.usage } : {}),
      ...(m.activity ? { activity: m.activity } : {}),
      ...(m.event ? { event: m.event } : {}),
      ...(m.reactions ? { reactions: m.reactions } : {}),
    }));
    refs.seenIds = new Set(messages.filter((m) => m.id).map((m) => `${normDirection(m.direction)}:${m.id}`));
    return;
  }
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
      files: m.files || null,
      ts,
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

interface ChatStartResponse {
  threadId: string;
  sessionId?: string | null;
  messagingGroupId?: string | null;
  sessionMode?: string;
}

export async function openChat(gid: string, resumeTid: string | null, opts: ThreadCtx | null): Promise<void> {
  if (resumeTid && groupId.value === gid && threadId.value === resumeTid) return;
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
    if (t && t.channelType && t.channelType !== 'web') {
      ct = t.channelType;
      mg = t.messagingGroupId || null;
      cs = !!t.canSend;
    }
  }

  batch(() => {
    groupId.value = gid;
    chatMessages.value = [];
    channelType.value = ct;
    messagingGroupId.value = mg;
    canSend.value = ct === 'web' ? true : cs;
    isTyping.value = false;
    typingHint.value = '';
    activityLog.value = [];
    if (resumeTid) {
      threadId.value = resumeTid;
      chatLoading.value = true;
      chatStatus.value = 'loading history\u2026';
    }
  });

  if (resumeTid) {
    writeHash();
    try {
      const r = await fetch(historyUrl(gid, resumeTid), { credentials: 'same-origin', cache: 'no-store' });
      if (r.ok) {
        const data = (await r.json()) as { messages: ServerMessage[]; voiceMode?: string };
        const messages = data.messages;
        batch(() => {
          chatMessages.value = (messages || []).map((m) => ({
            id: m.id,
            direction: normDirection(m.direction),
            text: m.text,
            files: m.files || null,
            ts: m.timestamp,
            ...(m.usage ? { usage: m.usage } : {}),
            ...(m.activity ? { activity: m.activity } : {}),
            ...(m.event ? { event: m.event } : {}),
            ...(m.reactions ? { reactions: m.reactions } : {}),
          }));
          chatLoading.value = false;
          voiceMode.value = (data.voiceMode as typeof voiceMode.value) || 'off';
        });
        if (Array.isArray(messages)) {
          refs.seenIds = new Set(messages.filter((m) => m.id).map((m) => `${normDirection(m.direction)}:${m.id}`));
        }
      } else {
        chatLoading.value = false;
      }
    } catch (err) {
      console.error('history load failed', err);
      chatLoading.value = false;
    }
    if (ct === 'web') connectChatWs();
    else {
      chatStatus.value = '';
      // Non-web threads catch up via runSync() on the next tick (or sooner
      // via the visibilitychange handler). The unified ticker is owned at
      // the app level by startSyncPoll().
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
    writeHash();
    connectChatWs();
    focusComposerSoon();
    return;
  }
  // Guard against rapid double-clicks while POST /chat/start is in
  // flight (the empty-thread check above can't catch this race since
  // the new thread isn't in `threads.value` yet).
  if (refs.newChatInFlight) return;
  refs.newChatInFlight = true;
  batch(() => {
    channelType.value = 'web';
    messagingGroupId.value = null;
    canSend.value = true;
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
    chatStatus.value = 'failed to start chat: ' + m;
    refs.newChatInFlight = false;
    return;
  }
  threadId.value = started.threadId;
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
  connectChatWs();
  focusComposerSoon();
  refs.newChatInFlight = false;
}

function connectChatWs(): void {
  if (!groupId.value || !threadId.value) return;
  const gid = groupId.value,
    tid = threadId.value;
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${proto}//${location.host}/ui/chat/api/groups/${encodeURIComponent(gid)}/chat/${encodeURIComponent(tid)}/ws`;
  const ws = new WebSocket(wsUrl);
  refs.ws = ws;
  ws.onopen = () => {
    const wasReconnect = refs.reconnectAttempt > 0;
    refs.reconnectAttempt = 0;
    chatStatus.value = 'connected';
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
    if (wasReconnect) {
      refetchThreadHistory(true).catch((err) => console.error('reconnect catchup failed', err));
    }
  };
  ws.onclose = () => {
    if (refs.ws !== ws) return;
    refs.ws = null;
    if (refs.wsPingTimer) {
      clearInterval(refs.wsPingTimer);
      refs.wsPingTimer = null;
    }
    isTyping.value = false;
    typingHint.value = '';
    activityLog.value = [];
    if (groupId.value !== gid || threadId.value !== tid) return;
    const attempt = ++refs.reconnectAttempt;
    const delay = Math.min(15000, 500 * Math.pow(2, attempt - 1));
    chatStatus.value = `disconnected \u00b7 reconnecting in ${Math.round(delay / 1000)}s\u2026`;
    refs.reconnectTimer = setTimeout(() => {
      refs.reconnectTimer = null;
      if (groupId.value === gid && threadId.value === tid) connectChatWs();
    }, delay);
  };
  ws.onerror = () => {
    chatStatus.value = 'connection error';
  };
  ws.onmessage = (ev: MessageEvent) => {
    let payload: WsPayload;
    try {
      payload = JSON.parse(ev.data) as WsPayload;
    } catch {
      return;
    }
    if (payload.kind === 'ready') return;
    if (payload.kind === 'typing') {
      isTyping.value = !!payload.on;
      typingHint.value = payload.hint || '';
      if (!payload.on) {
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
      return;
    }
    if (payload.kind === 'inbound') {
      refs.carryActivity = [];
      appendMsg('in', payload.text || '', payload.files || null, payload.timestamp || '', payload.id);
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
            question: payload.question.title,
            options: payload.question.options,
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
          activityLog.value = [];
        } else {
          // send_card or unknown chat-sdk — render fallbackText as bubble.
          const c = payload.content || {};
          const text = typeof c === 'string' ? c : (c as { fallbackText?: string }).fallbackText || '';
          if (text) {
            appendMsg('out', text, payload.files || [], payload.timestamp || '', payload.id);
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
      // For the final response, carry the live-accumulated trace onto the
      // message bubble so it stays visible immediately — the live outbound
      // frame has no activity of its own, and otherwise the trace would only
      // reappear after a reload (via /history's persisted turn_activity).
      // The typing:{on:false} frame usually arrives first and moves the trace
      // into refs.carryActivity, so prefer that; fall back to the live log if
      // the outbound raced ahead of the typing-off frame.
      const carriedActivity =
        dir === 'out' ? (activityLog.value.length ? activityLog.value.slice() : refs.carryActivity) : null;
      appendMsg(dir, text, payload.files || [], payload.timestamp || '', payload.id, carriedActivity);
      bumpActiveThread();
      if (dir === 'out') {
        // Final response arrived — the live activity trace has been carried
        // onto the message bubble above; clear the live log and carry buffer
        // so it doesn't linger under the new bubble or leak into next turn.
        activityLog.value = [];
        refs.carryActivity = [];
        playCompletionChime();
        maybeNotify(text, payload.files || []);
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
      // /history event row) and refresh the thread list so the live-task pill's
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

export async function sendChat(text: string, files: PendingFile[] | null | undefined): Promise<void> {
  if (!groupId.value || !threadId.value) return;
  // New turn boundary — drop any trace stashed from the previous turn.
  refs.carryActivity = [];
  // Scroll to bottom immediately so user sees their message area
  requestScrollToBottom();
  const isWeb = !channelType.value || channelType.value === 'web';
  const hasFiles = Array.isArray(files) && files.length > 0;
  if (!isWeb) {
    const now = new Date().toISOString();
    const fileMetas: ChatMessageFile[] | null = hasFiles
      ? files!.map((f) => ({ filename: f.name, size: f.size }))
      : null;
    appendMsg('in', text || '', fileMetas, now);
  }
  let url = `api/groups/${encodeURIComponent(groupId.value)}/chat/${encodeURIComponent(threadId.value)}/send`;
  if (!isWeb && messagingGroupId.value) {
    url += `?channel=${encodeURIComponent(channelType.value)}&mg=${encodeURIComponent(messagingGroupId.value)}`;
  }
  try {
    let res: Response;
    if (hasFiles) {
      const fd = new FormData();
      fd.append('text', text || '');
      for (const f of files!) {
        if (f.file) fd.append('file', f.file, f.name);
      }
      res = await fetch(url, { method: 'POST', credentials: 'same-origin', body: fd });
    } else {
      res = await fetch(url, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      });
    }
    if (!res.ok) {
      let detail = `HTTP ${res.status}`;
      try {
        const j = (await res.json()) as { error?: string; detail?: string };
        if (j && j.error) detail = j.error + (j.detail ? ` (${j.detail})` : '');
      } catch {
        /* ignore */
      }
      chatStatus.value = `send failed: ${detail}`;
    } else if (!isWeb) {
      try {
        await refetchThreadHistory(false);
      } catch {
        /* ignore */
      }
    }
  } catch (err) {
    console.error('send failed', err);
    const m = err instanceof Error ? err.message : 'network error';
    chatStatus.value = `send failed: ${m}`;
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

export async function loadTree(p: string): Promise<void> {
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

export async function selectFile(entry: Pick<TreeEntry, 'path' | 'name'> & Partial<TreeEntry>): Promise<void> {
  filePath.value = entry.path;
  if (!groupId.value) return;
  const segs = String(entry.path || '')
    .split('/')
    .filter(Boolean)
    .map(encodeURIComponent);
  const url = `api/groups/${encodeURIComponent(groupId.value)}/files/${segs.join('/')}`;
  let size = entry.size;
  let mtime = entry.mtime;
  try {
    const h = await fetch(url, { method: 'HEAD', credentials: 'same-origin' });
    if (h.status >= 400) {
      const msg = h.status === 404 ? 'File not found. It may have been renamed or deleted.' : `HTTP ${h.status}`;
      previewBlock.value = { kind: 'error', text: msg, name: entry.name, url };
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
  const ext = entry.name.toLowerCase().split('.').pop() || '';
  const meta = { name: entry.name, size: size ?? null, mtime: mtime ?? null, url, path: entry.path };
  if (['png', 'jpg', 'jpeg', 'gif', 'webp'].includes(ext)) previewBlock.value = { kind: 'image', ...meta };
  else if (['mp3', 'm4a', 'aac', 'wav', 'ogg', 'oga', 'opus', 'flac', 'weba'].includes(ext))
    previewBlock.value = { kind: 'audio', ...meta };
  else if (['mp4', 'm4v', 'mov', 'webm', 'ogv'].includes(ext)) previewBlock.value = { kind: 'video', ...meta };
  else if (ext === 'pdf') previewBlock.value = { kind: 'pdf', ...meta };
  else {
    try {
      const r = await fetch(url, { credentials: 'same-origin' });
      if (!r.ok) {
        previewBlock.value = { kind: 'error', text: `HTTP ${r.status}`, ...meta };
        return;
      }
      const ctType = r.headers.get('content-type') || '';
      const etag = r.headers.get('etag') ?? undefined;
      if (ctType.startsWith('text/') || ctType.includes('json') || ctType.includes('xml')) {
        const txt = await r.text();
        const isMd = ext === 'md' || ext === 'markdown';
        previewBlock.value = { kind: isMd ? 'markdown' : 'text', text: txt, etag, ...meta };
      } else {
        previewBlock.value = { kind: 'binary', mime: ctType, etag, ...meta };
      }
    } catch (err) {
      previewBlock.value = { kind: 'error', text: String((err as Error)?.message || err), ...meta };
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
    refetchThreadHistory(true).catch((err) => console.error('resume catchup failed', err));
    const ws = refs.ws;
    const open = !!ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING);
    if (channelType.value === 'web' && !open) {
      if (refs.reconnectTimer) {
        clearTimeout(refs.reconnectTimer);
        refs.reconnectTimer = null;
      }
      connectChatWs();
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
  // Optimistically remove the question card.
  pendingQuestions.value = pendingQuestions.value.filter((q) => q.questionId !== questionId);
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
