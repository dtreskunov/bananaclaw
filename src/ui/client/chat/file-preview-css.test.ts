import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

function read(file: string) {
  return readFileSync(new URL(`./src/components/${file}`, import.meta.url), 'utf8');
}

describe('fullscreen file preview CSS contract', () => {
  it('keeps one preview subtree inline and in the native top layer', () => {
    const css = read('FilePreviewDialog.css');
    expect(css).toContain('.file-preview-host:not(.is-expanded)');
    expect(css).toContain('display: contents');
    expect(css).toContain('height: var(--app-height, 100dvh)');
    expect(css).toContain('.file-preview-host.is-expanded > .file-preview-backdrop { position: absolute; inset: 0; }');
    expect(css).toContain('.file-preview-host.is-expanded .file-preview-panel { height: 100%; max-height: 100%; }');
    expect(read('FilesPane.css')).toContain(
      '.nc-pane.files-pane.file-preview-expanded > .files-body { display: flex; }',
    );
  });

  it('limits readable content but does not constrain embedded previews or media', () => {
    const css = read('FilePreviewDialog.css');
    expect(css).toContain(':is(.markdown-preview, pre, .file-editor, .empty, .preview-lyrics)');
    expect(css).toContain('max-width: 80ch');
    expect(css).toContain('margin-inline: auto');
    expect(css).not.toContain('.embedded-preview-frame');
    expect(css).not.toContain('.file-image-preview');
    expect(css).not.toContain('.media-player');
    const pane = read('FilesPane.tsx');
    expect(pane).toContain('aria-haspopup="dialog"');
    expect(pane).toContain('aria-label="Full screen preview"');
    expect(pane.match(/<Preview editor=\{editor\}/g)).toHaveLength(1);
    expect(pane).toMatch(/\{fullScreenButton\}\s*<ActionsMenu\s+mode="entry"/);
  });

  it('hides preview chrome only in full-screen mode without removing its state', () => {
    const css = read('FilePreviewDialog.css');
    expect(css).toContain(
      '.file-preview-host.is-expanded :is(.files-actions, .path-breadcrumb, .preview-meta) { display: none; }',
    );
  });

  it('removes the pane frame while keeping reading gutters inside textual content', () => {
    const css = read('FilePreviewDialog.css');
    const body = css.match(/\.file-preview-host\.is-expanded \.preview-body \{([^}]+)\}/)?.[1];
    for (const declaration of ['margin: 0', 'padding: 0', 'border: 0', 'border-radius: 0']) {
      expect(body).toContain(declaration);
    }
    expect(css).toContain('.file-preview-host.is-expanded .private-web-view { border: 0; }');
    const readable = css.match(/\.preview-body > :is\([^)]+\) \{([^}]+)\}/)?.[1];
    expect(readable).toContain('padding: var(--preview-padding)');
    expect(readable).toContain('border: 0');
    expect(readable).toContain('background: transparent');
  });
});
