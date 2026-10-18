import type { ComponentChildren, RefObject } from 'preact';
import { useLayoutEffect, useRef } from 'preact/hooks';
import { attachScrollEdges } from '../scroll-edges';

interface Props {
  class: string;
  'data-msg-id'?: string;
  elementRef?: RefObject<HTMLDivElement>;
  reveal?: string;
  children: ComponentChildren;
}

export function MessageBubble({ class: className, 'data-msg-id': id, elementRef, reveal, children }: Props) {
  const ownRef = useRef<HTMLDivElement | null>(null);
  const ref = elementRef ?? ownRef;
  useLayoutEffect(() => {
    const bubble = ref.current;
    if (!bubble) return;
    return attachScrollEdges(bubble, { horizontal: false }, (edges) => {
      const scrollable = edges.top || edges.bottom;
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
    const bubble = ref.current;
    const match = reveal ? bubble?.querySelector<HTMLElement>('.search-hl') : null;
    if (bubble && match) {
      bubble.scrollTop +=
        match.getBoundingClientRect().top - bubble.getBoundingClientRect().top - bubble.clientHeight / 2;
    }
  }, [reveal]);
  return (
    <div class={`${className} scroll-edge-fade`} data-msg-id={id} ref={ref}>
      {children}
    </div>
  );
}
