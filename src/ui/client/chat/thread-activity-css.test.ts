import fs from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = fs.readFileSync(new URL('./src/components/ThreadActivity.css', import.meta.url), 'utf8');

describe('thread activity styling', () => {
  it('keeps idle muted and waiting in the existing warning color', () => {
    expect(css).toMatch(/\.thread-activity\s*\{[^}]*color:\s*var\(--muted\)/);
    expect(css).toMatch(/\.thread-activity\.waiting\s*\{\s*color:\s*var\(--warning\)/);
    expect(css).toMatch(/\.thread-activity\.stale\s*\{\s*color:\s*var\(--muted\)/);
    expect(css).toMatch(/\.thread-activity\s*\{[^}]*flex:\s*none/);
  });

  it('only animates fresh running activity and respects reduced motion', () => {
    expect(css).toMatch(/\.running:not\(\.stale\) \.thread-activity-dot\s*\{\s*animation:\s*thread-activity-pulse/);
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)\s*\{\s*\.thread-activity\.running:not\(\.stale\) \.thread-activity-dot\s*\{\s*animation: none/);
    expect(css.match(/animation:/g)).toHaveLength(2);
  });
});
