// Threads rail.
import './ThreadsRail.css';
import type { JSX } from 'preact';
import { useState, useRef } from 'preact/hooks';
import {
  threads, threadId, groupId, paneOpen, drawerOpen, channelMeta,
  searchQuery, searchResults, searchLoading, searchError, highlightMessageId,
  isAdmin,
} from '../state';
import {
  openChat,
  deleteThread,
  searchThreads,
  clearSearch,
  openTaskPanel,
} from '../actions';
import { requestConfirm } from './PromptModal';
import { tsKey } from '../utils';
import { Pane } from './Pane';
import { RelativeTime } from './RelativeTime';
import type { Thread, ThreadCtx, SearchResult } from '../types';

function threadCtxOf(t: Thread | null | undefined): ThreadCtx | null {
  if (!t || !t.channelType || t.channelType === 'web') return null;
  return { channelType: t.channelType, messagingGroupId: t.messagingGroupId ?? null, canSend: !!t.canSend };
}

function ThreadRow({ t }: { t: Thread }) {
  const ct = t.channelType || 'web';
  const meta = channelMeta(ct);
  const active = t.threadId === threadId.value;
  const pillTitle = `${meta.label}${t.counterparty ? ' · ' + t.counterparty : ''}`;
  const subTrailer = t.messageCount ? ' · ' + t.messageCount + ' msg' : '';
  const costStr = t.totalCost != null && t.totalCost > 0
    ? ' · ' + (t.totalCost >= 1 ? '$' + t.totalCost.toFixed(2) : '$' + t.totalCost.toFixed(3))
    : '';
  const lt = t.liveTasks;
  const head = lt && lt.length > 0 ? lt[0] : null;
  const liveTaskTitle = head
    ? [
        lt!.length > 1 ? `${lt!.length} scheduled tasks` : (head.paused ? 'Paused scheduled task' : 'Live scheduled task'),
        head.recurrence ? `recurs ${head.recurrence}` : null,
        head.nextRunAt ? `next ${new Date(head.nextRunAt).toLocaleString()}` : null,
        head.summary,
      ].filter(Boolean).join(' · ')
    : undefined;
  const onOpen = (ev: JSX.TargetedMouseEvent<HTMLDivElement>): void => {
    if ((ev.target as HTMLElement).classList.contains('del')) return;
    if (groupId.value) openChat(groupId.value, t.threadId, threadCtxOf(t)).catch(console.error);
    drawerOpen.threads.value = false;
  };
  const onDel = async (ev: JSX.TargetedMouseEvent<HTMLButtonElement>): Promise<void> => {
    ev.stopPropagation();
    const ok = await requestConfirm({
      title: 'Delete thread',
      message: `Delete this thread?\n\n"${t.title}"`,
      okLabel: 'Delete',
      danger: true,
    });
    if (!ok) return;
    await deleteThread(t.threadId);
  };
  return (
    <div class={'thread' + (active ? ' active' : '')} data-id={t.threadId} onClick={onOpen}>
      <div class="title">
        {ct !== 'web' ? <span class="ch-pill" title={pillTitle}>{meta.icon}</span> : null}
        <span class="title-text">{t.title}</span>
        {head ? (
          <button
            type="button"
            class={'task-badge' + (lt!.every((x) => x.paused) ? ' paused' : '')}
            title={liveTaskTitle}
            aria-label="Scheduled tasks"
            onClick={(ev: JSX.TargetedMouseEvent<HTMLButtonElement>) => {
              ev.stopPropagation();
              if (groupId.value) openTaskPanel(groupId.value, t.threadId);
            }}
          >{'\u23F0'}</button>
        ) : null}
      </div>
      <div class="meta"><RelativeTime ts={t.lastActivityAt} />{subTrailer}{costStr}</div>
      {ct === 'web' && isAdmin.value
        ? <button type="button" class="del" title="Delete thread" aria-label="Delete thread" onClick={onDel}>{'\u00d7'}</button>
        : null}
    </div>
  );
}

function DmRow({ t }: { t: Thread }) {
  const ct = t.channelType || 'web';
  const meta = channelMeta(ct);
  const active = t.threadId === threadId.value;
  const onOpen = (): void => {
    if (groupId.value) openChat(groupId.value, t.threadId, threadCtxOf(t)).catch(console.error);
    drawerOpen.threads.value = false;
  };
  return (
    <div class={'thread dm' + (active ? ' active' : '')} data-id={t.threadId} onClick={onOpen}>
      <div class="title">
        <span class="ch-pill dm" title={meta.label}>{meta.icon}</span>
        <span class="title-text">{meta.label}</span>
      </div>
      <div class="meta">
        <RelativeTime ts={t.lastActivityAt} />
        {t.counterparty ? ' \u00b7 ' + t.counterparty : ''}
        {t.messageCount ? ' \u00b7 ' + t.messageCount + ' msg' : ''}
      </div>
    </div>
  );
}

function renderRow(t: Thread) {
  return t.kind === 'dm'
    ? <DmRow key={t.threadId} t={t} />
    : <ThreadRow key={t.threadId} t={t} />;
}

function ChannelSection({ ct, items, defaultOpen }: { ct: string; items: Thread[]; defaultOpen: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const expanded = ct === 'web' || open;
  const meta = channelMeta(ct);
  const totalMsgs = items.reduce((sum, t) => sum + (t.messageCount || 0), 0);
  const lastActivityAt = items.reduce((latest, t) => {
    const ts = t.lastActivityAt || '';
    return ts > latest ? ts : latest;
  }, '');
  const handles = Array.from(new Set(items.map((t) => t.counterparty).filter((h): h is string => !!h)));
  const handleStr = handles.length === 0
    ? ''
    : handles.length === 1 ? handles[0]
      : `${handles[0]} +${handles.length - 1}`;
  return (
    <div class={'thread-section' + (expanded ? ' open' : ' collapsed')}>
      {ct === 'web'
        ? null
        : <button
          type="button"
          class="thread-section-header"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={expanded}
        >
          <span class="row">
            <span class="chev" aria-hidden="true">{expanded ? '\u25BE' : '\u25B8'}</span>
            <span class="ch-pill" aria-hidden="true">{meta.icon}</span>
            <span class="label">{meta.label}</span>
            <span class="count">
              {lastActivityAt ? <><RelativeTime ts={lastActivityAt} />{' \u00b7 '}</> : null}
              {items.length} threads {'\u00b7'} {totalMsgs} msg
            </span>
          </span>
          {handleStr
            ? <span class="handle" title={handles.join(', ')}>{handleStr}</span>
            : null}
        </button>}
      {expanded ? <div class="thread-section-body">{items.map(renderRow)}</div> : null}
    </div>
  );
}

function SearchResultRow({ r }: { r: SearchResult }) {
  const meta = channelMeta(r.channelType || 'web');
  const onOpen = (): void => {
    if (!groupId.value) return;
    const msgId = r.messageId;
    // For shared sessions (threadId is null), use the synthetic __dm:<mgId> ID
    // that the thread list uses for DM channels.
    const tid = r.threadId || (r.messagingGroupId ? `__dm:${r.messagingGroupId}` : null);
    if (!tid) return;
    drawerOpen.threads.value = false;
    const opts = threadCtxOf(threads.value.find((t) => t.threadId === tid)) ?? {
      channelType: r.channelType || 'web',
      messagingGroupId: r.messagingGroupId,
      canSend: false,
    };
    if (threadId.value === tid) {
      // Thread already open — scroll directly to the matched message.
      setTimeout(() => {
        const el = document.querySelector(`[data-msg-id="${CSS.escape(msgId)}"]`);
        if (el) {
          el.scrollIntoView({ behavior: 'smooth', block: 'center' });
          el.classList.add('highlight-pulse');
          setTimeout(() => el.classList.remove('highlight-pulse'), 2000);
        }
      }, 100);
    } else {
      // Different thread — set signal so MessageLog scrolls after history loads.
      highlightMessageId.value = msgId;
      openChat(groupId.value, tid, opts).catch(console.error);
    }
  };
  // Crop the snippet around the first match marker so the highlighted term
  // is always visible regardless of container width or line-clamp.
  const raw = r.snippet || '';
  const markerPos = raw.indexOf('>>>');
  const MAX_CHARS = 120;
  let cropped = raw;
  if (markerPos > MAX_CHARS / 2) {
    cropped = '…' + raw.slice(markerPos - Math.floor(MAX_CHARS / 3));
  }
  if (cropped.length > MAX_CHARS + 20) {
    cropped = cropped.slice(0, MAX_CHARS + 20) + '…';
  }
  const snippetHtml = cropped
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/&gt;&gt;&gt;/g, '<mark>').replace(/&lt;&lt;&lt;/g, '</mark>');
  return (
    <button type="button" class="thread search-result" onClick={onOpen}>
      <div class="title">
        {r.channelType && r.channelType !== 'web'
          ? <span class="ch-pill" title={meta.label}>{meta.icon}</span>
          : null}
        <span class={'dir-pill ' + r.direction}>
          <span aria-hidden="true">{r.direction === 'in' ? '\u2190' : '\u2192'}</span>
          <span class="search-result-direction">{r.direction === 'in' ? 'Incoming' : 'Outgoing'}</span>
        </span>
        <span class="snippet" dangerouslySetInnerHTML={{ __html: snippetHtml }} />
      </div>
      <div class="meta"><RelativeTime ts={r.timestamp} /></div>
    </button>
  );
}

function SearchResults() {
  const results = searchResults.value;
  const loading = searchLoading.value;
  const error = searchError.value;
  if (loading) {
    return <div class="search-results"><div class="empty" role="status" aria-live="polite">Searching…</div></div>;
  }
  if (error) {
    const onRetry = (): void => {
      if (groupId.value && searchQuery.value) {
        searchThreads(groupId.value, searchQuery.value).catch(console.error);
      }
    };
    return (
      <div class="search-results">
        <div class="empty search-error" role="alert">
          <span>{error}</span>
          <button type="button" onClick={onRetry}>Retry</button>
        </div>
      </div>
    );
  }
  if (!results) return null;
  if (results.length === 0) {
    return <div class="search-results"><div class="empty" role="status" aria-live="polite">No results</div></div>;
  }
  return (
    <div class="search-results" aria-label={`${results.length} search results`}>
      {results.map((r) => <SearchResultRow key={r.messageId} r={r} />)}
    </div>
  );
}

export function ThreadsRail() {
  const list = threads.value;
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const isSearching = searchResults.value !== null || searchLoading.value;

  const onNewChat = (): void => {
    if (!groupId.value) return;
    // openChat handles composer focus once the WS is connected.
    openChat(groupId.value, null, null).then(() => {
      drawerOpen.threads.value = false;
      drawerOpen.files.value = false;
    }).catch(console.error);
  };

  const buckets = new Map<string, Thread[]>();
  for (const t of list) {
    const ct = t.channelType || 'web';
    if (!buckets.has(ct)) buckets.set(ct, []);
    buckets.get(ct)!.push(t);
  }
  const sections = Array.from(buckets.entries())
    .map(([ct, items]) => ({ ct, label: channelMeta(ct).label, items }))
    .sort((a, b) => {
      if (a.ct === 'web' && b.ct !== 'web') return -1;
      if (b.ct === 'web' && a.ct !== 'web') return 1;
      return a.label.localeCompare(b.label);
    });
  for (const s of sections) {
    s.items.sort((a, b) => tsKey(b.lastActivityAt) - tsKey(a.lastActivityAt));
  }

  const runSearch = (): void => {
    const q = searchInputRef.current?.value.trim();
    if (!q) {
      clearSearch();
      return;
    }
    if (groupId.value) searchThreads(groupId.value, q).catch(console.error);
  };

  const onSearchKeyDown = (ev: JSX.TargetedKeyboardEvent<HTMLInputElement>): void => {
    if (ev.key === 'Enter') {
      runSearch();
    }
    if (ev.key === 'Escape') {
      ev.currentTarget.value = '';
      clearSearch();
    }
  };

  const onOpenSearch = (ev: JSX.TargetedMouseEvent<HTMLButtonElement>): void => {
    ev.stopPropagation();
    paneOpen.threads.value = true;
    requestAnimationFrame(() => searchInputRef.current?.focus());
  };

  const collapsedActions = (
    <>
      <button type="button" class="icon-btn new-thread-btn" title="New thread" aria-label="New thread" onClick={onNewChat}>+</button>
      <button type="button" class="icon-btn search-toggle-btn" title="Search threads" aria-label="Search threads" onClick={onOpenSearch}>{'\uD83D\uDD0D'}</button>
    </>
  );

  return (
    <Pane
      paneKey="threads"
      name="threads-rail"
      label="Threads"
      collapsedActions={collapsedActions}
    >
      <div class="threads-actions">
        <button
          type="button"
          class="thread-action-btn new-thread-action-btn"
          title="New thread"
          aria-label="New thread"
          onClick={onNewChat}
        >+</button>
        <input
          ref={searchInputRef}
          type="text"
          class="search-input"
          placeholder="Search all threads..."
          onKeyDown={onSearchKeyDown}
          aria-label="Search threads"
        />
        <button
          type="button"
          class="thread-action-btn search-submit-btn"
          title="Search threads"
          aria-label="Search threads"
          onClick={runSearch}
        >{'\uD83D\uDD0D'}</button>
      </div>
      {isSearching
        ? <SearchResults />
        : (
          <div class="list" id="threads-list">
            {list.length === 0
              ? <div class="empty">No threads yet</div>
              : sections.map((s) => (
                <ChannelSection key={s.ct} ct={s.ct} items={s.items} defaultOpen={s.ct === 'web'} />
              ))}
          </div>
        )}
    </Pane>
  );
}
