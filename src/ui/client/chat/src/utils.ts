// Format helpers + markdown rendering. Returns plain strings/HTML —
// components handle escaping via JSX prop interpolation when possible.
import { marked } from 'marked';

// Open absolute (http/mailto/etc.) links rendered from markdown in a new
// tab. Relative links are left alone — they get rewritten to in-app
// file previews by rewriteFileLinks().
marked.use({
  renderer: {
    link({ href, title, tokens }) {
      const text = this.parser.parseInline(tokens);
      const isAbs = /^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('//');
      const titleAttr = title ? ` title="${title.replace(/"/g, '&quot;')}"` : '';
      const targetAttr = isAbs ? ' target="_blank" rel="noopener noreferrer"' : '';
      return `<a href="${href}"${titleAttr}${targetAttr}>${text}</a>`;
    },
  },
});

// Message reference extension: [[msg:messageId|threadId]] → clickable link.
// The chat UI intercepts clicks on these links to navigate to the thread.
marked.use({
  extensions: [
    {
      name: 'msgRef',
      level: 'inline',
      start(src: string) {
        return src.indexOf('[[msg:');
      },
      tokenizer(src: string) {
        const m = src.match(/^\[\[msg:([^\]|]+)\|([^\]]+)\]\]/);
        if (m) {
          return {
            type: 'msgRef',
            raw: m[0],
            messageId: m[1],
            threadId: m[2],
          };
        }
        return undefined;
      },
      renderer(token) {
        const { messageId, threadId } = token as unknown as { messageId: string; threadId: string };
        return `<a href="#" class="msg-ref" data-msg-id="${messageId}" data-thread-id="${threadId}" title="Jump to message">\uD83D\uDD17 referenced message</a>`;
      },
    },
  ],
});

export function fmtBytes(n: number | null | undefined): string {
  if (n == null) return '';
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' K';
  if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' M';
  return (n / 1024 / 1024 / 1024).toFixed(1) + ' G';
}

export function fmtBytesShort(n: number | null | undefined): string {
  if (n == null) return '';
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(0) + ' KB';
  return (n / (1024 * 1024)).toFixed(1) + ' MB';
}

export function fmtRelative(ts: string | null | undefined): string {
  if (!ts) return '';
  const norm = ts.includes('T') ? ts : ts.replace(' ', 'T') + 'Z';
  const t = Date.parse(norm);
  if (!t) return '';
  const sec = Math.max(0, (Date.now() - t) / 1000);
  if (sec < 60) return 'just now';
  if (sec < 3600) return Math.floor(sec / 60) + 'm';
  if (sec < 86400) return Math.floor(sec / 3600) + 'h';
  if (sec < 86400 * 7) return Math.floor(sec / 86400) + 'd';
  return new Date(t).toLocaleDateString();
}

export function fmtAbsolute(ts: string | null | undefined): string {
  if (!ts) return '';
  const norm = ts.includes('T') ? ts : ts.replace(' ', 'T') + 'Z';
  const t = Date.parse(norm);
  if (!t) return '';
  return new Date(t).toLocaleString();
}

export function tsKey(s: string | null | undefined): number {
  if (!s) return 0;
  const norm = s.includes('T') ? s : s.replace(' ', 'T') + 'Z';
  const n = Date.parse(norm);
  return Number.isFinite(n) ? n : 0;
}

export function parentPath(p: string): string {
  const i = p.lastIndexOf('/');
  return i < 0 ? '' : p.slice(0, i);
}

// Pre-process raw markdown to make file-link destinations parseable when the
// model emits unescaped spaces or parens in the URL — e.g.
// [`Foo (v2).mp3`](music/Foo (v2).mp3). CommonMark allows wrapping the
// destination in <...> to permit those characters; we add the wrap when the
// destination looks like a relative path (no URL scheme, not already wrapped).
function normalizeFileLinks(text: string): string {
  const re = /\[([^\]\n]+)\]\(([^<>\n()]*(?:\([^()\n]*\)[^<>\n()]*)*)\)/g;
  return text.replace(re, (match, label: string, dest: string) => {
    const d = dest.trim();
    if (!d) return match;
    if (/^[a-z][a-z0-9+.-]*:/i.test(d)) return match;
    if (d.startsWith('#') || d.startsWith('//') || d.startsWith('mailto:')) return match;
    if (!/[ ()]/.test(d)) return match;
    return `[${label}](<${d}>)`;
  });
}

const isExternalFileRef = (ref: string): boolean =>
  /^[a-z][a-z0-9+.-]*:/i.test(ref) || ref.startsWith('#') || ref.startsWith('//') || ref.startsWith('mailto:');
const isGroupFileRef = (ref: string): boolean => /^\/?(?:ui\/chat\/)?api\/groups\//.test(ref);

function decodeFileRef(ref: string): string {
  try {
    return decodeURIComponent(ref);
  } catch {
    return ref;
  }
}

function normalizeFileRef(ref: string): string {
  return String(ref || '')
    .replace(/^\.?\/+/, '')
    .replace(/^workspace\/+/, '');
}

function toGroupFileUrl(groupId: string, rel: string): string {
  const gid = encodeURIComponent(groupId);
  const segs = rel.split('/').filter(Boolean).map(encodeURIComponent);
  return `api/groups/${gid}/files/${segs.join('/')}`;
}

export function renderMarkdown(text: string | null | undefined, groupId?: string | null): string | null {
  try {
    const html = marked.parse(normalizeFileLinks(text || ''), { breaks: true, gfm: true }) as string;
    if (!groupId || typeof document === 'undefined') return html;
    const template = document.createElement('template');
    template.innerHTML = html;
    template.content.querySelectorAll<HTMLImageElement>('img[src]').forEach((img) => {
      const src = img.getAttribute('src') || '';
      if (!src || isExternalFileRef(src) || isGroupFileRef(src)) return;
      const rel = normalizeFileRef(decodeFileRef(src));
      if (rel) img.setAttribute('src', toGroupFileUrl(groupId, rel));
    });
    return template.innerHTML;
  } catch {
    return null;
  }
}

/**
 * Walk text nodes inside `root` and wrap case-insensitive matches of `query`
 * in <mark class="search-hl"> elements. Skips nodes inside <code>, <pre>,
 * <a>, <mark> to avoid breaking syntax or double-highlighting.
 */
export function highlightTextNodes(root: HTMLElement, query: string): void {
  if (!query) return;
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(${escaped})`, 'gi');
  const skip = new Set(['CODE', 'PRE', 'A', 'MARK', 'SCRIPT', 'STYLE']);

  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      let p = node.parentElement;
      while (p && p !== root) {
        if (skip.has(p.tagName)) return NodeFilter.FILTER_REJECT;
        p = p.parentElement;
      }
      return re.test(node.textContent || '') ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
    },
  });

  const nodes: Text[] = [];
  while (walker.nextNode()) nodes.push(walker.currentNode as Text);

  for (const textNode of nodes) {
    const frag = document.createDocumentFragment();
    const parts = textNode.textContent!.split(re);
    for (const part of parts) {
      if (re.test(part)) {
        const mark = document.createElement('mark');
        mark.className = 'search-hl';
        mark.textContent = part;
        frag.appendChild(mark);
      } else {
        frag.appendChild(document.createTextNode(part));
      }
      re.lastIndex = 0;
    }
    textNode.parentNode!.replaceChild(frag, textNode);
  }
}

export function rewriteFileLinks(
  root: HTMLElement,
  groupId: string,
  onNavFile: (entry: { path: string; name: string }) => void,
): void {
  if (!groupId || !root) return;
  const attachPreviewClick = (a: HTMLAnchorElement, rel: string): void => {
    a.addEventListener('click', (ev: MouseEvent) => {
      if (ev.button !== 0 || ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey) return;
      ev.preventDefault();
      onNavFile({ path: rel, name: rel.slice(rel.lastIndexOf('/') + 1) });
    });
  };
  root.querySelectorAll<HTMLAnchorElement>('a[href]').forEach((a) => {
    const href = a.getAttribute('href') || '';
    if (!href || isExternalFileRef(href) || isGroupFileRef(href)) return;
    const rel = normalizeFileRef(decodeFileRef(href));
    if (!rel) return;
    a.setAttribute('href', toGroupFileUrl(groupId, rel));
    a.setAttribute('target', '_blank');
    a.setAttribute('rel', 'noopener');
    attachPreviewClick(a, rel);
  });
  root.querySelectorAll<HTMLImageElement>('img[src]').forEach((img) => {
    const src = img.getAttribute('src') || '';
    if (!src || isExternalFileRef(src) || isGroupFileRef(src)) return;
    const rel = normalizeFileRef(decodeFileRef(src));
    if (!rel) return;
    img.setAttribute('src', toGroupFileUrl(groupId, rel));
  });
  const fileLikeRe = /^[\w.\-/ ]+\.[A-Za-z0-9]{1,8}$/;
  root.querySelectorAll<HTMLElement>('code').forEach((c) => {
    if (c.closest('pre')) return;
    const txt = c.textContent || '';
    if (!fileLikeRe.test(txt)) return;
    if (txt.length > 200) return;
    const rel = normalizeFileRef(txt);
    if (!rel) return;
    const a = document.createElement('a');
    a.href = toGroupFileUrl(groupId, rel);
    a.target = '_blank';
    a.rel = 'noopener';
    a.textContent = txt;
    attachPreviewClick(a, rel);
    c.replaceWith(a);
  });
}
