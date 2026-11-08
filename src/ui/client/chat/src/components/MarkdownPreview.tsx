import type { ComponentChildren, RefObject } from 'preact';
import { renderMarkdown } from '../utils';
import './MarkdownPreview.css';

interface Props {
  text?: string | null;
  html?: string | null;
  className?: string;
  contentRef?: RefObject<HTMLElement>;
  children?: ComponentChildren;
}

export function MarkdownPreview({ text, html, className = '', contentRef, children }: Props) {
  const rendered = html === undefined ? renderMarkdown(text) : html;
  const ref = (element: HTMLElement | null): void => {
    if (contentRef) contentRef.current = element;
  };
  return rendered == null ? <>
    <pre class="markdown-preview-fallback" ref={ref}>{text}</pre>{children}
  </> : (
    <div class={`markdown-preview${className ? ` ${className}` : ''}`}>
      <div class="markdown-preview-content" ref={ref} dangerouslySetInnerHTML={{ __html: rendered }} />
      {children}
    </div>
  );
}
