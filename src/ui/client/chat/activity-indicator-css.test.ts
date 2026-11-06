import fs from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = fs.readFileSync(new URL('./src/components/ActivityIndicator.css', import.meta.url), 'utf8');
const rail = fs.readFileSync(new URL('./src/components/ThreadsRail.css', import.meta.url), 'utf8');
const tabs = fs.readFileSync(new URL('./src/components/TabBar.css', import.meta.url), 'utf8');
const dialog = fs.readFileSync(new URL('./src/components/MobileDialog.css', import.meta.url), 'utf8');

describe('shared activity styling', () => {
  it('uses a subtle idle fill and a rotating running ring', () => {
    expect(css).toMatch(
      /\.activity-indicator\.idle \.activity-indicator-base\s*\{[^}]*background: var\(--muted\);[^}]*opacity: 0.3;/,
    );
    expect(css).toMatch(
      /\.activity-indicator\.running \.activity-indicator-base\s*\{[^}]*border: 1.5px solid currentColor;[^}]*border-right-color: transparent;[^}]*animation: activity-spin/,
    );
    expect(css).toContain('color: var(--activity-status-running)');
    expect(css).toContain('@keyframes activity-spin { to { transform: rotate(360deg); } }');
  });

  it('makes idle-only dots smaller and fainter without dimming waiting indicators', () => {
    expect(css).toMatch(
      /\.activity-indicator\.idle:not\(\.waiting\) \.activity-indicator-base\s*\{[^}]*width: 6px;[^}]*height: 6px;[^}]*opacity: 0.2;/,
    );
    expect(css).toMatch(/\.activity-indicator-base\s*\{[^}]*width: 12px;[^}]*height: 12px;/);
  });

  it('keeps this essential progress cue rotating even when motion is reduced', () => {
    expect(css).toMatch(
      /\.activity-indicator-question\s*\{[^}]*position: absolute;[^}]*color: var\(--activity-status-queued\)/,
    );
    expect(css).not.toContain('.activity-indicator.stale .activity-indicator-base { animation: none; }');
    expect(css).not.toContain('prefers-reduced-motion');
    expect(css.match(/animation: activity-spin/g)).toHaveLength(1);
  });

  it('keeps status-line indicators, non-link actions and visible keyboard focus', () => {
    expect(rail).not.toContain('.title > :is(.activity-indicator, .activity-action)');
    expect(rail).toMatch(/\.thread \.meta \{[^}]*align-items: center; gap: 6px;/);
    expect(rail).toContain('.meta > span:not(.activity-indicator)');
    expect(css).not.toContain('text-decoration: underline');
    expect(css).toContain('outline: 2px solid var(--focus-ring)');
    expect(css).toContain('[data-attention-target]:focus-within { outline: 2px solid var(--warning-border)');
    expect(tabs).not.toContain('attention-separator');
    expect(tabs).toMatch(/\.tab-item-status \{[^}]*align-items: center;[^}]*gap: 4px;/);
    expect(dialog).toContain('.mobile-dialog-item-row .mobile-dialog-item-sublabel { padding-left: 20px; }');
    expect(dialog).toContain('position: absolute; bottom: 10px; left: 12px;');
    expect(tabs).toContain('position: absolute; left: 10px; bottom: 4px;');
  });
});
