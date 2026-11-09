import { describe, expect, it } from 'vitest';
import { renderMarkdown } from './utils';

describe('inline reply markdown', () => {
  const markdown = 'Start with [Fix references](reply:Please%20fix%20the%20dangling%20references%20first.).';

  it('keeps the short label and full editable draft separate', () => {
    const html = renderMarkdown(markdown, null, true)!;
    expect(html).toContain('class="inline-reply-suggestion"');
    expect(html).toContain('type="button"');
    expect(html).toContain('data-reply-draft="Please fix the dangling references first."');
    expect(html).toContain('title="Draft reply: Please fix the dangling references first."');
    expect(html).toContain('aria-description="Draft reply: Please fix the dangling references first."');
    expect(html).toContain('>Fix references<span aria-hidden="true">');
    expect(html).not.toContain('href=');
    expect(html).not.toContain('target=');
  });

  it('renders inactive, reader, file-preview and inbound links as ordinary label text by default', () => {
    const html = renderMarkdown(markdown)!;
    expect(html).toBe('<p>Start with Fix references.</p>\n');
    expect(renderMarkdown(markdown, null, false)).toBe(html);
  });

  it('escapes the full draft instead of injecting URL content into attributes or navigation', () => {
    const draft = 'Discuss "<input autofocus>" & its meaning';
    const html = renderMarkdown(`[Discuss markup](reply:${encodeURIComponent(draft)})`, null, true)!;
    expect(html).toContain('data-reply-draft="Discuss &quot;&lt;input autofocus&gt;&quot; &amp; its meaning"');
    expect(html).not.toContain('<input');
    expect(html).not.toContain('href=');
    expect(renderMarkdown('[Literal text](reply:javascript%3Aalert%281%29)', null, true)).toContain(
      'data-reply-draft="javascript:alert(1)"',
    );
  });

  it.each(['reply:', 'reply:%20', 'reply:%ZZ', 'reply:%00', `reply:${'x'.repeat(241)}`])(
    'keeps invalid %s suggestions inert without breaking the message',
    (href) => {
      expect(renderMarkdown(`[Label](${href})`, null, true)).toBe('<p>Label</p>\n');
    },
  );

  it('leaves code examples inert and preserves ordinary links and message references', () => {
    expect(renderMarkdown('`[Fix](reply:Please%20fix)`', null, true)).not.toContain('inline-reply-suggestion');
    expect(renderMarkdown('[Site](https://example.test)', null, true)).toContain(
      'href="https://example.test" target="_blank" rel="noopener noreferrer"',
    );
    expect(renderMarkdown('[File](report.md)', null, true)).toContain('href="report.md"');
    expect(renderMarkdown('[[msg:message|thread]]', null, true)).toContain('class="msg-ref"');
  });
});
