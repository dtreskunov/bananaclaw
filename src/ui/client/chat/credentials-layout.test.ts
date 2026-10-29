import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('personal Credentials layout', () => {
  it('opts out of the global three-column chat main grid', () => {
    const css = readFileSync(new URL('./src/components/Credentials.css', import.meta.url), 'utf8');
    const rule = css.match(/\.credentials-page\s*\{([^}]+)\}/)?.[1];
    expect(rule).toMatch(/display:\s*block/);
    expect(rule).toMatch(/overflow:\s*auto/);
  });
});
