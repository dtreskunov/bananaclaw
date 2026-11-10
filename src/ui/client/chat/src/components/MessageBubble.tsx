import type { ComponentChildren, RefObject } from 'preact';
import { useLayoutEffect, useRef, useState } from 'preact/hooks';
import { attachScrollEdges } from '../scroll-edges';
import { RelativeTime } from './RelativeTime';
import type { EpochMs } from '../../../../shared/time';
import { revealedMobileMessageActionsId } from '../state';
import { openTranscriptReader, type ReaderId } from '../transcript-reader';
import { FullFrameIcon } from './ActionIcons';

interface Props {
  class: string;
  id?: string;
  tabIndex?: number;
  'data-attention-target'?: string;
  onFocus?: () => void;
  'data-msg-id'?: string;
  elementRef?: RefObject<HTMLDivElement>;
  reveal?: string;
  from?: string;
  timestamp?: EpochMs | null;
  metadata?: ComponentChildren;
  read?: ReaderId;
  children: ComponentChildren;
}

export function MessageBubble({
  class: className, 'data-msg-id': id, elementRef, reveal, from, timestamp, metadata,
  children, id: elementId, tabIndex, 'data-attention-target': attentionTarget, onFocus, read,
}: Props) {
  const ownRef = useRef<HTMLDivElement | null>(null);
  const ref = elementRef ?? ownRef;
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [readerButtonVisible, setReaderButtonVisible] = useState(false);
  useLayoutEffect(() => {
    const bubble = scrollRef.current;
    if (!bubble) return;
    let wasScrollable: boolean | undefined;
    return attachScrollEdges(bubble, { horizontal: false }, (edges) => {
      const scrollable = edges.top || edges.bottom;
      if (scrollable === wasScrollable) return;
      wasScrollable = scrollable;
      bubble.tabIndex = scrollable ? 0 : -1;
      if (scrollable) {
        bubble.setAttribute('role', 'region');
        bubble.setAttribute('aria-label', 'Scrollable message');
      } else {
        bubble.removeAttribute('role');
        bubble.removeAttribute('aria-label');
      }
    });
  }, []);
  useLayoutEffect(() => {
    const bubble = scrollRef.current;
    const match = reveal ? bubble?.querySelector<HTMLElement>('.search-hl') : null;
    if (bubble && match) {
      bubble.scrollTop +=
        match.getBoundingClientRect().top - bubble.getBoundingClientRect().top - bubble.clientHeight / 2;
    }
  }, [reveal]);
  useLayoutEffect(() => {
    if (!readerButtonVisible) return;
    const hide = () => setReaderButtonVisible(false);
    document.addEventListener('scroll', hide, true);
    return () => document.removeEventListener('scroll', hide, true);
  }, [readerButtonVisible]);
  const content = from || timestamp != null || metadata ? <>
    {from ? <div class="message-author">{from}</div> : null}
    {children}
    {timestamp != null || metadata ? <div class="meta turn-info">
      {timestamp != null ? <RelativeTime ts={timestamp} /> : null}
      {metadata}
    </div> : null}
  </> : children;
  return (
    <div class={className + (revealedMobileMessageActionsId.value === id ? ' mobile-actions-visible' : '')}
      data-msg-id={id} id={elementId} tabIndex={tabIndex}
      data-attention-target={attentionTarget} onFocus={onFocus} ref={ref}>
      <div class="message-scroll" ref={scrollRef} onClick={(event) => {
        const target = event.target;
        if (!read || event.defaultPrevented || !(target instanceof Element) ||
          target.closest('a, button, input, textarea, select, summary, audio, video, [role="button"], [contenteditable]:not([contenteditable="false"])') ||
          !target.closest('.transcript-copy-content, .display-card-title, .display-card-description, .display-card-block') ||
          window.getSelection()?.isCollapsed === false) return;
        setReaderButtonVisible((visible) => !visible);
      }}>
        {content}
      </div>
      {read ? <button type="button"
        class={`msg-action-btn message-reader-button${readerButtonVisible ? ' visible' : ''}`}
        title="Read full screen" aria-label="Read full screen" aria-haspopup="dialog"
        onFocus={() => setReaderButtonVisible(true)}
        onClick={(event) => {
          event.stopPropagation();
          setReaderButtonVisible(false);
          openTranscriptReader(read);
        }}><FullFrameIcon /></button> : null}
    </div>
  );
}
