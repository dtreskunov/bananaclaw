import { describe, expect, it } from 'vitest';
import { MarkdownPreview } from './MarkdownPreview';
import { renderMarkdown } from '../utils';

describe('shared FILES Markdown rendering', () => {
  it('renders file and transcript Markdown through the same preview markup', () => {
    const text = '# Heading\n\nA **paragraph**.\n\n```ts\nconst value = 1;\n```\n\n> Quote\n\n- Item';
    const file = MarkdownPreview({ text });
    const reader = MarkdownPreview({ text, html: renderMarkdown(text), className: 'reader-message' });
    expect(file.props.class).toBe('markdown-preview');
    expect(reader.props.class).toBe('markdown-preview reader-message');
    expect(file.props.children[0].props.dangerouslySetInnerHTML).toEqual(
      reader.props.children[0].props.dangerouslySetInnerHTML,
    );
    expect(file.props.children[0].props.dangerouslySetInnerHTML.__html).toContain('<h1>Heading</h1>');
    expect(file.props.children[0].props.dangerouslySetInnerHTML.__html).toContain('language-ts');
  });
  it('keeps attachment/interaction content outside the HTML processing target', () => {
    const contentRef = { current: null as HTMLElement | null };
    const node = MarkdownPreview({ text: 'Body', contentRef, children: 'Attachments' });
    expect(node.props.children[1]).toBe('Attachments');
    const element = {} as HTMLElement;
    node.props.children[0].ref(element);
    expect(contentRef.current).toBe(element);
  });
  it('retains an escaped text fallback if Markdown cannot be rendered', () => {
    const node = MarkdownPreview({ text: '<unrendered>', html: null });
    expect(node.props.children[0].type).toBe('pre');
    expect(node.props.children[0].props.children).toBe('<unrendered>');
  });
});
