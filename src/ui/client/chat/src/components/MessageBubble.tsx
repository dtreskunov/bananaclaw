import type { ComponentChildren, RefObject } from 'preact';
import { useLayoutEffect, useRef } from 'preact/hooks';
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
  const content = from || timestamp != null || metadata || read ? <>
    {from ? <div class="message-author">{from}</div> : null}
    {children}
    {timestamp != null || metadata || read ? <div class="meta turn-info">
      {timestamp != null ? <RelativeTime ts={timestamp} /> : null}
      {metadata}
      {read ? <span class="msg-inline-actions">
        <button type="button" class="msg-action-btn" title="Read full screen" aria-label="Read full screen"
          aria-haspopup="dialog" onClick={(event) => {
            event.stopPropagation();
            openTranscriptReader(read);
          }}><FullFrameIcon /></button>
      </span> : null}
    </div> : null}
  </> : children;
  return (
    <div class={className + (revealedMobileMessageActionsId.value === id ? ' mobile-actions-visible' : '')}
      data-msg-id={id} id={elementId} tabIndex={tabIndex}
      data-attention-target={attentionTarget} onFocus={onFocus} ref={ref}>
      <div class="message-scroll" ref={scrollRef}>
        {content}
      </div>
    </div>
  );
}
