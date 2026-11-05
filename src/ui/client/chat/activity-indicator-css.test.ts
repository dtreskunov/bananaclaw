import fs from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = fs.readFileSync(new URL('./src/components/ActivityIndicator.css', import.meta.url), 'utf8');
const trace = fs.readFileSync(new URL('./src/components/ChatMain.css', import.meta.url), 'utf8');
const rail = fs.readFileSync(new URL('./src/components/ThreadsRail.css', import.meta.url), 'utf8');

describe('shared activity styling', () => {
  it('matches solid 7px root trace circles, not hollow child hierarchy dots', () => {
    expect(trace).toMatch(/\.trace-dot\s*\{\s*width: 7px; height: 7px; border-radius: 50%; background:/);
    expect(css).toMatch(/\.activity-indicator\.dot\s*\{[^}]*width: 7px;[^}]*height: 7px;[^}]*border-radius: 50%;[^}]*background: currentColor;/);
    expect(css).not.toMatch(/animation:|@keyframes|background:\s*var\(--surface\)/);
  });

  it('uses the same queued/running tokens as the trace and keeps stale muted', () => {
    for (const [activity, token] of [['waiting', 'queued'], ['running', 'running']]) {
      expect(css).toContain(`.activity-indicator.${activity} { color: var(--activity-status-${token}); }`);
      expect(trace).toContain(`--trace-status-color: var(--activity-status-${token});`);
    }
    expect(css).toContain('.activity-indicator.stale { color: var(--muted); }');
    expect(css).toMatch(/:disabled\s*\{ opacity: 1; cursor: default;/);
  });

  it('spaces only rendered title markers and preserves request focus visibility', () => {
    expect(rail).toContain('.title > :is(.activity-indicator, .activity-action) { margin-right: 6px; }');
    expect(css).toContain('outline: 2px solid var(--focus-ring)');
    expect(css).toContain('[data-attention-target]:focus-within { outline: 2px solid var(--warning-border)');
  });
});
