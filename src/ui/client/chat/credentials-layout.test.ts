import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('personal Credentials layout', () => {
  it('opts out of the global three-column chat main grid', () => {
    const css = readFileSync(new URL('./src/components/Credentials.css', import.meta.url), 'utf8');
    const rule = css.match(/\.credentials-page\s*\{([^}]+)\}/)?.[1];
    expect(rule).toMatch(/display:\s*block/);
    expect(rule).toMatch(/overflow:\s*auto/);
  });
  it('uses transcript table formatting with vertical agent headings', () => {
    const source = readFileSync(new URL('./src/components/CredentialsTable.tsx', import.meta.url), 'utf8');
    const css = readFileSync(new URL('./src/components/Credentials.css', import.meta.url), 'utf8');
    expect(source).not.toContain('data-table-scroll="off"');
    expect(css).toMatch(/writing-mode:\s*vertical-rl/);
    expect(css).not.toMatch(/\.credentials-matrix\s*\{[^}]*border-collapse:/);
  });
});
