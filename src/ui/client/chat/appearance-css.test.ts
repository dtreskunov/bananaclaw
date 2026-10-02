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
  it('uses matched, opaque foreground/background tokens for the scroll button, including hover', () => {
    const css = read('./components/ChatMain.css');
    const normal = css.match(/\.chat-main \.scroll-jump \{([^}]+)\}/)?.[1];
    expect(normal).toContain('background: var(--surface)');
    expect(normal).toContain('color: var(--surface-fg)');
    const highlighted = css.match(
      /\.chat-main \.scroll-to-bottom\.new-message,\s*\.chat-main \.scroll-to-bottom\.new-message:hover \{([^}]+)\}/,
    )?.[1];
    expect(highlighted).toContain('background: var(--primary)');
    expect(highlighted).toContain('color: var(--primary-fg)');
  });

  it('keeps message metadata controls on one row and truncates usage details', () => {
    const css = read('./components/ChatMain.css');
    const meta = css.match(/\.chat-main \.msg \.meta, \.chat-main \.typing \.meta \{([^}]+)\}/)?.[1];
    expect(meta).toContain('flex-wrap: nowrap');
    expect(meta).toContain('min-width: 0');
    const usage = css.match(/\.chat-main \.usage \{([^}]+)\}/)?.[1];
    expect(usage).toContain('text-overflow: ellipsis');
    expect(usage).toContain('white-space: nowrap');
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
      for (const mode of ['light', 'dark']) {
        expect(css).toContain(`[data-theme="${theme.id}"][data-mode="${mode}"]`);
      }
    }
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
