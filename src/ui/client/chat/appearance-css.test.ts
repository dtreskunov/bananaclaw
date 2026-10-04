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
  const branch = css.match(new RegExp(`\\[data-theme="${theme}"\\]\\[data-mode="${mode}"\\] \\{([^}]+)\\}`))?.[1];
  if (!branch) throw new Error(`Missing ${theme}/${mode} branch`);
  return Object.fromEntries(
    [...`${common}\n${branch}`.matchAll(/--([\w-]+):\s*(#[\da-f]{3}(?:[\da-f]{3})?);/g)].map((match) => [
      match[1],
      match[2].length === 4 ? '#' + [...match[2].slice(1)].map((char) => char + char).join('') : match[2],
    ]),
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
  it('uses the same surface styling for both scroll buttons in every state', () => {
    const css = read('./components/ChatMain.css');
    const normal = css.match(/\.chat-main \.scroll-jump \{([^}]+)\}/)?.[1];
    expect(normal).toContain('background: var(--surface)');
    expect(normal).toContain('color: var(--surface-fg)');
    expect(css).not.toContain('.scroll-to-bottom.new-message');
  });

  it('fades scroll controls in and out over 500 ms while preserving reversal and reduced-motion hiding', () => {
    const css = read('./components/ChatMain.css');
    const resting = css.match(/\.chat-main \.scroll-jump \{([^}]+)\}/)?.[1];
    expect(resting).toContain('opacity: 0');
    expect(resting).toContain('visibility: hidden');
    expect(resting).toContain('pointer-events: none');
    expect(resting).toContain('opacity 0.5s, visibility 0s linear 0.5s');
    const active = css.match(/\.chat-main \.scroll-jump\[data-visible="true"\] \{([^}]+)\}/)?.[1];
    expect(active).toContain('opacity: 1');
    expect(active).toContain('visibility: visible');
    expect(active).toContain('pointer-events: auto');
    expect(active).toContain('transition: opacity 0.5s');
    expect(active).not.toContain('visibility 0s linear 0.5s');
    const reversed = css.match(/\.chat-main \.scroll-jump\[data-instant-hide="true"\] \{([^}]+)\}/)?.[1];
    expect(reversed).toContain('transition: none');
    expect(css).toMatch(
      /@media \(prefers-reduced-motion: reduce\) \{\s*\.chat-main \.scroll-jump,\s*\.chat-main \.scroll-jump\[data-visible="true"\] \{ transition: none; \}/,
    );
  });

  it('stacks Up above Down with an 8 px gap and a shared bottom anchor', () => {
    const css = read('./components/ChatMain.css');
    const shared = css.match(/\.chat-main \.scroll-jump \{([^}]+)\}/)?.[1];
    expect(shared).toContain('bottom: 10px');
    const up = css.match(/\.chat-main \.scroll-to-top \{([^}]+)\}/)?.[1];
    expect(up).toContain('transform: translateY(calc(-100% - 8px))');
    expect(up).not.toContain('top:');
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
    const mobileComposer = css.match(/@media \(max-width: 720px\) \{[\s\S]*?\.chat-main form \{([^}]+)\}/)?.[1];
    expect(mobileComposer).toContain('padding-inline: 12px');
    expect(css.match(/--chat-max:/g)).toHaveLength(1);
    expect(css.match(/max\(16px, calc\(\(100% - var\(--chat-max\)\)/g)).toHaveLength(1);
  });

  it('keeps message metadata controls on one row and truncates usage details', () => {
    const css = read('./components/ChatMain.css');
    const meta = css.match(/\.chat-main \.msg \.meta, \.chat-main \.typing \.meta \{([^}]+)\}/)?.[1];
    expect(meta).toContain('color: var(--message-meta, var(--muted))');
    expect(meta).toContain('flex-wrap: nowrap');
    expect(meta).toContain('min-width: 0');
    const usage = css.match(/\.chat-main \.usage \{([^}]+)\}/)?.[1];
    expect(usage).toContain('text-overflow: ellipsis');
    expect(usage).toContain('white-space: nowrap');
  });

  it('uses one inset provenance rail with accent, neutral and semantic tones', () => {
    const css = read('./components/ChatMain.css');
    const railRule = css.match(/\.chat-main \.msg\.agent-action,[\s\S]*?\.chat-main \.msg\.input-steering \{([^}]+)\}/);
    const rail = railRule?.[1];
    expect(rail).toContain('box-shadow: inset 2px 0 var(--provenance-rail-color, var(--border-strong))');
    expect(railRule?.[0]).not.toContain('.typing.turn-system');
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
    const timing = css.match(/\.chat-main \.typing \.typing-meta \{([^}]+)\}/)?.[1];
    expect(timing).toContain('flex: none');
    expect(timing).toContain('white-space: nowrap');
  });

  it('keeps activity trace typography comparable to the status line', () => {
    const css = read('./components/ChatMain.css');
    const trace = css.match(/\.chat-main \.msg-activity \.activity-trace \{([^}]+)\}/)?.[1];
    expect(trace).toContain('font-size: var(--font-2xs)');
    const toggle = css.match(
      /\.chat-main \.activity-trace \.trace-row-toggle,\s*\.chat-main \.activity-trace \.trace-chapter-toggle \{([^}]+)\}/,
    )?.[1];
    expect(toggle).toContain('font-size: inherit');
    expect(toggle).toContain('color: var(--trace-status-color, var(--muted))');
    for (const status of ['queued', 'running', 'completed', 'failed']) {
      const rule = css.match(new RegExp(`\\.chat-main \\.activity-trace \\.trace-status-${status} \\{([^}]+)\\}`))?.[1];
      expect(rule).toContain(`--trace-status-color: var(--activity-status-${status})`);
    }
    const subject = css.match(/\.chat-main \.activity-trace code\.trace-subject \{([^}]+)\}/)?.[1];
    expect(subject).toContain('font-size: inherit');
    const code = css.match(/\.chat-main \.activity-trace pre\.trace-code \{([^}]+)\}/)?.[1];
    expect(code).toContain('font-size: inherit');
    const codeContent = css.match(/\.chat-main \.activity-trace pre\.trace-code code \{([^}]+)\}/)?.[1];
    expect(codeContent).toContain('font-size: inherit');
    const preview = css.match(/\.chat-main \.typing \.trace-preview \{([^}]+)\}/)?.[1];
    expect(preview).toContain('font-size: var(--font-2xs)');
  });

  it('uses continuous chapter rails, indented hollow child dots and expanded TODO checklists', () => {
    const css = read('./components/ChatMain.css');
    expect(css).toContain('--trace-child-indent: 20px');
    expect(css).toContain('.trace-child::before { left: calc(4px - var(--trace-child-indent))');
    expect(css).toContain('.trace-child::after');
    expect(css).toMatch(/\.trace-child \.trace-dot \{[^}]*width: 5px;[^}]*border: 1px solid/);
    expect(css).toContain('.trace-chapter::before');
    expect(css).toContain('.trace-status-interrupted');
    expect(css).toContain('.trace-status-unknown');
    expect(css).toContain('ul.trace-todos');
  });

  it('uses one compact row rhythm for standalone steps, chapter headers and child connectors', () => {
    const css = read('./components/ChatMain.css');
    const trace = css.match(/\.chat-main \.msg-activity \.activity-trace \{([^}]+)\}/)?.[1];
    expect(trace).toContain('--trace-row-height: 28px');
    const row = css.match(/\.chat-main \.activity-trace \.trace-row-toggle \{([^}]+)\}/)?.[1];
    const chapter = [...css.matchAll(/\.chat-main \.activity-trace \.trace-chapter-toggle \{([^}]+)\}/g)].at(-1)?.[1];
    expect(row).toContain('height: var(--trace-row-height)');
    expect(chapter).toContain('height: var(--trace-row-height)');
    expect(css).toContain('top: calc(var(--trace-row-height) / 2)');
  });

  it('shares table transparency fades with the scrollable activity viewport', () => {
    const css = read('./components/ChatMain.css');
    const trace = css.match(/\.chat-main \.msg-activity \.activity-trace \{([^}]+)\}/)?.[1];
    expect(trace).toContain('overflow: auto');
    expect(css).toMatch(/\.trace-meta \{ white-space: nowrap/);
    expect(css).toContain('width: max-content; min-width: 100%');
    const global = read('./styles/global.css');
    expect(global).toContain('mask-composite: intersect');
    for (const edge of ['top', 'right', 'bottom'])
      expect(global).toContain(`.scroll-edge-fade.scroll-fade-${edge} { --fade-${edge}: 12px; }`);
  });

  it('keeps chapter headers free of the last step argument preview', () => {
    const component = read('./components/ChatMain.tsx');
    expect(component).not.toContain('trace-chapter-preview');
    expect(component).toContain('chapterEntryHeadline(step)');
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
