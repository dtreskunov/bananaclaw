import type { ComponentChildren, RefObject } from 'preact';
import { useLayoutEffect, useRef } from 'preact/hooks';
import { attachScrollEdges } from '../scroll-edges';
import { RelativeTime } from './RelativeTime';

interface Props {
  class: string;
  'data-msg-id'?: string;
  elementRef?: RefObject<HTMLDivElement>;
  reveal?: string;
  from?: string;
  timestamp?: string;
  metadata?: ComponentChildren;
  children: ComponentChildren;
}

export function MessageBubble({
  class: className, 'data-msg-id': id, elementRef, reveal, from, timestamp, metadata,
  children,
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
  const content = from || timestamp || metadata ? <>
    {from ? <div class="message-author">{from}</div> : null}
    {children}
    {timestamp || metadata ? <div class="meta turn-info">
      {timestamp ? <RelativeTime ts={timestamp} /> : null}
      {metadata}
    </div> : null}
  </> : children;
  return (
    <div class={className} data-msg-id={id} ref={ref}>
      <div class="message-scroll" ref={scrollRef}>
        {content}
      </div>
    </div>
  );
}
