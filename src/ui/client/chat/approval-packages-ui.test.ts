import fs from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('pending package approval UI', () => {
  it('renders separate package-manager lists from the approval payload', () => {
    const source = fs.readFileSync(new URL('./src/components/ChatMain.tsx', import.meta.url), 'utf8');
    const css = fs.readFileSync(new URL('./src/components/ChatMain.css', import.meta.url), 'utf8');

    expect(source).toContain("(['apt', 'npm', 'pip'] as const).map");
    expect(source).toContain("a.packages![manager].join(', ')");
    expect(source).toContain('class="approval-package-manager"');
    expect(css).toContain('.chat-main .approval-package-list');
  });
});
