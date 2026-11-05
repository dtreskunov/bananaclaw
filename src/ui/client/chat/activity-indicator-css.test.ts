import fs from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = fs.readFileSync(new URL('./src/components/ActivityIndicator.css', import.meta.url), 'utf8');
const rail = fs.readFileSync(new URL('./src/components/ThreadsRail.css', import.meta.url), 'utf8');
const tabs = fs.readFileSync(new URL('./src/components/TabBar.css', import.meta.url), 'utf8');
const dialog = fs.readFileSync(new URL('./src/components/MobileDialog.css', import.meta.url), 'utf8');

describe('shared activity styling', () => {
  it('uses a subtle idle fill and a rotating running ring', () => {
    expect(css).toMatch(/\.activity-indicator\.idle \.activity-indicator-base\s*\{[^}]*background: var\(--muted\);[^}]*opacity: 0.3;/);
    expect(css).toMatch(/\.activity-indicator\.running \.activity-indicator-base\s*\{[^}]*border: 1.5px solid currentColor;[^}]*border-right-color: transparent;[^}]*animation: activity-spin/);
    expect(css).toContain('color: var(--activity-status-running)');
    expect(css).toContain('@keyframes activity-spin { to { transform: rotate(360deg); } }');
  });

  it('keeps this essential progress cue rotating even when motion is reduced', () => {
    expect(css).toMatch(/\.activity-indicator-question\s*\{[^}]*position: absolute;[^}]*color: var\(--activity-status-queued\)/);
    expect(css).not.toContain('.activity-indicator.stale .activity-indicator-base { animation: none; }');
    expect(css).not.toContain('prefers-reduced-motion');
    expect(css.match(/animation: activity-spin/g)).toHaveLength(1);
  });

  it('keeps leading indicators, non-link actions and visible keyboard focus', () => {
    expect(rail).toContain('.title > :is(.activity-indicator, .activity-action) { margin-right: 6px; }');
    expect(css).not.toContain('text-decoration: underline');
    expect(css).toContain('outline: 2px solid var(--focus-ring)');
    expect(css).toContain('[data-attention-target]:focus-within { outline: 2px solid var(--warning-border)');
    expect(tabs).not.toContain('attention-separator');
    expect(dialog).toContain('.mobile-dialog-item-row > .mobile-dialog-item { padding-left: 40px; }');
    expect(dialog).toContain('left: 12px; transform: translateY(-50%)');
  });
});
