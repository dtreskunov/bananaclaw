import fs from 'node:fs';
import { describe, expect, it } from 'vitest';

const builtCss = fs.readFileSync(new URL('./dist/app.css', import.meta.url), 'utf8');
const chatPackage = fs.readFileSync(new URL('./package.json', import.meta.url), 'utf8');
const chatRoutes = fs.readFileSync(new URL('../../server/chat/routes.ts', import.meta.url), 'utf8');

describe('Figtree production assets', () => {
  it('bundles every required weight and serves only generated Figtree assets from the nested font path', () => {
    expect(chatPackage).toContain('--loader:.ttf=file');
    expect(chatPackage).toContain('--asset-names=fonts/[name]-[hash]');
    for (const weight of ['300', '400', '500']) {
      expect(builtCss).toContain(`font-weight: ${weight}`);
      expect(builtCss).toMatch(new RegExp(`fonts/figtree-${weight}-[A-Z0-9]{8}\\.ttf`));
    }
    expect(chatRoutes).toContain('/^figtree-(300|400|500)-[A-Z0-9]{8}\\.ttf$/');
    expect(chatRoutes).toContain("? 'font/ttf'");
  });
});
