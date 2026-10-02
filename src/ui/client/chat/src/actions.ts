// Action orchestrators. Mutate signals + perform IO.
import { batch, type Signal } from '@preact/signals';
import { voice } from './voice-audio';
import { cancelRecording } from './recorder';
import {
  groupId,
  threads,
  threadId,
  channelType,
  messagingGroupId,
  canSend,
  voiceInput,
  chatMessages,
  chatStatus,
  chatLoading,
  chatReady,
  activeTurn,
  turnConnected,
  pendingWebSends,
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
import { publicWebMessageId } from './chat-protocol';
import { applyConversationFrame, resetConversation } from './conversation-state';
import { ConversationProtocolError, type ConversationSnapshot } from '../../../shared/conversation-protocol';
import { applyTurnState, resetTurnState } from './stop-turn';
import { runReconnectImmediately, startConnectionTimeout, startReconnectCountdown } from './reconnect-countdown';
import { parentPath } from './utils';
import { showToast } from './components/Toast';
import { requestChoice } from './components/PromptModal';
import type {
  Thread,
  ThreadCtx,
  ChatMessageFile,
  TreeEntry,
  PreviewBlock,
  PendingFile,
  PendingApprovalDto,
  VoiceInputCapability,
  SearchResult,
  InputHandling,
} from './types';

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
function focusComposerSoon(
  options: {
    mobile?: boolean;
    draft?: string;
    expected?: { groupId: string; threadId: string };
    scrollToBottom?: boolean;
  } = {},
): void {
  if (isMobile.value && !options.mobile) return;
  let tries = 0;
  let draftApplied = false;
  const attempt = (): void => {
    if (
      options.expected &&
      (groupId.value !== options.expected.groupId || threadId.value !== options.expected.threadId)
    )
      return;
    const el = document.getElementById('chat-input') as HTMLTextAreaElement | null;
    if (el) {
      if (options.draft !== undefined && !draftApplied) {
        el.value = options.draft;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.setSelectionRange(options.draft.length, options.draft.length);
        draftApplied = true;
      }
      if (!el.disabled && el.offsetParent !== null) {
        if (options.scrollToBottom) requestScrollToBottom();
        el.focus();
        return;
      }
    }
    if (++tries < 180) requestAnimationFrame(attempt);
  };
  requestAnimationFrame(attempt);
}

export function focusBranchComposerSoon(expected: { groupId: string; threadId: string }, draft?: string): void {
  focusComposerSoon({
    mobile: true,
    scrollToBottom: true,
    ...(draft !== undefined ? { draft } : {}),
    expected,
  });
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
/** Resolves false when the list could not be refreshed, so callers don't trust stale entries. */
export async function loadThreads(_gid: string): Promise<boolean> {
  return runSync({ forceRefresh: true });
}

export async function deleteThread(
  thread: Pick<Thread, 'threadId' | 'sessionId' | 'channelType' | 'messagingGroupId'>,
  cascade = false,
): Promise<void> {
  if (!groupId.value) return;
  const tid = thread.threadId;
  if (thread.sessionId != null) {
    const params = new URLSearchParams();
    if (thread.channelType && thread.channelType !== 'web' && thread.messagingGroupId) {
      params.set('channel', thread.channelType);
      params.set('mg', thread.messagingGroupId);
    }
    if (cascade) params.set('cascade', '1');
    const query = params.toString();
    try {
      const r = await fetch(
        `api/groups/${encodeURIComponent(groupId.value)}/chat/${encodeURIComponent(tid)}${query ? `?${query}` : ''}`,
        {
          method: 'DELETE',
          credentials: 'same-origin',
        },
      );
      if (!r.ok) {
        showToast('Delete failed (HTTP ' + r.status + ')', 'err');
        return;
      }
    } catch (err) {
      console.error('delete failed', err);
      const m = err instanceof Error ? err.message : 'network error';
      showToast('Delete failed: ' + m, 'err');
      return;
    }
  }
  // A cascade took descendants the client can't enumerate locally, so drop
  // anything whose lineage leads back to the deleted thread too.
  const gone = new Set<string>([tid]);
  if (cascade) {
    for (let changed = true; changed; ) {
      changed = false;
      for (const t of threads.value) {
        if (!gone.has(t.threadId) && t.forkedFrom && gone.has(t.forkedFrom.threadId)) {
          gone.add(t.threadId);
          changed = true;
        }
      }
    }
  }
  // Removing a branch frees its parent of one child, so the parent's branch
  // badge and in-log link have to come down with it — otherwise the UI
  // advertises branches that are no longer there until the next full reload.
  threads.value = threads.value
    .filter((x) => !gone.has(x.threadId))
    .map((x) => {
      let next = x;
      if (x.forkedFrom && gone.has(x.forkedFrom.threadId)) {
        next = { ...next, forkedFrom: { ...x.forkedFrom, deleted: true } };
      }
      if (x.forkChildren?.some((c) => gone.has(c.threadId))) {
        next = { ...next, forkChildren: x.forkChildren.filter((c) => !gone.has(c.threadId)) };
      }
      return next;
    });
  if (threadId.value && gone.has(threadId.value)) {
    const latest = threads.value.length > 0 ? threads.value[0]! : null;
    if (latest) openChat(groupId.value, latest.threadId, threadCtxOf(latest)).catch(console.error);
    else clearChat();
  }
}

/**
 * Branch the thread at `atMessageId` and switch to the new branch.
 *
 * The branch is a copy: it inherits the conversation up to that message and
 * nothing after, and the original is left exactly as it was.
 */
export async function forkThreadAt(
  thread: Pick<Thread, 'threadId' | 'channelType' | 'messagingGroupId'>,
  atMessageId: string,
  options: { composerDraft?: string } = {},
): Promise<boolean> {
  if (!groupId.value) return false;
  const params = new URLSearchParams();
  if (thread.channelType && thread.channelType !== 'web' && thread.messagingGroupId) {
    params.set('channel', thread.channelType);
    params.set('mg', thread.messagingGroupId);
  }
  const query = params.toString();
  const gid = groupId.value;
  let created: { threadId: string } | null = null;
  try {
    const r = await fetch(
      `api/groups/${encodeURIComponent(gid)}/chat/${encodeURIComponent(thread.threadId)}/fork${query ? `?${query}` : ''}`,
      {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ atMessageId }),
      },
    );
    if (!r.ok) {
      showToast('Fork failed (HTTP ' + r.status + ')', 'err');
      return false;
    }
    created = (await r.json()) as { threadId: string };
  } catch (err) {
    console.error('fork failed', err);
    const m = err instanceof Error ? err.message : 'network error';
    showToast('Fork failed: ' + m, 'err');
    return false;
  }
  // Refresh before opening so the rail already knows the branch exists and
  // can render its lineage instead of flashing an unexplained new row.
  await loadThreads(gid);
  const branch = threads.value.find((x) => x.threadId === created!.threadId) ?? null;
  await openChat(gid, created.threadId, threadCtxOf(branch)).catch(console.error);
  focusBranchComposerSoon({ groupId: gid, threadId: created.threadId }, options.composerDraft);
  return true;
}

/**
 * Start a branch immediately before a user message and move its text into the
 * composer. The first conversational message has no valid fork anchor, so it
 * starts a blank web thread instead.
 */
export async function editMessageInBranch(
  thread: Pick<Thread, 'threadId' | 'channelType' | 'messagingGroupId'>,
  previousMessageId: string | null,
  draft: string,
): Promise<boolean> {
  if (previousMessageId) return forkThreadAt(thread, previousMessageId, { composerDraft: draft });
  const gid = groupId.value;
  if (!gid) return false;
  await openChat(gid, null, null);
  const targetThreadId = threadId.value;
  if (!targetThreadId || targetThreadId === thread.threadId) return false;
  focusBranchComposerSoon({ groupId: gid, threadId: targetThreadId }, draft);
  return true;
}

function threadCtxOf(t: Thread | null | undefined): ThreadCtx | null {
  if (!t || !t.channelType || t.channelType === 'web') return null;
  return { channelType: t.channelType, messagingGroupId: t.messagingGroupId ?? null, canSend: !!t.canSend };
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
  resetConversation();
  retryWebSend = null;
  resetTurnState();
  voice.detach();
  cancelRecording();
  voiceInput.value = { backend: 'disabled', ready: false, reason: 'Waiting for chat configuration.' };
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
  });
  if (refs.ws) {
    try {
      refs.ws.close();
    } catch {
      /* ignore */
    }
    refs.ws = null;
  }
  if (refs.reconnectCancel) {
    refs.reconnectCancel();
    refs.reconnectCancel = null;
  }
  if (refs.wsConnectCancel) {
    refs.wsConnectCancel();
    refs.wsConnectCancel = null;
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
  threads?: Thread[];
  conversation?: ConversationSnapshot;
  voiceInput?: VoiceInputCapability;
}

/** Returns whether `threads` now holds a fresh server list for the current group. */
export async function runSync(
  options: { replaceThreadMessages?: boolean; forceRefresh?: boolean } = {},
): Promise<boolean> {
  const requestId = ++refs.syncRequestId;
  const generation = refs.chatGeneration;
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
    res = await api<SyncResponse>(
      'api/sync' + (params.toString() ? '?' + params.toString() : ''),
      options.forceRefresh ? { cache: 'no-store' } : undefined,
    );
  } catch (error) {
    if (generation === refs.chatGeneration && gid === groupId.value && tid === threadId.value && ct !== 'web') {
      applyTurnState(activeTurn.value, false);
      console.error('Conversation sync failed', error);
      chatReady.value = false;
      chatStatus.value = 'Conversation unavailable. Reconnect to retry.';
    }
    return false;
  }
  if (requestId !== refs.syncRequestId) return false;
  if (
    generation === refs.chatGeneration &&
    tid &&
    gid === groupId.value &&
    tid === threadId.value &&
    ct === channelType.value &&
    mg === messagingGroupId.value &&
    ct !== 'web'
  ) {
    {
      try {
        applyConversationFrame(res.conversation, tid);
      } catch (error) {
        console.error('Conversation snapshot rejected', error);
        chatStatus.value = error instanceof Error ? error.message : 'Invalid chat snapshot. Reload this page.';
        chatReady.value = false;
        return false;
      }
    }
  }
  if (gid && groupId.value === gid && tid === threadId.value && res.voiceInput) {
    voiceInput.value = res.voiceInput;
    if (!res.voiceInput.ready)
      voice.interrupt(res.voiceInput.reason || 'Live voice input is no longer available. Current text has been kept.');
  }
  if (Array.isArray(res.approvals)) pendingApprovals.value = res.approvals;
  let threadsApplied = false;
  if (gid && groupId.value === gid && Array.isArray(res.threads)) {
    threadsApplied = true;
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
  return threadsApplied;
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

interface ChatStartResponse {
  threadId: string;
  messagingGroupId?: string | null;
  sessionMode?: string;
}

export async function openChat(gid: string, resumeTid: string | null, opts: ThreadCtx | null): Promise<void> {
  if (resumeTid && groupId.value === gid && threadId.value === resumeTid) return;
  if (!resumeTid && refs.newChatInFlight) return;
  resetConversation();
  resetTurnState();
  voice.detach();
  cancelRecording();
  voiceInput.value = { backend: 'disabled', ready: false, reason: 'Waiting for chat configuration.' };
  const generation = ++refs.chatGeneration;
  if (refs.ws) {
    try {
      refs.ws.close();
    } catch {
      /* ignore */
    }
    refs.ws = null;
  }
  if (refs.reconnectCancel) {
    refs.reconnectCancel();
    refs.reconnectCancel = null;
  }
  if (refs.wsConnectCancel) {
    refs.wsConnectCancel();
    refs.wsConnectCancel = null;
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
    if (generation === refs.chatGeneration) {
      chatLoading.value = false;
      chatStatus.value = '';
      showToast('Failed to start chat: ' + m, 'err');
    }
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
      sessionId: null,
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

const WS_CONNECT_TIMEOUT_MS = 10000;

function connectChatWs(ctx: ChatSocketContext): void {
  const { gid, tid, mg, generation } = ctx;
  if (generation !== refs.chatGeneration || groupId.value !== gid || threadId.value !== tid) return;
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  let wsUrl = `${proto}//${location.host}/ui/chat/api/groups/${encodeURIComponent(gid)}/chat/${encodeURIComponent(tid)}/ws`;
  if (mg) wsUrl += `?mg=${encodeURIComponent(mg)}`;
  const ws = new WebSocket(wsUrl);
  refs.ws = ws;
  refs.wsConnectCancel = startConnectionTimeout(WS_CONNECT_TIMEOUT_MS, () => {
    if (refs.ws !== ws || generation !== refs.chatGeneration) return;
    refs.wsConnectCancel = null;
    chatReady.value = false;
    chatStatus.value = 'connection timed out';
    try {
      ws.close();
    } catch {
      // onclose schedules the reconnect when the browser aborts the handshake
    }
  });
  ws.onopen = () => {
    if (refs.ws !== ws || generation !== refs.chatGeneration) return;
    if (refs.wsConnectCancel) {
      refs.wsConnectCancel();
      refs.wsConnectCancel = null;
    }
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
    if (refs.wsConnectCancel) {
      refs.wsConnectCancel();
      refs.wsConnectCancel = null;
    }
    chatReady.value = false;
    applyTurnState(activeTurn.value, false);
    if (refs.wsPingTimer) {
      clearInterval(refs.wsPingTimer);
      refs.wsPingTimer = null;
    }
    if (groupId.value !== gid || threadId.value !== tid) return;
    const attempt = ++refs.reconnectAttempt;
    const delay = Math.min(15000, 500 * Math.pow(2, attempt - 1));
    refs.reconnectCancel = startReconnectCountdown(
      delay,
      (seconds) => {
        if (generation !== refs.chatGeneration || groupId.value !== gid || threadId.value !== tid) return;
        chatStatus.value = `disconnected \u00b7 reconnecting in ${seconds}s\u2026`;
      },
      () => {
        refs.reconnectCancel = null;
        if (generation !== refs.chatGeneration || groupId.value !== gid || threadId.value !== tid) return;
        chatStatus.value = 'disconnected \u00b7 reconnecting\u2026';
        connectChatWs(ctx);
      },
    );
  };
  ws.onerror = () => {
    if (refs.ws !== ws || generation !== refs.chatGeneration) return;
    chatReady.value = false;
    applyTurnState(activeTurn.value, false);
    chatStatus.value = 'connection error';
  };
  ws.onmessage = (ev: MessageEvent) => {
    if (refs.ws !== ws || generation !== refs.chatGeneration) return;
    try {
      applyConversationFrame(JSON.parse(ev.data), tid);
      refs.reconnectAttempt = 0;
    } catch (error) {
      console.error('Conversation protocol error', error);
      chatReady.value = false;
      applyTurnState(activeTurn.value, false);
      chatStatus.value = error instanceof Error ? error.message : 'Invalid chat data. Reload this page.';
      if (error instanceof ConversationProtocolError && error.code === 'protocol_mismatch') {
        ws.onclose = null;
        if (refs.wsPingTimer) clearInterval(refs.wsPingTimer);
        showToast('Chat protocol changed. Reload this page.', 'err');
      } else {
        showToast('Chat synchronization lost. Reconnecting for a fresh snapshot.', 'err');
      }
      ws.close();
    }
  };
}

let retryWebSend: {
  generation: number;
  gid: string;
  tid: string;
  text: string;
  files: PendingFile[];
  clientMessageId: string;
  inputHandling?: InputHandling;
} | null = null;

export async function sendChat(text: string, files: PendingFile[] | null | undefined): Promise<boolean> {
  if (!groupId.value || !threadId.value) return false;
  const generation = refs.chatGeneration;
  const gid = groupId.value;
  const tid = threadId.value;
  const ct = channelType.value;
  const mg = messagingGroupId.value;
  const isWeb = !ct || ct === 'web';
  if (!canSend.value || (isWeb && !chatReady.value)) return false;
  const retry =
    isWeb &&
    retryWebSend?.generation === generation &&
    retryWebSend.gid === gid &&
    retryWebSend.tid === tid &&
    retryWebSend.text === text &&
    retryWebSend.files.length === (files?.length ?? 0) &&
    retryWebSend.files.every((file, index) => file === files?.[index])
      ? retryWebSend
      : null;
  let inputHandling = retry?.inputHandling;
  const turn = activeTurn.value;
  if (!retry && isWeb && turnConnected.value && turn?.status === 'running' && turn.supportsSteering === true) {
    const choice = await requestChoice({
      title: 'Send while the agent is working',
      message: 'Steer the current turn with this message, or queue it for later.',
      options: [
        { value: 'cancel', label: 'Cancel' },
        { value: 'queue', label: 'Queue for later' },
        { value: 'steer', label: 'Steer current turn', tone: 'primary' },
      ],
    });
    if (choice !== 'steer' && choice !== 'queue') return false;
    inputHandling = { mode: choice, turnId: turn.id };
  }
  if (
    generation !== refs.chatGeneration ||
    groupId.value !== gid ||
    threadId.value !== tid ||
    channelType.value !== ct ||
    messagingGroupId.value !== mg ||
    !canSend.value ||
    (isWeb && !chatReady.value)
  )
    return false;
  const clientMessageId = retry?.clientMessageId ?? crypto.randomUUID();
  const messageId = publicWebMessageId(clientMessageId);
  // Scroll to bottom immediately so user sees their message area
  requestScrollToBottom();
  if (isWeb) {
    retryWebSend = { generation, gid, tid, text, files: files?.slice() ?? [], clientMessageId, inputHandling };
    if (!pendingWebSends.value.some((send) => send.messageId === messageId)) {
      pendingWebSends.value = pendingWebSends.value.concat({ threadId: tid, messageId });
    }
  }
  const hasFiles = Array.isArray(files) && files.length > 0;
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
      if (inputHandling) fd.append('inputHandling', JSON.stringify(inputHandling));
      for (const f of files!) {
        if (f.file) fd.append('file', f.file, f.name);
      }
      res = await fetch(url, { method: 'POST', credentials: 'same-origin', body: fd });
    } else {
      res = await fetch(url, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, clientMessageId, ...(inputHandling ? { inputHandling } : {}) }),
      });
    }
    if (!res.ok) {
      if (res.status < 500 && retryWebSend?.clientMessageId === clientMessageId) retryWebSend = null;
      pendingWebSends.value = pendingWebSends.value.filter((pendingSend) => pendingSend.messageId !== messageId);
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
      showToast(`Send failed: ${detail}`, 'err');
      return false;
    } else if (!isWeb) {
      try {
        await runSync({ replaceThreadMessages: true });
      } catch {
        /* ignore */
      }
    }
    if (retryWebSend?.clientMessageId === clientMessageId) retryWebSend = null;
    return true;
  } catch (err) {
    console.error('send failed', err);
    pendingWebSends.value = pendingWebSends.value.filter((pendingSend) => pendingSend.messageId !== messageId);
    if (generation !== refs.chatGeneration) return false;
    const m = err instanceof Error ? err.message : 'network error';
    showToast(`Send failed: ${m}`, 'err');
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
  const threadsFresh = await loadThreads(gid);
  // Threads list refresh now happens via the unified sync ticker
  // (startSyncPoll), which picks up groupId.value automatically.
  await loadTree('');
  // A refresh that failed (server restart, offline) leaves `threads` describing
  // the *previous* group. Opening its newest entry pins a foreign thread onto
  // this group, and the server rejects that socket for good while the client
  // retries forever — so wait for a real list instead.
  const latest = threadsFresh && threads.value.length > 0 ? threads.value[0]! : null;
  if (latest) {
    openChat(gid, latest.threadId, threadCtxOf(latest)).catch((err) => console.error('chat open failed', err));
  } else if (threadsFresh) {
    // Brand-new group with no threads — auto-start one so the user lands
    // in an immediately usable state instead of staring at a disabled
    // composer ("Reconnecting…") and wondering what to click.
    openChat(gid, null, null).catch((err) => console.error('auto-start chat failed', err));
  } else {
    showToast('Could not load threads', 'err');
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

export function reconnectChatNow(): void {
  const gid = groupId.value;
  const tid = threadId.value;
  if (!refs.reconnectCancel || channelType.value !== 'web' || !gid || !tid) return;
  runReconnectImmediately(refs.reconnectCancel, () => {
    refs.reconnectCancel = null;
    chatStatus.value = 'disconnected \u00b7 reconnecting\u2026';
    connectChatWs({
      gid,
      tid,
      mg: messagingGroupId.value,
      generation: refs.chatGeneration,
    });
  });
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
  let validationError = '';
  for (const f of Array.from(fileList)) {
    if (next.length >= max) {
      validationError = `Max ${max} files per message`;
      break;
    }
    if (f.size > maxSize) {
      validationError = `${f.name} too large (max ${(maxSize / 1024 / 1024).toFixed(0)} MB)`;
      continue;
    }
    if (totalBytes + f.size > maxTotal) {
      validationError = `Total upload too large (max ${(maxTotal / 1024 / 1024).toFixed(0)} MB)`;
      break;
    }
    next.push({ name: f.name, size: f.size, file: f });
    totalBytes += f.size;
  }
  pending.value = next;
  if (validationError) showToast(validationError, 'err');
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
      if (refs.reconnectCancel) {
        refs.reconnectCancel();
        refs.reconnectCancel = null;
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
    chatStatus.value = '';
    showToast('Approval failed: ' + (err instanceof Error ? err.message : String(err)), 'err');
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

export async function respondQuestion(questionId: string, value: string): Promise<boolean> {
  if (respondingQuestionIds.value.has(questionId)) return false;
  const next = new Set(respondingQuestionIds.value);
  next.add(questionId);
  respondingQuestionIds.value = next;
  try {
    // Reuse the approval respond endpoint — dispatchResponse routes to both handlers.
    const res = await postJson<{ ok?: boolean; error?: string }>(
      `api/approvals/${encodeURIComponent(questionId)}/respond`,
      { value },
    );
    if (!res.ok) throw new Error(res.data?.error || 'HTTP ' + res.status);
    if (channelType.value !== 'web') await runSync({ forceRefresh: true });
    return true;
  } catch (err) {
    console.error('question respond failed', err);
    showToast('Response failed: ' + (err instanceof Error ? err.message : String(err)), 'err');
    runSync().catch(() => {
      /* ignore */
    });
    return false;
  } finally {
    const cleared = new Set(respondingQuestionIds.value);
    cleared.delete(questionId);
    respondingQuestionIds.value = cleared;
  }
}
