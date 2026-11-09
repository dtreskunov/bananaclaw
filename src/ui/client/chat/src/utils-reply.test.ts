import { describe, expect, it } from 'vitest';
import { renderMarkdown } from './utils';

describe('label-only reply Markdown', () => {
  const markdown = 'Start with [Take the food](reply:).';

  it('marks the visible label for rendering without a separate payload or navigation', () => {
    const html = renderMarkdown(markdown, null, true)!;
    expect(html).toBe('<p>Start with <span class="inline-reply-slot">Take the food</span>.</p>\n');
    expect(html).not.toContain('data-reply-draft');
    expect(html).not.toContain('href=');
    expect(html).not.toContain('target=');
  });

  it('keeps old destination contents inert, using only the label', () => {
    for (const destination of ['reply:', 'reply:Hidden%20draft', 'reply:%ZZ', 'reply:%00'])
      expect(renderMarkdown(`[Take the food](${destination})`, null, true)).toBe(
        '<p><span class="inline-reply-slot">Take the food</span></p>\n',
      );
  });

  it('renders inactive, reader, file-preview and inbound links as plain labels', () => {
    expect(renderMarkdown(markdown)).toBe('<p>Start with Take the food.</p>\n');
    expect(renderMarkdown(markdown, null, false)).toBe(renderMarkdown(markdown));
  });

  it.each(['#', '###'])('preserves %s heading typography and rich label markup', (heading) => {
    const html = renderMarkdown(`${heading} [**Fix** references](reply:)`, null, true)!;
    const level = heading.length;
    expect(html).toMatch(new RegExp(`^<h${level}[^>]*><span class="inline-reply-slot"`));
    expect(html).toContain('<strong>Fix</strong> references</span>');
    expect(html).toContain(`</h${level}>`);
  });

  it('handles punctuation and entities in labels without encoding a message', () => {
    const html = renderMarkdown('[Use **A &amp; B** (50%) and `C`](reply:)', null, true)!;
    expect(html).toContain('<strong>A &amp; B</strong> (50%) and <code>C</code>');
    expect(html).not.toContain('data-reply-draft');
  });

  it('never activates code examples and preserves ordinary links and message references', () => {
    expect(renderMarkdown('`[Take food](reply:)`', null, true)).not.toContain('inline-reply-slot');
    expect(renderMarkdown('[Site](https://example.test)', null, true)).toContain(
      'href="https://example.test" target="_blank" rel="noopener noreferrer"',
    );
    expect(renderMarkdown('[File](report.md)', null, true)).toContain('href="report.md"');
    expect(renderMarkdown('[[msg:message|thread]]', null, true)).toContain('class="msg-ref"');
  });
});
