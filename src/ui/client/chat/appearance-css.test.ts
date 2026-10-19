import fs from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { THEMES } from './src/appearance';

function read(relative: string): string {
  return fs.readFileSync(new URL(relative, new URL('./src/', import.meta.url)), 'utf8');
}

function literals(theme: string, mode: string): Record<string, string> {
  const css = read(`./styles/themes/${theme}.css`);
  const common = css.match(/\{([^}]+)\}/)?.[1] ?? '';
  const automaticLight =
    mode === 'system-dark'
      ? (css.match(/:root:not\(\[data-mode\]\),\s*\[data-theme="default"\]\[data-mode="light"\] \{([^}]+)\}/)?.[1] ??
        '')
      : '';
  const branch = css.match(
    mode === 'system-dark'
      ? /@media \(prefers-color-scheme: dark\) \{\s*:root:not\(\[data-mode\]\) \{([^}]+)\}/
      : new RegExp(`\\[data-theme="${theme}"\\]\\[data-mode="${mode}"\\] \\{([^}]+)\\}`),
  )?.[1];
  if (!branch) throw new Error(`Missing ${theme}/${mode} branch`);
  const declarations = Object.fromEntries(
    [...`${common}\n${automaticLight}\n${branch}`.matchAll(/--([\w-]+):\s*([^;]+);/g)].map((match) => [
      match[1],
      match[2],
    ]),
  );
  function resolve(name: string, seen = new Set<string>()): string | undefined {
    const value = declarations[name];
    if (/^#[\da-f]{6}$/.test(value)) return value;
    if (/^#[\da-f]{3}$/.test(value)) return '#' + [...value.slice(1)].map((char) => char + char).join('');
    const alias = value?.match(/^var\(--([\w-]+)\)$/)?.[1];
    if (!alias || seen.has(name)) return undefined;
    seen.add(name);
    return resolve(alias, seen);
  }
  return Object.fromEntries(
    Object.keys(declarations).flatMap((name) => {
      const value = resolve(name);
      return value ? [[name, value]] : [];
    }),
  );
}

function luminance(color: string): number {
  const channels = [1, 3, 5]
    .map((offset) => parseInt(color.slice(offset, offset + 2), 16) / 255)
    .map((value) => (value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4));
  return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
}

function contrast(fg: string, bg: string): number {
  const [low, high] = [luminance(fg), luminance(bg)].sort((a, b) => a - b);
  return (high + 0.05) / (low + 0.05);
}

function mix(fg: string, bg: string, fraction: number): string {
  return (
    '#' +
    [1, 3, 5]
      .map((offset) =>
        Math.round(
          parseInt(fg.slice(offset, offset + 2), 16) * fraction +
            parseInt(bg.slice(offset, offset + 2), 16) * (1 - fraction),
        )
          .toString(16)
          .padStart(2, '0'),
      )
      .join('')
  );
}

describe('theme CSS contract', () => {
  it('uses header and composer shadows without transcript navigation buttons', () => {
    const css = read('./components/ChatMain.css');
    expect(css).not.toContain('.scroll-jump');
    expect(read('./components/ChatMain.tsx')).not.toContain('ScrollNavigation');
    const headerCss = read('./components/Header.css');
    const header = headerCss.match(/\.app-header \{([^}]+)\}/)?.[1];
    expect(header).toContain('position: relative');
    expect(header).not.toContain('z-index');
    expect(header).not.toContain('box-shadow');
    const shadow = headerCss.match(/\.app-header::after \{([^}]+)\}/)?.[1];
    expect(shadow).toContain('box-shadow: 0 2px 10px var(--shadow-color)');
    expect(shadow).toContain('z-index: 5');
    expect(shadow).toContain('pointer-events: none');
    expect(read('./components/Header.tsx')).toContain('<header class="app-header">');
  });

  it('shares a 760 px column and desktop gutters between messages and composer, with 90% bubbles', () => {
    const css = read('./components/ChatMain.css');
    const column = css.match(/\.chat-main \{([^}]+)\}/)?.[1];
    expect(column).toContain('--chat-max: 760px');
    expect(column).toContain('--chat-gutter: max(16px, calc((100% - var(--chat-max)) / 2))');
    const rows = css.match(/\.chat-main \.log,\s*([^{}]+)\{([^}]+)\}/);
    expect(rows?.[1]).toContain('.chat-main form');
    expect(rows?.[2]).toContain('padding-inline: var(--chat-gutter)');
    const bubble = css.match(/\.chat-main \.msg \{([^}]+)\}/)?.[1];
    expect(bubble).toContain('max-width: 90%');
    const composer = css.match(/^\.chat-main form \{([^\n]+)\}/m)?.[1];
    expect(composer).toContain('padding-block: 8px 16px');
    const mobileComposer = css.match(/@media \(max-width: 720px\) \{[\s\S]*?\.chat-main form \{([^}]+)\}/)?.[1];
    expect(mobileComposer).toContain('padding-inline: 12px');
    expect(mobileComposer).toContain('padding-block: 8px calc(12px + env(safe-area-inset-bottom))');
    expect(css.match(/--chat-max:/g)).toHaveLength(1);
    expect(css.match(/max\(16px, calc\(\(100% - var\(--chat-max\)\)/g)).toHaveLength(1);
  });

  it('uses one full-height native scroller for both the transcript and its background', () => {
    const css = read('./components/ChatMain.css');
    const column = css.match(/\.chat-main \{([^}]+)\}/)?.[1];
    expect(column).toContain('grid-template-rows: auto minmax(0, 1fr)');
    expect(css).not.toContain('.chat-main::before');
    const log = css.match(/\.chat-main \.log \{([^}]+)\}/)?.[1];
    expect(log).toContain('container-type: size');
    expect(log).toContain('--transcript-hatch: color-mix(in srgb, var(--surface-fg) 6%, transparent)');
    expect(log).toContain('repeating-linear-gradient(45deg, var(--transcript-hatch) 0 1px, transparent 1px 16px)');
    expect(log).toContain('repeating-linear-gradient(-45deg, var(--transcript-hatch) 0 1px, transparent 1px 16px)');
    expect(log).toContain('background-attachment: local');
    expect(log).toContain('background-color: var(--surface)');
    expect(log).toContain(
      'scroll-padding-block: var(--transcript-edge-space) calc(var(--chat-dock-height, 0px) + var(--transcript-edge-space))',
    );
    const dock = css.match(/\.chat-main \.chat-bottom-dock \{([^}]+)\}/)?.[1];
    expect(dock).toContain('align-self: end');
    expect(dock).toContain('margin-inline-end: var(--chat-scrollbar-width, 0px)');
    expect(dock).toContain('z-index: 1');
    expect(dock).not.toContain('overflow');
    expect(css).toContain('.chat-main > .chat-bottom-dock { grid-area: 2 / 1; }');
    const component = read('./components/ChatMain.tsx');
    expect(component).not.toContain('transcript-scroll-offset');
    expect(component).not.toContain('onScrollCapture');
    expect(component).not.toContain('log-viewport');
    for (const [direction, tint] of [
      ['in', 'accent'],
      ['out', 'wash-strong'],
    ]) {
      const bubble = css.match(new RegExp(`\\.chat-main \\.msg\\.${direction} \\{([^}]+)\\}`))?.[1];
      expect(bubble).toContain(`background: linear-gradient(var(--${tint}), var(--${tint})) var(--surface)`);
    }
  });

  it('keeps one line of edge space and floating-dock clearance without transcript fades', () => {
    const css = read('./components/ChatMain.css');
    const column = css.match(/\.chat-main \{([^}]+)\}/)?.[1];
    expect(column).toContain('--transcript-edge-space: calc(var(--font-base) * var(--line-height-ui))');
    const mobileColumn = css.match(/@media \(max-width: 720px\) \{\s*\.chat-main \{([^}]+)\}/)?.[1];
    expect(mobileColumn).toContain('--transcript-edge-space: calc(var(--font-lg) * var(--line-height-ui))');
    const log = css.match(/\.chat-main \.log \{([^}]+)\}/)?.[1];
    expect(log).not.toContain('--fade-');
    expect(log).toContain('padding-block: 0');
    expect(css).not.toContain('.log.scroll-fade-');
    const edgeSpace = css.match(/\.chat-main \.log::before,\s*\.chat-main \.log::after \{([^}]+)\}/)?.[1];
    expect(edgeSpace).toContain("content: ''");
    expect(edgeSpace).toContain('flex: 0 0 calc(var(--transcript-edge-space) - var(--message-gap))');
    expect(css).toContain(
      '.chat-main .log::after { flex-basis: calc(var(--chat-dock-height, 0px) + var(--transcript-edge-space) - var(--message-gap)); }',
    );
    expect(css).not.toContain('.log-viewport::after');
    const component = read('./components/ChatMain.tsx');
    expect(component).toContain('class="log"');
    expect(component).not.toContain('class="log scroll-edge-fade"');
    expect(component).not.toContain('attachScrollEdges(ref.current');
    const composer = css.match(/\.chat-main form \{([^}]+)\}/)?.[1];
    expect(composer).not.toContain('border-top');
  });

  it('keeps rounded bubble frames solid while only their inset content scrolls and fades', () => {
    const css = read('./components/ChatMain.css');
    const frame = css.match(/\.chat-main \.log \.msg:not\(\.event\) \{([^}]+)\}/)?.[1];
    expect(frame).toContain('display: flex');
    expect(frame).toContain('flex-direction: column');
    expect(frame).toContain(
      'max-height: max(0px, calc(100cqh - var(--chat-dock-height, 0px) - 2 * var(--transcript-edge-space)))',
    );
    expect(frame).not.toContain('overflow');
    const content = css.match(/\.chat-main \.message-scroll \{([^}]+)\}/)?.[1];
    expect(content).toContain('min-height: 0');
    expect(content).toContain('min-width: 0');
    expect(content).toContain('overflow: auto');
    const bubble = read('./components/MessageBubble.tsx');
    expect(bubble).toContain('class={className}');
    expect(bubble).toContain('class="message-scroll scroll-edge-fade"');
    expect(css).toContain('.msg:has(> .message-scroll:focus-visible)');
    expect(css).toContain('.msg:not(.display-card) > .message-scroll > .turn-technical-details');
    expect(css).toContain('.msg.markdown > .message-scroll > :first-child');
    expect(css).toContain('.msg.markdown > .message-scroll > :last-child');
    const card = css.match(/\.chat-main \.display-card > \.message-scroll \{([^}]+)\}/)?.[1];
    expect(card).toContain('display: flex');
    expect(card).toContain('flex-direction: column');
    expect(card).toContain('gap: 8px');
  });

  it('sizes bubble fades to three text lines while preserving a readable center in small viewports', () => {
    const css = read('./components/ChatMain.css');
    const content = css.match(/\.chat-main \.message-scroll \{([^}]+)\}/)?.[1];
    expect(content).toContain('--message-edge-fade: min(3lh, 30%)');
    for (const edge of ['top', 'bottom']) {
      const state = css.match(new RegExp(`\\.chat-main \\.message-scroll\\.scroll-fade-${edge} \\{([^}]+)\\}`))?.[1];
      expect(state).toContain(`--fade-${edge}: var(--message-edge-fade)`);
    }
    const global = read('./styles/global.css');
    expect(global).toContain('.scroll-edge-fade.scroll-fade-top { --fade-top: 12px; }');
    expect(global).toContain('.scroll-edge-fade.scroll-fade-bottom { --fade-bottom: 12px; }');
  });

  it('keeps pending controls visible and status captions consistent with delivery labels', () => {
    const css = read('./components/ChatMain.css');
    const pending = css.match(/\.chat-main \.msg \.msg-inline-actions\.pending-input-actions \{([^}]+)\}/)?.[1];
    expect(pending).toContain('display: inline-flex');
    expect(pending).toContain('opacity: 1');
    expect(css).not.toContain('pending-input-action {');
    const labels = css.match(
      /\.chat-main \.msg \.delivery-origin,\s*\.chat-main \.input-state-caption \{([^}]+)\}/,
    )?.[1];
    expect(labels).toContain('font-style: italic');
    expect(labels).not.toMatch(/color:|opacity:/);
  });

  it('frames shared composers with opaque backplates and stable idle, hover and focus outlines', () => {
    const css = read('./components/ChatMain.css');
    const wrapper = css.match(/\.chat-main \.composer-input-wrap \{([^}]+)\}/)?.[1];
    expect(wrapper).toContain('border-radius: var(--radius-md)');
    expect(wrapper).toContain('background: var(--surface)');
    expect(wrapper).toContain('box-shadow: 0 0 0 4px var(--surface), 0 2px 10px 4px var(--shadow-color)');
    expect(wrapper).toContain('outline: 2px solid color-mix(in srgb, var(--focus-ring) 30%, transparent)');
    expect(wrapper).toContain('outline-offset: 2px');
    expect(wrapper).toContain('transition: outline-color 0.15s');
    expect(wrapper).not.toMatch(/(?:^|\s)(?:border|padding|margin):/);
    expect(css).toMatch(
      /@media \(hover: hover\) \{\s*\.chat-main \.composer-input-wrap:hover \{\s*outline-color: color-mix\(in srgb, var\(--focus-ring\) 55%, transparent\);/,
    );
    const focused = css.match(/\.chat-main \.composer-input-wrap:focus-within \{([^}]+)\}/)?.[1];
    expect(focused).toContain('outline-color: var(--focus-ring)');
    expect(css.indexOf('.composer-input-wrap:focus-within')).toBeGreaterThan(css.indexOf('.composer-input-wrap:hover'));
    expect(css).toMatch(
      /:root\[data-theme\] \.chat-main \.composer-input-wrap textarea:focus-visible \{\s*outline: none;/,
    );
    expect(css).toMatch(
      /@media \(prefers-reduced-motion: reduce\) \{\s*\.chat-main \.composer-input-wrap \{ transition: none; \}/,
    );
  });

  it('keeps metadata on one row and uses shared disclosure styling for inline metrics', () => {
    const css = read('./components/ChatMain.css');
    const meta = css.match(/\.chat-main \.msg \.meta, \.chat-main \.typing \.meta \{([^}]+)\}/)?.[1];
    expect(meta).toContain('color: var(--message-meta, var(--muted))');
    expect(meta).toContain('flex-wrap: nowrap');
    expect(meta).toContain('min-width: 0');
    const toggle = css.match(/\.chat-main \.meta \.trace-toggle \{([^}]+)\}/)?.[1];
    expect(toggle).toContain('display: inline-flex');
    expect(toggle).toContain('font: inherit');
    const details = css.match(/\.chat-main \.usage-details \{([^}]+)\}/)?.[1];
    expect(details).toContain('width: max-content');
    expect(details).not.toContain('border:');
    expect(details).toContain('font-size: var(--font-2xs)');
    const outline = css.match(/\.chat-main \.msg-activity\.expanded \{([^}]+)\}/)?.[1];
    expect(outline).toContain('border: 1px solid var(--border)');
    expect(details).not.toMatch(/position:|z-index:|box-shadow:/);
    expect(css).not.toMatch(/usage-popover|usage-backdrop/);
  });

  it('lays out usage as one row of content-sized, unoutlined columns whose rows share label and value tracks', () => {
    const css = read('./components/ChatMain.css');
    expect(css).toContain('.chat-main .usage-columns { display: flex; flex-wrap: nowrap;');
    const column = css.match(/\.chat-main \.usage-column \{([^}]+)\}/)?.[1];
    expect(column).toContain('flex: none');
    expect(column).toContain('grid-template-columns: max-content max-content');
    expect(column).not.toMatch(/border/);
    const row = css.match(/\.chat-main \.usage-row \{([^}]+)\}/)?.[1];
    expect(row).toContain('grid-column: 1 / -1');
    expect(row).toContain('grid-template-columns: subgrid');
    expect(row).not.toContain('flex:');
    expect(css).toContain('.chat-main .msg:has(.usage-details) { width: 100%; }');
    expect(css).toContain('.chat-main .usage-report { display: contents; }');
    expect(css).not.toMatch(/usage-total|usage-heading/);
    expect(css).toMatch(/\.chat-main \.usage-row > strong \{[^}]*text-align: left/);
    expect(css).not.toMatch(/usage-grid|usage-pair|usage-time-breakdown/);
  });

  it('keeps labels and values non-breaking without clipping oversized metrics', () => {
    const css = read('./components/ChatMain.css');
    const row = css.match(/\.chat-main \.usage-row \{([^}]+)\}/)?.[1];
    expect(row).toContain('white-space: nowrap');
    expect(row).toContain('grid-template-columns: subgrid');
    expect(row).toContain('overflow-wrap: normal');
    const details = css.match(/\.chat-main \.usage-details \{([^}]+)\}/)?.[1];
    expect(details).toContain('overflow-x: auto');
    expect(css).not.toMatch(/\.usage-row > (?:span|strong) \{[^}]*overflow-wrap: anywhere/);
  });

  it('uses one inset provenance rail with accent, neutral and semantic tones', () => {
    const css = read('./components/ChatMain.css');
    const railRule = css.match(/\.chat-main \.msg\.agent-action,[\s\S]*?\.chat-main \.msg\.input-steering \{([^}]+)\}/);
    const rail = railRule?.[1];
    expect(rail).toContain('box-shadow: inset 2px 0 var(--provenance-rail-color, var(--border-strong))');
    expect(railRule?.[0]).not.toContain('.typing.turn-system');
    expect(railRule?.[0]).not.toContain('.msg.input-queued');
    const action = css.match(/\.chat-main \.msg\.agent-action \{([^}]+)\}/)?.[1];
    expect(action).toContain('--provenance-rail-color: var(--accent-strong-opaque, var(--accent-strong))');
    const neutral = css.match(/\.chat-main :where\(\.msg\.out\.system-notice, \.msg\.internal\) \{([^}]+)\}/)?.[1];
    expect(neutral).toContain('--provenance-rail-color: var(--border-strong, var(--muted))');
    expect(css).not.toContain('.chat-main .msg.out.system-notice { background: transparent; }');
    const warning = css.match(
      /\.chat-main :is\(\.msg, \.typing\)\.provenance-warning,[\s\S]*?\.chat-main \.msg\.input-follow-up \{([^}]+)\}/,
    )?.[1];
    expect(warning).toContain('--provenance-rail-color: var(--warning-border, var(--warning))');
    const error = css.match(/\.chat-main :is\(\.msg, \.typing\)\.provenance-error \{([^}]+)\}/)?.[1];
    expect(error).toContain('--provenance-rail-color: var(--error-soft, var(--danger))');
  });

  it('keeps queued input bubbles free of a transient left rail', () => {
    const css = read('./components/ChatMain.css');
    expect(css).not.toContain('.msg.input-queued');
    const input = css.match(/\.chat-main \.msg\.in \{([^}]+)\}/)?.[1];
    expect(input).toContain('background: linear-gradient(var(--accent), var(--accent)) var(--surface)');
    expect(input).not.toMatch(/border(?:-left|-inline-start)?|box-shadow/);
    expect(css).toContain('.chat-main .input-state-caption');
  });

  it('keeps live status bubbles transparent and full-width with fixed controls and one-line timing metadata', () => {
    const css = read('./components/ChatMain.css');
    const message = css.match(/\.chat-main \.msg \{([^}]+)\}/)?.[1];
    expect(message).toContain(
      'padding: var(--message-padding-top) var(--message-padding-inline) var(--message-padding-block)',
    );
    const turnStatus = css.match(/\.chat-main \.typing\.turn-system\.turn-status \{([^}]+)\}/)?.[1];
    expect(turnStatus).toContain('width: fit-content');
    expect(turnStatus).not.toContain('max-width: 100%');
    const live = css.match(/\.chat-main \.typing\.turn-system\.turn-live \{([^}]+)\}/)?.[1];
    expect(live).toContain('width: 100%');
    expect(live).toContain('max-width: 100%');
    expect(live).toContain('min-width: 0');
    expect(css).toMatch(
      /\.turn-live \.typing-summary,\s*\.chat-main \.typing\.turn-system\.turn-live \.msg-activity \{ width: 100%; \}/,
    );
    const summary = css.match(/\.chat-main \.typing\.turn-system \.typing-summary \{([^}]+)\}/)?.[1];
    expect(summary).toContain('flex-direction: row');
    expect(summary).toContain('align-items: center');
    const stop = css.match(/\.chat-main \.typing\.turn-system \.typing-summary \.turn-stop-inline \{([^}]+)\}/)?.[1];
    expect(stop).toContain('margin-left: 0');
    const dots = css.match(/\.chat-main \.typing \.typing-dots \{([^}]+)\}/)?.[1];
    expect(dots).toContain('flex: none');
    const turn = css.match(/\.chat-main \.typing\.turn-system \{([^}]+)\}/)?.[1];
    expect(turn).toContain('background: transparent');
    expect(turn).toContain(
      'padding: var(--message-padding-top) var(--message-padding-inline) var(--message-padding-block)',
    );
    const timing = css.match(/\.chat-main \.turn-elapsed \{([^}]+)\}/)?.[1];
    expect(timing).toContain('flex: none');
    expect(timing).toContain('white-space: nowrap');
  });

  it('gives shared technical-detail panels a solid theme surface without filling the status row', () => {
    const css = read('./components/ChatMain.css');
    const panel = css.match(/\.chat-main \.msg-activity\.expanded \{([^}]+)\}/)?.[1];
    expect(panel).toContain('background: var(--surface)');
    expect(panel).toContain('border: 1px solid var(--border)');
    expect(panel).toContain('border-radius: 6px');
    const status = css.match(/\.chat-main \.typing\.turn-system \{([^}]+)\}/)?.[1];
    expect(status).toContain('background: transparent');
    expect(read('./components/ChatMain.tsx')).toContain('class="msg-activity expanded"');
  });

  it('keeps activity trace typography comparable to the status line', () => {
    const css = read('./components/ChatMain.css');
    const table = css.match(/\.chat-main \.msg-activity \.trace-table \{([^}]+)\}/)?.[1];
    expect(table).toContain('font-size: var(--font-2xs)');
    const toggle = css.match(
      /\.chat-main \.activity-trace \.trace-row-toggle,\s*\.chat-main \.activity-trace \.trace-chapter-toggle \{([^}]+)\}/,
    )?.[1];
    expect(toggle).toContain('font-size: inherit');
    expect(toggle).toContain('font-family: var(--font-ui)');
    expect(toggle).toContain('color: var(--trace-status-color, var(--muted))');
    for (const status of ['queued', 'running', 'completed', 'failed']) {
      const rule = css.match(new RegExp(`\\.chat-main \\.activity-trace \\.trace-status-${status} \\{([^}]+)\\}`))?.[1];
      expect(rule).toContain(`--trace-status-color: var(--activity-status-${status})`);
    }
    const subject = css.match(/\.chat-main \.activity-trace code\.trace-subject \{([^}]+)\}/)?.[1];
    expect(subject).toContain('font-size: inherit');
    expect(subject).toContain('font-family: var(--font-mono, monospace)');
    expect(css).toContain('.chat-main .typing .hint code.trace-subject,');
    const code = css.match(/\.chat-main \.activity-trace pre\.trace-code \{([^}]+)\}/)?.[1];
    expect(code).toContain('font-size: inherit');
    const codeContent = css.match(/\.chat-main \.activity-trace pre\.trace-code code \{([^}]+)\}/)?.[1];
    expect(codeContent).toContain('font-size: inherit');
    const preview = css.match(/\.chat-main \.typing \.trace-preview \{([^}]+)\}/)?.[1];
    // The preview inherits the status line hint's size.
    expect(preview).not.toContain('font-size');
    expect(css.match(/\.chat-main \.typing \.hint \{([^}]+)\}/)?.[1]).toContain('font-size: var(--font-xs)');
    expect(preview).toContain('font-family: var(--font-ui)');
  });

  it('uses distinct chapter chevrons, continuous rails, indented child labels and hollow child dots', () => {
    const css = read('./components/ChatMain.css');
    expect(css).toContain('--trace-child-indent: 20px');
    expect(css).toContain(
      '.trace-child .trace-marker { margin-left: calc(var(--trace-col-gap) + var(--trace-child-indent)); }',
    );
    expect(css).toContain(
      '.trace-child .trace-text { padding-left: calc(var(--trace-col-gap) + var(--trace-child-indent)); }',
    );
    const marker = css.match(/\.chat-main \.activity-trace \.trace-chapter-marker \{([^}]+)\}/)?.[1];
    expect(marker).toContain('stroke: currentColor');
    expect(marker).toContain('background: var(--surface)');
    expect(css).toContain(
      '.trace-chapter.open > .trace-row-header .trace-chapter-marker { transform: rotate(90deg); }',
    );
    for (const selector of ['trace-row::before', 'trace-child::after', 'trace-chapter::before']) {
      const rail = css.match(new RegExp(`\\.chat-main \\.activity-trace \\.${selector} \\{([^}]+)\\}`))?.[1];
      expect(rail).toContain('grid-column: tree / label');
      expect(rail).toContain('left: calc(var(--trace-col-gap) + 4px)');
    }
    expect(css).toContain('.trace-child::after');
    expect(css).toMatch(/\.trace-child \.trace-dot \{[^}]*width: 5px;[^}]*border: 1px solid/);
    expect(css).toContain('.trace-chapter::before');
    expect(css).toContain('.trace-status-interrupted');
    expect(css).toContain('.trace-status-unknown');
    expect(css).toContain('ul.trace-todos');
  });

  it('uses one compact row rhythm for standalone steps, chapter headers and child connectors', () => {
    const css = read('./components/ChatMain.css');
    const table = css.match(/\.chat-main \.msg-activity \.trace-table \{([^}]+)\}/)?.[1];
    expect(table).toContain('--trace-row-height: 28px');
    const row = css.match(/\.chat-main \.activity-trace \.trace-row-toggle \{([^}]+)\}/)?.[1];
    const chapter = [...css.matchAll(/\.chat-main \.activity-trace \.trace-chapter-toggle \{([^}]+)\}/g)].at(-1)?.[1];
    expect(row).toContain('height: var(--trace-row-height)');
    expect(chapter).toContain('height: var(--trace-row-height)');
    expect(css).toContain('top: calc(var(--trace-row-height) / 2)');
  });

  it('scrolls the trace table both ways and renders Stop as the timeline node', () => {
    const css = read('./components/ChatMain.css');
    // Tree, CPU and AI columns fit their widest cell; labels keep their full width and the table scrolls.
    const table = css.match(/\.chat-main \.msg-activity \.trace-table \{([^}]+)\}/)?.[1];
    expect(table).toContain(
      'grid-template-columns: [cpu] auto [ai] auto [tree] var(--trace-tree-width) [label] minmax(max-content, 1fr) [end]',
    );
    expect(table).toContain('max-height: 30vh; overflow: auto');
    expect(css.match(/\.chat-main \.msg-activity \.activity-trace \{([^}]+)\}/)?.[1]).not.toContain('overflow');
    expect(css).not.toContain('trace-column');
    expect(css).toMatch(
      /\.trace-row-header \{ grid-column: 1 \/ -1; display: grid; grid-template-columns: subgrid; \}/,
    );
    // Expanded details wrap within the table instead of widening it.
    expect(css).toContain('.trace-row > :not(.trace-row-header) { grid-column: label / end; contain: inline-size; }');
    expect(css).toContain(
      '.trace-child > :not(.trace-row-header) { margin-left: calc(var(--trace-col-gap) + var(--trace-child-indent)); }',
    );
    expect(css).toMatch(/\.trace-meta \{ white-space: normal; overflow-wrap: anywhere/);
    const toggle = css.match(
      /\.trace-row-toggle,\s*\.chat-main \.activity-trace \.trace-chapter-toggle \{([^}]+)\}/,
    )?.[1];
    expect(toggle).toContain('width: 100%; min-width: 0');
    const text = css.match(/\.trace-chapter-label,\s*\.chat-main \.activity-trace \.trace-text \{([^}]+)\}/)?.[1];
    expect(text).toContain('white-space: nowrap');
    expect(text).not.toContain('overflow');
    expect(text).not.toContain('mask-image');
    expect(css.match(/\.chat-main \.activity-trace \.trace-stop \{([^}]+)\}/)?.[1]).toContain('grid-column: tree');
    expect(css).toContain('.trace-row-header:has(.trace-stop .tool-stop) .trace-marker { visibility: hidden; }');
    const stop = css.match(/\.chat-main \.activity-trace \.trace-stop \.tool-stop \{([^}]+)\}/)?.[1];
    expect(stop).toContain('border: 1px solid var(--trace-status-color, var(--muted))');
    expect(stop).toContain('color: var(--trace-status-color, var(--muted))');
    const time = css.match(/\.chat-main \.activity-trace \.trace-time \{([^}]+)\}/)?.[1];
    expect(time).toContain('justify-self: end');
    expect(time).toContain('white-space: nowrap');
    expect(time).toContain('font-variant-numeric: tabular-nums');
    expect(time).not.toContain('border');
    expect(css).toContain('.chat-main .activity-trace .trace-time:empty { padding: 0; }');
    // AI time and the summary's Model time share one theme color.
    expect(css).toContain('.chat-main .trace-table .trace-time-ai { color: var(--activity-model-time); }');
    expect(css).toContain('.chat-main .usage-row-model-time > strong { color: var(--activity-model-time); }');
    for (const theme of ['default', 'autumn'])
      expect(read(`./styles/themes/${theme}.css`)).toContain('--activity-model-time:');
    const global = read('./styles/global.css');
    expect(global).toContain('mask-composite: intersect');
    for (const edge of ['top', 'right', 'bottom'])
      expect(global).toContain(`.scroll-edge-fade.scroll-fade-${edge} { --fade-${edge}: 12px; }`);
  });

  it('keeps chapter headers free of the last step argument preview', () => {
    const component = read('./components/ChatMain.tsx');
    expect(component).not.toContain('trace-chapter-preview');
    expect(component).toContain('const { line, step, headline } = entry');
    expect(component).toContain('trace-chapter-title');
    expect(component).toContain('trace-chapter-failures');
  });

  it('gives markdown tables full-width bubbles, local scrolling, legible cells and themed grid styling', () => {
    const css = read('./components/ChatMain.css');
    const bubble = css.match(/\.chat-main \.msg\.markdown:has\(table\) \{([^}]+)\}/)?.[1];
    expect(bubble).toContain('width: 100%');
    expect(bubble).toContain('max-width: 100%');
    const globalCss = read('./styles/global.css');
    const scrollableTable = globalCss.match(/:where\(table:not\(\[data-table-scroll="off"\]\)\) \{([^}]+)\}/)?.[1];
    expect(scrollableTable).toContain('display: block');
    expect(scrollableTable).toContain('width: max-content');
    expect(scrollableTable).toContain('max-width: 100%');
    expect(scrollableTable).toContain('overflow-x: auto');
    expect(scrollableTable).toContain('white-space: nowrap');
    expect(scrollableTable).toContain('border: 1px solid var(--border)');
    expect(scrollableTable).toContain('border-collapse: separate');
    expect(globalCss).toContain('table.scroll-fade-right');
    expect(globalCss).toContain('table.scroll-fade-left');
    expect(globalCss).toContain('calc(100% - var(--fade-right))');
    expect(globalCss).toContain('--fade-right: 12px');
    const cells = globalCss.match(/:where\(table:not\(\[data-table-scroll="off"\]\) :is\(th, td\)\) \{([^}]+)\}/)?.[1];
    expect(cells).toContain('border-inline-end: 1px solid var(--border)');
    expect(cells).toContain('border-block-end: 1px solid var(--border)');
    expect(cells).toContain('word-break: normal');
    expect(cells).toContain('overflow-wrap: normal');
    const header = globalCss.match(/:where\(table:not\(\[data-table-scroll="off"\]\) th\) \{([^}]+)\}/)?.[1];
    expect(header).toContain('background: var(--table-header-bg)');
    expect(header).toContain('border-block-end-color: var(--border-strong)');
    expect(globalCss).toContain(':where(table:not([data-table-scroll="off"]) tbody tr:nth-child(even) td)');
    for (const theme of THEMES) {
      const themeCss = read(`./styles/themes/${theme.id}.css`);
      expect(themeCss).toContain('--table-header-bg:');
      expect(themeCss).toContain('--table-row-alt-bg: color-mix(in srgb, var(--surface-fg) 4%, transparent);');
    }
    expect(read('./styles/themes/default.css')).toContain(
      '--table-header-bg: color-mix(in srgb, var(--surface-fg) 16%, var(--surface));',
    );
    const settingsCss = read('./components/Settings.css');
    expect(settingsCss).toContain('width: max-content');
    expect(settingsCss).toContain('min-width: 100%');
    expect(settingsCss).not.toContain('max-width: 0');
    expect(settingsCss).not.toContain('td:nth-child(2) code');
  });

  it('keeps Default/Light message metadata above AA contrast on outgoing bubbles', () => {
    expect(read('./styles/themes/default.css')).toContain(
      '--message-meta: color-mix(in srgb, var(--surface-fg) 60%, var(--surface));',
    );
    const metadata = mix('#000000', '#ffffff', 0.6);
    const outgoingBubble = mix('#7f7f7f', '#ffffff', 0.18);
    expect(contrast(metadata, outgoingBubble)).toBeGreaterThanOrEqual(4.5);
  });

  it('keeps Default/Light secondary, action and status text legible on shared tinted surfaces', () => {
    const tokens = literals('default', 'light');
    const surface = '#ffffff';
    const outgoing = mix('#7f7f7f', surface, 0.18);
    const incoming = mix('#6496ff', surface, 0.18);
    const tableHeader = mix('#000000', outgoing, 0.16);
    for (const background of [surface, outgoing, incoming, tableHeader]) {
      for (const name of [
        'muted',
        'primary',
        'accent-text',
        'message-action-text',
        'danger',
        'error',
        'error-soft',
        'warning',
        'warn',
        'success',
        'ok',
        'recording-fg',
      ]) {
        expect(contrast(tokens[name], background), `${name} on ${background}`).toBeGreaterThanOrEqual(4.5);
      }
      for (const name of ['border-control', 'focus-ring']) {
        expect(contrast(tokens[name], background), `${name} on ${background}`).toBeGreaterThanOrEqual(3);
      }
    }
    expect(read('./styles/themes/default.css')).toMatch(/--muted: #414b59;\s*--placeholder-opacity: 1;/);
    for (const name of [
      'activity-status-queued',
      'activity-status-running',
      'activity-status-completed',
      'activity-status-failed',
      'activity-model-time',
    ]) {
      expect(contrast(mix(tokens[name], outgoing, 0.85), outgoing), name).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('keeps Default/Light filled actions, status washes and nested syntax highlighting above AA contrast', () => {
    const tokens = literals('default', 'light');
    for (const [foreground, background] of [
      ['accent-fg', 'accent-strong-opaque'],
      ['action-fg', 'action-fill'],
      ['action-fg', 'dialog-action-fill'],
      ['primary-fg', 'primary'],
      ['danger-on-fill', 'danger-fill'],
      ['warning-on-fill', 'warning'],
      ['approve-fg', 'approve'],
      ['reject-fg', 'reject'],
    ]) {
      expect(contrast(tokens[foreground], tokens[background]), background).toBeGreaterThanOrEqual(4.5);
    }
    for (const [foreground, wash, alpha] of [
      ['error', '#e44444', 0.15],
      ['warning', '#b7791f', 0.1],
      ['success', '#6cc66c', 0.15],
    ] as const) {
      expect(contrast(tokens[foreground], mix(wash, '#ffffff', alpha)), foreground).toBeGreaterThanOrEqual(4.5);
    }
    const outgoing = mix('#7f7f7f', '#ffffff', 0.18);
    const nestedCode = mix('#7f7f7f', outgoing, 0.18);
    for (const name of ['syntax-keyword', 'syntax-string', 'syntax-number', 'syntax-title', 'syntax-type', 'muted']) {
      expect(contrast(tokens[name], nestedCode), `${name} on nested code`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('preserves the Default dark palette when appearance bootstrap is unavailable', () => {
    expect(literals('default', 'system-dark')).toEqual(literals('default', 'dark'));
  });

  it('keeps relative timestamps intact when metadata runs out of space', () => {
    const css = read('./components/ChatMain.css');
    const timestamp = css.match(/\.chat-main \.meta > \.ts \{([^}]+)\}/)?.[1];
    expect(timestamp).toContain('flex: none');
    expect(timestamp).toContain('white-space: nowrap');
  });

  it.each(THEMES.flatMap((theme) => ['light', 'dark'].map((mode) => [theme.id, mode])))(
    '%s / %s scroll-button symbols meet 4.5:1 in normal and new-message states',
    (theme, mode) => {
      const tokens = literals(theme, mode);
      const surface = theme === 'default' ? (mode === 'light' ? '#ffffff' : '#000000') : tokens['autumn-surface'];
      const text = theme === 'default' ? (mode === 'light' ? '#000000' : '#ffffff') : tokens['autumn-text'];
      expect(contrast(text, surface)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(tokens['primary-fg'], tokens['primary'])).toBeGreaterThanOrEqual(4.5);
      expect(contrast(tokens['primary'], surface)).toBeGreaterThanOrEqual(3);
    },
  );

  it('uses solid surface text for questions and choices, including hover and keyboard focus', () => {
    const css = read('./components/ChatMain.css');
    const dock = css.match(/\.chat-main \.question-dock \{([^}]+)\}/)?.[1];
    expect(dock).toContain('background: var(--surface-raised)');
    expect(dock).toContain('color: var(--surface-fg)');
    const question = css.match(/\.chat-main \.question-prompt-text \{([^}]+)\}/)?.[1];
    expect(question).toContain('color: var(--surface-fg)');
    const choice = css.match(/\.chat-main \.question-card-btn \{([^}]+)\}/)?.[1];
    expect(choice).toContain('color: var(--surface-fg)');
    expect(choice).toContain('background: var(--surface)');
    expect(choice).toContain('border: 1px solid currentColor');
    const hover = css.match(/\.chat-main \.question-card-btn:hover:not\(:disabled\) \{([^}]+)\}/)?.[1];
    expect(hover).toContain('background: var(--wash-strong)');
    expect(hover).toContain('color: var(--surface-fg)');
    const focus = css.match(/\.chat-main \.question-card-btn:focus-visible \{([^}]+)\}/)?.[1];
    expect(focus).toContain('outline: 2px solid currentColor');
    expect(focus).toContain('outline-offset: 2px');
    const disabled = css.match(/\.chat-main \.question-card-btn:disabled \{([^}]+)\}/)?.[1];
    expect(disabled).toContain('opacity: 0.7');
  });

  it.each(THEMES.flatMap((theme) => ['light', 'dark'].map((mode) => [theme.id, mode])))(
    '%s / %s questions and choices meet 4.5:1 in normal, hover and disabled states',
    (theme, mode) => {
      const tokens = literals(theme, mode);
      const surface = theme === 'default' ? (mode === 'light' ? '#ffffff' : '#000000') : tokens['autumn-surface'];
      const raised = theme === 'default' ? surface : tokens['autumn-raised'];
      const text = theme === 'default' ? (mode === 'light' ? '#000000' : '#ffffff') : tokens['autumn-text'];
      const hover = theme === 'default' ? mix('#7f7f7f', raised, 0.18) : mix(text, surface, 0.12);
      const disabledSurface = mix(surface, raised, 0.7);
      for (const background of [surface, raised, hover]) {
        expect(contrast(text, background), `question/choice on ${background}`).toBeGreaterThanOrEqual(4.5);
      }
      expect(contrast(mix(text, raised, 0.7), disabledSurface), 'disabled choice').toBeGreaterThanOrEqual(4.5);
    },
  );

  it('imports every registered theme and keeps OS queries out of components', () => {
    const global = read('./styles/global.css');
    for (const theme of THEMES) {
      expect(global).toContain(`@import './themes/${theme.id}.css'`);
      const css = read(`./styles/themes/${theme.id}.css`);
      for (const token of ['--font-ui', '--font-weight-body', '--font-weight-heading', '--letter-spacing-ui']) {
        expect(css, `${theme.id}: ${token}`).toContain(token);
      }
      for (const mode of ['light', 'dark']) {
        expect(css).toContain(`[data-theme="${theme.id}"][data-mode="${mode}"]`);
        const branch = css.match(
          new RegExp(`\\[data-theme="${theme.id}"\\]\\[data-mode="${mode}"\\] \\{([^}]+)\\}`),
        )?.[1];
        for (const status of ['queued', 'running', 'completed', 'failed']) {
          expect(branch, `${theme.id}/${mode}: activity ${status}`).toContain(`--activity-status-${status}:`);
        }
      }
    }
    expect(global).toContain('font: var(--font-weight-body) var(--font-body)/var(--line-height-ui) var(--font-ui)');
    expect(global).toContain('letter-spacing: var(--letter-spacing-ui)');
    expect(global).toContain('h1, h2, h3, h4, h5, h6 { font-weight: var(--font-weight-heading); }');
    const files = fs.readdirSync(new URL('./src/components/', import.meta.url)).filter((name) => name.endsWith('.css'));
    for (const name of files) expect(read(`./components/${name}`)).not.toContain('prefers-color-scheme');
  });

  it('runs the classic bootstrap before CSS and precaches it for offline loads', () => {
    const html = read('../index.html');
    expect(html.indexOf('<script src="dist/appearance.js"></script>')).toBeGreaterThan(0);
    expect(html.indexOf('dist/appearance.js')).toBeLessThan(html.indexOf('dist/app.css'));
    const source = read('../sw.js');
    const sandbox = { self: { addEventListener: () => {} }, assets: [] as string[] };
    vm.runInNewContext(`${source}\n;globalThis.assets = SHELL_ASSETS;`, sandbox);
    expect(sandbox.assets).toContain('/ui/chat/dist/appearance.js');
  });

  it.each(['light', 'dark'])('Autumn %s meets text and essential-control contrast thresholds', (mode) => {
    const tokens = literals('autumn', mode);
    const surface = tokens['autumn-surface'];
    const raised = tokens['autumn-raised'];
    const code = mix(tokens['autumn-text'], surface, 0.05);
    for (const background of [surface, raised]) {
      for (const name of ['autumn-text', 'muted', 'primary', 'error', 'warning', 'success']) {
        expect(contrast(tokens[name], background), `${name} on ${background}`).toBeGreaterThanOrEqual(4.5);
      }
      for (const name of ['border-control', 'focus-ring']) {
        expect(contrast(tokens[name], background), `${name} on ${background}`).toBeGreaterThanOrEqual(3);
      }
    }
    for (const name of ['primary', 'error', 'warning', 'success']) {
      const foreground = tokens[name === 'primary' ? 'primary-fg' : `${name}-on-fill`];
      expect(contrast(foreground, tokens[name]), `${name} button`).toBeGreaterThanOrEqual(4.5);
    }
    for (const name of ['syntax-keyword', 'syntax-string', 'syntax-number', 'syntax-title', 'syntax-type']) {
      expect(contrast(tokens[name], code), `${name} on code surface`).toBeGreaterThanOrEqual(4.5);
    }
    for (const name of ['error', 'success']) {
      expect(contrast(tokens[name], mix(tokens[name], surface, 0.1)), `${name} status wash`).toBeGreaterThanOrEqual(
        4.5,
      );
    }
  });
});
