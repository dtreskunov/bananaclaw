import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

function read(file: string): string {
  return readFileSync(new URL(`./src/${file}`, import.meta.url), 'utf8');
}

describe('collapsed desktop rails CSS contract', () => {
  const global = read('styles/global.css');
  const pane = read('components/Pane.css');
  const desktopLayout = global.split('@media (min-width: 721px)')[1]?.split('}')[0];
  const desktopPane = pane.split('@media (min-width: 721px)')[1];

  it('releases either or both collapsed columns without moving the transcript out of its grid slot', () => {
    expect(global).toContain('main.threads-collapsed { grid-template-columns: 0 minmax(0, 1fr) 1fr; }');
    expect(global).toContain('main.files-collapsed { grid-template-columns: var(--rail-w) minmax(0, 1fr) 0; }');
    expect(global).toContain('main.threads-collapsed.files-collapsed { grid-template-columns: 0 minmax(0, 1fr) 0; }');
    expect(desktopLayout).toContain('main { position: relative;');
    const desktop = global.split('@media (min-width: 721px)')[1];
    expect(desktop).toContain('main > .threads-rail { grid-area: 1 / 1; }');
    expect(desktop).toContain('main > .chat-main { grid-area: 1 / 2; }');
    expect(desktop).toContain('main > .files-pane { grid-area: 1 / 3; }');
  });

  it('floats compact, opaque controls at the top of each side above the transcript dock', () => {
    const collapsed = desktopPane?.match(/\.nc-pane\.collapsed \{([^}]+)\}/)?.[1];
    for (const declaration of [
      'position: absolute',
      'inset-block-start: 0',
      'width: var(--collapsed-w)',
      'height: max-content',
      'overflow: visible',
      'z-index: 4',
      'background: var(--surface)',
      'border: 1px solid var(--border)',
      'border-radius: var(--radius-lg)',
      'box-shadow:',
    ]) {
      expect(collapsed).toContain(declaration);
    }
    expect(desktopPane).toContain('.nc-pane.threads-rail.collapsed { inset-inline-start: 0; }');
    expect(desktopPane).toContain('.nc-pane.files-pane.collapsed { inset-inline-end: 0; }');
    const head = desktopPane?.match(/\.nc-pane\.collapsed > \.head \{([^}]+)\}/)?.[1];
    expect(head).toContain('position: relative');
    expect(head).toContain('width: auto');
    expect(head).toContain('height: auto');
    expect(head).toContain('border: 0');
  });

  it('retains expanded pane content, collapsed quick actions, and mobile drawer rules', () => {
    expect(pane).toContain('.nc-pane.collapsed > :not(.head) { display: none; }');
    expect(pane).toMatch(/\.nc-pane\.collapsed > \.head \.collapsed-actions \{[^}]*display: flex/);
    for (const name of ['ThreadsRail', 'FilesPane']) {
      const mobile = read(`components/${name}.css`).split('@media (max-width: 720px)')[1];
      expect(mobile).toContain('position: fixed');
      expect(mobile).toContain('height: var(--app-height, 100dvh)');
      expect(mobile).toContain('width: min(86vw, 340px)');
    }
    expect(global).toMatch(/@media \(max-width: 720px\)[\s\S]*grid-template-columns: 1fr !important/);
  });

  it('keeps desktop transcript bubbles at least 16px clear of each collapsed rail without reducing larger gutters', () => {
    const desktop = read('components/ChatMain.css').split('@media (min-width: 721px)')[1];
    expect(desktop).toContain(
      'main.threads-collapsed .chat-main > .log {\n    padding-inline-start: max(var(--chat-gutter), calc(var(--collapsed-w) + 16px));',
    );
    expect(desktop).toContain(
      'main.files-collapsed .chat-main > .log {\n    padding-inline-end: max(var(--chat-gutter), calc(var(--collapsed-w) + 16px));',
    );
  });
});
