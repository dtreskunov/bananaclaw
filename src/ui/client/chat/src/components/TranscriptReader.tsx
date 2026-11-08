import type { ComponentChildren, JSX } from 'preact';
import { useLayoutEffect, useRef } from 'preact/hooks';
import { chatLoading, threads, threadId } from '../state';
import {
  readerLocation, readerPages, readerSelection,
  type ReaderNavigate,
} from '../transcript-reader';
import { questionAnswerText } from '../question-presentation';
import type { ChatMessage, TranscriptRow } from '../types';
import { FilePreviewDialog } from './FilePreviewDialog';
import { ThreadAttention, ThreadTitle } from './ThreadsRail';
import { showToast } from './Toast';
import './TranscriptReader.css';

interface Props {
  rows: readonly TranscriptRow[];
  onNavigate: (anchorId: string) => void;
  renderMessage: (message: ChatMessage, onNavigate: ReaderNavigate) => ComponentChildren;
}

export function TranscriptReader({ rows, onNavigate, renderMessage }: Props) {
  const viewport = useRef<HTMLDivElement | null>(null);
  const positions = useRef(new Map<string, number>());
  const pendingAction = useRef<(() => void) | null>(null);
  const selection = readerSelection.value;
  const location = readerLocation();
  const pages = readerPages(rows);
  const sameLocation = selection?.location === location;
  const index = sameLocation ? pages.findIndex(page => page.key === selection.key) : -1;
  const page = pages[index];
  const expanded = !!page;
  const thread = threads.value.find(thread => thread.threadId === threadId.value);
  const title = thread?.title || 'Conversation';

  const close = (): void => {
    if (page) onNavigate(page.anchorId);
    readerSelection.value = null;
  };
  const handoff: ReaderNavigate = (action) => {
    pendingAction.current = action;
    close();
  };
  const afterClose = (): void => {
    const action = pendingAction.current;
    pendingAction.current = null;
    action?.();
  };
  const navigate = (delta: number): void => {
    const next = pages[index + delta];
    if (!selection || !next) return;
    if (viewport.current && page) positions.current.set(page.key, viewport.current.scrollTop);
    readerSelection.value = { location, key: next.key };
  };
  const onKeyDown: JSX.KeyboardEventHandler<HTMLDialogElement> = (event) => {
    if (event.defaultPrevented || event.ctrlKey || event.altKey || event.metaKey || event.shiftKey ||
      (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight')) return;
    if (event.target instanceof Element &&
      event.target.closest('input, textarea, select, [contenteditable], audio, video, table, .title-text')) return;
    event.preventDefault();
    navigate(event.key === 'ArrowLeft' ? -1 : 1);
  };

  useLayoutEffect(() => {
    if (!selection) return;
    if (!sameLocation) {
      readerSelection.value = null;
    } else if (!page && !chatLoading.value) {
      console.warn('Reader message unavailable', selection.key);
      showToast('This message is no longer available.', 'err');
      readerSelection.value = null;
    }
  }, [selection, sameLocation, !!page, chatLoading.value]);
  useLayoutEffect(() => {
    if (!page || !viewport.current) return;
    viewport.current.scrollTop = positions.current.get(page.key) ?? 0;
  }, [page?.key]);
  useLayoutEffect(() => {
    if (page) onNavigate(page.anchorId);
  }, [page?.key, page?.anchorId]);
  useLayoutEffect(() => {
    if (!expanded) positions.current.clear();
  }, [expanded]);
  useLayoutEffect(() => {
    pendingAction.current = null;
    return () => {
      pendingAction.current = null;
      if (readerSelection.peek()?.location === location) readerSelection.value = null;
    };
  }, [location]);

  let content: ComponentChildren = null;
  if (page?.row.kind === 'message') {
    content = renderMessage(page.row.message, handoff);
  } else if (page?.row.kind === 'question-answer') {
    content = renderMessage({ ...page.row.answer, text: questionAnswerText(page.row.question, page.row.answer) }, handoff);
  }
  return (
    <FilePreviewDialog expanded={expanded} title={title} className="transcript-reader-host"
      ariaLabel={`Reading: ${title}`} onClose={close} onAfterClose={afterClose} onKeyDown={onKeyDown}
      header={<>
        <button type="button" class="mobile-dialog-icon" aria-label="Previous message" title="Previous message"
          disabled={index <= 0} onClick={() => navigate(-1)}>{'\u2039'}</button>
        <button type="button" class="mobile-dialog-icon" aria-label="Next message" title="Next message"
          disabled={index < 0 || index >= pages.length - 1} onClick={() => navigate(1)}>{'\u203A'}</button>
        <span class="reader-position" aria-live="polite" aria-atomic="true">{index + 1} / {pages.length}</span>
        {thread ? <ThreadAttention thread={thread} onNavigate={handoff} />
          : <span title="Thread status unavailable" aria-label="Thread status unavailable">?</span>}
        <ThreadTitle title={title} />
      </>}
    >
      {expanded && <div class="transcript-reader-content" ref={viewport} tabIndex={0} aria-label="Message content">
        <div class="reader-body preview-body">{content}</div>
      </div>}
    </FilePreviewDialog>
  );
}
