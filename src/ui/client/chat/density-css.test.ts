import fs from 'node:fs';
import { describe, expect, it } from 'vitest';

function read(relative: string): string {
  return fs.readFileSync(new URL(`./src/${relative}`, import.meta.url), 'utf8');
}

function tokens(block: string): Record<string, string> {
  return Object.fromEntries([...block.matchAll(/(--[\w-]+):\s*([^;]+);/g)].map((match) => [match[1], match[2].trim()]));
}

describe('text density CSS contract', () => {
  const global = read('styles/global.css');
  const compact = tokens(global.match(/:root \{([^}]+)\}/)![1]);
  const comfortable = tokens(global.match(/:root\[data-density="comfortable"\] \{([^}]+)\}/)![1]);

  it('defines the selected Compact and Comfortable typography and spacing scales', () => {
    const scale = ['2xs', 'xs', 'sm', 'base', 'lg', 'xl'];
    expect(scale.map((size) => compact[`--font-${size}`])).toEqual(['10px', '11px', '12px', '13px', '14px', '15px']);
    expect(scale.map((size) => comfortable[`--font-${size}`])).toEqual([
      '12px',
      '13px',
      '14px',
      '15px',
      '16px',
      '17px',
    ]);
    expect(compact).toMatchObject({
      '--font-body': '15px',
      '--line-height-ui': '1.3',
      '--message-gap': '6px',
      '--message-padding-top': '4px',
      '--message-padding-block': '6px',
      '--message-padding-inline': '10px',
      '--text-block-gap': '4px',
      '--paragraph-gap': '8px',
      '--list-item-gap': '4px',
      '--ordered-list-padding': '32px',
      '--thread-padding-block': '8px',
      '--thread-padding-inline': '10px',
      '--file-padding-block': '4px',
      '--file-padding-inline': '10px',
      '--settings-section-gap': '24px',
    });
    for (const theme of ['default', 'autumn']) {
      expect(tokens(read(`styles/themes/${theme}.css`).match(/\{([^}]+)\}/)![1])).toMatchObject({
        '--font-ui': "'Figtree', system-ui, sans-serif",
        '--font-weight-body': '300',
        '--font-weight-heading': '500',
        '--letter-spacing-ui': '0.015em',
      });
    }
    expect(comfortable).toMatchObject({
      '--font-ui': "'Figtree', system-ui, sans-serif",
      '--font-weight-body': '300',
      '--font-weight-heading': '500',
      '--letter-spacing-ui': '0.015em',
      '--font-body': '16px',
      '--line-height-ui': '1.5',
      '--message-gap': '10px',
      '--message-padding-top': '6px',
      '--message-padding-block': '10px',
      '--message-padding-inline': '14px',
      '--text-block-gap': '8px',
      '--paragraph-gap': '12px',
      '--list-item-gap': '6px',
      '--ordered-list-padding': '35px',
      '--thread-padding-block': '12px',
      '--thread-padding-inline': '12px',
      '--file-padding-block': '8px',
      '--file-padding-inline': '12px',
      '--settings-section-gap': '32px',
    });
    expect(global).toContain('font: var(--font-weight-body) var(--font-body)/var(--line-height-ui) var(--font-ui)');
    expect(global.match(/font-family: 'Figtree'/g)).toHaveLength(3);
    expect(global).toContain("src: url('./fonts/figtree-300.ttf') format('truetype')");
    expect(global).toContain("src: url('./fonts/figtree-400.ttf') format('truetype')");
    expect(global).toContain("src: url('./fonts/figtree-500.ttf') format('truetype')");
  });

  it('uses shared tokens on chat, lists, menus, settings and native previews', () => {
    const consumers = [
      [
        'components/ChatMain.css',
        '--message-gap',
        '--message-padding-block',
        '--message-padding-inline',
        '--text-block-gap',
        '--paragraph-gap',
        '--list-item-gap',
        '--ordered-list-padding',
      ],
      ['components/ThreadsRail.css', '--thread-padding-block', '--thread-padding-inline'],
      [
        'components/FilesPane.css',
        '--file-padding-block',
        '--file-padding-inline',
        '--preview-padding',
        '--list-item-gap',
      ],
      ['components/Settings.css', '--settings-section-gap', '--settings-body-padding', '--control-padding-block'],
      ['components/GroupAdminField.css', '--control-padding-block', '--field-margin'],
      ['components/ActionsMenu.css', '--menu-padding-block'],
      ['components/UserMenu.css', '--menu-roomy-padding-block'],
      ['components/AppearanceSettings.css', '--message-gap', '--message-padding-block', '--thread-padding-block'],
    ];
    for (const [file, ...names] of consumers) {
      const css = read(file);
      for (const name of names) expect(css, `${file}: ${name}`).toContain(`var(${name})`);
    }
  });

  it('uses the table and thread-list hierarchy for browser rows', () => {
    const threads = read('components/ThreadsRail.css');
    const files = read('components/FilesPane.css');
    const source = read('components/FilesPane.tsx');

    expect(threads).toMatch(/\.thread \.title \{[^}]*font-size: var\(--font-base\)/);
    expect(threads).toMatch(/\.thread \.meta \{[^}]*font-size: var\(--font-xs\)[^}]*margin-top: 2px/);
    expect(threads).toMatch(/\.thread-section-body > \.thread:nth-child\(even\)[\s\S]*var\(--table-row-alt-bg\)/);
    expect(files).toMatch(/\.row \{[^}]*font-size: var\(--font-base\)/);
    expect(files).not.toMatch(/\.listing > \.row:nth-child\(even of \.row\)/);
    expect(files.match(/\.row \{([^}]+)\}/)?.[1]).not.toContain('border-bottom');
    expect(files).toMatch(/\.row \.details \{ display: contents; \}/);
    expect(files).toMatch(/\.row \.file-meta \{[^}]*font-size: var\(--font-xs\)/);
    expect(files).toMatch(
      /@media \(max-width: 720px\)[\s\S]*\.row \.details \{[^}]*flex-direction: column[^}]*\}[\s\S]*\.row \.file-meta \{[^}]*margin-top: 2px/,
    );
    expect(files).toMatch(/\.row \.entry-label \{[^}]*text-overflow: ellipsis[^}]*white-space: nowrap/);
    expect(source).toMatch(/<span class="file-meta">[\s\S]*result-path[\s\S]*class="meta"[\s\S]*class="size"/);
  });

  it('keeps density typography and spacing independent of theme, icons, widths, media and control sizes', () => {
    for (const name of Object.keys(comfortable)) {
      expect(name).not.toMatch(
        /theme|surface|color|radius|icon|glyph|rail-w|chat-max|control-size|control-height|bottom-row/,
      );
    }
    const bubble = read('components/ChatMain.css').match(/\.chat-main \.msg \{([^}]+)\}/)![1];
    expect(bubble).toContain('max-width: 90%');
    expect(read('components/ChatMain.css')).toContain('--chat-max: 760px');
    expect(global).not.toMatch(/(?:zoom|transform:\s*scale)\s*:/);
  });

  it('preserves Compact mobile spacing and keeps inputs and touch targets readable', () => {
    const mobile = global.slice(global.indexOf('@media (max-width: 720px)'));
    const mobileCompact = tokens(mobile.match(/:root \{([^}]+)\}/)![1]);
    const mobileComfortable = tokens(mobile.match(/:root\[data-density="comfortable"\] \{([^}]+)\}/)![1]);
    expect(mobileCompact).toMatchObject({
      '--thread-padding-block': '12px',
      '--thread-padding-inline': '14px',
      '--file-padding-block': '10px',
      '--file-padding-inline': '12px',
      '--message-input-font-size': '16px',
      '--rail-control-height': '48px',
      '--control-action-size': '40px',
      '--menu-item-min-height': '44px',
    });
    for (const name of [
      '--thread-padding-block',
      '--thread-padding-inline',
      '--file-padding-block',
      '--file-padding-inline',
    ]) {
      expect(parseInt(mobileComfortable[name])).toBeGreaterThanOrEqual(parseInt(mobileCompact[name]));
    }
    expect(mobile).toContain('font-size: max(16px, var(--message-input-font-size))');
    expect(read('components/FilesPane.css')).toContain('min-height: 40px');
  });

  it('reveals mobile bubble actions only after selecting or focusing a message', () => {
    const css = read('components/ChatMain.css');
    const source = read('components/ChatMain.tsx');
    const mobile = css.slice(css.indexOf('@media (max-width: 720px)'));

    expect(css).toContain('@media (min-width: 721px) and (hover: hover) and (pointer: fine)');
    expect(mobile).toContain('.chat-main .msg .msg-inline-actions { display: none; }');
    expect(mobile).toMatch(
      /\.msg\.mobile-actions-visible \.msg-inline-actions,[\s\S]*\.msg:focus-within \.msg-inline-actions \{ display: inline-flex; \}/,
    );
    expect(mobile).toContain('.chat-main .msg .meta { min-height: 32px; }');
    expect(css).toContain('.chat-main .msg.in .meta > .ts { margin-right: auto; }');
    expect(read('components/ActionIcons.css')).toMatch(
      /@media \(pointer: coarse\) \{[\s\S]*\.msg-action-btn \{ width: 32px; height: 32px; \}/,
    );
    expect(source).toContain("event.target.closest<HTMLElement>('.msg[data-msg-id]')");
    expect(source).toContain("' mobile-actions-visible'");
  });

  it('offers labeled density choices with visible focus and a live, noninteractive preview', () => {
    const css = read('components/AppearanceSettings.css');
    expect(css).toMatch(/\.appearance-mode, \.appearance-density \{[^}]*min-height: 44px/);
    expect(css).toContain('.appearance-density:has(:checked)');
    expect(css).toContain('.appearance-density:has(:focus-visible)');
    expect(css).toMatch(/\.appearance-density-preview \{[^}]*pointer-events: none/);
    expect(css).not.toContain('transition:');
  });
});
